import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  AccountRetentionWriteError,
  parseAccountRetentionPolicy,
  type AccountRetentionPolicyRecord,
} from '@ezacto/core'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type Row = {
  version: number
  policy_json: string
  published_at: string
  published_by_user_id: number | null
}
const record = (row: Row): AccountRetentionPolicyRecord => ({
  version: row.version,
  policy: parseAccountRetentionPolicy(JSON.parse(row.policy_json)),
  publishedAt: row.published_at,
  publishedByUserId: row.published_by_user_id,
})

export function createAccountRetentionRepository(database: Database) {
  return {
    async read(): Promise<AccountRetentionPolicyRecord | null> {
      const rows =
        await database.all<Row>(sql`SELECT version, policy_json, published_at, published_by_user_id
        FROM account_retention_policies ORDER BY version DESC LIMIT 1`)
      return rows[0] ? record(rows[0]) : null
    },
    async publish(input: {
      expectedVersion: number
      policy: unknown
      actorUserId: number
      now: string
    }): Promise<AccountRetentionPolicyRecord> {
      const policy = parseAccountRetentionPolicy(input.policy)
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        input.expectedVersion >= Number.MAX_SAFE_INTEGER ||
        !Number.isSafeInteger(input.actorUserId) ||
        input.actorUserId < 1 ||
        !Number.isFinite(Date.parse(input.now)) ||
        new Date(input.now).toISOString() !== input.now
      ) {
        throw new RangeError('Invalid account retention publication metadata')
      }
      // One statement is both the concurrency check and the authority check.
      // D1 and SQLite cannot interleave a competing publication/deactivation.
      const rows = await database.all<Row>(sql`INSERT INTO account_retention_policies
        (version, policy_json, published_by_user_id, published_at)
        SELECT ${input.expectedVersion + 1}, ${JSON.stringify(policy)}, ${input.actorUserId}, ${input.now}
        WHERE COALESCE((SELECT max(version) FROM account_retention_policies), 0) = ${input.expectedVersion}
          AND EXISTS (SELECT 1 FROM users WHERE id = ${input.actorUserId} AND is_active = 1 AND profile = 'administrator')
        RETURNING version, policy_json, published_at, published_by_user_id`)
      if (rows[0]) return record(rows[0])
      const active = await database.all(
        sql`SELECT id FROM users WHERE id = ${input.actorUserId} AND is_active = 1 AND profile = 'administrator'`,
      )
      throw new AccountRetentionWriteError(
        active.length === 0 ? 'administrator_required' : 'stale_policy',
      )
    },
  }
}
