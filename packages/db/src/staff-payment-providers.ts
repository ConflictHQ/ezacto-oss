import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'
import {
  StaffPaymentError,
  type StaffPaymentProviderCommand,
  type StaffPaymentProviderEvent,
  type StaffPaymentProviderSettings,
  type StaffPaymentStore,
} from '@ezacto/core'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
export const createStaffPaymentProviderStore = (database: Database) => ({
  read: async (): Promise<StaffPaymentProviderSettings> => {
    const rows = await database.all<{
      command_json: string
      version: number
      actor_id: number
      actor_name: string
      recorded_at: string
      request_id: string
    }>(sql`SELECT event.command_json, event.version, event.actor_id,
      actor.first_name || ' ' || actor.last_name AS actor_name, event.recorded_at, event.request_id
      FROM staff_payment_provider_events event JOIN users actor ON actor.id = event.actor_id
      ORDER BY event.version, event.id`)
    const events: StaffPaymentProviderEvent[] = rows.map(({ command_json, ...audit }) => ({
      ...(JSON.parse(command_json) as StaffPaymentProviderCommand),
      ...audit,
    }))
    const current = events.filter((event) => event.user_id === null).at(-1)
    return { default_provider: current?.provider ?? 'wise', version: current?.version ?? 0, events }
  },
  append: (async (command, actorId, requestId, now) => {
    const invalid = (message: string): never => {
      throw new StaffPaymentError('invalid', message)
    }
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(command.id)) invalid('Invalid command identifier.')
    if (!Number.isSafeInteger(command.expected_version) || command.expected_version < 0)
      invalid('Invalid settings version.')
    if (
      command.user_id !== null &&
      (!Number.isSafeInteger(command.user_id) || command.user_id <= 0)
    )
      invalid('Choose a valid person.')
    if (
      command.provider !== 'wise' &&
      command.provider !== 'deel' &&
      !(command.provider === null && command.user_id !== null)
    )
      invalid('Choose Wise or Deel, or use the organization default for a person.')
    if (!command.note.trim() || command.note.length > 2000)
      invalid('Add a note of up to 2,000 characters explaining this setting.')
    const encoded = JSON.stringify(command)
    const existing = async () =>
      (
        await database.all<{ command_json: string; actor_id: number }>(sql`
      SELECT command_json, actor_id FROM staff_payment_provider_events WHERE id = ${command.id}`)
      )[0]
    const replay = await existing()
    if (replay !== undefined) {
      if (replay.command_json === encoded && replay.actor_id === actorId) return
      throw new StaffPaymentError(
        'conflict',
        'This command identifier was already used for another setting.',
      )
    }
    if (command.user_id !== null) {
      const people = await database.all(sql`SELECT id FROM users WHERE id = ${command.user_id}`)
      if (people.length === 0)
        throw new StaffPaymentError('not_found', 'This person does not exist.')
    }
    const scope = command.user_id === null ? 'organization' : `user:${command.user_id}`
    const inserted = await database.all<{ id: string }>(sql`
      INSERT INTO staff_payment_provider_events
        (id, user_id, scope, version, provider, command_json, actor_id, recorded_at, request_id)
      SELECT ${command.id}, ${command.user_id}, ${scope}, ${command.expected_version + 1},
        ${command.provider}, ${encoded}, ${actorId}, ${now}, ${requestId}
      WHERE COALESCE((SELECT MAX(version) FROM staff_payment_provider_events WHERE scope = ${scope}), 0)
        = ${command.expected_version}
      ON CONFLICT(id) DO NOTHING RETURNING id`)
    if (inserted.length === 0) {
      const raced = await existing()
      if (raced?.command_json === encoded && raced.actor_id === actorId) return
      throw new StaffPaymentError('conflict', 'These settings changed. Refresh before saving.')
    }
  }) satisfies StaffPaymentStore['configureProvider'],
})
