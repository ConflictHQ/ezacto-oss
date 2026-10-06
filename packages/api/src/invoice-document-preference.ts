/**
 * Turning the invoice document on and off (issue 626).
 *
 * The preference existed before anything could set it, which is the same defect
 * as a control that changes nothing, arrived at from the other side: a stored
 * value nobody can reach is a decision the product has made on the operator's
 * behalf and will not let them revisit.
 *
 * Two surfaces because there are two answers. The organization's is the default
 * every invoice follows; an invoice's own overrides it, and clearing that hands
 * the invoice back. Reading the pair together matters -- an operator looking at
 * one invoice needs to know both what it will do and why.
 */

import { parseJournalFormats, type JournalFormat } from '@ezacto/core'
import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

/**
 * The two things an invoice can carry, each its own answer.
 *
 * `document` is the invoice rendered as a PDF. `files` is whatever an operator
 * staged against it -- a purchase order, a signed order form. Wanting one is not
 * wanting the other, so they are read and written separately rather than folded
 * into a single flag that would make the choice for somebody.
 */
export type AttachmentKind = 'document' | 'files' | 'append'

/**
 * One kind's answers at each level. `null` at the invoice follows its client,
 * and `null` at the client follows the organization.
 */
export interface LayeredAnswer<Value> {
  invoice: Value | null
  client: Value | null
  organization: Value
}

/**
 * The work journal's answer, which is not a boolean (issue 647).
 *
 * `'detailed'` is every entry billed, `'summary'` the same hours totalled per
 * project, `false` is off, and on an invoice `null` follows the organization.
 * This is the value that made issue 656's set worth building: a fourth boolean
 * pair could not have carried it.
 */
export type JournalPreference = 'detailed' | 'summary' | false

/**
 * The files the journal goes as (issue 647): a non-empty set of `pdf`, `csv`
 * and `xlsx`, one level shared by all of them. The organization's set is
 * complete -- the PDF alone until somebody chooses -- and an invoice's is an
 * override, `null` when it follows.
 */
export type JournalFormats = readonly JournalFormat[]

export interface InvoiceDocumentPreferenceService {
  /** `null` on the invoice means it follows the organization. */
  readInvoicePreference(
    invoiceId: number,
    kind: AttachmentKind,
  ): Promise<LayeredAnswer<boolean> | null>
  setInvoicePreference(
    invoiceId: number,
    kind: AttachmentKind,
    enabled: boolean | null,
  ): Promise<boolean>
  readOrganizationPreference(kind: AttachmentKind): Promise<boolean>
  setOrganizationPreference(kind: AttachmentKind, enabled: boolean): Promise<void>
  readInvoiceJournal(invoiceId: number): Promise<LayeredAnswer<JournalPreference> | null>
  setInvoiceJournal(invoiceId: number, level: JournalPreference | null): Promise<boolean>
  readOrganizationJournal(): Promise<JournalPreference>
  setOrganizationJournal(level: JournalPreference): Promise<void>
  readInvoiceJournalFormats(invoiceId: number): Promise<LayeredAnswer<JournalFormats> | null>
  setInvoiceJournalFormats(invoiceId: number, formats: JournalFormats | null): Promise<boolean>
  readOrganizationJournalFormats(): Promise<JournalFormats>
  setOrganizationJournalFormats(formats: JournalFormats): Promise<void>
}

/**
 * Reads the journal's answer out of a body.
 *
 * `false` rather than a missing field is how it is turned off, for the same
 * reason `null` is how an invoice defers: a caller that leaves it out has not
 * said anything, and guessing which they meant is how a client stops receiving
 * something nobody chose to stop.
 */
const journalOf = (
  body: Record<string, unknown>,
  nullable: boolean,
): JournalPreference | null => {
  const value = body.attach_journal
  if (value === 'detailed' || value === 'summary' || value === false) return value
  if (nullable && value === null) return null
  throw validationError([
    {
      field: 'attach_journal',
      code: 'invalid',
      message: nullable
        ? 'attach_journal must be "detailed", "summary", false, or null to follow the organization.'
        : 'attach_journal must be "detailed", "summary", or false.',
    },
  ])
}

/**
 * Reads the journal's files out of a body, in the product's order.
 *
 * A repeat is refused rather than collapsed and an empty set rather than read
 * as "none": turning the journal off is `attach_journal: false`, and a set
 * that says nothing is a caller that meant something else.
 */
const journalFormatsOf = (
  body: Record<string, unknown>,
  nullable: boolean,
): JournalFormats | null => {
  const value = body.journal_formats
  if (nullable && value === null) return null
  const formats = parseJournalFormats(value)
  if (formats !== null) return formats
  throw validationError([
    {
      field: 'journal_formats',
      code: 'invalid',
      message: nullable
        ? 'journal_formats must be a non-empty list of distinct formats from "pdf", "csv" and "xlsx", or null to follow the organization.'
        : 'journal_formats must be a non-empty list of distinct formats from "pdf", "csv" and "xlsx".',
    },
  ])
}

const preferenceFields = [
  'attach_pdf',
  'attach_files',
  'append_pdfs',
  'attach_journal',
  'journal_formats',
] as const

/** What will happen, at the first level that answered. */
const effectiveOf = <Value>(answer: LayeredAnswer<Value>): Value =>
  answer.invoice ?? answer.client ?? answer.organization

/**
 * The invoice's whole answer -- each kind at each level and what will happen
 * -- so a screen does not work out the precedence a second time and reach a
 * different answer.
 */
const preferenceData = (
  invoiceId: number,
  document: LayeredAnswer<boolean>,
  files: LayeredAnswer<boolean>,
  append: LayeredAnswer<boolean>,
  journal: LayeredAnswer<JournalPreference>,
  formats: LayeredAnswer<JournalFormats>,
) => ({
  invoice_id: invoiceId,
  attach_pdf: document.invoice,
  client_attach_pdf: document.client,
  organization_attach_pdf: document.organization,
  effective: effectiveOf(document),
  attach_files: files.invoice,
  client_attach_files: files.client,
  organization_attach_files: files.organization,
  effective_files: effectiveOf(files),
  append_pdfs: append.invoice,
  client_append_pdfs: append.client,
  organization_append_pdfs: append.organization,
  effective_append_pdfs: effectiveOf(append),
  attach_journal: journal.invoice,
  client_attach_journal: journal.client,
  organization_attach_journal: journal.organization,
  effective_journal: effectiveOf(journal),
  journal_formats: formats.invoice,
  client_journal_formats: formats.client,
  organization_journal_formats: formats.organization,
  effective_journal_formats: effectiveOf(formats),
})

const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  // What a client receives with their invoice sits with the people who raise
  // invoices, not with everyone who can edit their own time.
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can change invoice attachments.',
    })
  }
}

const invoiceIdOf = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const invoiceId = Number(context.req.param('id') ?? '')
  if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
    throw validationError([
      { field: 'id', code: 'invalid', message: 'id must be a positive integer.' },
    ])
  }
  return invoiceId
}

/**
 * Reads the flag out of a body, allowing an explicit null on the invoice.
 *
 * `null` is a third answer rather than a missing one -- it is how an invoice is
 * handed back to the organization default -- so it cannot be spelled by leaving
 * the field out.
 */
const flagOf = (
  body: Record<string, unknown>,
  field: string,
  nullable: boolean,
): boolean | null => {
  const value = body[field]
  if (typeof value === 'boolean') return value
  if (nullable && value === null) return null
  throw validationError([
    {
      field,
      code: 'invalid',
      message: nullable
        ? `${field} must be true, false, or null to follow the organization.`
        : `${field} must be true or false.`,
    },
  ])
}

/**
 * Both answers for one invoice, in one read.
 *
 * Separate calls would let a screen show a document answer from one moment and
 * a files answer from another, and the pair it displayed would be a state that
 * never existed.
 */
export const installInvoiceDocumentPreferenceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceDocumentPreferenceService>,
): void => {
  api.get('/invoices/:id/document-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const [document, files, append, journal, formats] = await Promise.all([
      service.readInvoicePreference(invoiceId, 'document'),
      service.readInvoicePreference(invoiceId, 'files'),
      service.readInvoicePreference(invoiceId, 'append'),
      service.readInvoiceJournal(invoiceId),
      service.readInvoiceJournalFormats(invoiceId),
    ])
    if (
      document === null ||
      files === null ||
      append === null ||
      journal === null ||
      formats === null
    ) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    return context.json(
      { data: preferenceData(invoiceId, document, files, append, journal, formats) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/invoices/:id/document-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    // At least one, or the call is a write that changes nothing and reports
    // success -- which reads as a saved setting that was never saved.
    if (!preferenceFields.some((field) => field in body)) {
      throw validationError([
        {
          field: 'attach_pdf',
          code: 'required',
          message:
            'Provide attach_pdf, attach_files, append_pdfs, attach_journal, journal_formats, or any combination.',
        },
      ])
    }
    // Every field read before any is written, so a body with one bad field
    // changes nothing rather than saving the half that came first.
    const journal = 'attach_journal' in body ? journalOf(body, true) : undefined
    const formats = 'journal_formats' in body ? journalFormatsOf(body, true) : undefined
    const attachPdf = 'attach_pdf' in body ? flagOf(body, 'attach_pdf', true) : undefined
    const attachFiles = 'attach_files' in body ? flagOf(body, 'attach_files', true) : undefined
    const appendPdfs = 'append_pdfs' in body ? flagOf(body, 'append_pdfs', true) : undefined
    const notFound = () =>
      new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    if (journal !== undefined && !(await service.setInvoiceJournal(invoiceId, journal))) {
      throw notFound()
    }
    if (formats !== undefined && !(await service.setInvoiceJournalFormats(invoiceId, formats))) {
      throw notFound()
    }
    if (
      attachPdf !== undefined &&
      !(await service.setInvoicePreference(invoiceId, 'document', attachPdf))
    ) {
      throw notFound()
    }
    if (
      attachFiles !== undefined &&
      !(await service.setInvoicePreference(invoiceId, 'files', attachFiles))
    ) {
      throw notFound()
    }
    if (
      appendPdfs !== undefined &&
      !(await service.setInvoicePreference(invoiceId, 'append', appendPdfs))
    ) {
      throw notFound()
    }
    const [document, files, append, journalAnswer, formatsAnswer] = await Promise.all([
      service.readInvoicePreference(invoiceId, 'document'),
      service.readInvoicePreference(invoiceId, 'files'),
      service.readInvoicePreference(invoiceId, 'append'),
      service.readInvoiceJournal(invoiceId),
      service.readInvoiceJournalFormats(invoiceId),
    ])
    if (
      document === null ||
      files === null ||
      append === null ||
      journalAnswer === null ||
      formatsAnswer === null
    ) {
      throw notFound()
    }
    return context.json(
      { data: preferenceData(invoiceId, document, files, append, journalAnswer, formatsAnswer) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/settings/invoice-documents', async (context) => {
    assertMoneyWriter(context)
    const [attachPdf, attachFiles, appendPdfs, attachJournal, journalFormats] = await Promise.all([
      service.readOrganizationPreference('document'),
      service.readOrganizationPreference('files'),
      service.readOrganizationPreference('append'),
      service.readOrganizationJournal(),
      service.readOrganizationJournalFormats(),
    ])
    return context.json(
      {
        data: {
          attach_pdf: attachPdf,
          attach_files: attachFiles,
          append_pdfs: appendPdfs,
          attach_journal: attachJournal,
          journal_formats: journalFormats,
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/invoice-documents', async (context) => {
    assertMoneyWriter(context)
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    if (!preferenceFields.some((field) => field in body)) {
      throw validationError([
        {
          field: 'attach_pdf',
          code: 'required',
          message:
            'Provide attach_pdf, attach_files, append_pdfs, attach_journal, journal_formats, or any combination.',
        },
      ])
    }
    const journal = 'attach_journal' in body ? journalOf(body, false)! : undefined
    const formats = 'journal_formats' in body ? journalFormatsOf(body, false)! : undefined
    const attachPdf = 'attach_pdf' in body ? flagOf(body, 'attach_pdf', false)! : undefined
    const attachFiles = 'attach_files' in body ? flagOf(body, 'attach_files', false)! : undefined
    const appendPdfs = 'append_pdfs' in body ? flagOf(body, 'append_pdfs', false)! : undefined
    if (journal !== undefined) await service.setOrganizationJournal(journal)
    if (formats !== undefined) await service.setOrganizationJournalFormats(formats)
    if (attachPdf !== undefined) await service.setOrganizationPreference('document', attachPdf)
    if (attachFiles !== undefined) await service.setOrganizationPreference('files', attachFiles)
    if (appendPdfs !== undefined) await service.setOrganizationPreference('append', appendPdfs)
    const [currentPdf, currentFiles, currentAppend, currentJournal, currentFormats] =
      await Promise.all([
        service.readOrganizationPreference('document'),
        service.readOrganizationPreference('files'),
        service.readOrganizationPreference('append'),
        service.readOrganizationJournal(),
        service.readOrganizationJournalFormats(),
      ])
    return context.json(
      {
        data: {
          attach_pdf: currentPdf,
          attach_files: currentFiles,
          append_pdfs: currentAppend,
          attach_journal: currentJournal,
          journal_formats: currentFormats,
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
