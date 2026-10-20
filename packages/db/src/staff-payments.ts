import { createReportRepository } from './reports.js'
import { createPaymentActualsStore } from './payment-actuals.js'
import { createPaymentReconciliationStore } from './payment-reconciliation.js'
import { createPaymentAllocationStore } from './payment-allocations.js'
import { createStaffPaymentProviderStore } from './staff-payment-providers.js'
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  paymentMonthEnd,
  summarizeStaffPayments,
  validateStaffPayment,
  type StaffPaymentCommand,
  type StaffPaymentEvent,
  type StaffPaymentStore,
} from '@ezacto/core'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
interface EventRow {
  command_json: string
  version: number
  actor_id: number
  actor_name: string
  recorded_at: string
  request_id: string
}
const eventOf = (row: EventRow): StaffPaymentEvent => {
  const { command_json, ...audit } = row
  return { ...(JSON.parse(command_json) as StaffPaymentCommand), ...audit }
}
const reservationError = (error: unknown): boolean => {
  let current = error
  for (let depth = 0; depth < 5 && current !== undefined; depth++) {
    if (String(current).includes('reserved') || String(current).includes('provider payments'))
      return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}
const eventSelect = sql`SELECT event.command_json, event.version, event.actor_id,
  actor.first_name || ' ' || actor.last_name AS actor_name, event.recorded_at, event.request_id
  FROM staff_payment_effective_events event JOIN users actor ON actor.id = event.actor_id`

export const createStaffPaymentStore = (database: Database): StaffPaymentStore => {
  const providers = createStaffPaymentProviderStore(database)
  const report: StaffPaymentStore['report'] = async (month, today) => {
    const [people, history, providerSettings] = await Promise.all([
      database.all<{
        user_id: number
        name: string
        active: number
        wise_ready: number
        deel_ready: number
        reserved_cents: number
        has_hours: number
      }>(sql`
        SELECT person.id AS user_id, person.first_name || ' ' || person.last_name AS name,
          person.is_active AS active,
          EXISTS(SELECT 1 FROM time_entries entry WHERE entry.user_id = person.id
            AND entry.spent_date BETWEEN ${month + '-01'} AND ${paymentMonthEnd(month)}
            AND entry.rounded_seconds != 0) AS has_hours,
          (SELECT COALESCE(SUM(amount_cents),0) FROM payment_run_items item WHERE item.user_id=person.id AND item.month=${month}
            AND item.state IN ('queued','creating','funding','processing','attention')) AS reserved_cents,
          EXISTS(SELECT 1 FROM user_payout_accounts account WHERE account.user_id = person.id
            AND account.provider = 'wise' AND account.detached_at IS NULL
            AND account.verified_at IS NOT NULL) AS wise_ready,
          EXISTS(SELECT 1 FROM user_payout_accounts account WHERE account.user_id = person.id
            AND account.provider = 'deel' AND account.detached_at IS NULL
            AND account.verified_at IS NOT NULL) AS deel_ready
        FROM users person WHERE person.is_active = 1 OR EXISTS(
          SELECT 1 FROM staff_payment_effective_events event WHERE event.user_id = person.id
            AND (event.month = ${month} OR (event.kind = 'opening' AND event.month >= ${month})))
        ORDER BY person.first_name, person.last_name, person.id`),
      database.all<EventRow>(sql`${eventSelect}
        WHERE event.month = ${month} OR (event.kind = 'opening' AND event.month >= ${month})
        ORDER BY event.month, event.version`),
      providers.read(),
    ])
    const events = history.map(eventOf)
    const result = {
      month,
      provider_settings: providerSettings,
      as_of: today,
      rows: people.map((person) => {
        const preference = providerSettings.events
          .filter((event) => event.user_id === person.user_id)
          .at(-1)
        const summary = summarizeStaffPayments(
          {
            ...person,
            active: person.active === 1,
            wise_ready: person.wise_ready === 1,
            deel_ready: person.deel_ready === 1,
            payout_provider: preference?.provider ?? providerSettings.default_provider,
            provider_override: preference?.provider ?? null,
            provider_version: preference?.version ?? 0,
          },
          month,
          events.filter((event) => event.user_id === person.user_id),
          today,
        )
        return {
          ...summary,
          has_hours: person.has_hours === 1,
          reserved_cents: person.reserved_cents,
          available_cents:
            summary.balance_cents === null ? null : summary.balance_cents - person.reserved_cents,
        }
      }),
    }
    // A cutoff confirms settlement, but supplies neither an amount nor a receipt.
    // Value only those unknown historical amounts using the canonical cost report.
    // Keep ledger balances/receipts untouched: this valuation cannot create payable funds.
    if (result.rows.some((row) => row.status === 'settled' && row.amount_cents === null)) {
      const costs = await createReportRepository(database).contractorCost({
        from: `${month}-01`,
        to: paymentMonthEnd(month),
      })
      const byPerson = new Map(
        costs.rows.filter((row) => row.isContractor).map((row) => [row.userId, row]),
      )
      for (const row of result.rows) {
        const cost = byPerson.get(row.user_id)
        if (row.status === 'settled' && row.amount_cents === null && cost?.costCents != null) {
          row.amount_cents = cost.costCents
          row.currency = cost.currency
          row.amount_basis = 'contractor_cost'
        }
      }
    }
    return result
  }
  return {
    ...createPaymentActualsStore(database, { report }),
    ...createPaymentAllocationStore(database),
    ...createPaymentReconciliationStore(database),
    report,
    configureProvider: providers.append,
    append: async (command, actorId, requestId, now) => {
      const encoded = JSON.stringify(command)
      const existing = async () =>
        (
          await database.all<{ command_json: string; actor_id: number }>(sql`
        SELECT command_json, actor_id FROM staff_payment_events WHERE id = ${command.id}`)
        )[0]
      const replay = await existing()
      if (replay !== undefined) {
        if (replay.command_json === encoded && replay.actor_id === actorId) return
        throw new StaffPaymentError(
          'conflict',
          'This command identifier was already used for a different entry.',
        )
      }
      const snapshot = await report(command.month, now.slice(0, 10))
      const row = snapshot.rows.find((person) => person.user_id === command.user_id)
      if (row === undefined)
        throw new StaffPaymentError('not_found', 'This person is not in the payment register.')
      validateStaffPayment(
        command,
        row.amount_basis === 'contractor_cost'
          ? { ...row, amount_cents: null, currency: null }
          : row,
        now.slice(0, 10),
      )
      // One statement is atomic in both D1 and SQLite. The comparison prevents
      // two operators spending the same remaining balance after reading it.
      const inserted = await Promise.resolve(
        database.all<{ id: string }>(sql`
        INSERT INTO staff_payment_events
          (id, user_id, month, version, kind, command_json, actor_id, recorded_at, request_id)
        SELECT ${command.id}, ${command.user_id}, ${command.month}, ${command.expected_version + 1},
          ${command.kind}, ${encoded}, ${actorId}, ${now}, ${requestId}
        WHERE COALESCE((SELECT MAX(version) FROM staff_payment_effective_events
          WHERE user_id = ${command.user_id} AND month = ${command.month}), 0) = ${command.expected_version}
        ON CONFLICT(id) DO NOTHING RETURNING id`),
      ).catch((error: unknown) => {
        if (reservationError(error))
          throw new StaffPaymentError(
            'conflict',
            'This balance is reserved by a payment run, or the payment requires provider reconciliation.',
          )
        throw error
      })
      if (inserted.length === 0) {
        const raced = await existing()
        if (raced?.command_json === encoded && raced.actor_id === actorId) return
        throw new StaffPaymentError('conflict', 'This record changed. Refresh before saving.')
      }
    },
  }
}
