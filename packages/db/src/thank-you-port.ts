import { composeThankYou, type ThankYouInvoice } from '@ezacto/core'
import { sql } from 'drizzle-orm'
import {
  readThankYouRecipients,
  recordThankYouDelivery,
  resolveThankYouPolicy,
} from './automatic-thank-you.js'
import type { EmailConfigurationStore } from './email-configuration.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * Everything between "this invoice is paid" and "queue this message" (issue 545).
 *
 * The subscriber above it knows only that an invoice settled; the store below
 * it knows only how to write the record. This is the part that decides, finds
 * the audience, renders and records -- and it returns `null` for every reason
 * there is nothing to send, so no caller has to re-derive the precedence rules
 * and reach a different answer.
 */

export interface ThankYouPortMessage {
  readonly deliveryId: number
  readonly senderIdentityId: number
  readonly senderIdentityVersion: number
  readonly senderEvidenceVersion: number
  readonly fromName: string
  readonly fromEmail: string
  readonly replyToEmail: string | null
  readonly to: readonly { readonly name: string; readonly email: string }[]
  readonly templateVersion: number
  readonly subject: string
  readonly textBody: string
  readonly htmlBody: string | null
}

/**
 * The invoice, as the template needs it.
 *
 * Supplied rather than read here, because reading an invoice and its lines
 * consistently is already solved -- and solved differently for D1 and the
 * container -- in the money resources.
 */
export interface ThankYouInvoiceSource {
  read(invoiceId: number): Promise<Omit<ThankYouInvoice, 'paidDate'> | null>
}

/**
 * The payment that settled this invoice, and when.
 *
 * The most recent payment, because `invoice.paid` is emitted exactly when the
 * status changes to paid, so the newest payment is the one that changed it. An
 * invoice settled, refunded and settled again by a later payment is a second
 * event with a second payment, and is thanked again -- which is right.
 */
const readSettlement = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ paymentId: number; paidDate: string | null } | null> => {
  const rows = await database.all<{ paymentId: number; paidDate: string | null }>(
    sql`SELECT payment.id AS paymentId, invoice.paid_date AS paidDate
        FROM invoice_payments payment
        JOIN invoices invoice ON invoice.id = payment.invoice_id
        WHERE payment.invoice_id = ${invoiceId}
        ORDER BY payment.id DESC LIMIT 1`,
  )
  return rows[0] ?? null
}

/**
 * The next `email_log` id.
 *
 * The same spelling `recordCheckoutPayment` uses for payment ids, and safe for
 * the same reason: two callers racing to the same number both write, and the
 * second loses on the intent's unique delivery, which aborts its batch.
 */
const nextDeliveryId = async (database: InvoiceStateDatabase): Promise<number> => {
  const rows = await database.all<{ next: number }>(
    sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM email_log`,
  )
  return rows[0]?.next ?? 1
}

export const createThankYouPort = (
  options: Readonly<{
    database: InvoiceStateDatabase
    configuration: Pick<EmailConfigurationStore, 'getTemplate' | 'listSenderIdentities'>
    invoices: ThankYouInvoiceSource
    now: () => string
  }>,
): { prepare(invoiceId: number): Promise<ThankYouPortMessage | null> } => ({
  async prepare(invoiceId) {
    // Read at send time, never captured when the invoice was raised: an
    // operator who turns this off today expects that to govern an invoice
    // raised yesterday.
    const policy = await resolveThankYouPolicy(options.database, invoiceId)
    if (!policy.send) return null

    const settlement = await readSettlement(options.database, invoiceId)
    if (settlement === null) return null

    const recipients = await readThankYouRecipients(options.database, invoiceId)
    if (recipients.length === 0) return null

    const [invoice, template, senders] = await Promise.all([
      options.invoices.read(invoiceId),
      options.configuration.getTemplate('thank_you'),
      options.configuration.listSenderIdentities(),
    ])
    if (invoice === null || template === null) return null
    const sender = senders.find(
      (candidate) => candidate.isDefault && candidate.archivedAt === null,
    )
    if (sender === undefined || sender.evidence === null) return null

    const composed = composeThankYou({
      invoice: { ...invoice, paidDate: settlement.paidDate },
      template: {
        version: template.version,
        subjectTemplate: template.subjectTemplate,
        textTemplate: template.textTemplate,
        htmlTemplate: template.htmlTemplate,
        unknownVariablePolicy: template.unknownVariablePolicy,
      },
      sender: {
        id: sender.id,
        version: sender.version,
        evidenceVersion: sender.evidence.version,
        displayName: sender.displayName,
        email: sender.email,
        replyToEmail: sender.replyToEmail,
      },
    })

    const deliveryId = await nextDeliveryId(options.database)
    // Recorded before it is queued. A record with no send costs one thank-you;
    // a send with no record costs a client two, because nothing then refuses
    // the redelivery.
    // `recorded` or nothing. This is also where a redelivered event stops: the
    // store answers `already_sent` off the intent's primary key, so idempotence
    // is a schema fact rather than a check anybody has to remember to make.
    const outcome = await recordThankYouDelivery(options.database, {
      invoicePaymentId: settlement.paymentId,
      invoiceId,
      deliveryId,
      recipients,
      now: options.now(),
      ...composed,
    })
    if (outcome !== 'recorded') return null

    return { deliveryId, to: recipients, ...composed }
  },
})
