import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  PaymentProviderError,
  validPaymentMonth,
  type PaymentDestination,
  type PaymentItem,
  type PaymentQuote,
  type PaymentProvider,
  type PaymentRun,
  type PaymentRunCommand,
  type PaymentRunsService,
  type PaymentTransfer,
} from '@ezacto/core'
import { createStaffPaymentStore } from './staff-payments.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type ItemRow = Omit<PaymentItem, 'destination' | 'quote' | 'execution_quote'> & {
  destination_json: string
  quote_json: string
  execution_quote_json: string | null
}
type RunRow = Omit<PaymentRun, 'items'> & { command_json: string; approval_json: string | null }
const itemOf = ({
  destination_json,
  quote_json,
  execution_quote_json,
  ...row
}: ItemRow): PaymentItem => ({
  ...row,
  destination: JSON.parse(destination_json) as PaymentDestination,
  quote: JSON.parse(quote_json) as PaymentQuote,
  execution_quote:
    execution_quote_json === null ? null : (JSON.parse(execution_quote_json) as PaymentQuote),
})
const invalid = (message: string): never => {
  throw new StaffPaymentError('invalid', message)
}
const conflict = (message: string): never => {
  throw new StaffPaymentError('conflict', message)
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const money = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= 9_000_000_000_000
const later = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString()
const safeError = (error: unknown) =>
  error instanceof PaymentProviderError
    ? error.message
    : 'Payment processing could not complete. Check the server logs; the reserved amount is held.'

export const createPaymentRunsService = (
  database: Database,
  provider: PaymentProvider | null,
): PaymentRunsService => {
  const ledger = createStaffPaymentStore(database)
  const get = async (id: string): Promise<PaymentRun> => {
    const row = (await database.all<RunRow>(sql`SELECT * FROM payment_runs WHERE id=${id}`))[0]
    if (!row) throw new StaffPaymentError('not_found', 'Payment run not found.')
    const { command_json, approval_json, ...run } = row
    void command_json
    void approval_json
    return {
      ...run,
      items: (
        await database.all<ItemRow>(
          sql`SELECT * FROM payment_run_items WHERE run_id=${id} ORDER BY name,id`,
        )
      ).map(itemOf),
    }
  }
  const currentDestination = async (userId: number): Promise<PaymentDestination | null> =>
    (
      await database.all<PaymentDestination>(
        sql`SELECT id,external_id,kind FROM user_payout_accounts WHERE user_id=${userId} AND provider='wise' AND detached_at IS NULL AND verified_at IS NOT NULL`,
      )
    )[0] ?? null
  const audit = async (
    run: string,
    item: string | null,
    action: string,
    actor: number,
    request: string,
    now: string,
  ) => {
    await database.run(
      sql`INSERT INTO payment_run_audit(run_id,item_id,action,actor_id,request_id,recorded_at,detail) VALUES(${run},${item},${action},${actor},${request},${now},'')`,
    )
  }
  const update = async (
    item: PaymentItem,
    values: {
      state: PaymentItem['state']
      transfer_id?: string
      provider_status?: string
      execution_quote?: PaymentQuote
      failure?: string | null
      next?: string
    },
    now: string,
  ): Promise<boolean> => {
    const result = await database.all<{
      id: string
    }>(sql`UPDATE payment_run_items SET state=${values.state},
      transfer_id=${values.transfer_id ?? item.transfer_id},provider_status=${values.provider_status ?? item.provider_status},
      execution_quote_json=${(values.execution_quote ?? item.execution_quote) === null ? null : JSON.stringify(values.execution_quote ?? item.execution_quote)},failure=${values.failure ?? null},
      next_attempt_at=${values.next ?? later(now, 60)},updated_at=${now},version=version+1,lease_token=NULL,lease_until=NULL
      WHERE id=${item.id} AND version=${item.version} AND lease_token=${item.lease_token} RETURNING id`)
    return result.length > 0
  }
  const validateTransfer = (item: PaymentItem, transfer: PaymentTransfer): void => {
    if (
      transfer.customer_transaction_id !== item.id ||
      transfer.recipient_id !== item.execution_quote?.recipient_id ||
      transfer.target_cents !== item.amount_cents ||
      transfer.target_currency !== item.currency
    )
      throw new PaymentProviderError(
        'Wise transfer details do not match the approved payment. Reconciliation required.',
        409,
      )
  }
  const process = async (item: PaymentItem, now: string): Promise<void> => {
    if (provider === null) return
    let fundingStarted = false
    try {
      if (item.transfer_id !== null) {
        const transfer = await provider.read(item.transfer_id)
        validateTransfer(item, transfer)
        if (transfer.status === 'outgoing_payment_sent') {
          await update(
            item,
            { state: 'paid', provider_status: transfer.status, next: later(now, 3600) },
            now,
          )
          return
        }
        if (transfer.status === 'funds_refunded' || transfer.status === 'cancelled') {
          if (item.state === 'paid' && transfer.status !== 'funds_refunded') {
            await update(
              item,
              {
                state: 'paid',
                failure: 'Wise status changed after payment; reconciliation required.',
                next: later(now, 3600),
              },
              now,
            )
            return
          }
          await update(
            item,
            {
              state: 'failed',
              provider_status: transfer.status,
              failure: `Wise ${transfer.status.replaceAll('_', ' ')}.`,
            },
            now,
          )
          return
        }
        if (transfer.status !== 'incoming_payment_waiting') {
          await update(
            item,
            {
              state: item.state === 'paid' ? 'paid' : 'processing',
              provider_status: transfer.status,
              next: later(now, item.state === 'paid' ? 3600 : 60),
            },
            now,
          )
          return
        }
        // Only the persisted 'creating' state with a known transfer may fund.
        // A funding attempt that timed out is reconciled, never blindly repeated.
        if (item.state !== 'creating') {
          await update(
            item,
            {
              state: item.state === 'paid' ? 'paid' : 'attention',
              provider_status: transfer.status,
              failure:
                'Funding needs confirmation in Wise. This transfer will not be funded again automatically.',
              next: later(now, 300),
            },
            now,
          )
          return
        }
        if (!(await update(item, { state: 'funding', next: later(now, 120) }, now))) return
        fundingStarted = true
        const funded = await provider.fund(
          item.execution_quote!.profile_id,
          item.transfer_id,
          item.id,
        )
        // Reload through the next scheduler tick; no new transfer can be made.
        await database.run(
          sql`UPDATE payment_run_items SET state=${funded === 'accepted' ? 'processing' : 'attention'},failure=${funded === 'accepted' ? null : 'Wise rejected funding. Complete this existing transfer in Wise or cancel it there.'},next_attempt_at=${later(now, 60)},updated_at=${now},version=version+1 WHERE id=${item.id} AND state='funding'`,
        )
        return
      }
      if (item.state === 'queued') {
        const destination = await currentDestination(item.user_id)
        if (destination?.id !== item.destination.id) {
          await update(
            item,
            {
              state: 'attention',
              failure: 'The payout destination changed. Cancel this payment and review a new run.',
            },
            now,
          )
          return
        }
        const quote = await provider.quote(
          item.destination,
          item.quote.source_currency,
          item.currency,
          item.amount_cents,
        )
        if (
          quote.profile_id !== item.quote.profile_id ||
          quote.recipient_id !== item.quote.recipient_id ||
          quote.recipient_name !== item.quote.recipient_name ||
          quote.source_cents > item.max_source_cents ||
          quote.target_cents !== item.amount_cents ||
          quote.target_currency !== item.currency ||
          quote.source_currency !== item.quote.source_currency ||
          Date.parse(quote.expires_at) <= Date.parse(now)
        ) {
          await update(
            item,
            {
              state: 'attention',
              failure:
                'The current quote exceeds the approved cost or no longer matches. Cancel and review a new run.',
            },
            now,
          )
          return
        }
        // Persist the exact quote before creating. Crash recovery repeats the
        // same transaction UUID and payload, including the original quote ID.
        await update(item, { state: 'creating', execution_quote: quote, next: now }, now)
        return
      }
      if (item.state === 'creating' && item.execution_quote !== null) {
        const transfer = await provider.create(item, item.execution_quote)
        validateTransfer(item, transfer)
        await update(
          item,
          {
            state: 'creating',
            transfer_id: transfer.id,
            provider_status: transfer.status,
            next: now,
          },
          now,
        )
      }
    } catch (error) {
      // Funding's marker was persisted before I/O; retain it if the reply was
      // lost. The next tick reads the transfer and never issues another debit.
      const message = safeError(error)
      if (!(error instanceof PaymentProviderError))
        console.error('[payments] processing failed', item.id, error)
      if (error instanceof PaymentProviderError && error.status === 429) {
        const delay = Math.max(
          60,
          error.retryAfterSeconds ?? 60,
          Math.min(3600, 2 ** Math.min(item.attempts, 10)),
        )
        if (fundingStarted) {
          // A 429 explicitly refused the debit; unlike a lost response, it can
          // be retried after Wise's requested delay against this same transfer.
          await database.run(
            sql`UPDATE payment_run_items SET state='creating',failure=${message},next_attempt_at=${later(now, delay)},updated_at=${now},version=version+1 WHERE id=${item.id} AND state='funding'`,
          )
        } else {
          await update(item, { state: item.state, next: later(now, delay), failure: message }, now)
        }
      } else {
        const canReconcile = item.transfer_id !== null
        await update(
          item,
          {
            state:
              item.state === 'paid'
                ? 'paid'
                : canReconcile
                  ? 'attention'
                  : item.state === 'creating' && item.attempts < 8
                    ? 'creating'
                    : 'attention',
            failure: message,
            next: later(now, canReconcile ? 300 : 3600),
          },
          now,
        )
      }
    }
  }
  return {
    preview: async (command, actorId, requestId, now) => {
      if (provider === null) invalid('Wise is not configured for this instance.')
      if (
        !uuid.test(command.id) ||
        !command.name.trim() ||
        command.name.length > 100 ||
        !/^[A-Z]{3}$/u.test(command.source_currency) ||
        !Number.isFinite(Date.parse(command.scheduled_at)) ||
        new Date(command.scheduled_at).toISOString() !== command.scheduled_at
      )
        invalid('Provide a name, currency, UUID and valid scheduled time.')
      try {
        new Intl.DateTimeFormat('en', { timeZone: command.timezone })
      } catch {
        invalid('Choose a valid timezone.')
      }
      if (!Array.isArray(command.items) || command.items.length < 1 || command.items.length > 100)
        invalid('Select between 1 and 100 payments per run.')
      if (
        new Set(command.items.map((x) => `${x.user_id}/${x.month}`)).size !== command.items.length
      )
        invalid('Select each person and period only once.')
      const existing = (
        await database.all<RunRow>(sql`SELECT * FROM payment_runs WHERE id=${command.id}`)
      )[0]
      if (existing) {
        const saved = JSON.parse(existing.command_json) as { input: PaymentRunCommand }
        if (
          existing.actor_id !== actorId ||
          JSON.stringify(saved.input) !== JSON.stringify(command)
        )
          conflict('This run ID already belongs to a different request.')
        return get(command.id)
      }
      const items = []
      for (const selection of command.items) {
        if (
          !validPaymentMonth(selection.month) ||
          !money(selection.amount_cents) ||
          !Number.isSafeInteger(selection.user_id) ||
          !Number.isSafeInteger(selection.expected_version)
        )
          invalid('Choose a valid person, month, amount and ledger version.')
        const row = (await ledger.report(selection.month, now.slice(0, 10))).rows.find(
          (x) => x.user_id === selection.user_id,
        )
        if (
          !row ||
          !row.active ||
          row.payout_provider !== 'wise' ||
          row.status === 'settled' ||
          row.currency === null ||
          row.balance_cents === null ||
          selection.amount_cents > row.balance_cents ||
          row.version !== selection.expected_version
        )
          conflict('The selected balance changed or is not ready for Wise. Refresh the ledger.')
        const destination = await currentDestination(selection.user_id)
        if (!destination) invalid('Set a verified Wise destination for every selected person.')
        const quote = await provider!.quote(
          destination!,
          command.source_currency,
          row!.currency!,
          selection.amount_cents,
        )
        items.push({
          ...selection,
          id: crypto.randomUUID(),
          name: row!.name,
          currency: row!.currency,
          destination,
          quote,
        })
      }
      try {
        await database.run(sql`INSERT INTO payment_runs(id,command_json,name,source_currency,scheduled_at,timezone,state,actor_id,created_at,request_id)
          VALUES(${command.id},${JSON.stringify({ input: command, items })},${command.name.trim()},${command.source_currency},${command.scheduled_at},${command.timezone},'draft',${actorId},${now},${requestId})`)
      } catch (error) {
        if (
          (
            await database.all<{ id: string }>(
              sql`SELECT id FROM payment_runs WHERE id=${command.id}`,
            )
          ).length === 0
        )
          throw error
        conflict('This run was created concurrently. Reload it before proceeding.')
      }
      return get(command.id)
    },
    approve: async (id, approval, actorId, requestId, now) => {
      const run = await get(id)
      if (run.state === 'approved') {
        const row = (
          await database.all<{ approval_json: string }>(
            sql`SELECT approval_json FROM payment_runs WHERE id=${id}`,
          )
        )[0]!
        if (row.approval_json !== JSON.stringify(approval) || run.approved_by !== actorId)
          conflict('This run was already approved with different limits.')
        return run
      }
      if (run.state !== 'draft' || Date.parse(now) - Date.parse(run.created_at) > 30 * 60 * 1000)
        conflict('This review expired or was cancelled. Prepare a new payment run.')
      if (
        approval.limits.length !== run.items.length ||
        new Set(approval.limits.map((x) => x.item_id)).size !== run.items.length ||
        approval.limits.some(
          (limit) =>
            !money(limit.max_source_cents) ||
            !run.items.some(
              (x) => x.id === limit.item_id && limit.max_source_cents >= x.quote.source_cents,
            ),
        )
      )
        invalid('Approve a maximum source cost for every payment, including fees.')
      try {
        const result = await database.all<{ id: string }>(
          sql`UPDATE payment_runs SET state='approved',approval_json=${JSON.stringify(approval)},approved_by=${actorId},approved_at=${now},request_id=${requestId} WHERE id=${id} AND state='draft' RETURNING id`,
        )
        if (!result.length) conflict('Run changed. Refresh before approving.')
      } catch (error) {
        if (error instanceof StaffPaymentError) throw error
        conflict(
          'A balance or destination changed, or another run reserved the funds. Refresh and review again.',
        )
      }
      return get(id)
    },
    cancel: async (id, actorId, requestId, now) => {
      await get(id)
      // One update cancels all items that have never entered transfer creation.
      await database.run(sql`UPDATE payment_run_items SET state='cancelled',updated_at=${now},version=version+1,lease_token=NULL,lease_until=NULL
        WHERE run_id=${id} AND (state IN ('draft','queued') OR (state='attention' AND execution_quote_json IS NULL AND transfer_id IS NULL))`)
      await database.run(
        sql`UPDATE payment_runs SET state='cancelled' WHERE id=${id} AND NOT EXISTS(SELECT 1 FROM payment_run_items WHERE run_id=${id} AND state NOT IN ('cancelled','failed'))`,
      )
      await audit(id, null, 'cancel-unsent', actorId, requestId, now)
      return get(id)
    },
    retry: async (id, itemId, actorId, requestId, now) => {
      const run = await get(id)
      const item = run.items.find((x) => x.id === itemId)
      if (!item) throw new StaffPaymentError('not_found', 'Payment not found.')
      // Reconciliation only: never reset a provider operation to a fresh send.
      await database.run(
        sql`UPDATE payment_run_items SET next_attempt_at=${now},state=CASE WHEN state='attention' AND transfer_id IS NULL AND execution_quote_json IS NOT NULL THEN 'creating' ELSE state END WHERE id=${itemId} AND state IN ('creating','funding','processing','attention','paid')`,
      )
      await audit(id, itemId, 'reconcile', actorId, requestId, now)
      return get(id)
    },
    report: async (from, to, now) => {
      if (!validPaymentMonth(from) || !validPaymentMonth(to) || from > to)
        invalid('Choose a valid period range.')
      const months = []
      let cursor = from
      while (cursor <= to && months.length < 13) {
        months.push(cursor)
        const [y, m] = cursor.split('-').map(Number)
        cursor = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 7)
      }
      if (months.length > 12) invalid('Choose at most 12 months per report.')
      const ledgers = []
      for (const month of months) ledgers.push(await ledger.report(month, now.slice(0, 10)))
      const ids = await database.all<{ id: string }>(
        sql`SELECT DISTINCT r.id FROM payment_runs r JOIN payment_run_items i ON i.run_id=r.id WHERE i.month>=${from} AND i.month<=${to} ORDER BY r.created_at DESC`,
      )
      const runs = []
      for (const { id } of ids) runs.push(await get(id))
      return { from, to, ledgers, runs }
    },
    processDue: async (now) => {
      if (provider === null) return { examined: 0 }
      const due = await database.all<{
        id: string
      }>(sql`SELECT i.id FROM payment_run_items i JOIN payment_runs r ON r.id=i.run_id
        WHERE r.state='approved' AND r.scheduled_at<=${now} AND i.next_attempt_at<=${now} AND (i.lease_until IS NULL OR i.lease_until<${now})
        AND (i.state IN ('queued','creating','funding','processing') OR (i.state='attention' AND i.transfer_id IS NOT NULL) OR (i.state='paid' AND (r.approved_at>=${later(now, -90 * 86400)} OR EXISTS(SELECT 1 FROM wise_webhook_deliveries w WHERE w.transfer_id=i.transfer_id AND w.received_at>i.updated_at)))) ORDER BY i.next_attempt_at,i.id LIMIT 10`)
      let examined = 0
      for (const { id } of due) {
        // Advance up to three durable stages per tick; each reacquires a lease.
        for (let stage = 0; stage < 3; stage++) {
          const token = crypto.randomUUID()
          const rows =
            await database.all<ItemRow>(sql`UPDATE payment_run_items SET lease_token=${token},lease_until=${later(now, 120)},attempts=attempts+1,version=version+1
          WHERE id=${id} AND next_attempt_at<=${now} AND (lease_until IS NULL OR lease_until<${now}) AND state NOT IN ('cancelled','failed') RETURNING *`)
          if (!rows[0]) break
          examined++
          await process(itemOf(rows[0]), now)
        }
      }
      return { examined }
    },
  }
}
