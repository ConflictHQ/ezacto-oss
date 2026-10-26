import { sql } from 'drizzle-orm'
import {
  matchDeposit,
  type NeutralDeposit,
  type MatchCandidate,
  type BankDepositObservation,
} from '@ezacto/core'
import { atomicStatements } from './atomic-statements.js'
import { recordInvoicePayment, type InvoiceStateDatabase } from './invoice-state.js'
import { bankDepositReviewAuthority } from './migrations/0174_bank_deposit_review.js'

export { BankDepositReviewError } from '@ezacto/core'
import {
  BankDepositReviewError,
  type BankReviewAuthority,
  type BankFeedAccount,
  type BankReviewInvoice,
  type BankDepositRow,
} from '@ezacto/core'
function fail(code: BankDepositReviewError['code'], message: string): never {
  throw new BankDepositReviewError(code, message)
}
const fingerprint = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
  )
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')
const validCommand = (value: string) => {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) fail('invalid', 'Use a valid command identity.')
}
const guard = (condition: string, params: unknown[]) => ({
  text: `INSERT OR REPLACE INTO bank_deposit_write_guard(singleton,ok) VALUES(1,CASE WHEN ${condition} THEN 1 ELSE 0 END) RETURNING singleton`,
  params,
})
const feedAuthority: BankReviewAuthority = { userId: 0, sessionId: 'private-feed-runtime' }
const actorId = (who: BankReviewAuthority) => (who === feedAuthority ? null : who.userId)
const whoGuard = (who: BankReviewAuthority) =>
  who === feedAuthority
    ? guard('1', [])
    : guard(bankDepositReviewAuthority('?', '?'), [who.userId, who.sessionId])

const clean = (value: unknown, max: number, nullable = false): string | null => {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string' ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!
      return (code < 32 && !['\t', '\r', '\n'].includes(character)) || code === 127
    }) ||
    (!nullable && !value.trim())
  )
    fail('invalid', 'A supplied text field is invalid.')
  return value as string
}
const normalize = (entry: NeutralDeposit): NeutralDeposit => {
  if (!entry || typeof entry !== 'object') fail('invalid', 'Provide a valid credit record.')
  const transaction = clean(entry.provider_transaction_id, 255)!
  if (
    !/^[A-Z]{3}$/.test(entry.currency) ||
    !Number.isSafeInteger(entry.amount_cents) ||
    entry.amount_cents < 1 ||
    entry.amount_cents > 9_000_000_000_000
  )
    fail('invalid', 'Provide a positive credit in one currency.')
  if (
    typeof entry.posted_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(entry.posted_at) ||
    !Number.isFinite(Date.parse(entry.posted_at)) ||
    new Date(entry.posted_at).toISOString().slice(0, 19) !== entry.posted_at.slice(0, 19)
  )
    fail('invalid', 'Provide a valid UTC posting timestamp.')
  return {
    provider_transaction_id: transaction,
    currency: entry.currency,
    posted_at: new Date(entry.posted_at).toISOString(),
    amount_cents: entry.amount_cents,
    memo: clean(entry.memo, 2000, true),
    counterparty: clean(entry.counterparty, 200, true),
  }
}
export const createBankDepositReviewService = (
  database: InvoiceStateDatabase,
  options: { now?: () => Date } = {},
) => {
  const now = () => (options.now?.() ?? new Date()).toISOString()
  const authorize = async (who: BankReviewAuthority) => {
    if (who === feedAuthority) return
    if (!Number.isSafeInteger(who.userId) || who.userId < 1 || !/^\d+$/.test(who.sessionId))
      fail('forbidden', 'A current native session is required.')
    const rows = await database.all<{ ok: number }>(
      sql.raw(
        'SELECT 1 AS ok WHERE ' +
          bankDepositReviewAuthority(
            String(who.userId),
            "'" + who.sessionId.replaceAll("'", "''") + "'",
          ),
      ),
    )
    if (!rows.length) fail('forbidden', 'Current administrator or accounting access is required.')
  }
  const prior = async (who: BankReviewAuthority, commandId: string, hash: string) => {
    validCommand(commandId)
    await authorize(who)
    const rows = await database.all<{
      fingerprint: string
      actor_user_id: number
      result_json: string
    }>(
      sql`SELECT fingerprint,actor_user_id,result_json FROM bank_deposit_audit WHERE command_id=${commandId}`,
    )
    if (!rows[0]) return null
    if (rows[0].fingerprint !== hash || rows[0].actor_user_id !== actorId(who))
      fail('conflict', 'That command identity was already used.')
    return JSON.parse(rows[0].result_json) as Record<string, unknown>
  }
  const accounts = async (who: BankReviewAuthority): Promise<BankFeedAccount[]> => {
    await authorize(who)
    return database.all<BankFeedAccount>(
      sql`SELECT a.id,a.provider,a.display_name AS name FROM payment_provider_accounts a JOIN bank_feed_accounts b ON b.provider_account_id=a.id ORDER BY a.display_name,a.id`,
    )
  }
  const readMany = async (ids: number[]): Promise<BankDepositRow[]> => {
    const rows = await database.all<
      Omit<BankDepositRow, 'suggested_invoice'> & {
        invoice_id: number | null
        number: string | null
        invoice_currency: string | null
        due_amount_cents: number | null
        invoice_version: number | null
        invoice_state: string | null
      }
    >(sql`SELECT d.id,d.provider_account_id AS account_id,a.display_name AS account_name,a.provider,d.provider_transaction_id,d.currency,d.posted_at,d.amount_cents,d.memo,d.counterparty,
   CASE WHEN d.match_state='confirmed' THEN 'confirmed' WHEN r.rejected_at IS NOT NULL THEN 'rejected' ELSE d.match_state END AS state,r.version,r.source_status,r.classification,r.source_reason,r.verified_at,r.verified_by_user_id,r.verification_reference,
   i.id AS invoice_id,i.number,i.currency AS invoice_currency,i.due_amount_cents,i.version AS invoice_version,i.state AS invoice_state,
   p.id AS payment_id,p.invoice_id AS confirmed_invoice_id
   FROM bank_deposits d JOIN bank_deposit_reviews r ON r.deposit_id=d.id JOIN bank_feed_accounts b ON b.provider_account_id=d.provider_account_id
   JOIN payment_provider_accounts a ON a.id=d.provider_account_id LEFT JOIN invoices i ON i.id=d.suggested_invoice_id LEFT JOIN invoice_payments p ON p.bank_deposit_id=d.id WHERE d.id IN(SELECT value FROM json_each(${JSON.stringify(ids)}))`)
    return rows.map((row) => {
      const {
        invoice_id,
        number,
        invoice_currency,
        due_amount_cents,
        invoice_version,
        invoice_state,
        ...base
      } = row
      return {
        ...base,
        confirmation_ready:
          (base.source_status === 'final' && base.classification === 'external_credit') ||
          (['unknown', 'final'].includes(base.source_status) &&
            base.classification !== 'internal_transfer' &&
            base.verified_at !== null),
        confirmation_basis:
          base.source_status === 'final' && base.classification === 'external_credit'
            ? 'provider'
            : ['unknown', 'final'].includes(base.source_status) &&
                base.classification !== 'internal_transfer' &&
                base.verified_at !== null
              ? 'operator'
              : null,
        suggested_invoice:
          invoice_id === null
            ? null
            : {
                id: invoice_id,
                number: number!,
                currency: invoice_currency!,
                due_amount_cents: due_amount_cents!,
                version: invoice_version!,
                state: invoice_state!,
              },
      }
    })
  }
  const read = async (id: number) => (await readMany([id]))[0] ?? null
  const audit = (
    who: BankReviewAuthority,
    command: string,
    hash: string,
    operation: string,
    account: number | null,
    deposit: number | null,
    invoice: number | null,
    before: number | null,
    after: number | null,
    result: unknown,
    stamp: string,
  ) => ({
    text: `INSERT INTO bank_deposit_audit(command_id,fingerprint,operation,actor_user_id,actor_type,provider_account_id,deposit_id,invoice_id,before_version,after_version,occurred_at,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING command_id`,
    params: [
      command,
      hash,
      operation,
      actorId(who),
      who === feedAuthority ? 'system' : 'user',
      account,
      deposit,
      invoice,
      before,
      after,
      stamp,
      JSON.stringify(result),
    ],
  })
  return {
    accounts,
    async createAccount(
      who: BankReviewAuthority,
      input: {
        command_id: string
        provider: 'mercury' | 'wise'
        name: string
        external_account_id?: string
      },
    ) {
      if (!['mercury', 'wise'].includes(input.provider))
        fail('invalid', 'Choose a supported feed provider.')
      const name = clean(input.name, 80)!,
        hash = await fingerprint([
          'account',
          input.provider,
          name,
          input.external_account_id ?? null,
        ]),
        old = await prior(who, input.command_id, hash)
      if (old) return old as unknown as BankFeedAccount
      const id = (
          await database.all<{ id: number }>(
            sql`SELECT coalesce(max(id),0)+1 AS id FROM payment_provider_accounts`,
          )
        )[0]!.id,
        stamp = now()
      const result = { id, provider: input.provider, name }
      try {
        await atomicStatements(database, [
          whoGuard(who),
          {
            text: `INSERT INTO payment_provider_accounts(id,provider,provider_shape,external_account_id,display_name,created_at,updated_at) VALUES(?,?,'reconciliation',?,?,?,?) RETURNING id`,
            params: [
              id,
              input.provider,
              who === feedAuthority && input.external_account_id
                ? clean(input.external_account_id, 255)!
                : 'local:' + crypto.randomUUID(),
              name,
              stamp,
              stamp,
            ],
          },
          {
            text: 'INSERT INTO bank_feed_accounts(provider_account_id,created_by_user_id,created_at) VALUES(?,?,?) RETURNING provider_account_id',
            params: [id, actorId(who), stamp],
          },
          audit(who, input.command_id, hash, 'account', id, null, null, null, null, result, stamp),
        ])
      } catch {
        const replay = await prior(who, input.command_id, hash)
        if (replay) return replay as unknown as BankFeedAccount
        fail('conflict', 'The feed account changed. Refresh and retry.')
      }
      return result
    },
    async ingest(
      who: BankReviewAuthority,
      input: {
        command_id: string
        account_id: number
        deposits: NeutralDeposit[]
        page?: { expected_version: number; cursor: string | null; holder?: string }
        observations?: Record<string, BankDepositObservation>
      },
    ) {
      if (
        !Number.isSafeInteger(input.account_id) ||
        input.account_id < 1 ||
        !Array.isArray(input.deposits) ||
        (!input.deposits.length && !input.page) ||
        input.deposits.length > 100
      )
        fail('invalid', 'Import between one and 100 credit records into a feed account.')
      const observationEntries = Object.entries(input.observations ?? {})
      if (observationEntries.length > 100) fail('invalid', 'Too many provider observations.')
      for (const [identity, observation] of observationEntries) {
        clean(identity, 255)
        if (
          !observation ||
          !['final', 'pending', 'reversed', 'ineligible', 'unknown'].includes(observation.status) ||
          !['external_credit', 'internal_transfer', 'ambiguous_credit'].includes(
            observation.classification,
          ) ||
          (observation.reason !== undefined && !/^[a-z_]{1,64}$/.test(observation.reason))
        )
          fail('invalid', 'Provider observation is invalid.')
      }
      const entries = input.deposits.map(normalize),
        keys = new Set(entries.map((e) => e.provider_transaction_id))
      if (keys.size !== entries.length)
        fail('invalid', 'A batch may contain a transaction identity only once.')
      const hash = await fingerprint([
          'import',
          input.account_id,
          entries,
          input.page ?? null,
          input.observations ?? null,
        ]),
        old = await prior(who, input.command_id, hash)
      if (old) return old
      if (!(await accounts(who)).some((a) => a.id === input.account_id))
        fail('not_found', 'That feed account is not available.')
      const candidates = await database.all<MatchCandidate>(
        sql`SELECT id AS invoice_id,reference_token,currency,due_amount_cents AS due_cents,issue_date FROM invoices WHERE state='open' AND due_amount_cents>0 LIMIT 2001`,
      )
      const first = (
          await database.all<{ id: number }>(
            sql`SELECT coalesce(max(id),0)+1 AS id FROM bank_deposits`,
          )
        )[0]!.id,
        stamp = now()
      const statements = [whoGuard(who)]
      if (input.page) {
        if (who !== feedAuthority) fail('forbidden', 'Feed cursors belong to the runtime.')
        statements.push(
          guard(
            'EXISTS(SELECT 1 FROM bank_feed_accounts WHERE provider_account_id=? AND version=?)',
            [input.account_id, input.page.expected_version],
          ),
        )
      }
      if (input.page?.holder)
        statements.push(
          guard(
            "EXISTS(SELECT 1 FROM bank_feed_accounts WHERE provider_account_id=? AND lease_holder=? AND julianday(lease_expires_at)>julianday('now'))",
            [input.account_id, input.page.holder],
          ),
        )
      for (const [index, entry] of entries.entries()) {
        const observation = input.observations?.[entry.provider_transaction_id] ?? {
          status: 'unknown',
          classification: 'ambiguous_credit',
        }
        if (
          !['final', 'pending', 'reversed', 'ineligible', 'unknown'].includes(observation.status) ||
          !['external_credit', 'internal_transfer', 'ambiguous_credit'].includes(
            observation.classification,
          ) ||
          (observation.reason !== undefined && !/^[a-z_]{1,64}$/.test(observation.reason))
        )
          fail('invalid', 'Provider observation is invalid.')
        const sourceHash = await fingerprint(entry),
          match =
            candidates.length > 2000
              ? { state: 'unmatched' as const }
              : matchDeposit(entry, candidates)
        statements.push(
          guard(
            `NOT EXISTS(SELECT 1 FROM bank_deposits d JOIN bank_deposit_reviews r ON r.deposit_id=d.id WHERE d.provider_account_id=? AND d.provider_transaction_id=? AND r.source_fingerprint<>?)`,
            [input.account_id, entry.provider_transaction_id, sourceHash],
          ),
        )
        statements.push({
          text: `INSERT INTO bank_deposits(id,provider_account_id,provider_transaction_id,currency,posted_at,amount_cents,memo,counterparty,match_state,suggested_invoice_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM bank_deposits WHERE provider_account_id=? AND provider_transaction_id=?) ON CONFLICT(provider_account_id,provider_transaction_id) DO NOTHING RETURNING id`,
          params: [
            first + index,
            input.account_id,
            entry.provider_transaction_id,
            entry.currency,
            entry.posted_at,
            entry.amount_cents,
            entry.memo,
            entry.counterparty,
            match.state,
            match.state === 'suggested' ? match.invoice_id : null,
            stamp,
            stamp,
            input.account_id,
            entry.provider_transaction_id,
          ],
        })
        statements.push({
          text: `INSERT INTO bank_deposit_reviews(deposit_id,source_fingerprint,source_status,classification,source_reason) SELECT id,?,?,?,? FROM bank_deposits WHERE provider_account_id=? AND provider_transaction_id=?
            ON CONFLICT(deposit_id) DO UPDATE SET source_status=excluded.source_status,classification=excluded.classification,source_reason=excluded.source_reason,verified_at=NULL,verified_by_user_id=NULL,verification_reference=NULL,version=bank_deposit_reviews.version+1
              WHERE source_status IS NOT excluded.source_status OR classification IS NOT excluded.classification OR source_reason IS NOT excluded.source_reason RETURNING deposit_id`,
          params: [
            sourceHash,
            observation.status,
            observation.classification,
            observation.reason ?? null,
            input.account_id,
            entry.provider_transaction_id,
          ],
        })
      }
      for (const [identity, observation] of observationEntries.filter(
        ([identity]) => !keys.has(identity),
      )) {
        statements.push({
          text: `UPDATE bank_deposit_reviews SET source_status=?,classification=?,source_reason=?,verified_at=NULL,verified_by_user_id=NULL,verification_reference=NULL,version=version+1
          WHERE deposit_id IN(SELECT id FROM bank_deposits WHERE provider_account_id=? AND provider_transaction_id=?)
            AND (source_status IS NOT ? OR classification IS NOT ? OR source_reason IS NOT ?) RETURNING deposit_id`,
          params: [
            observation.status,
            observation.classification,
            observation.reason ?? null,
            input.account_id,
            identity,
            observation.status,
            observation.classification,
            observation.reason ?? null,
          ],
        })
      }
      if (input.page)
        statements.push({
          text: 'UPDATE bank_feed_accounts SET cursor=?,version=version+1,last_synced_at=?,last_error=NULL,scan_active=?,next_poll_at=? WHERE provider_account_id=? RETURNING provider_account_id',
          params: [
            input.page.cursor,
            stamp,
            input.page.cursor === null ? 0 : 1,
            input.page.cursor === null
              ? new Date(Date.parse(stamp) + 5 * 60000).toISOString()
              : stamp,
            input.account_id,
          ],
        })
      const result = { account_id: input.account_id, processed: entries.length }
      statements.push(
        audit(
          who,
          input.command_id,
          hash,
          'import',
          input.account_id,
          null,
          null,
          null,
          null,
          result,
          stamp,
        ),
      )
      try {
        await atomicStatements(database, statements)
      } catch {
        const replay = await prior(who, input.command_id, hash)
        if (replay) return replay
        fail(
          'conflict',
          'A transaction changed or was already imported with different values. Refresh and review the source.',
        )
      }
      return result
    },
    async list(
      who: BankReviewAuthority,
      input: { state?: BankDepositRow['state']; page?: number; per_page?: number } = {},
    ) {
      await authorize(who)
      const page = input.page ?? 1,
        take = input.per_page ?? 25
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(take) ||
        take < 1 ||
        take > 100
      )
        fail('invalid', 'Choose a valid page.')
      const state = input.state ?? null
      if (state && !['unmatched', 'suggested', 'confirmed', 'rejected'].includes(state))
        fail('invalid', 'Choose a valid deposit state.')
      const filter = sql`(${state} IS NULL OR CASE WHEN d.match_state='confirmed' THEN 'confirmed' WHEN r.rejected_at IS NOT NULL THEN 'rejected' ELSE d.match_state END=${state})`
      const count = (
        await database.all<{ n: number }>(
          sql`SELECT count(*) AS n FROM bank_deposits d JOIN bank_deposit_reviews r ON r.deposit_id=d.id WHERE ${filter}`,
        )
      )[0]!.n
      const ids = await database.all<{ id: number }>(
        sql`SELECT d.id FROM bank_deposits d JOIN bank_deposit_reviews r ON r.deposit_id=d.id WHERE ${filter} ORDER BY d.posted_at DESC,d.id DESC LIMIT ${take} OFFSET ${(page - 1) * take}`,
      )
      const rows = await readMany(ids.map((row) => row.id)),
        byId = new Map(rows.map((row) => [row.id, row]))
      return {
        data: ids.flatMap((row) => (byId.has(row.id) ? [byId.get(row.id)!] : [])),
        page,
        per_page: take,
        total: count,
      }
    },
    async candidates(who: BankReviewAuthority, depositId: number, query = '') {
      await authorize(who)
      const deposit = await read(depositId)
      if (!deposit) fail('not_found', 'That deposit is not available.')
      if (query.length > 80) fail('invalid', 'Search text is too long.')
      return database.all<BankReviewInvoice>(
        sql`SELECT id,number,currency,due_amount_cents,version,state FROM invoices WHERE currency=${deposit.currency} AND state IN ('open','paid') AND instr(lower(number),lower(${query}))>0 ORDER BY issue_date DESC,id DESC LIMIT 50`,
      )
    },
    async act(
      who: BankReviewAuthority,
      input: {
        command_id: string
        deposit_id: number
        expected_version: number
        operation: 'assign' | 'reject' | 'reopen' | 'verify'
        invoice_id?: number
        verification_reference?: string
      },
    ) {
      const hash = await fingerprint(input),
        old = await prior(who, input.command_id, hash)
      if (old) return read(input.deposit_id)
      const deposit = await read(input.deposit_id)
      if (!deposit) fail('not_found', 'That deposit is not available.')
      if (deposit.version !== input.expected_version || deposit.state === 'confirmed')
        fail('conflict', 'The deposit changed. Refresh before reviewing it.')
      if (input.operation === 'assign') {
        if (deposit.state === 'rejected' || !Number.isSafeInteger(input.invoice_id))
          fail('invalid', 'Reopen the deposit and select an invoice before assigning it.')
        const invoice = (
          await database.all<BankReviewInvoice>(
            sql`SELECT id,number,currency,due_amount_cents,version,state FROM invoices WHERE id=${input.invoice_id!}`,
          )
        )[0]
        if (
          !invoice ||
          invoice.currency !== deposit.currency ||
          !['open', 'paid'].includes(invoice.state)
        )
          fail('invalid', 'Choose a sent invoice in the same currency.')
      } else if (input.operation === 'verify') {
        const admin = await database.all(
          sql`SELECT id FROM users WHERE id=${who.userId} AND profile='administrator'`,
        )
        if (!admin.length)
          fail('forbidden', 'Only administrators can attest uncertain source funds.')
        if (
          !['unknown', 'final'].includes(deposit.source_status) ||
          deposit.classification === 'internal_transfer'
        )
          fail('invalid', 'Only an uncertain external credit can be verified by an operator.')
        clean(input.verification_reference, 200)
      } else if (input.operation === 'reopen' && deposit.state !== 'rejected')
        fail('conflict', 'Only a rejected deposit can be reopened.')
      const stamp = now(),
        statements = [
          whoGuard(who),
          guard(
            `EXISTS(SELECT 1 FROM bank_deposit_reviews r JOIN bank_deposits d ON d.id=r.deposit_id WHERE r.deposit_id=? AND r.version=? AND d.match_state<>'confirmed')`,
            [deposit.id, deposit.version],
          ),
        ]
      if (input.operation === 'verify') {
        statements.push(
          guard("EXISTS(SELECT 1 FROM users WHERE id=? AND profile='administrator')", [who.userId]),
        )
        statements.push({
          text: 'UPDATE bank_deposit_reviews SET verified_at=?,verified_by_user_id=?,verification_reference=?,version=version+1 WHERE deposit_id=? RETURNING deposit_id',
          params: [stamp, who.userId, input.verification_reference!, deposit.id],
        })
      } else if (input.operation === 'assign')
        statements.push({
          text: `UPDATE bank_deposits SET match_state='suggested',suggested_invoice_id=?,updated_at=? WHERE id=? RETURNING id`,
          params: [input.invoice_id!, stamp, deposit.id],
        })
      else {
        statements.push({
          text: `UPDATE bank_deposit_reviews SET rejected_at=?,rejected_by_user_id=? WHERE deposit_id=? RETURNING deposit_id`,
          params: [
            input.operation === 'reject' ? stamp : null,
            input.operation === 'reject' ? who.userId : null,
            deposit.id,
          ],
        })
        statements.push({
          text: `UPDATE bank_deposits SET match_state='unmatched',suggested_invoice_id=NULL,updated_at=? WHERE id=? RETURNING id`,
          params: [stamp, deposit.id],
        })
      }
      statements.push(
        audit(
          who,
          input.command_id,
          hash,
          input.operation,
          deposit.account_id,
          deposit.id,
          input.invoice_id ?? null,
          deposit.version,
          deposit.version + 1,
          { deposit_id: deposit.id },
          stamp,
        ),
      )
      try {
        await atomicStatements(database, statements)
      } catch {
        const replay = await prior(who, input.command_id, hash)
        if (!replay)
          fail('conflict', 'The deposit or your authority changed. Refresh before retrying.')
      }
      return read(deposit.id)
    },
    async confirm(
      who: BankReviewAuthority,
      input: {
        command_id: string
        deposit_id: number
        expected_version: number
        invoice_id: number
        expected_invoice_version: number
        confirm_overpayment: boolean
      },
    ) {
      const hash = await fingerprint(input),
        old = await prior(who, input.command_id, hash)
      if (old) return read(input.deposit_id)
      const deposit = await read(input.deposit_id)
      if (!deposit) fail('not_found', 'That deposit is not available.')
      if (
        deposit.version !== input.expected_version ||
        deposit.state !== 'suggested' ||
        deposit.suggested_invoice?.id !== input.invoice_id
      )
        fail('conflict', 'The deposit or selected invoice changed. Refresh before confirming.')
      if (!deposit.confirmation_ready)
        fail('conflict', 'The provider has not verified this as a settled external credit.')
      const invoice = deposit.suggested_invoice
      if (invoice.version !== input.expected_invoice_version)
        fail('conflict', 'The invoice balance changed. Refresh before confirming.')
      if (deposit.amount_cents > invoice.due_amount_cents && !input.confirm_overpayment)
        fail(
          'overpayment',
          'Explicitly confirm that the whole deposit exceeds the invoice balance.',
        )
      const raw = (
        await database.all<{ updated_at: string; match_state: 'suggested' }>(
          sql`SELECT updated_at,match_state FROM bank_deposits WHERE id=${deposit.id}`,
        )
      )[0]!
      let permit = (
        await database.all<{
          fingerprint: string
          actor_user_id: number
          payment_id: number
          occurred_at: string
        }>(
          sql`SELECT fingerprint,actor_user_id,payment_id,occurred_at FROM bank_deposit_confirmation_permits WHERE command_id=${input.command_id}`,
        )
      )[0]
      if (permit && (permit.fingerprint !== hash || permit.actor_user_id !== who.userId))
        fail('conflict', 'That command identity was already used.')
      if (!permit) {
        const paymentId = (
            await database.all<{ id: number }>(
              sql`SELECT max(value)+1 AS id FROM (SELECT coalesce(max(id),0) AS value FROM invoice_payments UNION ALL SELECT coalesce(max(payment_id),0) AS value FROM bank_deposit_confirmation_permits)`,
            )
          )[0]!.id,
          stamp = now()
        try {
          await atomicStatements(database, [
            whoGuard(who),
            guard(
              `EXISTS(SELECT 1 FROM bank_deposit_reviews r JOIN bank_deposits d ON d.id=r.deposit_id JOIN invoices i ON i.id=d.suggested_invoice_id WHERE r.deposit_id=? AND r.version=? AND r.rejected_at IS NULL AND d.match_state='suggested' AND i.id=? AND i.version=?)`,
              [deposit.id, deposit.version, invoice.id, invoice.version],
            ),
            {
              text: `INSERT INTO bank_deposit_confirmation_permits(command_id,fingerprint,deposit_id,invoice_id,payment_id,expected_version,expected_invoice_version,expected_updated_at,actor_user_id,session_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING RETURNING command_id`,
              params: [
                input.command_id,
                hash,
                deposit.id,
                invoice.id,
                paymentId,
                deposit.version,
                invoice.version,
                raw.updated_at,
                who.userId,
                who.sessionId,
                stamp,
              ],
            },
          ])
        } catch {
          fail('conflict', 'The deposit or authority changed before confirmation.')
        }
        permit = (
          await database.all<typeof permit & object>(
            sql`SELECT fingerprint,actor_user_id,payment_id,occurred_at FROM bank_deposit_confirmation_permits WHERE command_id=${input.command_id}`,
          )
        )[0]
      }
      if (permit) {
        await database.run(sql`UPDATE bank_deposit_confirmation_permits SET payment_id=(SELECT max(value)+1 FROM (SELECT coalesce(max(id),0) AS value FROM invoice_payments UNION ALL SELECT coalesce(max(payment_id),0) AS value FROM bank_deposit_confirmation_permits))
          WHERE command_id=${input.command_id} AND fingerprint=${hash} AND EXISTS(SELECT 1 FROM invoice_payments p WHERE p.id=bank_deposit_confirmation_permits.payment_id)
          AND NOT EXISTS(SELECT 1 FROM invoice_command_ledger l WHERE l.invoice_id=bank_deposit_confirmation_permits.invoice_id AND l.command_id=bank_deposit_confirmation_permits.command_id)
          AND NOT EXISTS(SELECT 1 FROM bank_deposit_audit a WHERE a.command_id=bank_deposit_confirmation_permits.command_id)`)
        permit = (
          await database.all<typeof permit>(
            sql`SELECT fingerprint,actor_user_id,payment_id,occurred_at FROM bank_deposit_confirmation_permits WHERE command_id=${input.command_id}`,
          )
        )[0]
      }
      if (!permit || permit.fingerprint !== hash || permit.actor_user_id !== who.userId)
        fail('conflict', 'The confirmation changed. Refresh before retrying.')
      try {
        await recordInvoicePayment(database, {
          invoiceId: invoice.id,
          commandId: input.command_id,
          actor: { type: 'user', id: who.userId },
          authorize: async () => {
            await authorize(who)
            return true
          },
          expectedVersion: input.expected_invoice_version,
          occurredAt: permit.occurred_at,
          eventIds: [input.command_id + '-recorded', input.command_id + '-settled'],
          payment: {
            type: 'bank_deposit',
            id: permit.payment_id,
            depositId: deposit.id,
            expectedDepositUpdatedAt: raw.updated_at,
            expectedMatchState: 'suggested',
            paidAt: deposit.posted_at,
            recordedByUserId: who.userId,
          },
        })
      } catch (error) {
        const completed = await prior(who, input.command_id, hash)
        if (!completed) {
          if (error instanceof BankDepositReviewError) throw error
          fail(
            'conflict',
            'The deposit, invoice or authority changed during confirmation. Refresh before retrying.',
          )
        }
      }
      return read(deposit.id)
    },
  }
}

/** Trusted runtime-only ingestion port. Never expose this object as a request service. */
export const createBankDepositIngestionService = (database: InvoiceStateDatabase) => {
  const service = createBankDepositReviewService(database)
  return {
    async ensureAccount(input: {
      provider: 'mercury' | 'wise'
      externalAccountId: string
      name: string
    }) {
      const rows = await database.all<BankFeedAccount>(
        sql`SELECT a.id,a.provider,a.display_name AS name FROM payment_provider_accounts a JOIN bank_feed_accounts b ON b.provider_account_id=a.id WHERE a.provider=${input.provider} AND a.external_account_id=${input.externalAccountId}`,
      )
      if (rows[0]) return rows[0]
      try {
        return await service.createAccount(feedAuthority, {
          provider: input.provider,
          name: input.name,
          external_account_id: input.externalAccountId,
          command_id:
            'feed-account-' + (await fingerprint([input.provider, input.externalAccountId])),
        })
      } catch (error) {
        const existing = await database.all<BankFeedAccount>(
          sql`SELECT a.id,a.provider,a.display_name AS name FROM payment_provider_accounts a JOIN bank_feed_accounts b ON b.provider_account_id=a.id WHERE a.provider=${input.provider} AND a.external_account_id=${input.externalAccountId}`,
        )
        if (existing[0]) return existing[0]
        throw error
      }
    },
    async findAccount(provider: string, key: string) {
      return (
        (
          await database.all<{
            id: number
            name: string
            last_synced_at: string | null
            last_error: string | null
            next_poll_at: string | null
          }>(
            sql`SELECT a.id,a.display_name AS name,b.last_synced_at,b.last_error,b.next_poll_at FROM payment_provider_accounts a JOIN bank_feed_accounts b ON b.provider_account_id=a.id WHERE a.provider=${provider} AND a.external_account_id=${key}`,
          )
        )[0] ?? null
      )
    },
    async claim(accountId: number, holder: string, at: string) {
      return (
        (
          await database.all<{
            cursor: string | null
            version: number
            scan_from: string
            scan_to: string
          }>(sql`UPDATE bank_feed_accounts SET lease_holder=${holder},lease_expires_at=${new Date(Date.parse(at) + 60000).toISOString()},
        scan_from=CASE WHEN scan_active=0 THEN ${new Date(Date.parse(at) - 30 * 86400000).toISOString()} ELSE scan_from END,
        scan_to=CASE WHEN scan_active=0 THEN ${at} ELSE scan_to END,
        version=version+CASE WHEN scan_active=0 THEN 1 ELSE 0 END,scan_active=1
        WHERE provider_account_id=${accountId} AND (next_poll_at IS NULL OR next_poll_at<=${at}) AND (lease_holder IS NULL OR lease_expires_at<=${at})
        RETURNING cursor,version,scan_from,scan_to`)
        )[0] ?? null
      )
    },
    async release(accountId: number, holder: string, error: string | null, at: string) {
      await database.run(sql`UPDATE bank_feed_accounts SET lease_holder=NULL,lease_expires_at=NULL,
        last_error=CASE WHEN ${error} IS NULL THEN last_error ELSE ${error} END,
        next_poll_at=CASE WHEN ${error} IS NULL THEN next_poll_at ELSE ${new Date(Date.parse(at) + 60000).toISOString()} END
        WHERE provider_account_id=${accountId} AND lease_holder=${holder}`)
    },
    async state(accountId: number) {
      return (
        (
          await database.all<{ cursor: string | null; version: number }>(
            sql`SELECT cursor,version FROM bank_feed_accounts WHERE provider_account_id=${accountId}`,
          )
        )[0] ?? null
      )
    },
    ingest: (input: {
      command_id: string
      account_id: number
      deposits: NeutralDeposit[]
      observations?: Record<string, BankDepositObservation>
      page?: { expected_version: number; cursor: string | null; holder?: string }
    }) => service.ingest(feedAuthority, input),
  }
}
