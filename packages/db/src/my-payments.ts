import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  paymentMonthEnd,
  summarizeMyPayments,
  type MyPaymentsStore,
  type MyUpcomingPayment,
  type StaffPaymentCommand,
  type StaffPaymentEvent,
} from '@ezacto/core'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

/** The calendar date of an instant in the zone the run was scheduled in. */
const scheduledDate = (instant: string, timezone: string): string => {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return instant.slice(0, 10)
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at)
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/**
 * Issue 100: the own-subject read model. Every query is keyed on the one user id
 * the caller supplies; nothing here can be asked about anybody else. Dates and
 * the ledger arithmetic come from the same view and function as the
 * administrator register, so the two reconcile.
 */
export const createMyPaymentsStore = (database: Database): MyPaymentsStore => ({
  read: async (userId, month, today) => {
    const [eligibility] = await database.all<{ contractor: number; obligated: number }>(sql`
      SELECT person.is_contractor AS contractor,
        EXISTS(SELECT 1 FROM staff_payment_effective_events event
          WHERE event.user_id = person.id AND event.kind = 'amount') AS obligated
      FROM users person WHERE person.id = ${userId}`)
    if (eligibility === undefined || (eligibility.contractor !== 1 && eligibility.obligated !== 1))
      return null
    const [history, hours, items] = await Promise.all([
      database.all<{
        command_json: string
        version: number
        actor_id: number
        actor_name: string
        recorded_at: string
        request_id: string
      }>(sql`
        SELECT event.command_json, event.version, event.actor_id,
          actor.first_name || ' ' || actor.last_name AS actor_name, event.recorded_at, event.request_id
        FROM staff_payment_effective_events event JOIN users actor ON actor.id = event.actor_id
        WHERE event.user_id = ${userId}
          AND (event.month = ${month} OR (event.kind = 'opening' AND event.month >= ${month}))
        ORDER BY event.month, event.version`),
      database.all<{ seconds: number }>(sql`
        SELECT COALESCE(SUM(rounded_seconds), 0) AS seconds FROM time_entries
        WHERE user_id = ${userId} AND spent_date BETWEEN ${month + '-01'} AND ${paymentMonthEnd(month)}`),
      database.all<{
        purpose: string
        amount_cents: number
        currency: string
        state: string
        scheduled_at: string
        timezone: string
      }>(sql`
        SELECT item.purpose, item.amount_cents, item.currency, item.state, run.scheduled_at, run.timezone
        FROM payment_run_items item JOIN payment_runs run ON run.id = item.run_id
        WHERE item.user_id = ${userId} AND run.state = 'approved'
          AND item.state IN ('queued','creating','funding','processing','attention')
        ORDER BY run.scheduled_at, item.id`),
    ])
    const events = history.map((row): StaffPaymentEvent => {
      const { command_json, ...audit } = row
      return { ...(JSON.parse(command_json) as StaffPaymentCommand), ...audit }
    })
    const upcoming: MyUpcomingPayment[] = items.map((item) => ({
      ...(item.purpose === 'advance' ? { kind: 'advance' as const } : {}),
      amount_cents: item.amount_cents,
      currency: item.currency,
      scheduled_on: scheduledDate(item.scheduled_at, item.timezone),
      status: item.state === 'queued' ? 'scheduled' : 'processing',
    }))
    return summarizeMyPayments(month, events, hours[0]?.seconds ?? 0, upcoming, today)
  },
})
