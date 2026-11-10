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

export interface InvoiceFeedbackRecoveryLedger extends EmailFeedbackLedger {
  claimInvoiceFeedbackSweep(token: string, now: string): Promise<string | null>
  scanInvoiceFeedback(afterId: string, limit: number): Promise<Array<{
    eventId: string; messageId: string | null; recipient: string | null; eventType: string; receivedAt: string; eligible: number
  }>>
  finishInvoiceFeedbackSweep(token: string, afterId: string, more: boolean, now: string): Promise<boolean>
  recordInvoiceEvidence(eventId: string, now: string): Promise<void>
}

const createLedger = (database: PortableDatabase): InvoiceFeedbackRecoveryLedger => ({
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
  async claimInvoiceFeedbackSweep(token, now) {
    const seconds = Math.floor(Date.parse(now) / 1000)
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(token) || !Number.isSafeInteger(seconds)) {
      throw new TypeError('invalid invoice feedback sweep claim')
    }
    const row = await database.first<{ afterId: string }>(
      `UPDATE invoice_feedback_recovery_cursor SET lease_token = ?, lease_expires_at = ?
       WHERE id = 1 AND next_due <= ? AND (lease_token IS NULL OR lease_expires_at <= ?)
       RETURNING after_event_id AS afterId`, [token, seconds + 180, seconds, seconds],
    )
    return row?.afterId ?? null
  },
  async scanInvoiceFeedback(afterId, limit) {
    if (typeof afterId !== 'string' || afterId.length > 255 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('invalid invoice feedback sweep page')
    }
    return database.all<{ eventId: string; messageId: string | null; recipient: string | null; eventType: string; receivedAt: string; eligible: number }>(
      `WITH page AS MATERIALIZED (SELECT * FROM email_feedback_events WHERE event_id > ? AND processed_at IS NOT NULL
        AND (event_type = 'complained' OR (event_type = 'failed' AND severity = 'permanent')) ORDER BY event_id LIMIT ?)
       SELECT f.event_id AS eventId, f.provider_message_id AS messageId, f.recipient AS recipient,
        f.event_type AS eventType, f.received_at AS receivedAt,
        CASE WHEN f.processed_at IS NOT NULL AND e.provider = 'mailgun' AND e.template LIKE 'invoice:%'
          AND e.provider_message_id = f.provider_message_id
          AND (f.event_type = 'complained' OR (f.event_type = 'failed' AND f.severity = 'permanent'))
          AND EXISTS (SELECT 1 FROM invoice_email_recipients r WHERE r.delivery_id = e.id AND lower(r.email) = lower(f.recipient))
          AND NOT EXISTS (SELECT 1 FROM invoice_feedback_provider_evidence p WHERE p.event_id = f.event_id)
        THEN 1 ELSE 0 END AS eligible
       FROM page f LEFT JOIN email_log e ON e.id = f.delivery_id ORDER BY f.event_id`, [afterId, limit],
    )
  },
  async finishInvoiceFeedbackSweep(token, afterId, more, now) {
    const seconds = Math.floor(Date.parse(now) / 1000)
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(token) ||
        typeof afterId !== 'string' || afterId.length > 255 || typeof more !== 'boolean' || !Number.isSafeInteger(seconds)) {
      throw new TypeError('invalid invoice feedback sweep completion')
    }
    const row = await database.first<{ id: number }>(
      `UPDATE invoice_feedback_recovery_cursor SET after_event_id = ?, next_due = ?, lease_token = NULL, lease_expires_at = NULL
       WHERE id = 1 AND lease_token = ? AND lease_expires_at > ? RETURNING id`,
      [afterId, seconds + (more ? 300 : 3600), token, seconds],
    )
    return row !== null
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
): InvoiceFeedbackRecoveryLedger => {
  database.pragma('foreign_keys = ON')
  return createLedger({
    first: async <T>(query: string, bindings: readonly unknown[] = []) =>
      (database.prepare(query).get(...bindings) as T | undefined) ?? null,
    all: async <T>(query: string, bindings: readonly unknown[] = []) =>
      database.prepare(query).all(...bindings) as T[],
  })
}

export const createD1EmailFeedbackLedger = (database: D1Database): InvoiceFeedbackRecoveryLedger =>
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
