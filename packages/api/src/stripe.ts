/**
 * The two Stripe surfaces (#102): the link an operator can fetch for an
 * invoice, and the endpoint Stripe posts a payment to.
 *
 * The webhook takes no principal and that is not an oversight. Stripe has no
 * session with us, so the signature is the whole of the authorisation -- the
 * same shape the QuickBooks and BILL webhooks already have.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'

export interface StripeService {
  configured(): boolean
  paymentLink(
    invoiceId: number,
  ): Promise<{ kind: 'linked'; url: string } | { kind: 'refused'; reason: string }>
  receiveWebhook(input: {
    payload: string
    signature: string | null
  }): Promise<
    | { kind: 'recorded'; invoiceId: number }
    | { kind: 'ignored'; reason: string }
    | { kind: 'unverified' }
  >
}

const assertMoneyReader = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  // Fetching the link shows what a client would be asked to pay, so it sits
  // with the profiles that already see invoice money rather than with everyone.
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can read an invoice payment link.',
    })
  }
}

export const installStripeRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<StripeService>,
): void => {
  api.post('/invoices/:id/payment-link', async (context) => {
    assertMoneyReader(context)
    const invoiceId = Number(context.req.param('id') ?? '')
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      throw validationError([
        { field: 'id', code: 'invalid', message: 'id must be a positive integer.' },
      ])
    }
    if (!service.configured()) {
      throw new ApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Stripe is not configured for this deployment.',
      })
    }
    const result = await service.paymentLink(invoiceId)
    if (result.kind === 'refused') {
      // A refusal here is a fact about the invoice -- nothing owed, or it does
      // not exist -- rather than a failure of ours.
      throw new ApiError({
        status: 409,
        code: 'payment_link_unavailable',
        message: result.reason,
      })
    }
    return context.json({ data: { invoice_id: invoiceId, url: result.url } }, 200, {
      'cache-control': 'no-store',
    })
  })
}

/**
 * Stripe's deliveries. Outside the API surface and taking no principal: Stripe
 * has no session, so the signature is the authorisation.
 *
 * Always 200 once the signature holds, even where the payment is not ours.
 * Stripe retries a non-2xx for up to three days, and retrying a delivery we
 * have correctly decided to ignore is work that can never succeed. An
 * unverified delivery is a 400, which is what Stripe's own documentation treats
 * as a refusal rather than something to retry forever.
 */
export const installStripeWebhookRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  service: Readonly<StripeService>,
): void => {
  app.post('/webhooks/stripe', async (context) => {
    // Read as text, never parsed and re-serialised: the signature covers the
    // raw bytes, and any reserialisation breaks it.
    const payload = await context.req.text()
    const result = await service.receiveWebhook({
      payload,
      signature: context.req.header('stripe-signature') ?? null,
    })
    if (result.kind === 'unverified') {
      return context.json({ error: { code: 'signature_invalid' } }, 400)
    }
    return context.json({ data: { received: true } }, 200)
  })
}
