import { sql } from 'drizzle-orm'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  parseAccountRetentionPolicy,
  type AccountDeletionStatusStore,
  type AccountDeletionTrackingStatus,
  type AccountClosureInventoryItem,
} from '@ezacto/core'
import type * as schema from './schema.js'
type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
const digest = (token: string) => bytesToHex(sha256(utf8ToBytes(token)))
const date = (value: string) => {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new RangeError('Invalid tracking time')
  return Date.parse(value)
}
export function createAccountDeletionStatusRepository(
  database: Database,
): AccountDeletionStatusStore {
  return {
    async issue(input) {
      const expires = new Date(date(input.now) + 90 * 86400000).toISOString()
      const token = `ezacto_deletion_${bytesToHex(crypto.getRandomValues(new Uint8Array(32)))}`
      const rows = await database.all<{
        expires_at: string
      }>(sql`INSERT INTO account_deletion_status_access(request_id,token_hash,issued_at,expires_at)
        SELECT id,${digest(token)},${input.now},CASE WHEN completed_at IS NULL THEN ${expires} ELSE min(${expires},strftime('%Y-%m-%dT%H:%M:%fZ',completed_at,'+30 days')) END FROM account_deletion_requests WHERE id=${input.requestId} AND user_id=${input.userId}
        RETURNING expires_at`)
      if (!rows.length) throw new Error('The deletion request is unavailable for tracking')
      return {
        token,
        expires_at: rows[0]!.expires_at,
        url: `/account-deletion/requests/${input.requestId}/status`,
      }
    },
    async allowRead(now) {
      const window = Math.floor(date(now) / 60000)
      const rows = await database.all<{
        attempts: number
      }>(sql`INSERT INTO account_deletion_status_limits(window_minute,attempts) VALUES(${window},1)
        ON CONFLICT(window_minute) DO UPDATE SET attempts=min(attempts+1,601) RETURNING attempts`)
      await database.run(
        sql`DELETE FROM account_deletion_status_limits WHERE window_minute<${window - 2}`,
      )
      await database.run(
        sql`DELETE FROM account_deletion_status_access WHERE unixepoch(expires_at)<=unixepoch(${now}) OR EXISTS (SELECT 1 FROM account_deletion_requests request WHERE request.id=request_id AND request.completed_at IS NOT NULL AND unixepoch(request.completed_at)+2592000<=unixepoch(${now}))`,
      )
      return rows[0]!.attempts <= 600
    },
    async read(input) {
      date(input.now)
      if (!/^ezacto_deletion_[0-9a-f]{64}$/.test(input.token)) return null
      const rows = await database.all<{
        id: string
        status: AccountDeletionTrackingStatus['status']
        requested_at: string
        expected_completion_at: string | null
        completed_at: string | null
        message: string
        completion_confirmation: string | null
        policy_version: number | null
        policy_snapshot: string | null
        policy_reviewed: number
        expires_at: string
        closed_at: string | null
        closure_policy: string | null
        inventory_json: string | null
        current_policy: string | null
      }>(sql`SELECT request.id,request.status,request.requested_at,request.expected_completion_at,request.completed_at,request.message,request.completion_confirmation,
        request.policy_version,request.policy_snapshot,request.policy_reviewed,access.expires_at,closure.closed_at,closure.policy_snapshot AS closure_policy,closure.inventory_json,
        (SELECT policy_json FROM account_retention_policies ORDER BY version DESC LIMIT 1) AS current_policy
        FROM account_deletion_status_access access JOIN account_deletion_requests request ON request.id=access.request_id
        LEFT JOIN account_closures closure ON closure.request_id=request.id
        WHERE access.request_id=${input.requestId} AND access.token_hash=${digest(input.token)} AND unixepoch(access.expires_at)>unixepoch(${input.now})
          AND (request.completed_at IS NULL OR unixepoch(request.completed_at)+2592000>unixepoch(${input.now}))`)
      const row = rows[0]
      if (!row) return null
      const policy =
        row.policy_snapshot === null
          ? null
          : parseAccountRetentionPolicy(JSON.parse(row.policy_snapshot))
      const closurePolicy =
        row.closure_policy === null
          ? null
          : parseAccountRetentionPolicy(JSON.parse(row.closure_policy))
      const currentPolicy =
        row.current_policy === null
          ? null
          : parseAccountRetentionPolicy(JSON.parse(row.current_policy))
      const inventory = (
        row.inventory_json === null ? [] : JSON.parse(row.inventory_json)
      ) as AccountClosureInventoryItem[]
      return {
        request_id: row.id,
        status: row.status,
        requested_at: row.requested_at,
        expected_completion_at: row.expected_completion_at,
        closed_at: row.closed_at,
        completed_at: row.completed_at,
        message: row.message,
        completion_confirmation: row.completion_confirmation,
        policy_version: row.policy_version,
        policy_snapshot: policy,
        policy_reviewed: row.policy_reviewed === 1,
        closure_disclosure:
          closurePolicy === null || row.closed_at === null
            ? null
            : {
                retained_records: closurePolicy.retained_records
                  .filter((rule) => inventory.some((item) => item.category === rule.category))
                  .map((rule) => ({
                    ...rule,
                    review_due: new Date(
                      Date.parse(row.closed_at!) + rule.review_after_days * 86400000,
                    ).toISOString(),
                  })),
                backup_handling: closurePolicy.backup_handling,
                user_notice: closurePolicy.user_notice,
                operator_contact: closurePolicy.operator_contact,
              },
        operator_contact:
          currentPolicy?.operator_contact ??
          closurePolicy?.operator_contact ??
          policy?.operator_contact ??
          null,
        expires_at:
          row.completed_at === null
            ? row.expires_at
            : new Date(
                Math.min(Date.parse(row.expires_at), Date.parse(row.completed_at) + 30 * 86400000),
              ).toISOString(),
      }
    },
  }
}
