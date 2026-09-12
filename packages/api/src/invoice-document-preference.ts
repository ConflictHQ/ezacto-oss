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

export interface InvoiceDocumentPreferenceService {
  /** `null` on the invoice means it follows the organization. */
  readInvoicePreference(
    invoiceId: number,
  ): Promise<{ invoice: boolean | null; organization: boolean } | null>
  setInvoicePreference(invoiceId: number, enabled: boolean | null): Promise<boolean>
  readOrganizationPreference(): Promise<boolean>
  setOrganizationPreference(enabled: boolean): Promise<void>
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
const flagOf = (body: Record<string, unknown>, nullable: boolean): boolean | null => {
  const value = body['attach_pdf']
  if (typeof value === 'boolean') return value
  if (nullable && value === null) return null
  throw validationError([
    {
      field: 'attach_pdf',
      code: 'invalid',
      message: nullable
        ? 'attach_pdf must be true, false, or null to follow the organization.'
        : 'attach_pdf must be true or false.',
    },
  ])
}

export const installInvoiceDocumentPreferenceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceDocumentPreferenceService>,
): void => {
  api.get('/invoices/:id/document-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const preference = await service.readInvoicePreference(invoiceId)
    if (preference === null) {
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
          attach_pdf: preference.invoice,
          organization_attach_pdf: preference.organization,
          // What will actually happen, so a screen does not have to work out
          // the precedence a second time and reach a different answer.
          effective: preference.invoice ?? preference.organization,
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
    const wanted = flagOf(body, true)
    if (!(await service.setInvoicePreference(invoiceId, wanted))) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    const preference = await service.readInvoicePreference(invoiceId)
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          attach_pdf: wanted,
          organization_attach_pdf: preference?.organization ?? false,
          effective: wanted ?? preference?.organization ?? false,
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.get('/settings/invoice-documents', async (context) => {
    assertMoneyWriter(context)
    return context.json(
      { data: { attach_pdf: await service.readOrganizationPreference() } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/invoice-documents', async (context) => {
    assertMoneyWriter(context)
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    const wanted = flagOf(body, false) as boolean
    await service.setOrganizationPreference(wanted)
    return context.json({ data: { attach_pdf: wanted } }, 200, {
      'cache-control': 'no-store',
    })
  })
}
