/**
 * Each person's default payout provider (issue 1152).
 *
 * A person's choice is an event in their own scope of the staff payment
 * provider log, the same log the payments register and the Deel sync already
 * read. So there is one source of truth: a choice the person makes, one the
 * administrator makes, and the one made automatically when the first account is
 * linked are all the same kind of row, told apart by who wrote them.
 *
 * `provider` null means "use the organization default". Who may set what is the
 * API's rule, not this store's; this module only records and reads.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { AUTOMATIC_PREFERENCE_NOTE, type StaffPaymentProvider } from '@ezacto/core'
import type * as schema from './schema.js'
import { createStaffPaymentProviderStore } from './staff-payment-providers.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export type PayoutPreferenceSource = 'person' | 'administrator' | 'automatic'

export interface PersonPayoutPreference {
  userId: number
  /** Null: the person uses the organization default. */
  provider: StaffPaymentProvider | null
  version: number
  source: PayoutPreferenceSource | null
}

export interface PayoutPreferenceRosterRow {
  userId: number
  name: string
  provider: StaffPaymentProvider | null
  version: number
  source: PayoutPreferenceSource | null
  linked: StaffPaymentProvider[]
}

const sourceFor = (actorIsSubject: boolean, automatic: boolean): PayoutPreferenceSource =>
  automatic ? 'automatic' : actorIsSubject ? 'person' : 'administrator'

export const createPayoutPreferenceStore = (database: Database) => {
  const log = createStaffPaymentProviderStore(database)

  const latest = async (userId: number) =>
    (
      await database.all<{
        provider: StaffPaymentProvider | null
        version: number
        note: string
        actor_id: number
      }>(sql`
        SELECT json_extract(event.command_json, '$.provider') AS provider,
          event.version, json_extract(event.command_json, '$.note') AS note, event.actor_id
        FROM staff_payment_provider_events event
        WHERE event.scope = ${`user:${userId}`}
        ORDER BY event.version DESC LIMIT 1`)
    )[0]

  return {
    read: async (userId: number): Promise<PersonPayoutPreference> => {
      const row = await latest(userId)
      if (row === undefined) return { userId, provider: null, version: 0, source: null }
      return {
        userId,
        provider: row.provider,
        version: row.version,
        source: sourceFor(row.actor_id === userId, row.note === AUTOMATIC_PREFERENCE_NOTE),
      }
    },

    orgDefault: async (): Promise<StaffPaymentProvider> =>
      (await log.read()).default_provider,

    /** Records a choice. The version must match the current one, or nothing is written. */
    set: async (input: {
      id: string
      userId: number
      provider: StaffPaymentProvider | null
      expectedVersion: number
      note: string
      actorId: number
      requestId: string
      now: string
    }): Promise<void> => {
      await log.append(
        {
          id: input.id,
          user_id: input.userId,
          expected_version: input.expectedVersion,
          provider: input.provider,
          note: input.note,
        },
        input.actorId,
        input.requestId,
        input.now,
      )
    },

    /** Everyone who can be paid, with their choice and the providers they hold. */
    roster: async (): Promise<PayoutPreferenceRosterRow[]> => {
      const people = await database.all<{ id: number; name: string }>(sql`
        SELECT id, first_name || ' ' || last_name AS name FROM users
        WHERE is_active = 1 ORDER BY first_name, last_name, id`)
      const accounts = await database.all<{ user_id: number; provider: StaffPaymentProvider }>(sql`
        SELECT user_id, provider FROM user_payout_accounts WHERE detached_at IS NULL`)
      const choices = await database.all<{
        user_id: number
        provider: StaffPaymentProvider | null
        version: number
        note: string
        actor_id: number
      }>(sql`
        SELECT event.user_id, json_extract(event.command_json, '$.provider') AS provider,
          event.version, json_extract(event.command_json, '$.note') AS note, event.actor_id
        FROM staff_payment_provider_events event
        WHERE event.user_id IS NOT NULL
          AND event.version = (SELECT MAX(version) FROM staff_payment_provider_events
            WHERE scope = 'user:' || event.user_id)`)
      const linkedBy = new Map<number, StaffPaymentProvider[]>()
      for (const account of accounts) {
        linkedBy.set(account.user_id, [...(linkedBy.get(account.user_id) ?? []), account.provider])
      }
      const chosen = new Map(choices.map((choice) => [choice.user_id, choice]))
      return people.map((person) => {
        const choice = chosen.get(person.id)
        return {
          userId: person.id,
          name: person.name,
          provider: choice?.provider ?? null,
          version: choice?.version ?? 0,
          source: choice
            ? sourceFor(choice.actor_id === person.id, choice.note === AUTOMATIC_PREFERENCE_NOTE)
            : null,
          linked: linkedBy.get(person.id) ?? [],
        }
      })
    },
  }
}
