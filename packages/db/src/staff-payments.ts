import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
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
const eventSelect = sql`SELECT event.command_json, event.version, event.actor_id,
  actor.first_name || ' ' || actor.last_name AS actor_name, event.recorded_at, event.request_id
  FROM staff_payment_events event JOIN users actor ON actor.id = event.actor_id`

export const createStaffPaymentStore = (database: Database): StaffPaymentStore => {
  const report: StaffPaymentStore['report'] = async (month, today) => {
    const [people, history] = await Promise.all([
      database.all<{ user_id: number; name: string; active: number; wise_ready: number }>(sql`
        SELECT person.id AS user_id, person.first_name || ' ' || person.last_name AS name,
          person.is_active AS active,
          EXISTS(SELECT 1 FROM user_payout_accounts account WHERE account.user_id = person.id
            AND account.provider = 'wise' AND account.detached_at IS NULL
            AND account.verified_at IS NOT NULL) AS wise_ready
        FROM users person WHERE person.is_active = 1 OR EXISTS(
          SELECT 1 FROM staff_payment_events event WHERE event.user_id = person.id
            AND (event.month = ${month} OR (event.kind = 'opening' AND event.month >= ${month})))
        ORDER BY person.first_name, person.last_name, person.id`),
      database.all<EventRow>(sql`${eventSelect}
        WHERE event.month = ${month} OR (event.kind = 'opening' AND event.month >= ${month})
        ORDER BY event.month, event.version`),
    ])
    const events = history.map(eventOf)
    return {
      month,
      as_of: today,
      rows: people.map((person) =>
        summarizeStaffPayments(
          { ...person, active: person.active === 1, wise_ready: person.wise_ready === 1 },
          month,
          events.filter((event) => event.user_id === person.user_id),
          today,
        ),
      ),
    }
  }
  return {
    report,
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
      validateStaffPayment(command, row, now.slice(0, 10))
      // One statement is atomic in both D1 and SQLite. The comparison prevents
      // two operators spending the same remaining balance after reading it.
      const inserted = await database.all<{ id: string }>(sql`
        INSERT INTO staff_payment_events
          (id, user_id, month, version, kind, command_json, actor_id, recorded_at, request_id)
        SELECT ${command.id}, ${command.user_id}, ${command.month}, ${command.expected_version + 1},
          ${command.kind}, ${encoded}, ${actorId}, ${now}, ${requestId}
        WHERE COALESCE((SELECT MAX(version) FROM staff_payment_events
          WHERE user_id = ${command.user_id} AND month = ${command.month}), 0) = ${command.expected_version}
        ON CONFLICT(id) DO NOTHING RETURNING id`)
      if (inserted.length === 0) {
        const raced = await existing()
        if (raced?.command_json === encoded && raced.actor_id === actorId) return
        throw new StaffPaymentError('conflict', 'This record changed. Refresh before saving.')
      }
    },
  }
}
