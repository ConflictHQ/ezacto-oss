import type BetterSqlite3 from 'better-sqlite3'
import type {
  EmailDeliveryStatus,
  EmailFailureCode,
  EmailLogRecord,
  EmailLogStore,
  EmailRecipient,
} from '@ezacto/mailer'

export interface EmailLogStoreOptions {
  now?: () => string
}

interface PortableDatabase {
  first<T>(query: string, bindings?: readonly unknown[]): Promise<T | null>
  all<T>(query: string, bindings?: readonly unknown[]): Promise<T[]>
}

interface EmailLogRow {
  id: number
  toJson: string
  template: string
  subject: string
  provider: string | null
  providerMessageId: string | null
  status: EmailDeliveryStatus
  relatedType: string | null
  relatedId: number | null
  attemptCount: number
  failureCode: EmailFailureCode | null
  createdAt: string
  updatedAt: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('email log clock must return a canonical UTC timestamp')
  }
}

const columns = `id, to_json AS toJson, template, subject, provider,
  provider_message_id AS providerMessageId, status, related_type AS relatedType,
  related_id AS relatedId, attempt_count AS attemptCount,
  failure_code AS failureCode, created_at AS createdAt, updated_at AS updatedAt`

const rowRecord = (row: EmailLogRow | null): EmailLogRecord => {
  if (row === null) throw new Error('email delivery state transition did not match a queued log')
  let recipients: unknown
  try {
    recipients = JSON.parse(row.toJson)
  } catch {
    throw new Error('email log contains malformed recipients')
  }
  if (
    !Array.isArray(recipients) ||
    !recipients.every(
      (recipient) =>
        typeof recipient === 'object' &&
        recipient !== null &&
        typeof (recipient as { email?: unknown }).email === 'string' &&
        ((recipient as { name?: unknown }).name === undefined ||
          typeof (recipient as { name?: unknown }).name === 'string'),
    )
  ) {
    throw new Error('email log contains malformed recipients')
  }
  return {
    id: row.id,
    to: recipients as EmailRecipient[],
    template: row.template,
    subject: row.subject,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    status: row.status,
    relatedType: row.relatedType,
    relatedId: row.relatedId,
    attemptCount: row.attemptCount,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

const createStore = (
  database: PortableDatabase,
  options: EmailLogStoreOptions,
): EmailLogStore => {
  const now = options.now ?? (() => new Date().toISOString())
  const timestamp = (): string => {
    const value = now()
    assertCanonicalTimestamp(value)
    return value
  }
  return {
    async createQueued(message) {
      const at = timestamp()
      return rowRecord(
        await database.first<EmailLogRow>(
          `INSERT INTO email_log (
             to_json, template, subject, related_type, related_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING ${columns}`,
          [
            JSON.stringify(message.to),
            message.template,
            message.subject,
            message.related?.type ?? null,
            message.related?.id ?? null,
            at,
            at,
          ],
        ),
      )
    },

    async get(deliveryId) {
      const row = await database.first<EmailLogRow>(
        `SELECT ${columns} FROM email_log WHERE id = ?`,
        [deliveryId],
      )
      return row === null ? null : rowRecord(row)
    },

    async claimAttempt(deliveryId, provider, attemptId, leaseSeconds) {
      if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3_600) {
        throw new RangeError('email delivery attempt lease must be between 1 and 3600 seconds')
      }
      const at = timestamp()
      const leaseExpiresAt = new Date(
        Date.parse(at) + leaseSeconds * 1_000,
      ).toISOString()
      return (
        (await database.first<{ claimed: number }>(
          `UPDATE email_log
           SET provider = ?, attempt_count = attempt_count + 1,
             active_attempt_id = ?, attempt_lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND status = 'queued'
             AND (provider IS NULL OR provider = ?)
             AND (active_attempt_id IS NULL
               OR julianday(attempt_lease_expires_at) <= julianday(?))
           RETURNING 1 AS claimed`,
          [
            provider,
            attemptId,
            leaseExpiresAt,
            at,
            deliveryId,
            provider,
            at,
          ],
        )) !== null
      )
    },

    async releaseAttempt(deliveryId, provider, attemptId) {
      const at = timestamp()
      return (
        (await database.first<{ released: number }>(
          `UPDATE email_log
           SET active_attempt_id = NULL, attempt_lease_expires_at = NULL,
             updated_at = ?
           WHERE id = ? AND status = 'queued' AND provider = ?
             AND active_attempt_id = ?
           RETURNING 1 AS released`,
          [at, deliveryId, provider, attemptId],
        )) !== null
      )
    },

    async markSent(deliveryId, provider, providerMessageId, attemptId) {
      const at = timestamp()
      return rowRecord(
        await database.first<EmailLogRow>(
          `UPDATE email_log
           SET status = 'sent', provider = ?, provider_message_id = ?,
             active_attempt_id = NULL, attempt_lease_expires_at = NULL,
             updated_at = ?
           WHERE id = ? AND status = 'queued' AND attempt_count > 0
             AND provider = ? AND active_attempt_id = ?
           RETURNING ${columns}`,
          [provider, providerMessageId, at, deliveryId, provider, attemptId],
        ),
      )
    },

    async markProviderFailed(deliveryId, provider, failureCode, attemptId) {
      const at = timestamp()
      return rowRecord(
        await database.first<EmailLogRow>(
          `UPDATE email_log
           SET status = 'failed', provider = ?, failure_code = ?,
             active_attempt_id = NULL, attempt_lease_expires_at = NULL,
             updated_at = ?
           WHERE id = ? AND status = 'queued' AND provider = ?
             AND active_attempt_id = ?
           RETURNING ${columns}`,
          [provider, failureCode, at, deliveryId, provider, attemptId],
        ),
      )
    },

    async markQueueFailed(deliveryId) {
      const at = timestamp()
      return rowRecord(
        await database.first<EmailLogRow>(
          `UPDATE email_log
           SET status = 'failed', failure_code = 'queue_unavailable', updated_at = ?
           WHERE id = ? AND status = 'queued' AND provider IS NULL
             AND active_attempt_id IS NULL
           RETURNING ${columns}`,
          [at, deliveryId],
        ),
      )
    },

    async list(input = {}) {
      const limit = input.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        throw new RangeError('email log limit must be between 1 and 200')
      }
      const rows = await database.all<EmailLogRow>(
        `SELECT ${columns} FROM email_log
         ${input.status === undefined ? '' : 'WHERE status = ?'}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
        input.status === undefined ? [limit] : [input.status, limit],
      )
      return rows.map((row) => rowRecord(row))
    },
  }
}

export const createContainerEmailLogStore = (
  database: BetterSqlite3.Database,
  options: EmailLogStoreOptions = {},
): EmailLogStore => {
  database.pragma('foreign_keys = ON')
  return createStore(
    {
      first: async <T>(query: string, bindings: readonly unknown[] = []) =>
        (database.prepare(query).get(...bindings) as T | undefined) ?? null,
      all: async <T>(query: string, bindings: readonly unknown[] = []) =>
        database.prepare(query).all(...bindings) as T[],
    },
    options,
  )
}

export const createD1EmailLogStore = (
  database: D1Database,
  options: EmailLogStoreOptions = {},
): EmailLogStore =>
  createStore(
    {
      first: async (query, bindings = []) =>
        database
          .prepare(query)
          .bind(...bindings)
          .first(),
      all: async <T>(query: string, bindings: readonly unknown[] = []) =>
        (
          await database
            .prepare(query)
            .bind(...bindings)
            .all<T>()
        ).results,
    },
    options,
  )
