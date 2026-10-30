/**
 * Which payout providers an administrator has made available (#1152).
 *
 * A person may hold an account at every enabled provider and picks one as
 * primary. Disabling a provider stops new links to it; accounts already linked
 * are kept, so nothing is detached by changing this setting.
 */

import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface PayoutProviderSetting {
  provider: string
  enabled: boolean
  updatedAt: string
  updatedByUserId: number | null
}

export const createPayoutProviderEnablementStore = (database: Database) => ({
  list: async (): Promise<PayoutProviderSetting[]> => {
    const rows = await database.all<{
      provider: string
      enabled: number
      updated_at: string
      updated_by_user_id: number | null
    }>(sql`SELECT provider, enabled, updated_at, updated_by_user_id
      FROM payout_provider_enablement ORDER BY provider`)
    return rows.map((row) => ({
      provider: row.provider,
      enabled: row.enabled === 1,
      updatedAt: row.updated_at,
      updatedByUserId: row.updated_by_user_id,
    }))
  },

  /** False when the provider has no row, which is a provider this code does not know. */
  setEnabled: async (
    provider: string,
    enabled: boolean,
    userId: number,
    now: string,
  ): Promise<boolean> => {
    const rows = await database.all<{ provider: string }>(sql`
      UPDATE payout_provider_enablement
      SET enabled = ${enabled ? 1 : 0}, updated_at = ${now}, updated_by_user_id = ${userId}
      WHERE provider = ${provider}
      RETURNING provider`)
    return rows.length === 1
  },
})
