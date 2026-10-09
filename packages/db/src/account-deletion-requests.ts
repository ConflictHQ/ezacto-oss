import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  AccountDeletionError,
  hasAccountDeletionControlCharacters,
  parseAccountRetentionPolicy,
  type AccountDeletionRecord,
  type AccountDeletionStore,
} from '@ezacto/core'
import type * as schema from './schema.js'
import { captureActivityEvent } from './activity-log.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>
type Row = Omit<
  AccountDeletionRecord,
  'policy_snapshot' | 'response_target_at' | 'policy_reviewed'
> & { policy_snapshot: string | null; policy_reviewed: number }
const record = (row: Row): AccountDeletionRecord => {
  const policy =
    row.policy_snapshot === null
      ? null
      : parseAccountRetentionPolicy(JSON.parse(row.policy_snapshot))
  return {
    id: row.id,
    user_id: row.user_id,
    requested_at: row.requested_at,
    policy_version: row.policy_version,
    policy_snapshot: policy,
    policy_reviewed: row.policy_reviewed === 1,
    status: row.status,
    version: row.version,
    message: row.message,
    response_target_at:
      policy === null
        ? null
        : new Date(
            Date.parse(row.requested_at) + policy.response_target_days * 86400000,
          ).toISOString(),
    expected_completion_at: row.expected_completion_at,
    completed_at: row.completed_at,
    completion_confirmation: row.completion_confirmation,
    notification: row.notification,
    notification_updated_at: row.notification_updated_at,
    notification_delivery_id: row.notification_delivery_id,
    updated_at: row.updated_at,
  }
}
const projection = sql`request.*, CASE WHEN request.notification = 'queued' AND EXISTS (SELECT 1 FROM email_log delivery WHERE delivery.id = request.notification_delivery_id AND delivery.status IN ('failed', 'bounced', 'complained')) THEN 'failed' ELSE request.notification END AS notification`
const timestamp = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const userId = (value: number) => Number.isSafeInteger(value) && value > 0

export function createAccountDeletionRequestRepository(database: Database): AccountDeletionStore {
  const activeAdmin = async (id: number) => {
    const rows = await database.all(
      sql`SELECT id FROM users WHERE id = ${id} AND is_active = 1 AND profile = 'administrator'`,
    )
    if (rows.length === 0) throw new AccountDeletionError('administrator_required')
  }
  const read = async (id: string) => {
    const rows = await database.all<Row>(
      sql`SELECT ${projection} FROM account_deletion_requests request WHERE id = ${id}`,
    )
    if (!rows[0]) throw new AccountDeletionError('request_not_found')
    return record(rows[0])
  }
  return {
    async request(input) {
      if (
        !userId(input.userId) ||
        !timestamp(input.now) ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(input.id) ||
        (input.expectedPolicyVersion !== undefined &&
          input.expectedPolicyVersion !== null &&
          !userId(input.expectedPolicyVersion))
      )
        throw new RangeError('Invalid deletion request metadata')
      const expected = input.expectedPolicyVersion
      // Identity, policy version and snapshot are selected at the write itself.
      const rows = await database.all<Row>(sql`INSERT INTO account_deletion_requests
        (id, user_id, requested_at, policy_version, policy_snapshot, policy_reviewed, notification_updated_at, updated_at)
        SELECT ${input.id}, ${input.userId}, ${input.now}, policy.version, policy.policy_json, ${expected === undefined ? 0 : 1}, ${input.now}, ${input.now}
        FROM users person LEFT JOIN account_retention_policies policy
          ON policy.version = (SELECT max(version) FROM account_retention_policies)
        WHERE person.id = ${input.userId} AND person.is_active = 1
          AND (${expected === undefined ? 1 : 0} = 1 OR policy.version IS ${expected ?? null})
        ON CONFLICT(user_id) DO NOTHING RETURNING *`)
      if (rows[0]) {
        await captureActivityEvent(database, {
          eventType: 'account.deletion_requested',
          subjectId: input.userId,
          actor: { type: 'user', id: input.userId },
          occurredAt: input.now,
          captureId: `deletion-request-${rows[0].id}`,
        })
        return { record: record(rows[0]), created: true }
      }
      const existing = await this.readOwn(input.userId)
      if (existing !== null) return { record: existing, created: false }
      const person = await database.all(
        sql`SELECT id FROM users WHERE id = ${input.userId} AND is_active = 1`,
      )
      throw new AccountDeletionError(person.length === 0 ? 'account_unavailable' : 'stale_policy')
    },
    async readOwn(id) {
      const rows =
        await database.all<Row>(sql`SELECT ${projection} FROM account_deletion_requests request
        JOIN users person ON person.id = request.user_id AND person.is_active = 1 WHERE person.id = ${id}`)
      return rows[0] ? record(rows[0]) : null
    },
    async list(actor, after) {
      await activeAdmin(actor)
      const rows =
        await database.all<Row>(sql`SELECT ${projection} FROM account_deletion_requests request
        WHERE (${after} IS NULL OR request.id > ${after})
          AND EXISTS (SELECT 1 FROM users WHERE id = ${actor} AND is_active = 1 AND profile = 'administrator')
        ORDER BY request.id LIMIT 51`)
      return rows.map(record)
    },
    async readAdmin(actor, id) {
      await activeAdmin(actor)
      const rows =
        await database.all<Row>(sql`SELECT ${projection} FROM account_deletion_requests request
        WHERE request.id = ${id} AND EXISTS (SELECT 1 FROM users WHERE id = ${actor} AND is_active = 1 AND profile = 'administrator')`)
      if (!rows[0]) throw new AccountDeletionError('request_not_found')
      return record(rows[0])
    },
    async update(input) {
      if (
        !userId(input.actorUserId) ||
        !userId(input.expectedVersion) ||
        input.expectedVersion >= Number.MAX_SAFE_INTEGER ||
        !timestamp(input.now) ||
        (input.expectedCompletionAt !== null && !timestamp(input.expectedCompletionAt)) ||
        !['pending', 'in_progress', 'action_required'].includes(input.status) ||
        input.message.length > 5000 ||
        hasAccountDeletionControlCharacters(input.message) ||
        (input.status === 'action_required' && input.message.trim() === '')
      )
        throw new RangeError('Invalid deletion request update')
      const rows = await database.all<Row>(sql`UPDATE account_deletion_requests SET
        status = ${input.status}, message = ${input.message}, expected_completion_at = ${input.expectedCompletionAt},
        version = version + 1, updated_at = ${input.now}, updated_by_user_id = ${input.actorUserId}
        WHERE id = ${input.id} AND version = ${input.expectedVersion} AND status <> 'completed'
          AND EXISTS (SELECT 1 FROM users WHERE id = ${input.actorUserId} AND is_active = 1 AND profile = 'administrator')
        RETURNING *`)
      if (rows[0]) return record(rows[0])
      await activeAdmin(input.actorUserId)
      const current = await read(input.id)
      throw new AccountDeletionError(
        current.status === 'completed' ? 'request_completed' : 'stale_request',
      )
    },
    async claimNotification(id, actor, now) {
      if (!timestamp(now)) throw new RangeError('Invalid notification time')
      const rows =
        await database.all(sql`UPDATE account_deletion_requests SET notification = 'sending', notification_updated_at = ${now}
        WHERE id = ${id} AND status <> 'completed'
          AND (notification IN ('pending','failed','unavailable') OR (notification = 'queued' AND EXISTS (SELECT 1 FROM email_log delivery WHERE delivery.id = notification_delivery_id AND delivery.status IN ('failed','bounced'))) OR (notification = 'sending' AND unixepoch(notification_updated_at) <= unixepoch(${now}) - 900))
          AND EXISTS (SELECT 1 FROM users WHERE id = ${actor} AND is_active = 1 AND (id = account_deletion_requests.user_id OR profile = 'administrator'))
        RETURNING id`)
      return rows.length > 0
    },
    async finishNotification(id, claimedAt, outcome, deliveryId) {
      await database.run(sql`UPDATE account_deletion_requests SET notification = ${outcome}, notification_delivery_id = ${deliveryId}
        WHERE id = ${id} AND notification = 'sending' AND notification_updated_at = ${claimedAt}`)
    },
    async notificationRecipients(id) {
      const rows = await database.all<{
        name: string
        email: string | null
      }>(sql`SELECT trim(person.first_name || ' ' || person.last_name) AS name,
        (SELECT address FROM user_emails WHERE user_id = person.id AND is_primary = 1 AND invalidated_at IS NULL) AS email
        FROM account_deletion_requests request JOIN users person ON person.id = request.user_id WHERE request.id = ${id}`)
      if (!rows[0]) throw new AccountDeletionError('request_not_found')
      const administrators = await database.all<{
        address: string
      }>(sql`SELECT DISTINCT address.address FROM users admin
        JOIN user_emails address ON address.user_id = admin.id AND address.is_primary = 1 AND address.invalidated_at IS NULL
        WHERE admin.profile = 'administrator' AND admin.is_active = 1 ORDER BY address.address`)
      return { person: rows[0], administrators: administrators.map((item) => item.address) }
    },
  }
}
