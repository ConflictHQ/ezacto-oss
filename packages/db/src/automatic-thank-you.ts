import { sql } from 'drizzle-orm'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'

/**
 * Whether a settled invoice should send a thank-you (issue 545).
 *
 * Two levels, and the precedence is the load-bearing part: an invoice's own
 * preference wins, and an invoice that has none follows the global default.
 *
 * Read at send time rather than captured when the invoice was raised. An
 * operator who turns the feature off today expects that to govern an invoice
 * raised yesterday, and a preference frozen at creation would quietly keep
 * sending from invoices already in flight.
 */
export type ThankYouDecision =
  | { readonly send: true; readonly because: 'invoice' | 'organization' }
  | { readonly send: false; readonly because: 'invoice' | 'organization' | 'unknown_invoice' }

export const resolveThankYouPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<ThankYouDecision> => {
  const rows = await database.all<{
    invoice: number | null
    organization: number | null
  }>(
    sql`SELECT invoice.auto_thank_you AS invoice,
               (SELECT organization.auto_thank_you FROM organizations organization
                ORDER BY organization.id LIMIT 1) AS organization
        FROM invoices invoice WHERE invoice.id = ${invoiceId}`,
  )
  const row = rows[0]
  if (row === undefined) return { send: false, because: 'unknown_invoice' }
  if (row.invoice !== null) {
    return row.invoice === 1
      ? { send: true, because: 'invoice' }
      : { send: false, because: 'invoice' }
  }
  // No organization row at all is treated as off. A deployment that has not
  // been configured should not begin emailing clients because this shipped.
  return row.organization === 1
    ? { send: true, because: 'organization' }
    : { send: false, because: 'organization' }
}

/**
 * Whether this payment has already had its thank-you.
 *
 * The schema already refuses a second one -- the intent table is keyed on the
 * payment -- so this exists to let a caller decide rather than to catch a
 * constraint failure and guess what it meant.
 */
export const hasThankYouIntent = async (
  database: InvoiceStateDatabase,
  invoicePaymentId: number,
): Promise<boolean> => {
  const rows = await database.all<{ present: number }>(
    sql`SELECT 1 AS present FROM invoice_auto_email_intents
        WHERE invoice_payment_id = ${invoicePaymentId}`,
  )
  return rows.length > 0
}

export interface ThankYouPolicyUpdate {
  readonly invoiceId: number
  /** `null` hands the invoice back to the global default. */
  readonly enabled: boolean | null
}

export const setInvoiceThankYouPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<ThankYouPolicyUpdate>,
): Promise<boolean> => {
  // Asked before the write rather than counted after it: the two drivers behind
  // this seam report affected rows differently, and a caller wants to know
  // whether the invoice exists, not how many rows a driver decided to name.
  const present = await database.all<{ id: number }>(
    sql`SELECT id FROM invoices WHERE id = ${input.invoiceId}`,
  )
  if (present.length === 0) return false
  const value = input.enabled === null ? null : input.enabled ? 1 : 0
  await database.run(
    sql`UPDATE invoices SET auto_thank_you = ${value} WHERE id = ${input.invoiceId}`,
  )
  return true
}

export const setOrganizationThankYouPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => {
  await database.run(
    sql`UPDATE organizations SET auto_thank_you = ${enabled ? 1 : 0}`,
  )
}

export interface ThankYouRecipient {
  readonly name: string
  readonly email: string
}

/**
 * Everything the thank-you needs, already rendered.
 *
 * The rendering happens above this: which template version, which sender
 * identity, and what the interpolated subject and body came out as are the same
 * questions the confirmed invoice send answers, and answering them twice is how
 * the two would drift. What arrives here is the finished message plus the
 * versions it was built from, and this records it.
 */
export interface ThankYouDelivery {
  /** The payment that settled the invoice. The identity of the whole thing. */
  readonly invoicePaymentId: number
  readonly invoiceId: number
  /** The `email_log` row this send becomes. Derived by the caller, as sends are. */
  readonly deliveryId: number
  readonly templateVersion: number
  readonly senderIdentityId: number
  readonly senderIdentityVersion: number
  readonly senderEvidenceVersion: number
  readonly fromName: string
  readonly fromEmail: string
  readonly replyToEmail: string | null
  /**
   * Everyone, on one message. The intent is keyed on the payment and its
   * delivery is unique, so there is exactly one thank-you per payment -- which
   * is right: a client who received the invoice at three addresses is thanked
   * once, not three times.
   */
  readonly recipients: readonly ThankYouRecipient[]
  readonly subject: string
  readonly textBody: string
  readonly htmlBody: string | null
  readonly now: string
}

/**
 * Why a thank-you was or was not recorded.
 *
 * Answers rather than throws, for the same reason `recordCheckoutPayment` does:
 * every one of these is ordinary, and an exception would make the caller's
 * retry treat a correct answer as a failure and try again until it gave up.
 */
export type ThankYouOutcome =
  | 'recorded'
  | 'already_sent'
  | 'no_recipients'
  | 'not_settled'
  | 'imported_payment'
  | 'unknown_payment'
  | 'sender_unusable'
  | 'template_missing'

/**
 * Records the thank-you: the delivery, and the intent that explains it.
 *
 * Both rows or neither. The intent's `delivery_id` points at `email_log`, so
 * the delivery has to exist first -- which means a failure between them would
 * leave a delivery row with nothing recording why it was sent, and the record of
 * what a client received is the entire reason the intent table exists.
 *
 * The guards are asked before writing and re-stated as joins in the intent
 * insert. Asking first is what lets this name the reason instead of handing
 * back a constraint failure; re-stating them is what holds when the world
 * changes underneath.
 *
 * Two callers racing need nothing extra. Both read no intent, both write, and
 * the second loses on the intent's primary key -- which aborts its batch and
 * takes its delivery row with it. That is the migration's own thesis: the key
 * is the payment, so nothing has to remember what it already sent.
 */
export const recordThankYouDelivery = async (
  database: InvoiceStateDatabase,
  input: Readonly<ThankYouDelivery>,
): Promise<ThankYouOutcome> => {
  // A message addressed to nobody is not a send; it is a row claiming one.
  if (input.recipients.length === 0) return 'no_recipients'
  if (await hasThankYouIntent(database, input.invoicePaymentId)) return 'already_sent'

  const payments = await database.all<{
    invoiceId: number
    imported: number
    state: string
  }>(
    sql`SELECT payment.invoice_id AS invoiceId,
               CASE WHEN payment.harvest_id IS NULL THEN 0 ELSE 1 END AS imported,
               invoice.state AS state
        FROM invoice_payments payment
        JOIN invoices invoice ON invoice.id = payment.invoice_id
        WHERE payment.id = ${input.invoicePaymentId}`,
  )
  const payment = payments[0]
  if (payment === undefined || payment.invoiceId !== input.invoiceId) return 'unknown_payment'
  if (payment.imported === 1) return 'imported_payment'
  // A $10 payment against a $10,000 invoice is not "paid". The invoice's own
  // state is what decides that, and it lives here rather than in the caller so
  // a second caller cannot reach a different answer about the same payment.
  if (payment.state !== 'paid') return 'not_settled'

  const templates = await database.all<{ version: number }>(
    sql`SELECT version FROM email_template_versions
        WHERE template_kind = 'thank_you' AND version = ${input.templateVersion}`,
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
          id, from_json, reply_to_json, to_json, template, subject,
          related_type, related_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'invoice', ?, ?, ?`,
      params: [
        input.deliveryId,
        JSON.stringify({ email: input.fromEmail, name: input.fromName }),
        input.replyToEmail === null ? null : JSON.stringify([{ email: input.replyToEmail }]),
        JSON.stringify(
          input.recipients.map((person) =>
            person.name === '' ? { email: person.email } : { email: person.email, name: person.name },
          ),
        ),
        `thank_you:${String(input.templateVersion)}`,
        input.subject,
        input.invoiceId,
        input.now,
        input.now,
      ],
    },
    {
      // Re-stated as joins rather than trusted from the reads above: between
      // them an identity can be archived or a template rolled back, and the
      // wrong answer here is a permanent record of a send that did not match
      // what it claims to have been built from.
      text: `INSERT INTO invoice_auto_email_intents (
          invoice_payment_id, invoice_id, delivery_id, template_kind, template_version,
          sender_identity_id, sender_identity_version, sender_evidence_version,
          from_name, from_email, reply_to_email, subject, text_body, html_body,
          triggered_by, created_at
        )
        SELECT ?, ?, ?, 'thank_you', template.version,
          identity.id, identity.version, evidence.evidence_version,
          ?, ?, ?, ?, ?, ?, 'payment_settled', ?
        FROM sender_identities identity
        JOIN sender_identity_evidence evidence
          ON evidence.sender_identity_id = identity.id AND evidence.evidence_version = ?
        JOIN email_template_versions template
          ON template.template_kind = 'thank_you' AND template.version = ?
        JOIN invoices invoice ON invoice.id = ? AND invoice.state = 'paid'
        WHERE identity.id = ? AND identity.version = ? AND identity.archived_at IS NULL`,
      params: [
        input.invoicePaymentId,
        input.invoiceId,
        input.deliveryId,
        input.fromName,
        input.fromEmail,
        input.replyToEmail,
        input.subject,
        input.textBody,
        input.htmlBody,
        input.now,
        input.senderEvidenceVersion,
        input.templateVersion,
        input.invoiceId,
        input.senderIdentityId,
        input.senderIdentityVersion,
      ],
    },
  ])
  return 'recorded'
}

/**
 * Who to thank: whoever was sent the invoice.
 *
 * There is no other honest answer. Recipients are chosen by an operator on the
 * send, not derived from the client -- an invoice may go to one address in
 * accounts payable and not to the contact who signed the work -- so the client
 * record cannot supply them. Thanking the people who received the invoice is
 * also the only answer that cannot surprise anybody: every address here already
 * got mail about this invoice.
 *
 * The most recent send, because an invoice re-sent to a corrected address must
 * not thank the address that was wrong.
 */
export const readThankYouRecipients = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<readonly ThankYouRecipient[]> =>
  database.all<ThankYouRecipient>(
    sql`SELECT recipient.name AS name, recipient.email AS email
        FROM invoice_email_recipients recipient
        WHERE recipient.invoice_message_id = (
          SELECT message.id FROM invoice_messages message
          WHERE message.invoice_id = ${invoiceId} AND message.event_type = 'send'
          ORDER BY message.id DESC LIMIT 1
        )
        ORDER BY recipient.recipient_index`,
  )

/**
 * Both answers for one invoice, for a screen that has to show why.
 *
 * `resolveThankYouPolicy` answers what will happen; this answers what each
 * level said. An operator looking at one invoice needs both -- "off" and "off
 * because the whole organization is off" are different things to be looking at,
 * and only one of them is changed on this invoice.
 */
export const readThankYouPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ invoice: boolean | null; organization: boolean } | null> => {
  const rows = await database.all<{ invoice: number | null; organization: number | null }>(
    sql`SELECT invoice.auto_thank_you AS invoice,
               (SELECT organization.auto_thank_you FROM organizations organization
                ORDER BY organization.id LIMIT 1) AS organization
        FROM invoices invoice WHERE invoice.id = ${invoiceId}`,
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    invoice: row.invoice === null ? null : row.invoice === 1,
    organization: row.organization === 1,
  }
}

/** The organization default on its own, for the settings screen. */
export const readOrganizationThankYouPolicy = async (
  database: InvoiceStateDatabase,
): Promise<boolean> => {
  const rows = await database.all<{ enabled: number | null }>(
    sql`SELECT auto_thank_you AS enabled FROM organizations ORDER BY id LIMIT 1`,
  )
  return rows[0]?.enabled === 1
}
