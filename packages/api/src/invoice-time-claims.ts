/**
 * Handing an invoice's time entries back (issue 496).
 *
 * The first of the two operations that let billed time be removed. Releasing is
 * refused while the invoice still stands, because hours released from an
 * invoice a client may yet pay can be billed a second time -- the schema
 * enforces that, and this route reports it rather than surfacing a constraint
 * failure.
 *
 * A POST rather than a DELETE. Nothing is destroyed here: the entries survive
 * and the invoice survives, and what changes is which of them claims the other.
 * The name is the noun that results, which is the shape the rest of this API
 * uses for a state change with no resource to remove.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export type ReleaseTimeOutcome =
  | { kind: 'released'; released: number }
  | { kind: 'refused'; reason: 'invoice_not_found' | 'invoice_still_stands' }

export interface InvoiceTimeClaimService {
  releaseInvoicedTime(invoiceId: number): Promise<ReleaseTimeOutcome>
}

const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  // Releasing decides whether hours can be billed again, so it sits with the
  // profiles that already raise invoices rather than with everyone who can edit
  // their own time.
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can release invoiced time.',
    })
  }
}

export const installInvoiceTimeClaimRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceTimeClaimService>,
): void => {
  api.post('/invoices/:id/released-time', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = Number(context.req.param('id') ?? '')
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      throw validationError([
        { field: 'id', code: 'invalid', message: 'id must be a positive integer.' },
      ])
    }
    const result = await service.releaseInvoicedTime(invoiceId)
    if (result.kind === 'refused') {
      if (result.reason === 'invoice_not_found') {
        throw new ApiError({
          status: 404,
          code: 'not_found',
          message: 'The requested resource does not exist.',
        })
      }
      // A fact about the invoice rather than a failure of ours, and the caller
      // can act on it: close the invoice first, then release.
      throw new ApiError({
        status: 409,
        code: 'invoice_still_stands',
        message:
          'An invoice that is open or paid still claims these hours. Cancel or write it off first.',
      })
    }
    return context.json(
      { data: { invoice_id: invoiceId, released: result.released } },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
