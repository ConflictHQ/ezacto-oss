/**
 * Turning the automatic thank-you on and off (issue 545).
 *
 * The per-invoice half is the load-bearing one. Some invoices settle a dispute,
 * and a cheerful automated note is the wrong thing to send about those -- so an
 * operator needs to suppress one invoice without turning the feature off for
 * everybody, and needs to do it before the payment lands.
 *
 * Precedence is explicit and read at send time: an invoice's own answer wins,
 * and an invoice with none follows the organization default *as it stands when
 * the invoice settles*, not as it stood when the invoice was raised.
 *
 * This is the fourth invoice-level boolean paired with an organization default,
 * after the three from issue 626. That is the point migration 0056 named: four
 * of these is a list wearing a disguise, and the next person to add one should
 * turn them into a set column rather than a fifth pair.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export interface ThankYouPreferenceService {
  /** `null` on the invoice means it follows the organization. */
  readInvoiceThankYou(
    invoiceId: number,
  ): Promise<{ invoice: boolean | null; organization: boolean } | null>
  setInvoiceThankYou(invoiceId: number, enabled: boolean | null): Promise<boolean>
  readOrganizationThankYou(): Promise<boolean>
  setOrganizationThankYou(enabled: boolean): Promise<void>
}

const assertMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  // What a client receives about their payment sits with the people who raise
  // invoices, not with everyone who can edit their own time.
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can change automatic thank-you notes.',
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
 * `null` is a third answer rather than a missing one -- it is how an invoice is
 * handed back to the organization default -- so it cannot be spelled by leaving
 * the field out.
 */
const flagOf = (body: Record<string, unknown>, nullable: boolean): boolean | null => {
  if (!('auto_thank_you' in body)) {
    throw validationError([
      { field: 'auto_thank_you', code: 'required', message: 'auto_thank_you is required.' },
    ])
  }
  const value = body.auto_thank_you
  if (typeof value === 'boolean') return value
  if (nullable && value === null) return null
  throw validationError([
    {
      field: 'auto_thank_you',
      code: 'invalid',
      message: nullable
        ? 'auto_thank_you must be true, false, or null to follow the organization.'
        : 'auto_thank_you must be true or false.',
    },
  ])
}

const notFound = (): never => {
  throw new ApiError({
    status: 404,
    code: 'not_found',
    message: 'The requested resource does not exist.',
  })
}

export const installThankYouPreferenceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<ThankYouPreferenceService>,
): void => {
  const invoiceBody = (
    answer: { invoice: boolean | null; organization: boolean },
    invoiceId: number,
  ) => ({
    data: {
      invoice_id: invoiceId,
      auto_thank_you: answer.invoice,
      organization_auto_thank_you: answer.organization,
      // What will actually happen, so a screen does not work out the precedence
      // a second time and reach a different answer than the sender will.
      effective: answer.invoice ?? answer.organization,
    },
  })

  api.get('/invoices/:id/thank-you-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const answer = await service.readInvoiceThankYou(invoiceId)
    if (answer === null) notFound()
    return context.json(invoiceBody(answer!, invoiceId), 200, { 'cache-control': 'no-store' })
  })

  api.post('/invoices/:id/thank-you-preference', async (context) => {
    assertMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    const wanted = flagOf(body, true)
    if (!(await service.setInvoiceThankYou(invoiceId, wanted))) notFound()
    const answer = await service.readInvoiceThankYou(invoiceId)
    if (answer === null) notFound()
    return context.json(invoiceBody(answer!, invoiceId), 200, { 'cache-control': 'no-store' })
  })

  api.get('/settings/invoice-thank-you', async (context) => {
    assertMoneyWriter(context)
    return context.json(
      { data: { auto_thank_you: await service.readOrganizationThankYou() } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/settings/invoice-thank-you', async (context) => {
    assertMoneyWriter(context)
    const body = (await context.req.json().catch(() => ({}))) as Record<string, unknown>
    // An invoice can defer; the organization is where the answer stops.
    await service.setOrganizationThankYou(flagOf(body, false)!)
    return context.json(
      { data: { auto_thank_you: await service.readOrganizationThankYou() } },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
