/**
 * The QuickBooks connection, as an operator meets it: a button that starts an
 * authorization, the callback it comes back to, a status to render, a way to
 * disconnect, and the endpoint Intuit posts changes to.
 *
 * Every dependency is injected. This module knows the shape of the handshake
 * and nothing about where tokens live or how to reach Intuit, which is what
 * lets the whole thing be driven by fakes.
 */

import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, validationError } from './errors.js'
import { readObjectBody } from './resources/support.js'

export interface QuickBooksTokenSet {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
}

export interface QuickBooksConnectionStatus {
  realmId: string
  companyName: string | null
  scope: string
  allowOnlinePayment: boolean
  connectedAt: string
}

/**
 * Where one invoice stands with QuickBooks (issue 819): stated here in the
 * same structural way as the connection status, so the integrations package
 * that produces it never has to import the package that serves it.
 */
export interface QuickBooksInvoiceSyncState {
  connected: boolean
  invoice: { quickBooksId: string; mirroredAt: string } | null
  payments: readonly { paymentId: number; quickBooksId: string; mirroredAt: string }[]
  lastOutcome: { kind: string; reason: string | null; at: string } | null
}

export interface QuickBooksSyncResult {
  invoice: { kind: string; reason?: string; quickBooksId?: string }
  payments: readonly { paymentId: number; outcome: { kind: string; reason?: string } }[]
}

/** One line of the reconciliation report (issue 1013), structurally. */
export interface QuickBooksReconciliationRow {
  status: string
  issues: readonly string[]
  ezactoInvoiceId: number | null
  number: string
  quickBooksId: string | null
  linked: boolean
  ezactoAmountCents: number | null
  quickBooksAmountCents: number | null
  ezactoCurrency: string | null
  quickBooksCurrency: string | null
  ezactoPaidCents: number | null
  quickBooksPaidCents: number | null
  detail: string
}

export interface QuickBooksReconciliation {
  realmId: string
  generatedAt: string
  counts: Readonly<Record<string, number>>
  rows: readonly QuickBooksReconciliationRow[]
}

/**
 * What the routes need from the rest of the system.
 *
 * `clientSecret` and `verifierToken` are read through functions rather than
 * held as strings so a deployment that has not configured them can say so,
 * rather than sending an empty secret to Intuit and reading the refusal as a
 * bug in the handshake.
 */
export interface QuickBooksService {
  clientId(): string | null
  callbackUrl(): string | null
  /** Where the operator lands after connecting; a page, not an API route. */
  settingsUrl(): string
  authorizeUrl(input: { state: string; redirectUri: string }): Promise<string>
  beginAuthorization(input: {
    state: string
    userId: number
    redirectUri: string
  }): Promise<void>
  completeAuthorization(input: {
    state: string
    code: string
    realmId: string
  }): Promise<QuickBooksConnectionStatus>
  readStatus(): Promise<QuickBooksConnectionStatus | null>
  setAllowOnlinePayment(allow: boolean): Promise<void>
  disconnect(): Promise<void>
  /**
   * Answers whether the delivery was accepted. The route does not decide: what
   * counts as a valid signature, a known realm, or a duplicate belongs with the
   * code that holds the verifier token and the ledger.
   */
  receiveWebhook(input: {
    payload: string
    signature: string | null
  }): Promise<{ accepted: boolean; reason?: string }>
  newState(): string
  /** Both answer null for an invoice that does not exist, which is the route's 404. */
  sync(invoiceId: number): Promise<QuickBooksSyncResult | null>
  syncState(invoiceId: number): Promise<QuickBooksInvoiceSyncState | null>
  /** Read-only comparison with the company; null where QuickBooks is not connected. */
  reconcile(): Promise<QuickBooksReconciliation | null>
}

const requireAdministrator = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
): { userId: number } => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    // Connecting an accounting system is a grant over the whole book, not a
    // per-user preference.
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can manage the QuickBooks connection.',
    })
  }
  return { userId: principal.userId }
}

/**
 * The same profiles that raise invoices and record money against them
 * (`assertMoneyWriter` in thank-you-preference.ts). Syncing one invoice is not
 * a grant over the book the way connecting is, so accounting can press it.
 */
const requireMoneyWriter = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (!['administrator', 'accounting', 'executive_manager'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can sync an invoice to QuickBooks.',
    })
  }
}

/**
 * The report shows every invoice and every receipt total in the book next to
 * the books' own, so it is for the people who keep them: administrators and
 * accounting, and nobody else.
 */
const requireAccountant = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (!['administrator', 'accounting'].includes(principal.profile)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators and accounting can read the QuickBooks reconciliation.',
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

const invoiceNotFound = (): never => {
  throw new ApiError({
    status: 404,
    code: 'not_found',
    message: 'The requested resource does not exist.',
  })
}

const serializeSyncState = (state: QuickBooksInvoiceSyncState) => ({
  connected: state.connected,
  invoice:
    state.invoice === null
      ? null
      : { quickbooks_id: state.invoice.quickBooksId, mirrored_at: state.invoice.mirroredAt },
  payments: state.payments.map((payment) => ({
    payment_id: payment.paymentId,
    quickbooks_id: payment.quickBooksId,
    mirrored_at: payment.mirroredAt,
  })),
  last_outcome:
    state.lastOutcome === null
      ? null
      : {
          kind: state.lastOutcome.kind,
          reason: state.lastOutcome.reason,
          at: state.lastOutcome.at,
        },
})

const requireConfigured = (service: Readonly<QuickBooksService>): {
  clientId: string
  callbackUrl: string
} => {
  const clientId = service.clientId()
  const callbackUrl = service.callbackUrl()
  if (clientId === null || callbackUrl === null) {
    throw new ApiError({
      status: 503,
      code: 'service_unavailable',
      message:
        'QuickBooks is not configured for this deployment. An Intuit client id and callback URL are required.',
    })
  }
  return { clientId, callbackUrl }
}

const serialize = (status: QuickBooksConnectionStatus) => ({
  realm_id: status.realmId,
  company_name: status.companyName,
  scope: status.scope,
  allow_online_payment: status.allowOnlinePayment,
  connected_at: status.connectedAt,
})

export const installQuickBooksRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<QuickBooksService>,
): void => {
  api.get('/integrations/quickbooks', async (context) => {
    requireAdministrator(context)
    const status = await service.readStatus()
    return context.json(
      {
        data: {
          configured: service.clientId() !== null && service.callbackUrl() !== null,
          connection: status === null ? null : serialize(status),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  // The reconciliation report (issue 1013): differences between our invoices
  // and the company's, listed and never corrected. A GET that reads QuickBooks
  // and writes nothing -- not an invoice, not a receipt, not a QuickBooks
  // document.
  api.get('/integrations/quickbooks/reconciliation', async (context) => {
    requireAccountant(context)
    const report = await service.reconcile()
    if (report === null) {
      throw new ApiError({
        status: 409,
        code: 'quickbooks_not_connected',
        message: 'QuickBooks is not connected.',
      })
    }
    return context.json(
      {
        data: {
          realm_id: report.realmId,
          generated_at: report.generatedAt,
          counts: report.counts,
          rows: report.rows.map((row) => ({
            status: row.status,
            issues: row.issues,
            invoice_id: row.ezactoInvoiceId,
            number: row.number,
            quickbooks_id: row.quickBooksId,
            linked: row.linked,
            ezacto_amount_cents: row.ezactoAmountCents,
            quickbooks_amount_cents: row.quickBooksAmountCents,
            ezacto_currency: row.ezactoCurrency,
            quickbooks_currency: row.quickBooksCurrency,
            ezacto_paid_cents: row.ezactoPaidCents,
            quickbooks_paid_cents: row.quickBooksPaidCents,
            detail: row.detail,
          })),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  // The button. Answers with the URL rather than redirecting, so the shell can
  // send the operator there itself and a caller can see where it is being sent
  // before following.
  api.post('/integrations/quickbooks/authorize', async (context) => {
    const { userId } = requireAdministrator(context)
    const { callbackUrl } = requireConfigured(service)
    const state = service.newState()
    await service.beginAuthorization({ state, userId, redirectUri: callbackUrl })
    return context.json(
      { data: { authorize_url: await service.authorizeUrl({ state, redirectUri: callbackUrl }) } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Where Intuit sends the operator back.
   *
   * Not JSON: a person's browser lands here, so it redirects to the settings
   * page either way and the page says what happened. The one thing it must not
   * do is act on a callback whose state it did not issue.
   */
  api.get('/integrations/quickbooks/callback', async (context) => {
    const url = new URL(context.req.url)
    const settings = service.settingsUrl()
    const error = url.searchParams.get('error')
    if (error !== null) {
      // The operator pressed Cancel, or Intuit refused. Neither is our failure.
      return context.redirect(`${settings}?quickbooks=${encodeURIComponent(error)}`, 302)
    }
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const realmId = url.searchParams.get('realmId')
    if (state === null || code === null || realmId === null) {
      return context.redirect(`${settings}?quickbooks=invalid_callback`, 302)
    }
    try {
      await service.completeAuthorization({ state, code, realmId })
    } catch (cause) {
      const reason =
        cause instanceof ApiError && cause.code === 'state_unknown'
          ? 'state_unknown'
          : 'exchange_failed'
      return context.redirect(`${settings}?quickbooks=${reason}`, 302)
    }
    return context.redirect(`${settings}?quickbooks=connected`, 302)
  })

  api.post('/integrations/quickbooks/settings', async (context) => {
    requireAdministrator(context)
    const body = await readObjectBody(context)
    const allow = body['allow_online_payment']
    if (typeof allow !== 'boolean') {
      // A 422 has to name the field at fault -- the shape this codebase
      // enforces, and the reason is that a validation error nobody can act on
      // is just a refusal.
      throw validationError([
        {
          field: 'allow_online_payment',
          code: 'invalid',
          message: 'allow_online_payment must be true or false.',
        },
      ])
    }
    await service.setAllowOnlinePayment(allow)
    const status = await service.readStatus()
    return context.json(
      { data: status === null ? null : serialize(status) },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.delete('/integrations/quickbooks', async (context) => {
    requireAdministrator(context)
    await service.disconnect()
    return context.body(null, 204)
  })

  // Where one invoice stands (issue 819). Mounted with the connection routes
  // because it is the same feature under the same gate: without Intuit keys
  // there is no state to report and the invoice page shows no line.
  api.get('/invoices/:id/quickbooks', async (context) => {
    requireMoneyWriter(context)
    const state = await service.syncState(invoiceIdOf(context))
    if (state === null) invoiceNotFound()
    return context.json({ data: serializeSyncState(state!) }, 200, {
      'cache-control': 'no-store',
    })
  })

  /**
   * The Sync button. A refused invoice mirror is a 409 carrying the reason,
   * because the operator pressed this to find out why -- the mirror's decision
   * is the answer, not an error in the request. A refused *receipt* after a
   * mirrored invoice is not a 409: the invoice did sync, and the state that
   * comes back names the receipt's refusal as the last outcome.
   */
  api.post('/invoices/:id/quickbooks/sync', async (context) => {
    requireMoneyWriter(context)
    const invoiceId = invoiceIdOf(context)
    const result = await service.sync(invoiceId)
    if (result === null) invoiceNotFound()
    if (result!.invoice.kind === 'refused') {
      throw new ApiError({
        status: 409,
        code: 'quickbooks_refused',
        message: result!.invoice.reason ?? 'QuickBooks refused the invoice.',
      })
    }
    const state = await service.syncState(invoiceId)
    if (state === null) invoiceNotFound()
    return context.json({ data: serializeSyncState(state!) }, 200, {
      'cache-control': 'no-store',
    })
  })
}

/**
 * Intuit's deliveries, on the app router rather than the API router.
 *
 * Unauthenticated by nature -- Intuit has no session with us -- so the
 * signature is the whole of the authorization, and it is checked before the
 * body is parsed as anything but text. That is exactly why it cannot live
 * under /api/v1: every request there goes through apiAuthenticationMiddleware,
 * which answered a bearer-less, same-origin-less POST with 403
 * csrf_origin_mismatch before the HMAC verifier ever ran (#739). The shipped
 * QuickBooks payment sync could not receive a single webhook. Stripe and Wise
 * were already mounted here for the same reason.
 *
 * Always 200 once the signature holds, even where the change is not ours.
 * Intuit retries a non-2xx, and retrying a delivery we have correctly decided
 * to ignore is work that can never succeed. A refusal is a 401, which is the
 * one case where a retry is not what we want either, but is the honest answer
 * to an unsigned request.
 */
export const installQuickBooksWebhookRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  service: Readonly<QuickBooksService>,
): void => {
  app.post('/webhooks/quickbooks', async (context) => {
    const payload = await context.req.text()
    const result = await service.receiveWebhook({
      payload,
      signature: context.req.header('intuit-signature') ?? null,
    })
    if (!result.accepted) {
      return context.json({ error: { code: 'signature_invalid' } }, 401)
    }
    return context.json({ data: { accepted: true } }, 200)
  })
}
