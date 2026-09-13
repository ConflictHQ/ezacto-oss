import { calculateInvoiceLineAmountCents } from '@ezacto/core'
import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  assertRecurringAmountConfig,
  type RecurringAmountConfig,
  type RecurringFixedLinesConfigV1,
} from './recurring-invoices.js'
import { assertStaticRecurringAttachmentPolicy } from './attachments.js'

type ContainerDatabase = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database
}

type WorkerDatabase = DrizzleD1Database<typeof schema> & {
  $client: D1Database
}

export type RecurringEngineDatabase = ContainerDatabase | WorkerDatabase

export type RecurringEngineErrorCode =
  | 'invalid_definition'
  | 'not_due'
  | 'already_generated'
  | 'retainer_overdraw'
  | 'forbidden'
  | 'definition_not_found'

export class RecurringEngineError extends Error {
  readonly code: RecurringEngineErrorCode

  constructor(code: RecurringEngineErrorCode, message: string) {
    super(message)
    this.name = 'RecurringEngineError'
    this.code = code
  }
}

export interface RecurringGenerationUserPrincipal {
  type: 'user'
  userId: number
  profile: string
}

/**
 * The scheduled pass, which has no person behind it.
 *
 * The alternative was to let the schedule borrow a user id -- the account
 * owner, or whoever last edited the definition -- and that is the one thing
 * that cannot be allowed here. `invoice_command_ledger` is the audit trail of a
 * document that goes to a client, and a name in it that did not act is a lie
 * that reads as a fact. The schema has always modelled the honest answer: its
 * CHECK permits `actor_type = 'system' AND actor_id IS NULL`, and until the
 * daily cron existed nothing ever wrote that branch.
 *
 * It carries no fields because there is nothing to authorize. Authority for a
 * system run is the cron trigger itself, which is not reachable from a request.
 */
export interface RecurringGenerationSystemPrincipal {
  type: 'system'
}

export type RecurringGenerationPrincipal =
  | RecurringGenerationUserPrincipal
  | RecurringGenerationSystemPrincipal

export interface RecurringGenerationResult {
  invoiceId: number
  definitionId: number
  period: string
  nextIssueOn: string
  retainerDrawdownCents: number | null
}

interface SqlStatement {
  text: string
  params: Array<string | number | null>
}

interface StoredDefinition {
  id: number
  clientId: number
  definitionStatus: string
  subjectTemplate: string | null
  notesTemplate: string | null
  everyNMonths: number | null
  dayOfMonth: number | null
  nextIssueOn: string | null
  amountConfig: string | null
  attachmentPolicy: string | null
  /** JSON array of project ids whose unbilled time this flat amount consumes. */
  claimsProjectIds: string | null
  canDrawFromRetainerId: number | null
}

interface ClientDefaults {
  id: number
  currency: string
  paymentTerms: 'upon_receipt' | 'net_15' | 'net_30' | 'net_45' | 'net_60' | 'custom'
}

const centsLimit = 9_000_000_000_000
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const moneyProfiles = new Set(['accounting', 'executive_manager', 'administrator'])

const assertTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  if (match === null) throw new RecurringEngineError('invalid_definition', 'clock must return a canonical UTC timestamp')
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(
    match[7] ?? ''
  ).padEnd(3, '0')}Z`
  const instant = Date.parse(normalized)
  if (!Number.isSafeInteger(instant) || new Date(instant).toISOString() !== normalized) {
    throw new RecurringEngineError('invalid_definition', 'clock must return a real canonical UTC timestamp')
  }
}

export const anchoredDate = (dayOfMonth: number, year: number, month: number): string => {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(dayOfMonth, lastDay)
  const pad = (n: number, w: number) => String(n).padStart(w, '0')
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

export const advanceIssueDate = (
  nextIssueOn: string,
  everyNMonths: number,
  dayOfMonth: number,
): string => {
  const [yearStr, monthStr] = nextIssueOn.split('-')
  let year = Number(yearStr)
  let month = Number(monthStr) + everyNMonths
  while (month > 12) {
    month -= 12
    year += 1
  }
  return anchoredDate(dayOfMonth, year, month)
}

const digest = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const stableId = async (namespace: string, key: string, suffix = ''): Promise<number> =>
  Number.parseInt((await digest(`${namespace}\u001f${key}\u001f${suffix}`)).slice(0, 13), 16) + 1

const idempotencyKey = (definitionId: number, period: string): string =>
  `recurring:${definitionId}:${period}`

const isD1Client = (client: BetterSqlite3.Database | D1Database): client is D1Database =>
  'batch' in client

const first = async <T>(
  database: RecurringEngineDatabase,
  statement: SqlStatement,
): Promise<T | null> => {
  const client = database.$client
  if (isD1Client(client)) {
    return (
      (await client
        .prepare(statement.text)
        .bind(...statement.params)
        .first<T>()) ?? null
    )
  }
  return (client.prepare(statement.text).get(...statement.params) as T | undefined) ?? null
}

const all = async <T>(
  database: RecurringEngineDatabase,
  statement: SqlStatement,
): Promise<T[]> => {
  const client = database.$client
  if (isD1Client(client)) {
    return (
      await client
        .prepare(statement.text)
        .bind(...statement.params)
        .all<T>()
    ).results
  }
  return client.prepare(statement.text).all(...statement.params) as T[]
}

const runAtomic = async (
  database: RecurringEngineDatabase,
  statements: readonly SqlStatement[],
): Promise<void> => {
  const client = database.$client
  if (isD1Client(client)) {
    await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return
  }
  client
    .transaction(() => {
      for (const statement of statements) client.prepare(statement.text).run(...statement.params)
    })
    .immediate()
}

/**
 * The issue-date tokens, expanded wherever an operator can write them.
 *
 * This applied to the subject alone, and the line descriptions were copied
 * through verbatim -- which is wrong for exactly the definitions this product
 * exists to carry across. A migrated client line reads "for the month of
 * September 2026"; frozen, every invoice it raises from October onwards names
 * September, to a client, monthly, with nothing failing. Harvest expands them
 * in descriptions, so a definition brought over from Harvest arrives expecting
 * it to.
 */
/**
 * Which payment of a finite run this issue is, so a line can count itself off:
 * "CREDIT 2 of 4".
 *
 * A definition records when a line *stops* (`through`) and never when it
 * started, so the position is derived backwards -- the total less the issues
 * still to come, which a fixed cadence makes countable. Deriving it forwards
 * would mean storing a start date the agreement never had, purely to count.
 *
 * Null when the arithmetic cannot be trusted: a `through` already behind the
 * issue date, or a run that works out longer than its own total. The caller
 * leaves the token unsubstituted in that case, because a visible
 * `%line_installment_number%` is a bug someone fixes, and "CREDIT 5 of 4" on an
 * invoice is a bug the client reads first.
 */
const installmentPosition = (
  through: string,
  issueDate: string,
  everyNMonths: number,
  installments: number,
): number | null => {
  const months =
    (Number(through.slice(0, 4)) - Number(issueDate.slice(0, 4))) * 12 +
    (Number(through.slice(5, 7)) - Number(issueDate.slice(5, 7)))
  if (!Number.isFinite(months) || months < 0) return null
  const remaining = Math.floor(months / everyNMonths)
  const position = installments - remaining
  return position >= 1 && position <= installments ? position : null
}

interface InstallmentContext {
  readonly position: number
  readonly total: number
}

const templateTokens = (
  template: string,
  issueDate: string,
  installment: InstallmentContext | null = null,
): string => {
  const date = new Date(`${issueDate}T00:00:00.000Z`)
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return template
    .replace(/%invoice_issue_month_name%/g, monthNames[date.getUTCMonth()]!)
    .replace(/%invoice_issue_year%/g, String(date.getUTCFullYear()))
    .replace(/%invoice_issue_date%/g, issueDate)
    .replace(/%line_installment_number%/g, (token) =>
      installment === null ? token : String(installment.position),
    )
    .replace(/%line_installment_total%/g, (token) =>
      installment === null ? token : String(installment.total),
    )
}

const dueDate = (issueDate: string, terms: ClientDefaults['paymentTerms']): string => {
  const days =
    terms === 'net_15'
      ? 15
      : terms === 'net_30'
        ? 30
        : terms === 'net_45'
          ? 45
          : terms === 'net_60'
            ? 60
            : 0
  const value = new Date(`${issueDate}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

const checkedSum = (values: readonly number[]): number => {
  const sum = values.reduce((total, value) => total + BigInt(value), 0n)
  if (sum < 0n || sum > BigInt(centsLimit)) {
    throw new RecurringEngineError('invalid_definition', 'generated line amounts exceed the invoice cents limit')
  }
  return Number(sum)
}

export interface RecurringEngineOptions {
  clock?: () => string
}

export interface RecurringGenerationFailure {
  definitionId: number
  /** Null for a failure the engine did not raise itself. */
  code: RecurringEngineErrorCode | null
  message: string
}

export interface RecurringGenerationSweep {
  generated: RecurringGenerationResult[]
  failed: RecurringGenerationFailure[]
}

export interface RecurringInvoiceEngine {
  generate(
    definitionId: number,
    asOfDate: string,
    principal: RecurringGenerationPrincipal,
  ): Promise<RecurringGenerationResult>
  generateDue(
    asOfDate: string,
    principal: RecurringGenerationPrincipal,
  ): Promise<RecurringGenerationSweep>
}

export const createRecurringInvoiceEngine = (
  database: RecurringEngineDatabase,
  options: RecurringEngineOptions = {},
): RecurringInvoiceEngine => ({
  async generate(definitionId, asOfDate, principal) {
    // Only a user has anything to authorize. A system run is reached from the
    // cron and from nowhere else, so there is no claim to check against a row;
    // checking one would mean inventing a user for it, which is precisely what
    // the system branch exists to avoid.
    if (principal.type === 'user') {
      const actor = await first<{ profile: string }>(database, {
        text: 'SELECT profile FROM users WHERE id = ? AND is_active = 1',
        params: [principal.userId],
      })
      if (
        actor === null ||
        actor.profile !== principal.profile ||
        !moneyProfiles.has(actor.profile)
      ) {
        throw new RecurringEngineError('forbidden', 'the acting user cannot generate recurring invoices')
      }
    }
    const actorId = principal.type === 'user' ? principal.userId : null

    const definition = await first<StoredDefinition>(database, {
      text: `SELECT id, client_id AS "clientId", definition_status AS "definitionStatus",
          subject_template AS "subjectTemplate", notes_template AS "notesTemplate",
          every_n_months AS "everyNMonths", day_of_month AS "dayOfMonth",
          next_issue_on AS "nextIssueOn", amount_config AS "amountConfig",
          attachment_policy AS "attachmentPolicy",
          claims_project_ids AS "claimsProjectIds",
          can_draw_from_retainer_id AS "canDrawFromRetainerId"
        FROM recurring_invoices WHERE id = ?`,
      params: [definitionId],
    })
    if (definition === null) {
      throw new RecurringEngineError('definition_not_found', `recurring invoice definition ${definitionId} does not exist`)
    }
    if (definition.definitionStatus !== 'complete') {
      throw new RecurringEngineError('invalid_definition', 'definition is incomplete')
    }
    if (
      definition.subjectTemplate === null ||
      definition.everyNMonths === null ||
      definition.dayOfMonth === null ||
      definition.nextIssueOn === null ||
      definition.amountConfig === null
    ) {
      throw new RecurringEngineError('invalid_definition', 'complete definition has null required fields')
    }
    // Captured at the guard: the narrowing above does not survive the awaits
    // between here and the line rendering, and re-checking there would be a
    // second guard for a fact already established.
    const everyNMonths = definition.everyNMonths

    let parsedConfig: unknown
    try {
      parsedConfig = JSON.parse(definition.amountConfig)
    } catch {
      throw new RecurringEngineError('invalid_definition', 'amountConfig is not valid JSON')
    }
    assertRecurringAmountConfig(parsedConfig)

    if (definition.attachmentPolicy !== null) {
      let parsedPolicy: unknown
      try {
        parsedPolicy = JSON.parse(definition.attachmentPolicy)
      } catch {
        throw new RecurringEngineError('invalid_definition', 'attachmentPolicy is not valid JSON')
      }
      assertStaticRecurringAttachmentPolicy(parsedPolicy)
    }

    if (definition.nextIssueOn > asOfDate) {
      // Nothing new is due — but the cycle that just ran may be exactly what the
      // caller is retrying. Generation advances nextIssueOn, so by the time a
      // retry arrives the period it targeted is no longer derivable from the
      // definition; it has to be recovered from the ledger. Without this a retry
      // gets `not_due` and the idempotency branch below is unreachable.
      const previous = await first<{ completed: number | boolean; invoiceId: number; period: string }>(
        database,
        {
          text: `SELECT completed, invoice_id AS "invoiceId",
              json_extract(request_json, '$.period') AS period
            FROM invoice_command_ledger
            WHERE command_kind = 'recurring.generate'
              AND json_extract(request_json, '$.definition_id') = ?
              AND json_extract(request_json, '$.period') <= ?
            ORDER BY json_extract(request_json, '$.period') DESC
            LIMIT 1`,
          params: [definitionId, asOfDate],
        },
      )
      if (
        previous !== null &&
        previous.completed &&
        advanceIssueDate(previous.period, definition.everyNMonths, definition.dayOfMonth) ===
          definition.nextIssueOn
      ) {
        return {
          invoiceId: previous.invoiceId,
          definitionId,
          period: previous.period,
          nextIssueOn: definition.nextIssueOn,
          retainerDrawdownCents: null,
        }
      }
      throw new RecurringEngineError('not_due', `definition ${definitionId} is not due until ${definition.nextIssueOn}`)
    }

    const period = definition.nextIssueOn
    const commandId = idempotencyKey(definitionId, period)
    const invoiceId = await stableId('recurring-generation', commandId)

    const existing = await first<{ completed: number | boolean; invoiceId: number }>(database, {
      text: `SELECT completed, invoice_id AS "invoiceId"
        FROM invoice_command_ledger WHERE command_id = ?`,
      params: [commandId],
    })
    if (existing !== null) {
      if (existing.completed) {
        const nextIssueOn = advanceIssueDate(period, definition.everyNMonths, definition.dayOfMonth)
        return {
          invoiceId: existing.invoiceId,
          definitionId,
          period,
          nextIssueOn,
          retainerDrawdownCents: null,
        }
      }
      throw new RecurringEngineError('already_generated', 'recurring generation command is in progress')
    }

    const client = await first<ClientDefaults>(database, {
      text: `SELECT id, upper(currency) AS currency, payment_terms AS "paymentTerms"
        FROM clients WHERE id = ?`,
      params: [definition.clientId],
    })
    if (client === null) {
      throw new RecurringEngineError('invalid_definition', 'the definition client does not exist')
    }

    const amountConfig = parsedConfig as RecurringAmountConfig
    if (amountConfig.type !== 'fixed_lines') {
      throw new RecurringEngineError(
        'invalid_definition',
        'only fixed_lines recurring invoices can be generated in this release',
      )
    }

    const fixedConfig = amountConfig as RecurringFixedLinesConfigV1
    const issueDate = period
    const subject = templateTokens(definition.subjectTemplate, issueDate)
    const notes = definition.notesTemplate ?? ''

    // A line with a `through` date stops appearing once the issue date passes
    // it. Compared as strings because both are ISO calendar dates, which sort
    // lexicographically -- parsing them into Dates here would introduce a
    // timezone where the agreement has none.
    //
    // Positions are assigned after the filter, so a surviving line does not
    // inherit a gap from one that expired: an invoice's lines are numbered 0, 1,
    // 2 whatever stopped before it.
    const live = fixedConfig.line_items.filter(
      // Absent and null both mean "repeats indefinitely" -- a line written
      // before this key existed says nothing about stopping, which is the same
      // as saying it does not.
      (item) => item.through === null || item.through === undefined || item.through >= issueDate,
    )
    if (live.length === 0) {
      // Every line has expired. Issuing an empty invoice would be worse than
      // issuing nothing -- it reaches the client as a demand for zero -- and
      // silently skipping would leave a definition that looks live and never
      // produces. The definition needs a person.
      throw new RecurringEngineError(
        'invalid_definition',
        'every line on this definition has passed its through date',
      )
    }
    const lines = live.map((item, position) => {
      const amountCents = calculateInvoiceLineAmountCents(item.quantity, item.unit_price_cents)
      // A null description stays null rather than becoming an empty string: the
      // column is nullable and "no description" is not the same fact as "".
      // Only a line that carries both a total and an end can count itself; the
      // config validator already refuses one without the other, so this is the
      // absent case, not a half-configured one.
      const installment: InstallmentContext | null =
        item.installments === null ||
        item.installments === undefined ||
        item.through === null ||
        item.through === undefined
          ? null
          : ((position) => (position === null ? null : { position, total: item.installments! }))(
              installmentPosition(item.through, issueDate, everyNMonths, item.installments),
            )
      const description =
        item.description === null
          ? null
          : templateTokens(item.description, issueDate, installment)
      return { ...item, description, position, amountCents }
    })
    const totalAmountCents = checkedSum(lines.map((l) => l.amountCents))

    const occurredAt = (options.clock ?? (() => new Date().toISOString()))()
    assertTimestamp(occurredAt)

    const fingerprint = `sha256:${await digest(
      JSON.stringify({
        command_id: commandId,
        definition_id: definitionId,
        period,
        amount_config_type: amountConfig.type,
      }),
    )}`

    const eventId = `evt_${await digest(`recurring-generation-event\u001f${commandId}`)}`
    const nextIssueOn = advanceIssueDate(period, definition.everyNMonths, definition.dayOfMonth)

    let retainerDrawdownCents: number | null = null
    const statements: SqlStatement[] = []

    // The ledger row is written before the invoice exists, so the line manifest
    // has to name ids the lines will be inserted with (migration 0037).
    const lineIds = await Promise.all(
      lines.map((_, index) =>
        stableId('recurring-generation-line', commandId, String(index)),
      ),
    )
    const lineManifestJson = JSON.stringify({
      schema_version: 1,
      lines: lines.map((line, index) => ({
        id: lineIds[index]!,
        position: line.position,
        kind: line.kind,
        description: line.description,
        quantity: line.quantity,
        unit_price_cents: line.unit_price_cents,
        amount_cents: line.amountCents,
        project_id: line.project_id,
      })),
    })
    const requestJson = JSON.stringify({
      schema_version: 1,
      expected_version: 0,
      definition_id: definitionId,
      client_id: definition.clientId,
      period,
      day_of_month: definition.dayOfMonth,
      every_n_months: definition.everyNMonths,
      currency: client.currency,
      amount_cents: totalAmountCents,
      line_count: lines.length,
    })

    statements.push({
      text: `INSERT INTO invoice_command_ledger (
          invoice_id, command_id, command_kind, input_fingerprint, actor_type, actor_id,
          expected_invoice_version, occurred_at, request_json, line_manifest_json
        ) VALUES (?, ?, 'recurring.generate', ?, ?, ?, 0, ?, ?, ?)`,
      params: [
        invoiceId,
        commandId,
        fingerprint,
        principal.type,
        actorId,
        occurredAt,
        requestJson,
        lineManifestJson,
      ],
    })

    const projectId = lines.length === 1 && lines[0]!.project_id !== null ? lines[0]!.project_id : null

    // The acting user is re-checked here as well as at the top, so that a
    // deactivation between the two cannot still put an invoice in front of a
    // client. A system run has no row to re-check, so the clause is left out
    // rather than folded into one that also passes when the actor is null --
    // that version would silently start passing for a user whose id no longer
    // resolves, which is the case it was written to catch.
    const actorGuard =
      principal.type === 'user'
        ? `AND EXISTS (
            SELECT 1 FROM users WHERE id = ? AND is_active = 1
              AND profile IN ('accounting','executive_manager','administrator')
          )`
        : ''

    statements.push({
      text: `INSERT INTO invoices (
          id, client_id, created_by_user_id, number, subject, notes, currency,
          issue_date, due_date, payment_terms, recurring_invoice_id, retainer_id,
          project_id, created_at, updated_at
        ) SELECT ?, ?, ?, CAST(sequence.next_number AS TEXT), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM invoice_number_sequence sequence
        WHERE sequence.singleton = 1
          ${actorGuard}
          AND EXISTS (SELECT 1 FROM clients WHERE id = ?)
          AND EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'recurring.generate'
              AND command.completed = 0
          )`,
      params: [
        invoiceId,
        definition.clientId,
        actorId,
        subject,
        notes,
        client.currency,
        issueDate,
        dueDate(issueDate, client.paymentTerms),
        client.paymentTerms,
        definitionId,
        // A drawdown's invoice must link the retainer it draws from; the ledger
        // trigger requires invoice.retainer_id to match the movement's.
        definition.canDrawFromRetainerId,
        projectId,
        occurredAt,
        occurredAt,
        ...(principal.type === 'user' ? [principal.userId] : []),
        definition.clientId,
        invoiceId,
        commandId,
      ],
    })

    for (const [index, line] of lines.entries()) {
      const lineId = lineIds[index]!
      statements.push({
        text: `INSERT INTO invoice_line_items (
            id, invoice_id, position, kind, description, quantity, unit_price_cents,
            amount_cents, taxed, taxed2, project_id, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'recurring.generate' AND command.completed = 0
          )`,
        params: [
          lineId,
          invoiceId,
          line.position,
          line.kind,
          line.description,
          line.quantity,
          line.unit_price_cents,
          line.amountCents,
          line.taxed ? 1 : 0,
          line.taxed2 ? 1 : 0,
          line.project_id,
          occurredAt,
          occurredAt,
          invoiceId,
          commandId,
        ],
      })
    }

    // A banded engagement: the flat amount consumes the work rather than pricing
    // it (issue 484). Two statements, in this order and inside the same batch as
    // everything else, so a generation that fails leaves neither.
    //
    // Everything still unbilled on the named projects up to the issue date,
    // rather than a period window. A window would have to be guessed -- an
    // invoice issued on the 10th could mean the calendar month before it or the
    // rolling month ending that day -- and guessing wrong either double-bills a
    // week or leaves one stranded. "Whatever the band has not covered yet" needs
    // no such guess and cannot strand anything.
    if (definition.claimsProjectIds !== null) {
      statements.push({
        text: `UPDATE time_entries SET invoice_id = ?
          WHERE invoice_id IS NULL AND billable = 1
            AND timer_started_at IS NULL
            AND NOT (started_time IS NOT NULL AND ended_time IS NULL)
            AND spent_date <= ?
            AND project_id IN (
              SELECT CAST(member.value AS INTEGER) FROM json_each(?) member
            )
            AND EXISTS (
              SELECT 1 FROM invoice_command_ledger command
              WHERE command.invoice_id = ? AND command.command_id = ?
                AND command.command_kind = 'recurring.generate'
                AND command.completed = 0
            )`,
        params: [
          invoiceId,
          issueDate,
          definition.claimsProjectIds,
          invoiceId,
          commandId,
        ],
      })

      // What the band absorbed: billable value delivered and never charged.
      // Deliberately not `written_off_cents` -- that is settlement, and this
      // client owes and pays the whole flat amount. Recording it there would
      // make a fully collectible invoice read as partly written off and would
      // block returning it to draft.
      //
      // Runs after the line items, because it reads the invoice total the line
      // triggers maintain.
      statements.push({
        text: `UPDATE invoices SET foregone_billable_cents = max(
            0,
            coalesce((
              SELECT sum(CAST(ROUND(
                coalesce(entry.rounded_seconds, entry.seconds)
                  * coalesce(entry.billable_rate_cents, 0) / 3600.0
              ) AS INTEGER))
              FROM time_entries entry WHERE entry.invoice_id = invoices.id
            ), 0) - invoices.amount_cents
          )
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM invoice_command_ledger command
            WHERE command.invoice_id = ? AND command.command_id = ?
              AND command.command_kind = 'recurring.generate'
              AND command.completed = 0
          )`,
        params: [invoiceId, invoiceId, commandId],
      })
    }

    if (definition.canDrawFromRetainerId !== null) {
      const balance = await first<{ balance: number; denomination: string }>(database, {
        text: `SELECT balance, denomination FROM retainer_balances WHERE retainer_id = ?`,
        params: [definition.canDrawFromRetainerId],
      })
      if (balance !== null && balance.denomination === 'money' && balance.balance > 0) {
        retainerDrawdownCents = Math.min(totalAmountCents, balance.balance)
        if (retainerDrawdownCents > 0) {
          const ledgerId = `recurring:${definitionId}:${period}:drawdown`
          statements.push({
            text: `INSERT INTO retainer_ledger (
                id, retainer_id, kind, unit, amount, invoice_id, occurred_on, notes, created_at
              ) SELECT ?, ?, 'drawdown', 'cents', ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM invoice_command_ledger command
                WHERE command.invoice_id = ? AND command.command_id = ?
                  AND command.command_kind = 'recurring.generate' AND command.completed = 0
              )`,
            params: [
              ledgerId,
              definition.canDrawFromRetainerId,
              -retainerDrawdownCents,
              invoiceId,
              issueDate,
              `Recurring invoice generation for period ${period}`,
              occurredAt,
              invoiceId,
              commandId,
            ],
          })
        }
      }
    }

    const eventPayload = JSON.stringify({
      schema_version: 1,
      event_id: eventId,
      event_type: 'invoice.created',
      occurred_at: occurredAt,
      aggregate: { type: 'invoice', id: invoiceId, sequence: 0 },
      command: { id: commandId, kind: 'recurring.generate', event_index: 0 },
      actor: { type: principal.type, id: actorId },
      trigger: { type: 'recurring_invoice', id: definitionId },
      invoice: {
        before: null,
        after: {
          version: 0,
          updated_at: occurredAt,
          state: 'draft',
          close_reason: null,
          close_write_off_cents: 0,
          sent_at: null,
          paid_at: null,
          paid_date: null,
          closed_at: null,
          amount_cents: totalAmountCents,
          due_amount_cents: totalAmountCents,
          written_off_cents: 0,
          payment_count: 0,
          payment_status: 'unpaid',
        },
      },
    })

    statements.push({
      text: `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence, event_type,
          command_id, event_index, payload_json, occurred_at, available_at
        ) SELECT ?, 'invoice', ?, sequence.next_sequence, 'invoice.created', ?, 0,
          json_set(?, '$.aggregate.sequence', sequence.next_sequence), ?, ?
        FROM (
          SELECT COALESCE(MAX(aggregate_sequence), 0) + 1 AS next_sequence
          FROM event_outbox WHERE aggregate_type = 'invoice' AND aggregate_id = ?
        ) sequence
        WHERE EXISTS (
          SELECT 1 FROM invoice_command_ledger command
          WHERE command.invoice_id = ? AND command.command_id = ?
            AND command.command_kind = 'recurring.generate' AND command.completed = 0
        )`,
      params: [
        eventId,
        invoiceId,
        commandId,
        eventPayload,
        occurredAt,
        occurredAt,
        invoiceId,
        invoiceId,
        commandId,
      ],
    })

    statements.push({
      text: `UPDATE invoice_command_ledger SET
          completed_at = occurred_at,
          completed = 1,
          event_count = 1,
          first_aggregate_sequence = (
            SELECT min(aggregate_sequence) FROM event_outbox event
            WHERE event.aggregate_type = 'invoice' AND event.aggregate_id = ?
              AND event.command_id = ?
          ),
          result_json = json_object(
            'schema_version', 1,
            'definition_id', ?,
            'period', ?,
            'invoice_id', ?,
            'amount_cents', ?
          )
        WHERE invoice_id = ? AND command_id = ? AND completed = 0`,
      params: [
        invoiceId,
        commandId,
        definitionId,
        period,
        invoiceId,
        totalAmountCents,
        invoiceId,
        commandId,
      ],
    })

    statements.push({
      text: `UPDATE recurring_invoices SET next_issue_on = ?, updated_at = ?
        WHERE id = ? AND next_issue_on = ?`,
      params: [nextIssueOn, occurredAt, definitionId, period],
    })

    await runAtomic(database, statements)

    return {
      invoiceId,
      definitionId,
      period,
      nextIssueOn,
      retainerDrawdownCents,
    }
  },

  async generateDue(asOfDate, principal) {
    // Incomplete definitions are excluded by their own CHECK rather than by
    // this predicate: the table only permits `next_issue_on` on a complete row,
    // so the status test is what makes the date test meaningful rather than a
    // second filter over the same fact.
    const due = await all<{ id: number }>(database, {
      text: `SELECT id FROM recurring_invoices
        WHERE definition_status = 'complete' AND next_issue_on <= ?
        ORDER BY id`,
      params: [asOfDate],
    })

    const generated: RecurringGenerationResult[] = []
    const failed: RecurringGenerationFailure[] = []
    for (const { id } of due) {
      // One at a time, and one failure at a time. A definition can throw for
      // reasons that belong to it alone -- every line past its through date, a
      // client deleted underneath it -- and the definitions behind it in the id
      // order have nothing to do with that. Collecting the failure instead of
      // rethrowing is the difference between one client not being invoiced this
      // month and none of them being.
      //
      // Nothing here locks or remembers what it did. It does not have to: the
      // engine keys each issue on `recurring:<definition>:<period>` in
      // `invoice_command_ledger`, so a retry, a second cron that overlaps this
      // one, or a catch-up after days of downtime all land on the same row and
      // return the invoice that already exists.
      try {
        generated.push(await this.generate(id, asOfDate, principal))
      } catch (error) {
        failed.push({
          definitionId: id,
          code: error instanceof RecurringEngineError ? error.code : null,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { generated, failed }
  },
})
