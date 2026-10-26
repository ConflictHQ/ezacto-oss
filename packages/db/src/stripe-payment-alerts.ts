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
 AND julianday(s.idle_expires_at)>julianday(?) AND julianday(s.absolute_expires_at)>julianday(?) AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id))`
export const createStripePaymentAlertStore = (database: InvoiceStateDatabase) => ({
  async record(
    input: StripePaymentAlertInput,
    now: string,
  ): Promise<{ kind: 'flagged'; invoiceId: number } | { kind: 'ignored'; reason: string }> {
    // Match authoritative original receipt, never webhook metadata or current balance.
    // INSERT SELECT checks the receipt and amount in the same write as evidence custody.
    const rows = await database.all<{ invoice_id: number }>(sql`INSERT INTO stripe_payment_alerts
      (id,invoice_id,payment_id,payment_intent_id,object_id,event_type,kind,amount_cents,currency,provider_status,occurred_at,received_at)
      SELECT ${input.id},p.invoice_id,p.id,${input.paymentIntentId},${input.objectId},${input.eventType},${input.kind},
        ${input.amountCents},${input.currency},${input.providerStatus},${input.occurredAt},${now}
      FROM invoice_payments p JOIN payment_provider_accounts a ON a.id=p.provider_account_id
      WHERE a.provider='stripe' AND a.external_account_id='stripe' AND p.provider_transaction_id=${input.paymentIntentId}
        AND p.currency=${input.currency} AND ${input.amountCents}>0 AND ${input.amountCents}<=p.amount_cents
      ON CONFLICT(id) DO NOTHING RETURNING invoice_id`)
    if (rows[0]) return { kind: 'flagged', invoiceId: rows[0].invoice_id }
    const prior = await database.all<{ invoice_id: number }>(
      sql`SELECT invoice_id FROM stripe_payment_alerts WHERE id=${input.id}`,
    )
    if (prior[0]) return { kind: 'flagged', invoiceId: prior[0].invoice_id }
    return {
      kind: 'ignored',
      reason: 'provider report has no matching receipt, currency or valid amount',
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
          now,
          now,
        ],
      },
      {
        text: `UPDATE stripe_payment_alerts SET reviewed_at=(SELECT reviewed_at FROM stripe_payment_alert_reviews WHERE alert_id=?),
        reviewed_by=(SELECT actor_user_id FROM stripe_payment_alert_reviews WHERE alert_id=?)
        WHERE id=? AND invoice_id=? AND ${nativeAdmin} RETURNING id`,
        params: [
          alertId,
          alertId,
          alertId,
          invoiceId,
          authority.userId,
          authority.sessionId,
          now,
          now,
        ],
      },
    ])
    if (!updated?.length) return null
    const rows =
      await database.all<InvoiceProviderAlert>(sql`SELECT id,event_type,kind,amount_cents,currency,provider_status,occurred_at,reviewed_at,reviewed_by
      FROM stripe_payment_alerts WHERE id=${alertId} AND invoice_id=${invoiceId}`)
    return rows[0]?.reviewed_at ? rows[0] : null
  },
})

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
    const result = await recordNotificationMail(database, {
      kind,
      userId: row.user_id,
      scope: String(row.invoice_id),
      period: row.id,
      from: input.from,
      to: { email: row.email, name: row.name.trim() },
      template: 'stripe-payment-alert',
      subject: `Stripe report requires review: invoice ${row.number}`,
      text: `Stripe reported ${row.event_type} for invoice ${row.number} (${row.currency} ${(row.amount_cents / 100).toFixed(2)}).\n\nThe original receipt and invoice balance have not changed. Review the provider report and choose any accounting action separately.\n\n${new URL(`/invoices/${row.invoice_id}`, input.appUrl).href}`,
      related: { type: 'invoice', id: row.invoice_id },
      now: input.now,
    })
    if (result.outcome === 'recorded') messages.push(result.notification)
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
