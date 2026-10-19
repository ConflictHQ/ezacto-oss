import type BetterSqlite3 from 'better-sqlite3'
import type {
  EmailFeedbackClaim,
  EmailFeedbackLedger,
  EmailFeedbackOutcome,
} from '@ezacto/mailer'

/**
 * The ledger of provider feedback events (ezacto-pvt #42, slice B), over
 * `email_feedback_events`.
 *
 * `claim` is one `INSERT ... ON CONFLICT DO NOTHING`, with the primary key and
 * the unique token as the arbiters. Looking first and inserting after would let
 * two concurrent retries both see nothing and both act.
 */

interface PortableDatabase {
  first<T>(query: string, bindings?: readonly unknown[]): Promise<T | null>
  all<T>(query: string, bindings?: readonly unknown[]): Promise<T[]>
}

const createLedger = (database: PortableDatabase): EmailFeedbackLedger => ({
  async claim(input): Promise<EmailFeedbackClaim> {
    const inserted = await database.first<{ eventId: string }>(
      `INSERT INTO email_feedback_events
         (event_id, signature_token, event_type, severity, recipient,
          provider_message_id, delivery_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING event_id AS eventId`,
      [
        input.eventId,
        input.signatureToken,
        input.eventType,
        input.severity,
        input.recipient,
        input.providerMessageId,
        input.deliveryId,
        input.now,
      ],
    )
    if (inserted !== null) return 'fresh'
    // Not inserted: the event id is taken (a retry), or only the token is (a
    // signature carried by some other event).
    const existing = await database.first<{ signatureToken: string; processedAt: string | null }>(
      `SELECT signature_token AS signatureToken, processed_at AS processedAt
       FROM email_feedback_events WHERE event_id = ?`,
      [input.eventId],
    )
    if (existing === null || existing.signatureToken !== input.signatureToken) {
      return 'token_reused'
    }
    return existing.processedAt === null ? 'resume' : 'duplicate'
  },

  async finish(eventId, now, outcome: EmailFeedbackOutcome, detail) {
    await database.all(
      `UPDATE email_feedback_events
       SET processed_at = ?, outcome = ?, detail = ?
       WHERE event_id = ? AND processed_at IS NULL
       RETURNING event_id`,
      [now, outcome, detail, eventId],
    )
  },

  async attemptInFlight(provider, now) {
    const row = await database.first<{ held: number }>(
      `SELECT 1 AS held FROM email_log
       WHERE status = 'queued' AND provider = ? AND active_attempt_id IS NOT NULL
         AND julianday(attempt_lease_expires_at) > julianday(?)
       LIMIT 1`,
      [provider, now],
    )
    return row !== null
  },
})

export const createContainerEmailFeedbackLedger = (
  database: BetterSqlite3.Database,
): EmailFeedbackLedger => {
  database.pragma('foreign_keys = ON')
  return createLedger({
    first: async <T>(query: string, bindings: readonly unknown[] = []) =>
      (database.prepare(query).get(...bindings) as T | undefined) ?? null,
    all: async <T>(query: string, bindings: readonly unknown[] = []) =>
      database.prepare(query).all(...bindings) as T[],
  })
}

export const createD1EmailFeedbackLedger = (database: D1Database): EmailFeedbackLedger =>
  createLedger({
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
  })
