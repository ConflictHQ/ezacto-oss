import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

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
  const rows = await database.all<{ invoice: number | null; organization: number | null }>(
    sql`SELECT invoice.attach_invoice_pdf AS invoice,
               (SELECT organization.attach_invoice_pdf FROM organizations organization
                ORDER BY organization.id LIMIT 1) AS organization
        FROM invoices invoice WHERE invoice.id = ${invoiceId}`,
  )
  const row = rows[0]
  if (row === undefined) return { attach: false, because: 'unknown_invoice' }
  if (row.invoice !== null) {
    return row.invoice === 1
      ? { attach: true, because: 'invoice' }
      : { attach: false, because: 'invoice' }
  }
  return row.organization === 1
    ? { attach: true, because: 'organization' }
    : { attach: false, because: 'organization' }
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
  const rows = await database.all<{ invoice: number | null; organization: number | null }>(
    sql`SELECT invoice.attach_invoice_pdf AS invoice,
               (SELECT organization.attach_invoice_pdf FROM organizations organization
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

export const readOrganizationAttachPolicy = async (
  database: InvoiceStateDatabase,
): Promise<boolean> => {
  const rows = await database.all<{ attach: number | null }>(
    sql`SELECT attach_invoice_pdf AS attach FROM organizations ORDER BY id LIMIT 1`,
  )
  return rows[0]?.attach === 1
}

export const setInvoiceAttachPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; enabled: boolean | null }>,
): Promise<boolean> => {
  const present = await database.all<{ id: number }>(
    sql`SELECT id FROM invoices WHERE id = ${input.invoiceId}`,
  )
  if (present.length === 0) return false
  const value = input.enabled === null ? null : input.enabled ? 1 : 0
  await database.run(
    sql`UPDATE invoices SET attach_invoice_pdf = ${value} WHERE id = ${input.invoiceId}`,
  )
  return true
}

export const setOrganizationAttachPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => {
  await database.run(
    sql`UPDATE organizations SET attach_invoice_pdf = ${enabled ? 1 : 0}`,
  )
}

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
  const rows = await database.all<{ invoice: number | null; organization: number | null }>(
    sql`SELECT invoice.attach_invoice_files AS invoice,
               (SELECT organization.attach_invoice_files FROM organizations organization
                ORDER BY organization.id LIMIT 1) AS organization
        FROM invoices invoice WHERE invoice.id = ${invoiceId}`,
  )
  const row = rows[0]
  if (row === undefined) return false
  return row.invoice === null ? row.organization === 1 : row.invoice === 1
}

export const readFilesPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<{ invoice: boolean | null; organization: boolean } | null> => {
  const rows = await database.all<{ invoice: number | null; organization: number | null }>(
    sql`SELECT invoice.attach_invoice_files AS invoice,
               (SELECT organization.attach_invoice_files FROM organizations organization
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

export const readOrganizationFilesPolicy = async (
  database: InvoiceStateDatabase,
): Promise<boolean> => {
  const rows = await database.all<{ attach: number | null }>(
    sql`SELECT attach_invoice_files AS attach FROM organizations ORDER BY id LIMIT 1`,
  )
  return rows[0]?.attach === 1
}

export const setInvoiceFilesPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; enabled: boolean | null }>,
): Promise<boolean> => {
  const present = await database.all<{ id: number }>(
    sql`SELECT id FROM invoices WHERE id = ${input.invoiceId}`,
  )
  if (present.length === 0) return false
  const value = input.enabled === null ? null : input.enabled ? 1 : 0
  await database.run(
    sql`UPDATE invoices SET attach_invoice_files = ${value} WHERE id = ${input.invoiceId}`,
  )
  return true
}

export const setOrganizationFilesPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => {
  await database.run(
    sql`UPDATE organizations SET attach_invoice_files = ${enabled ? 1 : 0}`,
  )
}

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
