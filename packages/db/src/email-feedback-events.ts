import type BetterSqlite3 from 'better-sqlite3'
import type {
  EmailFeedbackClaim,
  EmailFeedbackClaimInput,
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
    // Historical migration tests can use this ledger before reconciliation was
    // introduced. On current schemas, aliases also spend a webhook token.
    const aliases = await database.first<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'reminder_reconciliation_webhook_tokens'",
    ) !== null
    const inserted = await database.first<{ eventId: string }>(
      `INSERT INTO email_feedback_events
         (event_id, signature_token, event_type, severity, recipient,
          provider_message_id, delivery_id, received_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       ${aliases ? 'WHERE NOT EXISTS (SELECT 1 FROM reminder_reconciliation_webhook_tokens WHERE signature_token = ?)' : ''}
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
        ...(aliases ? [input.signatureToken] : []),
      ],
    )
    if (inserted !== null) return 'fresh'
    // Not inserted: the event id is taken (a retry), or only the token is (a
    // signature carried by some other event).
    const existing = await database.first<
      Omit<EmailFeedbackClaimInput, 'now'> & { processedAt: string | null }
    >(
      `SELECT event_id AS eventId, signature_token AS signatureToken, processed_at AS processedAt,
         event_type AS eventType,severity,recipient,provider_message_id AS providerMessageId,delivery_id AS deliveryId
       FROM email_feedback_events WHERE event_id = ?`,
      [input.eventId],
    )
    if (
      existing === null ||
      existing.eventType !== input.eventType ||
      existing.severity !== input.severity ||
      (existing.recipient?.toLowerCase() ?? null) !== (input.recipient?.toLowerCase() ?? null) ||
      existing.providerMessageId !== input.providerMessageId ||
      existing.deliveryId !== input.deliveryId
    ) {
      return 'token_reused'
    }
    if (existing.signatureToken !== input.signatureToken) {
      // A provider-API reconciliation has no signed webhook token. Spend the
      // later genuine token before acknowledging the exact same event.
      if (!aliases || existing.processedAt === null || !existing.signatureToken.startsWith('reconciliation:')) return 'token_reused'
      const proven = await database.first<{ present: number }>(
        `SELECT 1 AS present FROM reminder_reconciliation_feedback r, json_each(r.feedback_json) f
         WHERE r.delivery_id = ? AND json_extract(f.value, '$.eventId') = ?
           AND r.provider_message_id = ? LIMIT 1`,
        [input.deliveryId, input.eventId, input.providerMessageId],
      )
      if (proven === null) return 'token_reused'
      const alias = await database.first<{ token: string }>(
        `INSERT INTO reminder_reconciliation_webhook_tokens(signature_token, event_id)
         SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM email_feedback_events WHERE signature_token = ?)
         ON CONFLICT DO NOTHING RETURNING signature_token AS token`,
        [input.signatureToken, input.eventId, input.signatureToken],
      )
      if (alias === null) {
        const prior = await database.first<{ eventId: string }>(
          'SELECT event_id AS eventId FROM reminder_reconciliation_webhook_tokens WHERE signature_token = ?', [input.signatureToken],
        )
        if (prior?.eventId !== input.eventId) return 'token_reused'
      }
      return 'duplicate'
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

  async heldReminderAttempt(provider, deliveryId, attemptId) {
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(attemptId)) return false
    const row = await database.first<{ held: number }>(
      `SELECT 1 AS held FROM email_log WHERE id = ? AND provider = ? AND status = 'queued'
        AND template LIKE 'reminder:%' AND active_attempt_id = ? LIMIT 1`, [deliveryId, provider, attemptId])
    return row !== null
  },
  async recordInvoiceEvidence(eventId, now) {
    await database.all(
      `INSERT INTO invoice_feedback_provider_evidence(event_id, verified_at) VALUES (?, ?)
       ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, [eventId, now],
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
