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
export type AttachmentKind = 'document' | 'files'

export interface InvoiceDocumentPreferenceService {
  /** `null` on the invoice means it follows the organization. */
  readInvoicePreference(
    invoiceId: number,
    kind: AttachmentKind,
  ): Promise<{ invoice: boolean | null; organization: boolean } | null>
  setInvoicePreference(
    invoiceId: number,
    kind: AttachmentKind,
    enabled: boolean | null,
  ): Promise<boolean>
  readOrganizationPreference(kind: AttachmentKind): Promise<boolean>
  setOrganizationPreference(kind: AttachmentKind, enabled: boolean): Promise<void>
}

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
    const [document, files] = await Promise.all([
      service.readInvoicePreference(invoiceId, 'document'),
      service.readInvoicePreference(invoiceId, 'files'),
    ])
    if (document === null || files === null) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          attach_pdf: document.invoice,
          organization_attach_pdf: document.organization,
          // What will actually happen, so a screen does not work out the
          // precedence a second time and reach a different answer.
          effective: document.invoice ?? document.organization,
          attach_files: files.invoice,
          organization_attach_files: files.organization,
          effective_files: files.invoice ?? files.organization,
        },
      },
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
    if (!('attach_pdf' in body) && !('attach_files' in body)) {
      throw validationError([
        {
          field: 'attach_pdf',
          code: 'required',
          message: 'Provide attach_pdf, attach_files, or both.',
        },
      ])
    }
    if ('attach_pdf' in body) {
      const wanted = flagOf(body, 'attach_pdf', true)
      if (!(await service.setInvoicePreference(invoiceId, 'document', wanted))) {
        throw new ApiError({
          status: 404,
          code: 'not_found',
          message: 'The requested resource does not exist.',
        })
      }
    }
    if ('attach_files' in body) {
      const wanted = flagOf(body, 'attach_files', true)
      if (!(await service.setInvoicePreference(invoiceId, 'files', wanted))) {
        throw new ApiError({
          status: 404,
          code: 'not_found',
          message: 'The requested resource does not exist.',
        })
      }
    }
    const [document, files] = await Promise.all([
      service.readInvoicePreference(invoiceId, 'document'),
      service.readInvoicePreference(invoiceId, 'files'),
    ])
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          attach_pdf: document?.invoice ?? null,
          organization_attach_pdf: document?.organization ?? false,
          effective: document?.invoice ?? document?.organization ?? false,
          attach_files: files?.invoice ?? null,
          organization_attach_files: files?.organization ?? false,
          effective_files: files?.invoice ?? files?.organization ?? false,
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/settings/invoice-documents', async (context) => {
    assertMoneyWriter(context)
    const [attachPdf, attachFiles] = await Promise.all([
      service.readOrganizationPreference('document'),
      service.readOrganizationPreference('files'),
    ])
    return context.json(
      { data: { attach_pdf: attachPdf, attach_files: attachFiles } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/invoice-documents', async (context) => {
    assertMoneyWriter(context)
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    if (!('attach_pdf' in body) && !('attach_files' in body)) {
      throw validationError([
        {
          field: 'attach_pdf',
          code: 'required',
          message: 'Provide attach_pdf, attach_files, or both.',
        },
      ])
    }
    if ('attach_pdf' in body) {
      await service.setOrganizationPreference('document', flagOf(body, 'attach_pdf', false)!)
    }
    if ('attach_files' in body) {
      await service.setOrganizationPreference('files', flagOf(body, 'attach_files', false)!)
    }
    const [attachPdf, attachFiles] = await Promise.all([
      service.readOrganizationPreference('document'),
      service.readOrganizationPreference('files'),
    ])
    return context.json(
      { data: { attach_pdf: attachPdf, attach_files: attachFiles } },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
