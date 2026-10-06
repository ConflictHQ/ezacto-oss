import { composeReminder, daysPastDue, type ReminderInvoice } from '@ezacto/core'
import { sql } from 'drizzle-orm'
import {
  followUpHeaders,
  readThankYouRecipients,
  type ThankYouRecipient,
} from './automatic-thank-you.js'
import type { EmailConfigurationStore } from './email-configuration.js'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
import type { ScheduledReminderRecord } from './reminders.js'

/**
 * Everything between "this reminder is due" and "queue this message" (issue 801).
 *
 * The scheduler above it knows only that a row came due; the mailer below it
 * knows only how to send. This finds the audience, renders, records, and hands
 * back what to queue -- or `null` for every ordinary reason there is nothing
 * to send, so the scheduler's `send` callback never has to decide anything.
 *
 * The same shape as the thank-you port on purpose. A client should not be
 * able to tell from the formatting that one of these mails was sent because
 * money arrived and the other because it did not.
 */

export interface ReminderPortMessage {
  readonly deliveryId: number
  readonly senderIdentityId: number
  readonly senderIdentityVersion: number
  readonly senderEvidenceVersion: number
  readonly fromName: string
  readonly fromEmail: string
  readonly replyToEmail: string | null
  readonly to: readonly { readonly name: string; readonly email: string }[]
  readonly cc: readonly { readonly name: string; readonly email: string }[]
  readonly templateVersion: number
  readonly subject: string
  readonly textBody: string
  readonly htmlBody: string | null
}

export interface ReminderInvoiceSource {
  /** The invoice as the template needs it, less the balance, which is read here. */
  read(invoiceId: number): Promise<Omit<ReminderInvoice, 'dueAmountCents'> | null>
  /** Where the client pays online, or null where no link exists. */
  paymentUrl(invoiceId: number): Promise<string | null>
}

export type ReminderOutcome =
  | 'recorded'
  | 'already_sent'
  | 'no_recipients'
  | 'not_open'
  | 'sender_unusable'
  | 'template_missing'

const nextDeliveryId = async (database: InvoiceStateDatabase): Promise<number> => {
  const rows = await database.all<{ next: number }>(
    sql`SELECT COALESCE(MAX(id), 0) + 1 AS next FROM email_log`,
  )
  return rows[0]?.next ?? 1
}

export const hasReminderDelivery = async (
  database: InvoiceStateDatabase,
  scheduledReminderId: number,
): Promise<boolean> => {
  const rows = await database.all<{ present: number }>(
    sql`SELECT 1 AS present FROM invoice_reminder_deliveries
        WHERE scheduled_reminder_id = ${scheduledReminderId}`,
  )
  return rows.length > 0
}

/** What an invoice has been sent, for the detail screen. */
export interface ReminderDeliveryRecord {
  readonly scheduledReminderId: number
  readonly deliveryId: number
  readonly subject: string
  readonly daysPastDue: number
  readonly createdAt: string
}

export const listReminderDeliveries = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<readonly ReminderDeliveryRecord[]> =>
  database.all<ReminderDeliveryRecord>(
    sql`SELECT scheduled_reminder_id AS scheduledReminderId, delivery_id AS deliveryId,
               subject, days_past_due AS daysPastDue, created_at AS createdAt
        FROM invoice_reminder_deliveries WHERE invoice_id = ${invoiceId}
        ORDER BY created_at, scheduled_reminder_id`,
  )

export const createReminderPort = (
  options: Readonly<{
    database: InvoiceStateDatabase
    configuration: Pick<EmailConfigurationStore, 'getTemplate' | 'listSenderIdentities'>
    invoices: ReminderInvoiceSource
    now: () => string
  }>,
): { prepare(reminder: Readonly<ScheduledReminderRecord>): Promise<ReminderPortMessage | null> } => ({
  async prepare(reminder) {
    const { database } = options
    if (await hasReminderDelivery(database, reminder.id)) return null

    // The balance and state at send time, not when the row was scheduled: a
    // part payment since then changes what the reminder should say, and a
    // full one means it should not go at all. The scheduler cancels on
    // `invoice.paid`, and this is the same rule stated where the message is
    // built, so the two cannot disagree.
    const rows = await database.all<{ state: string; dueAmountCents: number }>(
      sql`SELECT state, due_amount_cents AS dueAmountCents FROM invoices WHERE id = ${reminder.invoiceId}`,
    )
    const current = rows[0]
    if (current === undefined || current.state !== 'open' || current.dueAmountCents <= 0) return null

    // Whoever was sent the invoice, the same answer the thank-you gives and for
    // the same reason: every address here already got mail about it.
    const recipients = await readThankYouRecipients(database, reminder.invoiceId)
    if (recipients.length === 0) return null

    const [invoice, template, senders, paymentUrl] = await Promise.all([
      options.invoices.read(reminder.invoiceId),
      options.configuration.getTemplate('reminder'),
      options.configuration.listSenderIdentities(),
      options.invoices.paymentUrl(reminder.invoiceId),
    ])
    if (invoice === null || template === null) return null
    const sender = senders.find(
      (candidate) => candidate.isDefault && candidate.archivedAt === null,
    )
    if (sender === undefined || sender.evidence === null) return null

    const now = options.now()
    const composed = composeReminder({
      invoice: { ...invoice, dueAmountCents: current.dueAmountCents },
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
      onDate: now,
      paymentUrl,
    })

    const deliveryId = await nextDeliveryId(database)
    // Recorded before it is queued, as the thank-you is: a record with no send
    // costs one reminder, a send with no record costs a client two.
    const outcome = await recordReminderDelivery(database, {
      scheduledReminderId: reminder.id,
      invoiceId: reminder.invoiceId,
      deliveryId,
      recipients,
      daysPastDue: daysPastDue(invoice.dueDate, now),
      now,
      ...composed,
    })
    if (outcome !== 'recorded') return null
    return { deliveryId, ...followUpHeaders(recipients), ...composed }
  },
})

export interface ReminderDelivery {
  readonly scheduledReminderId: number
  readonly invoiceId: number
  readonly deliveryId: number
  readonly templateVersion: number
  readonly senderIdentityId: number
  readonly senderIdentityVersion: number
  readonly senderEvidenceVersion: number
  readonly fromName: string
  readonly fromEmail: string
  readonly replyToEmail: string | null
  readonly recipients: readonly ThankYouRecipient[]
  readonly subject: string
  readonly textBody: string
  readonly htmlBody: string | null
  readonly daysPastDue: number
  readonly now: string
}

/**
 * Records the reminder: the delivery, and the row that explains it. Both or
 * neither, and the guards are re-stated as joins so a template rolled back or
 * an identity archived between the read and the write leaves no record
 * claiming a send that did not match what it was built from.
 */
export const recordReminderDelivery = async (
  database: InvoiceStateDatabase,
  input: Readonly<ReminderDelivery>,
): Promise<ReminderOutcome> => {
  const headers = followUpHeaders(input.recipients)
  if (headers.to.length === 0) return 'no_recipients'
  if (await hasReminderDelivery(database, input.scheduledReminderId)) return 'already_sent'
  const invoices = await database.all<{ state: string }>(
    sql`SELECT state FROM invoices WHERE id = ${input.invoiceId}`,
  )
  if (invoices[0]?.state !== 'open') return 'not_open'
  const templates = await database.all<{ version: number }>(
    sql`SELECT version FROM email_template_versions
        WHERE template_kind = 'reminder' AND version = ${input.templateVersion}`,
  )
  if (templates.length === 0) return 'template_missing'
  const senders = await database.all<{ id: number }>(
    sql`SELECT identity.id AS id FROM sender_identities identity
        JOIN sender_identity_evidence evidence
          ON evidence.sender_identity_id = identity.id
          AND evidence.evidence_version = ${input.senderEvidenceVersion}
        WHERE identity.id = ${input.senderIdentityId}
          AND identity.version = ${input.senderIdentityVersion}
          AND identity.archived_at IS NULL`,
  )
  if (senders.length === 0) return 'sender_unusable'

  await runAtomic(database, [
    {
      text: `INSERT INTO email_log (
          id, from_json, reply_to_json, to_json, cc_json, template, subject,
          related_type, related_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'invoice', ?, ?, ?`,
      params: [
        input.deliveryId,
        JSON.stringify({ email: input.fromEmail, name: input.fromName }),
        input.replyToEmail === null ? null : JSON.stringify([{ email: input.replyToEmail }]),
        JSON.stringify(
          headers.to.map((person) =>
            person.name === '' ? { email: person.email } : { email: person.email, name: person.name },
          ),
        ),
        headers.cc.length === 0
          ? null
          : JSON.stringify(
              headers.cc.map((person) =>
                person.name === '' ? { email: person.email } : { email: person.email, name: person.name },
              ),
            ),
        `reminder:${String(input.templateVersion)}`,
        input.subject,
        input.invoiceId,
        input.now,
        input.now,
      ],
    },
    {
      text: `INSERT INTO invoice_reminder_deliveries (
          scheduled_reminder_id, invoice_id, delivery_id, template_kind, template_version,
          sender_identity_id, sender_identity_version, sender_evidence_version,
          from_name, from_email, reply_to_email, subject, text_body, html_body,
          days_past_due, created_at
        )
        SELECT ?, ?, ?, 'reminder', template.version,
          identity.id, identity.version, evidence.evidence_version,
          ?, ?, ?, ?, ?, ?, ?, ?
        FROM sender_identities identity
        JOIN sender_identity_evidence evidence
          ON evidence.sender_identity_id = identity.id AND evidence.evidence_version = ?
        JOIN email_template_versions template
          ON template.template_kind = 'reminder' AND template.version = ?
        JOIN scheduled_reminders reminder ON reminder.id = ? AND reminder.invoice_id = ?
        WHERE identity.id = ? AND identity.version = ? AND identity.archived_at IS NULL`,
      params: [
        input.scheduledReminderId,
        input.invoiceId,
        input.deliveryId,
        input.fromName,
        input.fromEmail,
        input.replyToEmail,
        input.subject,
        input.textBody,
        input.htmlBody,
        input.daysPastDue,
        input.now,
        input.senderEvidenceVersion,
        input.templateVersion,
        input.scheduledReminderId,
        input.invoiceId,
        input.senderIdentityId,
        input.senderIdentityVersion,
      ],
    },
  ])
  return 'recorded'
}
