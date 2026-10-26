import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import { atomicStatements } from './atomic-statements.js'
import {
  recordNotificationMail,
  readStrandedNotifications,
  type RecordedNotification,
} from './notification-mail.js'

export interface StripePaymentAlertInput {
  id: string
  eventType: string
  kind: 'refund' | 'dispute'
  paymentIntentId: string
  objectId: string
  amountCents: number
  currency: string
  providerStatus: string
  occurredAt: string
}
export interface InvoiceProviderAlert {
  id: string
  event_type: string
  kind: 'refund' | 'dispute'
  amount_cents: number
  currency: string
  provider_status: string
  occurred_at: string
  reviewed_at: string | null
  reviewed_by: number | null
}
const fields =
  'id,event_type,kind,amount_cents,currency,provider_status,occurred_at,reviewed_at,reviewed_by'
const nativeAdmin = `EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
 WHERE u.id=? AND u.is_active=1 AND u.profile='administrator' AND s.id=?
 AND s.revoked_at IS NULL AND s.profile_snapshot=u.profile AND json(s.manager_grants_snapshot)=json(u.manager_grants)
 AND julianday(s.idle_expires_at)>julianday('now') AND julianday(s.absolute_expires_at)>julianday('now') AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id))`
export const createStripePaymentAlertStore = (database: InvoiceStateDatabase) => {
  const match = async (id: string) => {
    await atomicStatements(database, [
      {
        text: `INSERT INTO stripe_payment_alerts
      (id,invoice_id,payment_id,payment_intent_id,object_id,event_type,kind,amount_cents,currency,provider_status,occurred_at,received_at)
      SELECT i.id,p.invoice_id,p.id,i.payment_intent_id,i.object_id,i.event_type,i.kind,i.amount_cents,i.currency,i.provider_status,i.occurred_at,i.received_at
      FROM stripe_payment_alert_inbox i JOIN invoice_payments p ON p.provider_transaction_id=i.payment_intent_id
      JOIN payment_provider_accounts a ON a.id=p.provider_account_id
      WHERE i.id=? AND a.provider='stripe' AND a.external_account_id='stripe'
        AND p.currency=i.currency AND i.amount_cents<=p.amount_cents
      ON CONFLICT(id) DO NOTHING RETURNING id`,
        params: [id],
      },
      {
        // Known-invalid amounts/currencies are refused; unknown receipts retain custody.
        text: `DELETE FROM stripe_payment_alert_inbox WHERE id=? AND (EXISTS(SELECT 1 FROM stripe_payment_alerts a WHERE a.id=?)
        OR EXISTS(SELECT 1 FROM invoice_payments p JOIN payment_provider_accounts a ON a.id=p.provider_account_id
          WHERE a.provider='stripe' AND a.external_account_id='stripe' AND p.provider_transaction_id=stripe_payment_alert_inbox.payment_intent_id)) RETURNING id`,
        params: [id, id],
      },
    ])
  }
  const reconcile = async (now: string, paymentIntentId: string | null = null) => {
    await database.run(sql`DELETE FROM stripe_payment_alert_inbox WHERE expires_at<=${now}`)
    const candidates = await database.all<{
      id: string
    }>(sql`SELECT id FROM stripe_payment_alert_inbox
      WHERE (${paymentIntentId} IS NULL OR payment_intent_id=${paymentIntentId})
      AND EXISTS(SELECT 1 FROM invoice_payments p JOIN payment_provider_accounts a ON a.id=p.provider_account_id
        WHERE a.provider='stripe' AND a.external_account_id='stripe' AND p.provider_transaction_id=stripe_payment_alert_inbox.payment_intent_id)
      ORDER BY received_at,id LIMIT 5`)
    for (const item of candidates) await match(item.id)
    return { checked: candidates.length }
  }
  return {
    processDue: (now: string) => reconcile(now),
    reconcileForPayment: (id: string, now: string) => reconcile(now, id),
    async record(
      input: StripePaymentAlertInput,
      now: string,
    ): Promise<{ kind: 'flagged'; invoiceId: number } | { kind: 'ignored'; reason: string }> {
      const existing = await database.all<{ invoice_id: number }>(
        sql`SELECT invoice_id FROM stripe_payment_alerts WHERE id=${input.id}`,
      )
      if (existing[0]) return { kind: 'flagged', invoiceId: existing[0].invoice_id }
      await database.run(sql`INSERT INTO stripe_payment_alert_inbox
      (id,event_type,kind,payment_intent_id,object_id,amount_cents,currency,provider_status,occurred_at,received_at,expires_at)
      SELECT ${input.id},${input.eventType},${input.kind},${input.paymentIntentId},${input.objectId},${input.amountCents},${input.currency},${input.providerStatus},${input.occurredAt},${now},${new Date(Date.parse(now) + 30 * 86400000).toISOString()}
      WHERE (SELECT count(*) FROM stripe_payment_alert_inbox)<5000 ON CONFLICT(id) DO NOTHING`)
      const held = await database.all<{ id: string }>(
        sql`SELECT id FROM stripe_payment_alert_inbox WHERE id=${input.id}`,
      )
      if (!held.length) {
        // Another delivery may already have moved this inbox row into evidence.
        const completed = await database.all<{ invoice_id: number }>(
          sql`SELECT invoice_id FROM stripe_payment_alerts WHERE id=${input.id}`,
        )
        if (completed[0]) return { kind: 'flagged', invoiceId: completed[0].invoice_id }
        const refused = await database.all<{
          id: number
        }>(sql`SELECT p.id FROM invoice_payments p JOIN payment_provider_accounts a ON a.id=p.provider_account_id
          WHERE a.provider='stripe' AND a.external_account_id='stripe' AND p.provider_transaction_id=${input.paymentIntentId}
          AND (p.currency<>${input.currency} OR p.amount_cents<${input.amountCents})`)
        if (refused.length)
          return {
            kind: 'ignored',
            reason: 'provider report currency or amount does not match original receipt',
          }
        throw new Error('Stripe report custody capacity unavailable')
      }
      await match(input.id)
      const matched = await database.all<{ invoice_id: number }>(
        sql`SELECT invoice_id FROM stripe_payment_alerts WHERE id=${input.id}`,
      )
      if (matched[0]) return { kind: 'flagged', invoiceId: matched[0].invoice_id }
      const pending = await database.all<{ id: string }>(
        sql`SELECT id FROM stripe_payment_alert_inbox WHERE id=${input.id}`,
      )
      return {
        kind: 'ignored',
        reason: pending.length
          ? 'provider report retained awaiting original receipt'
          : 'provider report currency or amount does not match original receipt',
      }
    },
    async list(invoiceId: number): Promise<InvoiceProviderAlert[]> {
      return database.all<InvoiceProviderAlert>(
        sql.raw(
          `SELECT ${fields} FROM stripe_payment_alerts WHERE invoice_id=${invoiceId} ORDER BY occurred_at DESC,id DESC`,
        ),
      )
    },
    async review(
      invoiceId: number,
      alertId: string,
      authority: { userId: number; sessionId: string },
      now: string,
    ): Promise<InvoiceProviderAlert | null> {
      const [, updated] = await atomicStatements(database, [
        {
          text: `INSERT INTO stripe_payment_alert_reviews(alert_id,actor_user_id,reviewed_at)
        SELECT id,?,? FROM stripe_payment_alerts WHERE id=? AND invoice_id=? AND ${nativeAdmin}
        ON CONFLICT(alert_id) DO NOTHING RETURNING alert_id`,
          params: [
            authority.userId,
            now,
            alertId,
            invoiceId,
            authority.userId,
            authority.sessionId,
          ],
        },
        {
          text: `UPDATE stripe_payment_alerts SET reviewed_at=(SELECT reviewed_at FROM stripe_payment_alert_reviews WHERE alert_id=?),
        reviewed_by=(SELECT actor_user_id FROM stripe_payment_alert_reviews WHERE alert_id=?)
        WHERE id=? AND invoice_id=? AND ${nativeAdmin} RETURNING id`,
          params: [alertId, alertId, alertId, invoiceId, authority.userId, authority.sessionId],
        },
      ])
      if (!updated?.length) return null
      const rows =
        await database.all<InvoiceProviderAlert>(sql`SELECT id,event_type,kind,amount_cents,currency,provider_status,occurred_at,reviewed_at,reviewed_by
      FROM stripe_payment_alerts WHERE id=${alertId} AND invoice_id=${invoiceId}`)
      return rows[0]?.reviewed_at ? rows[0] : null
    },
  }
}

/** Durable notice preparation runs separately from webhook custody and repairs interrupted queue sends. */
export const prepareStripePaymentAlertNotifications = async (
  database: InvoiceStateDatabase,
  input: { now: string; appUrl: string; from: { email: string; name?: string } },
): Promise<readonly RecordedNotification[]> => {
  const kind = 'stripe_payment_alert'
  const rows = await database.all<{
    id: string
    invoice_id: number
    number: string
    event_type: string
    amount_cents: number
    currency: string
    user_id: number
    name: string
    email: string
  }>(sql`
    SELECT alert.id,alert.invoice_id,i.number,alert.event_type,alert.amount_cents,alert.currency,u.id AS user_id,u.first_name||' '||u.last_name AS name,e.address AS email
    FROM stripe_payment_alerts alert JOIN invoices i ON i.id=alert.invoice_id
    JOIN users u ON u.is_active=1 AND u.profile='administrator'
    JOIN user_emails e ON e.user_id=u.id AND e.is_primary=1 AND e.verified_at IS NOT NULL AND e.invalidated_at IS NULL
    WHERE NOT EXISTS(SELECT 1 FROM notification_deliveries n WHERE n.kind=${kind} AND n.user_id=u.id AND n.scope=CAST(alert.invoice_id AS TEXT) AND n.period=alert.id)
    ORDER BY alert.received_at,alert.id,u.id LIMIT 5`)
  const messages: RecordedNotification[] = []
  for (const row of rows) {
    try {
      const result = await recordNotificationMail(database, {
        kind,
        userId: row.user_id,
        scope: String(row.invoice_id),
        period: row.id,
        from: input.from,
        to: { email: row.email, name: row.name.trim() },
        template: 'stripe-payment-alert',
        subject: `Stripe report requires review: invoice ${row.number}`,
        text: `Stripe reported ${row.event_type} for invoice ${row.number} (${row.currency} ${(row.amount_cents / 100).toFixed(2)}).\n\nThe original receipt and invoice balance have not changed. Review the provider report and choose any accounting action separately.\n\n${new URL(`/invoices/by-id/${row.invoice_id}`, input.appUrl).href}`,
        related: { type: 'invoice', id: row.invoice_id },
        now: input.now,
      })
      if (result.outcome === 'recorded') messages.push(result.notification)
    } catch (error) {
      const current = await database.all<{
        id: number
      }>(sql`SELECT u.id FROM users u JOIN user_emails e ON e.user_id=u.id
        WHERE u.id=${row.user_id} AND u.is_active=1 AND u.profile='administrator' AND e.address=${row.email}
          AND e.is_primary=1 AND e.verified_at IS NOT NULL AND e.invalidated_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id)`)
      if (current.length) throw error
    }
  }
  const stranded = await readStrandedNotifications(database, {
    kind,
    olderThan: new Date(Date.parse(input.now) - 60000).toISOString(),
    limit: 5,
  })
  for (const notice of stranded) {
    if (messages.some((m) => m.deliveryId === notice.deliveryId)) continue
    const active = await database.all<{ id: number }>(
      sql`SELECT u.id FROM users u JOIN user_emails e ON e.user_id=u.id WHERE u.id=(SELECT user_id FROM notification_deliveries WHERE delivery_id=${notice.deliveryId}) AND u.is_active=1 AND u.profile='administrator' AND e.is_primary=1 AND e.address=${notice.to.email} AND e.verified_at IS NOT NULL AND e.invalidated_at IS NULL`,
    )
    if (active.length) messages.push(notice)
  }
  return messages
}
