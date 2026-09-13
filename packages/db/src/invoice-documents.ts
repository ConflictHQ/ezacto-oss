import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'
import {
  isExtraEnabled,
  type InvoiceExtraValue,
  readInvoiceExtras,
  readOrganizationInvoiceExtras,
  resolveInvoiceExtra,
  setInvoiceExtra,
  setOrganizationInvoiceExtra,
} from './invoice-extras.js'

/**
 * Whether an invoice arrives with its document, and what was actually sent
 * (issue 626).
 *
 * The preference follows the precedence migration 0053 settled for the
 * automatic thank-you: the invoice's own answer wins, an invoice with none
 * follows the organization, and the question is asked at send time rather than
 * captured when the invoice was raised. One rule in this product rather than
 * two that drift apart.
 */

export type AttachDecision =
  | { readonly attach: true; readonly because: 'invoice' | 'organization' }
  | { readonly attach: false; readonly because: 'invoice' | 'organization' | 'unknown_invoice' }

export const resolveAttachPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<AttachDecision> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return { attach: false, because: 'unknown_invoice' }
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, 'document')
  const because = resolved.invoice === null ? 'organization' : 'invoice'
  return isExtraEnabled(resolved.effective)
    ? { attach: true, because }
    : { attach: false, because }
}
/**
 * Both answers at once, for a screen that has to show what will happen and why.
 *
 * Reading them separately would let the two come from different moments, and an
 * operator would be shown a precedence that was never true.
 */
export const readAttachPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ invoice: boolean | null; organization: boolean } | null> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return null
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, 'document')
  return {
    invoice: resolved.invoice === null ? null : isExtraEnabled(resolved.invoice),
    organization: isExtraEnabled(resolved.organization),
  }
}
export const readOrganizationAttachPolicy = async (
  database: InvoiceStateDatabase,
): Promise<boolean> =>
  isExtraEnabled(
    resolveInvoiceExtra(await readOrganizationInvoiceExtras(database), {}, 'document').organization,
  )
export const setInvoiceAttachPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; enabled: boolean | null }>,
): Promise<boolean> => setInvoiceExtra(database, input.invoiceId, 'document', input.enabled)
export const setOrganizationAttachPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => setOrganizationInvoiceExtra(database, 'document', enabled)
/**
 * Whether the files staged against an invoice go with it.
 *
 * Same precedence as the document, and a separate answer: an operator who wants
 * a purchase order returned has not thereby asked for the invoice as a PDF.
 */
export const resolveFilesPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<boolean> => {
  // A plain boolean, unlike the document's decision, because the only caller
  // asks "do these go?" and nothing needs to explain which level answered. It
  // stays a boolean deliberately: the worker port writes
  // `(await resolveFilesPolicy(...)) ? ... : []`, and a truthy object there
  // would attach every staged file to every invoice, silently.
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return false
  return isExtraEnabled(resolveInvoiceExtra(both.organization, both.invoice, 'files').effective)
}
export const readFilesPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ invoice: boolean | null; organization: boolean } | null> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return null
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, 'files')
  return {
    invoice: resolved.invoice === null ? null : isExtraEnabled(resolved.invoice),
    organization: isExtraEnabled(resolved.organization),
  }
}
export const readOrganizationFilesPolicy = async (
  database: InvoiceStateDatabase,
): Promise<boolean> =>
  isExtraEnabled(
    resolveInvoiceExtra(await readOrganizationInvoiceExtras(database), {}, 'files').organization,
  )
export const setInvoiceFilesPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; enabled: boolean | null }>,
): Promise<boolean> => setInvoiceExtra(database, input.invoiceId, 'files', input.enabled)
export const setOrganizationFilesPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => setOrganizationInvoiceExtra(database, 'files', enabled)

export interface StagedAttachment {
  readonly key: string
  readonly filename: string
  readonly contentType: string
  readonly byteSize: number
}

/**
 * The files an operator staged against this invoice, ready to attach.
 *
 * Ordered by when they were attached, so a client opening two of them meets
 * them in the order somebody put them there.
 */
export const readStagedAttachments = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<readonly StagedAttachment[]> =>
  database.all<StagedAttachment>(
    sql`SELECT object.file_key AS key, attachment.name AS filename,
               object.content_type AS contentType, object.byte_size AS byteSize
        FROM invoice_attachments link
        JOIN attachments attachment ON attachment.id = link.attachment_id
        JOIN file_objects object ON object.id = attachment.file_object_id
        WHERE link.invoice_id = ${invoiceId}
        ORDER BY attachment.created_at, attachment.id`,
  )

export interface AttachedDocument {
  readonly invoiceMessageId: number
  readonly invoiceId: number
  readonly objectKey: string
  readonly filename: string
  readonly contentType: string
  readonly byteSize: number
  readonly invoiceVersion: number
}

/**
 * Records what went with a message.
 *
 * Written once, at the moment the message is composed, alongside the body that
 * is persisted for the same reason: a client disputing what they received is
 * answered by the file they were sent. Re-rendering later would answer a
 * different question, because the invoice may have moved on since.
 */
export const recordAttachedDocument = async (
  database: InvoiceStateDatabase,
  input: Readonly<AttachedDocument & { now: string }>,
): Promise<void> => {
  await database.run(
    sql`INSERT INTO invoice_message_documents
          (invoice_message_id, invoice_id, object_key, filename, content_type,
           byte_size, invoice_version, created_at)
        VALUES (${input.invoiceMessageId}, ${input.invoiceId}, ${input.objectKey},
                ${input.filename}, ${input.contentType}, ${input.byteSize},
                ${input.invoiceVersion}, ${input.now})`,
  )
}

export const readAttachedDocument = async (
  database: InvoiceStateDatabase,
  invoiceMessageId: number,
): Promise<AttachedDocument | null> => {
  const rows = await database.all<{
    invoiceMessageId: number
    invoiceId: number
    objectKey: string
    filename: string
    contentType: string
    byteSize: number
    invoiceVersion: number
  }>(
    sql`SELECT invoice_message_id AS invoiceMessageId, invoice_id AS invoiceId,
               object_key AS objectKey, filename, content_type AS contentType,
               byte_size AS byteSize, invoice_version AS invoiceVersion
        FROM invoice_message_documents WHERE invoice_message_id = ${invoiceMessageId}`,
  )
  return rows[0] ?? null
}

/**
 * The object key a document is stored under.
 *
 * Derived rather than random, so the same message cannot end up with two
 * objects, and scoped by invoice so an operator reading the bucket can tell
 * what they are looking at.
 */
export const invoiceDocumentKey = (invoiceId: number, invoiceMessageId: number): string =>
  `invoice-documents/${String(invoiceId)}/${String(invoiceMessageId)}.pdf`

/** What the recipient sees the file called. */
export const invoiceDocumentFilename = (invoiceNumber: string): string =>
  `invoice-${invoiceNumber.replace(/[^A-Za-z0-9._-]/gu, '-')}.pdf`

/**
 * The work behind an invoice, for the journal that can go with it (issue 647).
 *
 * Reads the entries this invoice actually billed -- `time_entries.invoice_id` is
 * set when they are claimed -- rather than re-deriving them from a date range.
 * A range would drift: entries can be released from an invoice, and two
 * invoices can cover overlapping weeks for different projects.
 *
 * `rounded_seconds` where it exists, because that is what was billed. Showing
 * the raw duration next to a total computed from the rounded one is a client
 * asking why the arithmetic does not work.
 */
export interface InvoiceJournalEntry {
  readonly spentDate: string
  readonly personName: string
  readonly projectName: string
  readonly taskName: string | null
  readonly notes: string | null
  readonly seconds: number
}

export const readInvoiceJournal = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<readonly InvoiceJournalEntry[]> =>
  database.all<InvoiceJournalEntry>(
    sql`SELECT entry.spent_date AS spentDate,
               trim(coalesce(person.first_name, '') || ' ' || coalesce(person.last_name, ''))
                 AS personName,
               project.name AS projectName,
               task.name AS taskName,
               entry.notes AS notes,
               coalesce(entry.rounded_seconds, entry.seconds) AS seconds
        FROM time_entries entry
        JOIN users person ON person.id = entry.user_id
        JOIN projects project ON project.id = entry.project_id
        LEFT JOIN tasks task ON task.id = entry.task_id
        WHERE entry.invoice_id = ${invoiceId}
        ORDER BY entry.spent_date, entry.id`,
  )

/**
 * Whether the work journal goes with this invoice, and at which level.
 *
 * `false` is off; `'detailed'` is every entry billed; `'summary'` is the same
 * hours totalled per project. Three answers rather than two, which is the reason
 * issue 647 made these a set instead of a fourth boolean pair: a client checking
 * an unexpected total wants the entries, a client filing the invoice wants a
 * page rather than forty, and the operator picks.
 */
export type JournalLevel = 'detailed' | 'summary'

export const resolveJournalPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<JournalLevel | null> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return null
  const effective = resolveInvoiceExtra(both.organization, both.invoice, 'journal').effective
  return effective === 'detailed' || effective === 'summary' ? effective : null
}

/** `null` on the invoice hands it back to the organization. */
export const setInvoiceJournalPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; level: JournalLevel | false | null }>,
): Promise<boolean> => setInvoiceExtra(database, input.invoiceId, 'journal', input.level)

export const setOrganizationJournalPolicy = async (
  database: InvoiceStateDatabase,
  level: JournalLevel | false,
): Promise<void> => setOrganizationInvoiceExtra(database, 'journal', level)

/** Both answers, for a screen that shows what will happen and why. */
export const readJournalPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ invoice: JournalLevel | false | null; organization: JournalLevel | false } | null> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return null
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, 'journal')
  const level = (value: InvoiceExtraValue | null): JournalLevel | false | null =>
    value === 'detailed' || value === 'summary' ? value : value === null ? null : false
  return {
    invoice: level(resolved.invoice),
    organization: level(resolved.organization) === null ? false : (level(resolved.organization) as JournalLevel | false),
  }
}

export const readOrganizationJournalPolicy = async (
  database: InvoiceStateDatabase,
): Promise<JournalLevel | false> => {
  const value = resolveInvoiceExtra(
    await readOrganizationInvoiceExtras(database),
    {},
    'journal',
  ).organization
  return value === 'detailed' || value === 'summary' ? value : false
}
