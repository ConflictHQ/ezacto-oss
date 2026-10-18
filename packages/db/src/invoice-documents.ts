import {
  defaultJournalFormats,
  parseJournalFormats,
  reportNoteIsClientVisible,
  type JournalFormat,
  type JournalSource,
} from '@ezacto/core'
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
  | { readonly attach: true; readonly because: 'invoice' | 'client' | 'organization' }
  | {
      readonly attach: false
      readonly because: 'invoice' | 'client' | 'organization' | 'unknown_invoice'
    }

export const resolveAttachPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<AttachDecision> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return { attach: false, because: 'unknown_invoice' }
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, 'document', both.client)
  const because =
    resolved.invoice !== null ? 'invoice' : resolved.client !== null ? 'client' : 'organization'
  return isExtraEnabled(resolved.effective)
    ? { attach: true, because }
    : { attach: false, because }
}

/** One boolean kind's three answers, for a screen that shows what and why. */
export interface LayeredPreference<Value> {
  readonly invoice: Value | null
  readonly client: Value | null
  readonly organization: Value
}

const layeredBoolean = (
  both: Awaited<ReturnType<typeof readInvoiceExtras>>,
  kind: 'document' | 'files' | 'append',
): LayeredPreference<boolean> | null => {
  if (both === null) return null
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, kind, both.client)
  return {
    invoice: resolved.invoice === null ? null : isExtraEnabled(resolved.invoice),
    client: resolved.client === null ? null : isExtraEnabled(resolved.client),
    organization: isExtraEnabled(resolved.organization),
  }
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
): Promise<LayeredPreference<boolean> | null> =>
  layeredBoolean(await readInvoiceExtras(database, invoiceId), 'document')
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
  return isExtraEnabled(
    resolveInvoiceExtra(both.organization, both.invoice, 'files', both.client).effective,
  )
}
export const readFilesPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<LayeredPreference<boolean> | null> =>
  layeredBoolean(await readInvoiceExtras(database, invoiceId), 'files')
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

/**
 * Whether the invoice's PDF files are bound into the back of the invoice
 * document rather than sent beside it (migration 0099).
 *
 * Accounts payable departments ask for exactly this -- "invoice on the first
 * page, any other supporting documentation should follow" -- so one PDF
 * reaches their system with the purchase order behind the invoice. The same
 * precedence as every other extra: the invoice, then its client, then the
 * organization.
 */
export const resolveAppendPolicy = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<boolean> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return false
  return isExtraEnabled(
    resolveInvoiceExtra(both.organization, both.invoice, 'append', both.client).effective,
  )
}
export const readAppendPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<LayeredPreference<boolean> | null> =>
  layeredBoolean(await readInvoiceExtras(database, invoiceId), 'append')
export const readOrganizationAppendPolicy = async (
  database: InvoiceStateDatabase,
): Promise<boolean> =>
  isExtraEnabled(
    resolveInvoiceExtra(await readOrganizationInvoiceExtras(database), {}, 'append').organization,
  )
export const setInvoiceAppendPolicy = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; enabled: boolean | null }>,
): Promise<boolean> => setInvoiceExtra(database, input.invoiceId, 'append', input.enabled)
export const setOrganizationAppendPolicy = async (
  database: InvoiceStateDatabase,
  enabled: boolean,
): Promise<void> => setOrganizationInvoiceExtra(database, 'append', enabled)

export interface StagedAttachment {
  readonly attachmentId: number
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
    sql`SELECT attachment.id AS attachmentId, object.file_key AS key,
               attachment.name AS filename,
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
  /**
   * The invoice's files bound into the back of this document, in the order
   * they were bound. A retried delivery reads it to attach the identical
   * document and to leave these files out of the attachments beside it.
   */
  readonly appendedAttachmentIds: readonly number[]
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
           byte_size, invoice_version, appended_attachment_ids, created_at)
        VALUES (${input.invoiceMessageId}, ${input.invoiceId}, ${input.objectKey},
                ${input.filename}, ${input.contentType}, ${input.byteSize},
                ${input.invoiceVersion}, ${JSON.stringify(input.appendedAttachmentIds)},
                ${input.now})`,
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
    appended: string
  }>(
    sql`SELECT invoice_message_id AS invoiceMessageId, invoice_id AS invoiceId,
               object_key AS objectKey, filename, content_type AS contentType,
               byte_size AS byteSize, invoice_version AS invoiceVersion,
               appended_attachment_ids AS appended
        FROM invoice_message_documents WHERE invoice_message_id = ${invoiceMessageId}`,
  )
  const row = rows[0]
  if (row === undefined) return null
  const { appended, ...document } = row
  const ids = JSON.parse(appended) as unknown
  return {
    ...document,
    appendedAttachmentIds: Array.isArray(ids)
      ? ids.filter((id): id is number => Number.isSafeInteger(id))
      : [],
  }
}

/**
 * Whether a message said its invoice PDF goes with it -- the decision its
 * body was written to, so the email and its attachments cannot disagree about
 * whether a document is attached. `false` for no such message.
 */
export const readMessageAttachesPdf = async (
  database: InvoiceStateDatabase,
  invoiceMessageId: number,
): Promise<boolean> => {
  const rows = await database.all<{ attachPdf: number }>(
    sql`SELECT attach_pdf AS attachPdf FROM invoice_messages WHERE id = ${invoiceMessageId}`,
  )
  return rows[0]?.attachPdf === 1
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

/**
 * What the recipient sees the file called: `INVOICE_4021_EXAMPLE_LLC.pdf`,
 * Harvest's own name for it. A client's accounts payable files invoices from
 * many vendors by that name, so the company is in it, upper-cased, accents
 * dropped and every run of anything but letters and digits made one `_`. A
 * company name with nothing left after that leaves the name at the number.
 */
export const invoiceDocumentFilename = (invoiceNumber: string, companyName: string): string => {
  const number = invoiceNumber.replace(/[^A-Za-z0-9._-]/gu, '-')
  const company = companyName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
  return company === '' ? `INVOICE_${number}.pdf` : `INVOICE_${number}_${company}.pdf`
}

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
 *
 * Every reader of this sends it to the client, so a note comes back only where
 * a client may read it (D20): the entry's own `client_visible`, else the
 * organization's default. An internal note is `null` here, the same as an
 * entry with none -- the client is told nothing was written, not that
 * something was withheld.
 */
export interface InvoiceJournalEntry {
  readonly spentDate: string
  readonly personName: string
  /**
   * The project's client -- the invoice's own, or for a parent's invoice an
   * end-client beneath it (migration 0115) -- printed on every row as Harvest does.
   */
  readonly clientName: string
  readonly projectName: string
  readonly projectCode: string
  readonly taskName: string | null
  /** The person's roles, name-ordered; empty when they hold none. */
  readonly roles: readonly string[]
  readonly notes: string | null
  readonly seconds: number
  readonly billable: boolean
}

export const readInvoiceJournal = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<readonly InvoiceJournalEntry[]> => {
  const rows = await database.all<{
    spentDate: string
    personId: number
    personName: string
    clientName: string
    projectName: string
    projectCode: string
    taskName: string | null
    notes: string | null
    seconds: number
    billable: number
    clientVisible: number | null
    visibleDefault: number | null
  }>(
    sql`SELECT entry.spent_date AS spentDate,
               person.id AS personId,
               trim(coalesce(person.first_name, '') || ' ' || coalesce(person.last_name, ''))
                 AS personName,
               client.name AS clientName,
               project.name AS projectName,
               project.code AS projectCode,
               task.name AS taskName,
               entry.notes AS notes,
               entry.billable AS billable,
               entry.client_visible AS clientVisible,
               (SELECT report_notes_client_visible_default FROM organizations
                ORDER BY id LIMIT 1) AS visibleDefault,
               coalesce(entry.rounded_seconds, entry.seconds) AS seconds
        FROM time_entries entry
        JOIN users person ON person.id = entry.user_id
        JOIN projects project ON project.id = entry.project_id
        JOIN clients client ON client.id = project.client_id
        LEFT JOIN tasks task ON task.id = entry.task_id
        WHERE entry.invoice_id = ${invoiceId}
        ORDER BY entry.spent_date, entry.id`,
  )
  // Roles in one read for everybody on the invoice, rather than one per entry
  // for a question that has as many answers as there are people.
  const memberships =
    rows.length === 0
      ? []
      : await database.all<{ userId: number; name: string }>(
          sql`SELECT membership.user_id AS userId, role.name AS name
              FROM user_roles membership
              JOIN roles role ON role.id = membership.role_id
              WHERE membership.user_id IN (
                SELECT user_id FROM time_entries WHERE invoice_id = ${invoiceId}
              )
              ORDER BY membership.user_id, role.name, role.id`,
        )
  const roles = new Map<number, string[]>()
  for (const membership of memberships) {
    const held = roles.get(membership.userId)
    if (held === undefined) roles.set(membership.userId, [membership.name])
    else held.push(membership.name)
  }
  return rows.map(({ clientVisible, visibleDefault, personId, billable, ...entry }) => ({
    ...entry,
    roles: roles.get(personId) ?? [],
    billable: billable === 1,
    notes: reportNoteIsClientVisible(
      { clientVisible: clientVisible === null ? null : clientVisible === 1 },
      // No organization row yet is the column's own default: visible.
      visibleDefault !== 0,
    )
      ? entry.notes
      : null,
  }))
}

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
  const effective = resolveInvoiceExtra(
    both.organization,
    both.invoice,
    'journal',
    both.client,
  ).effective
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
): Promise<LayeredPreference<JournalLevel | false> | null> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return null
  const resolved = resolveInvoiceExtra(both.organization, both.invoice, 'journal', both.client)
  const level = (value: InvoiceExtraValue | null): JournalLevel | false | null =>
    value === 'detailed' || value === 'summary' ? value : value === null ? null : false
  return {
    invoice: level(resolved.invoice),
    client: level(resolved.client),
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

/**
 * The files the journal goes as, whichever level it goes at (issue 647).
 *
 * Its own answer beside the level rather than part of it, with the same
 * precedence: an invoice's set wins, an invoice with none follows the
 * organization, and an organization that never chose sends the PDF the journal
 * has always been. Asked at send time, like every other extra.
 */
const formatsOf = (value: InvoiceExtraValue | undefined): readonly JournalFormat[] | null =>
  Array.isArray(value) ? (value as readonly JournalFormat[]) : null

export const readJournalFormatsPreference = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<LayeredPreference<readonly JournalFormat[]> | null> => {
  const both = await readInvoiceExtras(database, invoiceId)
  if (both === null) return null
  return {
    invoice: formatsOf(both.invoice.journal_formats),
    client: formatsOf(both.client.journal_formats),
    organization: formatsOf(both.organization.journal_formats) ?? defaultJournalFormats,
  }
}

/** What will actually go, or `null` for an invoice that does not exist. */
export const resolveJournalFormats = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<readonly JournalFormat[] | null> => {
  const both = await readJournalFormatsPreference(database, invoiceId)
  return both === null ? null : (both.invoice ?? both.client ?? both.organization)
}

export const readOrganizationJournalFormats = async (
  database: InvoiceStateDatabase,
): Promise<readonly JournalFormat[]> =>
  formatsOf((await readOrganizationInvoiceExtras(database)).journal_formats) ??
  defaultJournalFormats

/**
 * Stored in the product's order whatever order it arrived in. Anything that
 * is not a format set is refused here as well as at the route, so no caller
 * can store a list that would read back as the default.
 */
const storedFormats = (formats: readonly JournalFormat[]): readonly JournalFormat[] => {
  const parsed = parseJournalFormats(formats)
  if (parsed === null) {
    throw new RangeError('journal formats must be a non-empty set of pdf, csv and xlsx')
  }
  return parsed
}

/** `null` on the invoice hands it back to the organization. */
export const setInvoiceJournalFormats = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ invoiceId: number; formats: readonly JournalFormat[] | null }>,
): Promise<boolean> =>
  setInvoiceExtra(
    database,
    input.invoiceId,
    'journal_formats',
    input.formats === null ? null : storedFormats(input.formats),
  )

export const setOrganizationJournalFormats = async (
  database: InvoiceStateDatabase,
  formats: readonly JournalFormat[],
): Promise<void> => setOrganizationInvoiceExtra(database, 'journal_formats', storedFormats(formats))

/**
 * Everything the hours report is rendered from, for the download beside the
 * email (issue 647): the invoice, the work it billed with notes reduced to
 * those a client may read, and the level its journal would go at -- `null`
 * when it would not go at all. `null` for an invoice that does not exist.
 */
export const readInvoiceHoursReport = async (
  database: InvoiceStateDatabase,
  invoiceId: number,
): Promise<(JournalSource & { readonly level: JournalLevel | null }) | null> => {
  const rows = await database.all<{
    invoiceNumber: string
    clientName: string
    companyName: string | null
  }>(
    sql`SELECT invoice.number AS invoiceNumber, client.name AS clientName,
               (SELECT name FROM organizations ORDER BY id LIMIT 1) AS companyName
        FROM invoices invoice
        JOIN clients client ON client.id = invoice.client_id
        WHERE invoice.id = ${invoiceId}`,
  )
  const header = rows[0]
  if (header === undefined) return null
  const [level, entries] = await Promise.all([
    resolveJournalPolicy(database, invoiceId),
    readInvoiceJournal(database, invoiceId),
  ])
  return {
    invoiceNumber: header.invoiceNumber,
    clientName: header.clientName,
    companyName: header.companyName ?? '',
    level,
    entries,
  }
}
