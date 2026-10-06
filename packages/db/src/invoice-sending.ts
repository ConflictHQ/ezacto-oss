import { sql } from 'drizzle-orm'
import {
  defaultJournalFormats,
  invoiceEmailPattern,
  normalizeInvoiceAddresses,
  normalizeInvoiceRecipientLists,
  parseJournalFormats,
  type InvoiceAddress,
  type InvoiceRecipientLists,
  type JournalFormat,
} from '@ezacto/core'
import type { EmailConfigurationStore } from './email-configuration.js'
import {
  readClientInvoiceExtras,
  readOrganizationInvoiceExtras,
  setClientInvoiceExtras,
  type ClientInvoiceExtraKind,
  type InvoiceExtraValue,
} from './invoice-extras.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * Who an invoice email goes to, as standing rules rather than choices remade
 * on every send (migration 0099).
 *
 * Three sources, each answering a different question:
 *
 * - the client's own lists, saved from the Send dialog or the client page --
 *   accounts payable in To, the client's people in Cc;
 * - failing those, the contacts' invoice routing, which is how Harvest kept the
 *   same answer and what the import brought across: a contact marked Recipient
 *   is To, one marked CC is Cc;
 * - the organization's own mailboxes copied on every invoice email, and each
 *   person's choice to be copied on what they send.
 *
 * Addresses are stored as the mailer takes them -- lower-cased, trimmed, with
 * the display name beside them -- so what was saved is what is sent.
 */

const parseList = (value: unknown): InvoiceAddress[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is InvoiceAddress =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as InvoiceAddress).email === 'string' &&
          typeof (entry as InvoiceAddress).name === 'string',
      )
    : []

export interface ClientInvoiceRecipients {
  /** What was saved for this client, or `null` where nothing was. */
  readonly saved: InvoiceRecipientLists | null
  /** The contacts' invoice routing: Recipient is To, CC is Cc. */
  readonly contacts: InvoiceRecipientLists
}

/** A client's lists and its contacts' routing, or `null` for no such client. */
export const readClientInvoiceRecipients = async (
  database: InvoiceStateDatabase,
  clientId: number,
): Promise<ClientInvoiceRecipients | null> => {
  // `*`, so a database migration 0099 has not reached yet reads as a client
  // that saved nothing rather than failing to read the client at all.
  const clients = await database.all<Record<string, unknown>>(
    sql`SELECT * FROM clients WHERE id = ${clientId}`,
  )
  const client = clients[0]
  if (client === undefined) return null
  let saved: InvoiceRecipientLists | null = null
  if (typeof client.invoice_recipients === 'string') {
    const parsed = JSON.parse(client.invoice_recipients) as { to?: unknown; cc?: unknown }
    saved = { to: parseList(parsed.to), cc: parseList(parsed.cc) }
  }
  const contacts = await database.all<{
    name: string
    email: string
    routing: 'recipient' | 'cc'
  }>(
    sql`SELECT trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) AS name,
               lower(trim(email)) AS email, invoice_recipient_status AS routing
        FROM contacts
        WHERE client_id = ${clientId} AND invoice_recipient_status IN ('recipient', 'cc')
          AND email IS NOT NULL AND trim(email) <> ''
        ORDER BY id`,
  )
  // A contact listed twice, or routed both ways, is addressed once, in the
  // first header it appears in.
  const seen = new Set<string>()
  const routed = (routing: 'recipient' | 'cc') =>
    contacts
      .filter((contact) => contact.routing === routing && invoiceEmailPattern.test(contact.email))
      .filter((contact) => !seen.has(contact.email) && (seen.add(contact.email), true))
      .map(({ name, email }) => ({ name, email }))
  const to = routed('recipient')
  const cc = routed('cc')
  return { saved, contacts: { to, cc } }
}

/** The lists an invoice for this client opens with: what was saved, else the contacts. */
export const effectiveClientRecipients = (
  recipients: ClientInvoiceRecipients,
): InvoiceRecipientLists & { readonly source: 'client' | 'contacts' } =>
  recipients.saved === null
    ? { ...recipients.contacts, source: 'contacts' }
    : { ...recipients.saved, source: 'client' }

/**
 * Saves a client's lists, or clears them with `null` so the contacts' routing
 * answers again. `false` for no such client.
 */
export const setClientInvoiceRecipients = async (
  database: InvoiceStateDatabase,
  clientId: number,
  lists: InvoiceRecipientLists | null,
  updatedAt: string,
): Promise<boolean> => {
  const stored = lists === null ? null : JSON.stringify(normalizeInvoiceRecipientLists(lists))
  const rows = await database.all<{ id: number }>(
    sql`UPDATE clients SET invoice_recipients = ${stored}, updated_at = ${updatedAt}
        WHERE id = ${clientId} RETURNING id`,
  )
  return rows.length === 1
}

/** The organization's own mailboxes, copied on every invoice email. */
export const readOrganizationAlwaysCc = async (
  database: InvoiceStateDatabase,
): Promise<InvoiceAddress[]> => {
  const rows = await database.all<Record<string, unknown>>(
    sql`SELECT * FROM organizations ORDER BY id LIMIT 1`,
  )
  const stored = rows[0]?.invoice_always_cc
  return typeof stored === 'string' ? parseList(JSON.parse(stored)) : []
}

export const setOrganizationAlwaysCc = async (
  database: InvoiceStateDatabase,
  addresses: readonly InvoiceAddress[],
): Promise<InvoiceAddress[]> => {
  const normalized = normalizeInvoiceAddresses(addresses, 'always_cc', 20)
  await database.run(
    sql`UPDATE organizations SET invoice_always_cc = ${JSON.stringify(normalized)}`,
  )
  return normalized
}

export interface InvoiceSenderCopy {
  /** Whether this person is copied on the invoice emails they send. */
  readonly copy: boolean
  readonly name: string
  /** Their primary address, or `null` where they have none to be copied at. */
  readonly email: string | null
}

export const readInvoiceSenderCopy = async (
  database: InvoiceStateDatabase,
  userId: number,
): Promise<InvoiceSenderCopy | null> => {
  const rows = await database.all<Record<string, unknown>>(
    sql`SELECT person.*, trim(person.first_name || ' ' || person.last_name) AS display_name,
               address.address AS primary_email
        FROM users person
        LEFT JOIN user_emails address ON address.user_id = person.id
          AND address.is_primary = 1 AND address.invalidated_at IS NULL
        WHERE person.id = ${userId}`,
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    // A person a migration has not reached yet is copied, which is the default.
    copy: row.invoice_email_copy === undefined ? true : row.invoice_email_copy === 1,
    name: typeof row.display_name === 'string' ? row.display_name : '',
    email:
      typeof row.primary_email === 'string' && row.primary_email.trim() !== ''
        ? row.primary_email.trim().toLowerCase()
        : null,
  }
}

export const setInvoiceSenderCopy = async (
  database: InvoiceStateDatabase,
  userId: number,
  copy: boolean,
  updatedAt: string,
): Promise<boolean> => {
  const rows = await database.all<{ id: number }>(
    sql`UPDATE users SET invoice_email_copy = ${copy ? 1 : 0}, updated_at = ${updatedAt}
        WHERE id = ${userId} RETURNING id`,
  )
  return rows.length === 1
}

export type JournalLevelRule = 'detailed' | 'summary' | false

/** A client's attachment rules; `null` follows the organization. */
export interface ClientAttachmentRules {
  readonly attachPdf: boolean | null
  readonly appendPdfs: boolean | null
  readonly attachFiles: boolean | null
  readonly attachJournal: JournalLevelRule | null
  readonly journalFormats: readonly JournalFormat[] | null
}

export interface ClientInvoiceSending {
  readonly clientId: number
  readonly recipients: InvoiceRecipientLists | null
  readonly contacts: InvoiceRecipientLists
  readonly rules: ClientAttachmentRules
  readonly organization: {
    readonly attachPdf: boolean
    readonly appendPdfs: boolean
    readonly attachFiles: boolean
    readonly attachJournal: JournalLevelRule
    readonly journalFormats: readonly JournalFormat[]
  }
}

const levelOf = (value: InvoiceExtraValue | undefined): JournalLevelRule | null =>
  value === 'detailed' || value === 'summary' ? value : value === false ? false : null

const formatsOf = (value: InvoiceExtraValue | undefined): readonly JournalFormat[] | null =>
  Array.isArray(value) ? (value as readonly JournalFormat[]) : null

const booleanOf = (value: InvoiceExtraValue | undefined): boolean | null =>
  typeof value === 'boolean' ? value : null

/** A client's whole sending profile, or `null` for no such client. */
export const readClientInvoiceSending = async (
  database: InvoiceStateDatabase,
  clientId: number,
): Promise<ClientInvoiceSending | null> => {
  const [recipients, extras, organization] = await Promise.all([
    readClientInvoiceRecipients(database, clientId),
    readClientInvoiceExtras(database, clientId),
    readOrganizationInvoiceExtras(database),
  ])
  if (recipients === null || extras === null) return null
  return {
    clientId,
    recipients: recipients.saved,
    contacts: recipients.contacts,
    rules: {
      attachPdf: booleanOf(extras.document),
      appendPdfs: booleanOf(extras.append),
      attachFiles: booleanOf(extras.files),
      attachJournal: levelOf(extras.journal),
      journalFormats: formatsOf(extras.journal_formats),
    },
    organization: {
      attachPdf: booleanOf(organization.document) ?? false,
      appendPdfs: booleanOf(organization.append) ?? false,
      attachFiles: booleanOf(organization.files) ?? false,
      attachJournal: levelOf(organization.journal) ?? false,
      journalFormats: formatsOf(organization.journal_formats) ?? defaultJournalFormats,
    },
  }
}

/**
 * Changes a client's sending profile. Recipients absent are left as they are
 * and null hands them back to the contacts; each rule absent is left as it is
 * and null hands it back to the organization. `null` for no such client.
 */
export const saveClientInvoiceSending = async (
  database: InvoiceStateDatabase,
  clientId: number,
  change: Readonly<{
    recipients?: InvoiceRecipientLists | null
    rules?: Partial<ClientAttachmentRules>
  }>,
  updatedAt: string,
): Promise<ClientInvoiceSending | null> => {
  const current = await readClientInvoiceExtras(database, clientId)
  if (current === null) return null
  if (change.recipients !== undefined) {
    await setClientInvoiceRecipients(database, clientId, change.recipients, updatedAt)
  }
  if (change.rules !== undefined) {
    const next: Partial<Record<ClientInvoiceExtraKind, InvoiceExtraValue>> = { ...current }
    const apply = (kind: ClientInvoiceExtraKind, value: InvoiceExtraValue | null | undefined) => {
      if (value === undefined) return
      if (value === null) delete next[kind]
      else next[kind] = value
    }
    apply('document', change.rules.attachPdf)
    apply('append', change.rules.appendPdfs)
    apply('files', change.rules.attachFiles)
    apply('journal', change.rules.attachJournal)
    if (change.rules.journalFormats !== undefined && change.rules.journalFormats !== null) {
      const parsed = parseJournalFormats(change.rules.journalFormats)
      if (parsed === null) throw new RangeError('journal formats must be a non-empty set of pdf, csv and xlsx')
      apply('journal_formats', parsed)
    } else apply('journal_formats', change.rules.journalFormats)
    await setClientInvoiceExtras(database, clientId, next, updatedAt)
  }
  return readClientInvoiceSending(database, clientId)
}

export interface InvoiceEmailDefaults {
  readonly invoiceId: number
  readonly clientId: number
  /** The two names the dialog fills the record of the send with. */
  readonly companyName: string
  readonly clientName: string
  readonly templateVersion: number
  readonly subject: string
  readonly message: string
  readonly to: readonly InvoiceAddress[]
  readonly cc: readonly InvoiceAddress[]
  readonly recipientsSource: 'client' | 'contacts'
  readonly alwaysCc: readonly InvoiceAddress[]
  readonly sender: { readonly name: string; readonly email: string | null }
  readonly sendMeACopy: boolean
}

/**
 * Everything the Send dialog opens on for one invoice: the organization's
 * invoice template as the subject and message to start from, the client's
 * lists or its contacts' routing, the organization's copies, and whether the
 * person asking is copied. `null` for no such invoice.
 */
export const readInvoiceEmailDefaults = async (
  database: InvoiceStateDatabase,
  configuration: Pick<EmailConfigurationStore, 'getTemplate'>,
  invoiceId: number,
  userId: number,
): Promise<InvoiceEmailDefaults | null> => {
  const invoices = await database.all<{ clientId: number; clientName: string; companyName: string | null }>(
    sql`SELECT invoice.client_id AS clientId, client.name AS clientName,
               (SELECT name FROM organizations ORDER BY id LIMIT 1) AS companyName
        FROM invoices invoice JOIN clients client ON client.id = invoice.client_id
        WHERE invoice.id = ${invoiceId}`,
  )
  const invoice = invoices[0]
  if (invoice === undefined) return null
  const [template, recipients, alwaysCc, sender] = await Promise.all([
    configuration.getTemplate('invoice'),
    readClientInvoiceRecipients(database, invoice.clientId),
    readOrganizationAlwaysCc(database),
    readInvoiceSenderCopy(database, userId),
  ])
  if (template === null || recipients === null) return null
  const effective = effectiveClientRecipients(recipients)
  return {
    invoiceId,
    clientId: invoice.clientId,
    companyName: invoice.companyName ?? '',
    clientName: invoice.clientName,
    templateVersion: template.version,
    subject: template.subjectTemplate,
    message: template.textTemplate,
    to: effective.to,
    cc: effective.cc,
    recipientsSource: effective.source,
    alwaysCc,
    sender: { name: sender?.name ?? '', email: sender?.email ?? null },
    sendMeACopy: sender?.copy ?? false,
  }
}

/**
 * Preview emails an invoice has sent since an instant, read off the email log
 * the mailer keeps for them, so the limit is counted where the sends are.
 */
export const countInvoicePreviewsSince = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
  since: string,
): Promise<number> => {
  const rows = await database.all<{ count: number }>(
    sql`SELECT count(*) AS count FROM email_log
        WHERE related_type = 'invoice_preview' AND related_id = ${invoiceId}
          AND created_at >= ${since}`,
  )
  return rows[0]?.count ?? 0
}
