import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  installQuickBooksRoutes,
  installQuickBooksWebhookRoute,
  type QuickBooksService,
} from '../src/quickbooks.js'
import { createApiApp } from '../src/index.js'
import { ApiError, errorResponse } from '../src/errors.js'

type Principal = { userId: number; profile: string } | null

const connection = {
  realmId: 'realm-a',
  companyName: 'Sandbox Company',
  scope: 'com.intuit.quickbooks.accounting',
  allowOnlinePayment: false,
  connectedAt: '2026-09-11T12:00:00.000Z',
}

const service = (overrides: Partial<QuickBooksService> = {}): QuickBooksService => ({
  clientId: vi.fn(() => 'client-id'),
  callbackUrl: vi.fn(() => 'https://app.example.test/api/v1/integrations/quickbooks/callback'),
  settingsUrl: vi.fn(() => '/settings/integrations'),
  authorizeUrl: vi.fn(
    ({ state }: { state: string }) =>
      `https://appcenter.intuit.com/connect/oauth2?state=${state}`,
  ),
  beginAuthorization: vi.fn(async () => undefined),
  completeAuthorization: vi.fn(async () => connection),
  readStatus: vi.fn(async () => connection),
  setAllowOnlinePayment: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  receiveWebhook: vi.fn(async () => ({ accepted: true })),
  newState: vi.fn(() => 'state-value-0123456789'),
  ...overrides,
})

/**
 * A minimal app with the same session shape the real one uses, so the routes
 * see a principal the way they will in production.
 */
const app = (quickBooks: QuickBooksService, principal: Principal = { userId: 1, profile: 'administrator' }) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    if (principal !== null) {
      context.set('principal', {
        ...principal,
        authentication: { kind: 'session', sessionId: 'session-1' },
      })
    }
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installQuickBooksRoutes(instance as never, quickBooks)
  return instance
}

/**
 * The webhook on the surface it actually ships on: `createApiApp`, with the
 * authentication middleware in front of /api/v1, and no session or bearer of
 * any kind -- which is what Intuit sends.
 *
 * #739. The harness above mounts the router on a bare Hono with a principal
 * already set, so it never reproduced the condition that broke this: under
 * /api/v1 the middleware answered a bearer-less, same-origin-less POST with
 * 403 before the HMAC verifier ran, and the shipped payment sync received
 * nothing. A test that stands in for Intuit has to use the real app.
 */
const shippedApp = (quickBooks: QuickBooksService) =>
  createApiApp({
    installApp(app) {
      installQuickBooksWebhookRoute(app, quickBooks)
    },
  })

describe('the connect button', () => {
  it('[api] hands back an authorize URL carrying the state it just issued', async () => {
    const quickBooks = service()
    const response = await app(quickBooks).request('/integrations/quickbooks/authorize', {
      method: 'POST',
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { authorize_url: string } }
    expect(body.data.authorize_url).toContain('state=state-value-0123456789')
    // The state is recorded before the operator is sent anywhere, or the
    // callback has nothing to check against.
    expect(quickBooks.beginAuthorization).toHaveBeenCalledWith({
      state: 'state-value-0123456789',
      userId: 1,
      redirectUri: 'https://app.example.test/api/v1/integrations/quickbooks/callback',
    })
  })

  it('[security] only an administrator may connect or disconnect', async () => {
    // Connecting an accounting system is a grant over the whole book, not a
    // per-user preference.
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager']) {
      const quickBooks = service()
      const instance = app(quickBooks, { userId: 2, profile })
      const authorize = await instance.request('/integrations/quickbooks/authorize', {
        method: 'POST',
      })
      expect(authorize.status).toBe(403)
      const remove = await instance.request('/integrations/quickbooks', { method: 'DELETE' })
      expect(remove.status).toBe(403)
      expect(quickBooks.beginAuthorization).not.toHaveBeenCalled()
      expect(quickBooks.disconnect).not.toHaveBeenCalled()
    }
  })

  it('[security] an API token cannot connect an accounting system', async () => {
    // These routes sit behind the app's authentication, so a request with no
    // principal never reaches them -- that is the middleware's job, not theirs.
    // What *is* theirs: a token principal is not a session, and connecting
    // QuickBooks is a grant over the whole book that a person has to make.
    const quickBooks = service()
    const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
    instance.use('*', async (context, next) => {
      context.set('principal', {
        userId: 1,
        profile: 'administrator',
        authentication: { kind: 'api_token', tokenId: 7 },
      })
      await next()
    })
    instance.onError((error, context) => errorResponse(error, context as never))
    installQuickBooksRoutes(instance as never, quickBooks)

    const response = await instance.request('/integrations/quickbooks/authorize', {
      method: 'POST',
    })
    expect(response.status).toBe(403)
    expect(quickBooks.beginAuthorization).not.toHaveBeenCalled()
  })

  it('[api] says so rather than half-starting when the deployment has no Intuit keys', async () => {
    const quickBooks = service({ clientId: vi.fn(() => null) })
    const response = await app(quickBooks).request('/integrations/quickbooks/authorize', {
      method: 'POST',
    })
    expect(response.status).toBe(503)
    // Nothing is recorded for a handshake that cannot start.
    expect(quickBooks.beginAuthorization).not.toHaveBeenCalled()
  })
})

describe('the callback', () => {
  const callback = (query: string, quickBooks: QuickBooksService) =>
    app(quickBooks).request(`/integrations/quickbooks/callback${query}`)

  it('[api] completes the authorization and sends the operator back to settings', async () => {
    const quickBooks = service()
    const response = await callback(
      '?state=state-value-0123456789&code=auth-code&realmId=realm-a',
      quickBooks,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/settings/integrations?quickbooks=connected')
    expect(quickBooks.completeAuthorization).toHaveBeenCalledWith({
      state: 'state-value-0123456789',
      code: 'auth-code',
      realmId: 'realm-a',
    })
  })

  it('[security] a callback missing its state is not acted on', async () => {
    // The forged-authorization case. Without state, somebody can walk an
    // administrator through connecting their own QuickBooks company here.
    const quickBooks = service()
    const response = await callback('?code=auth-code&realmId=realm-a', quickBooks)
    expect(response.headers.get('location')).toBe(
      '/settings/integrations?quickbooks=invalid_callback',
    )
    expect(quickBooks.completeAuthorization).not.toHaveBeenCalled()
  })

  it('[security] a state the service refuses becomes a message, not a connection', async () => {
    const quickBooks = service({
      completeAuthorization: vi.fn(async () => {
        throw new ApiError({ status: 400, code: 'state_unknown', message: 'unknown state' })
      }),
    })
    const response = await callback(
      '?state=never-issued-0123456&code=auth-code&realmId=realm-a',
      quickBooks,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/settings/integrations?quickbooks=state_unknown')
  })

  it('[api] a cancelled consent is reported, not treated as a failure of ours', async () => {
    const quickBooks = service()
    const response = await callback('?error=access_denied&state=state-value-0123456789', quickBooks)
    expect(response.headers.get('location')).toBe('/settings/integrations?quickbooks=access_denied')
    expect(quickBooks.completeAuthorization).not.toHaveBeenCalled()
  })
})

describe('the webhook on the shipped surface', () => {
  const intuitDelivers = (quickBooks: QuickBooksService, path: string) =>
    shippedApp(quickBooks).request(`http://localhost${path}`, {
      method: 'POST',
      body: '{"eventNotifications":[]}',
      headers: { 'intuit-signature': 'a-signature' },
    })

  it('[security] reaches the signature check with no session and no origin', async () => {
    const quickBooks = service()
    const response = await intuitDelivers(quickBooks, '/webhooks/quickbooks')
    expect(response.status).toBe(200)
    expect(quickBooks.receiveWebhook).toHaveBeenCalledWith({
      payload: '{"eventNotifications":[]}',
      signature: 'a-signature',
    })
  })

  it('[security] is not under /api/v1, where authentication refuses it first', async () => {
    const quickBooks = service()
    const response = await intuitDelivers(quickBooks, '/api/v1/integrations/quickbooks/webhook')
    expect(response.status).not.toBe(200)
    // The point is that the verifier is never consulted there.
    expect(quickBooks.receiveWebhook).not.toHaveBeenCalled()
  })
})

describe('the webhook endpoint', () => {
  // Through the real app at the route it ships on, not a bare router: the
  // whole of #739 was that the two disagreed.
  const deliver = (quickBooks: QuickBooksService, signature: string | null) =>
    shippedApp(quickBooks).request('http://localhost/webhooks/quickbooks', {
      method: 'POST',
      body: '{"eventNotifications":[]}',
      ...(signature === null ? {} : { headers: { 'intuit-signature': signature } }),
    })

  it('[security] takes no session, and passes the signature to be checked', async () => {
    // Intuit has no session with us. The signature is the whole of the
    // authorization.
    const quickBooks = service()
    const response = await deliver(quickBooks, 'a-signature')
    expect(response.status).toBe(200)
    expect(quickBooks.receiveWebhook).toHaveBeenCalledWith({
      payload: '{"eventNotifications":[]}',
      signature: 'a-signature',
    })
  })

  it('[security] refuses a delivery the service did not accept', async () => {
    const quickBooks = service({ receiveWebhook: vi.fn(async () => ({ accepted: false })) })
    const response = await deliver(quickBooks, 'forged')
    expect(response.status).toBe(401)
  })

  it('[security] an unsigned delivery still reaches the check rather than being trusted', async () => {
    const quickBooks = service({ receiveWebhook: vi.fn(async () => ({ accepted: false })) })
    const response = await deliver(quickBooks, null)
    expect(response.status).toBe(401)
    expect(quickBooks.receiveWebhook).toHaveBeenCalledWith({
      payload: '{"eventNotifications":[]}',
      signature: null,
    })
  })

  it('[api] answers 200 for an accepted delivery it has nothing to do with', async () => {
    // Intuit retries a non-2xx, and retrying a delivery we have correctly
    // decided to ignore is work that can never succeed.
    const quickBooks = service({
      receiveWebhook: vi.fn(async () => ({ accepted: true, reason: 'entity is not mirrored' })),
    })
    expect((await deliver(quickBooks, 'a-signature')).status).toBe(200)
  })
})

describe('the settings toggle', () => {
  it('[api] turns QuickBooks payment links on for mirrored invoices', async () => {
    const quickBooks = service()
    const response = await app(quickBooks).request('/integrations/quickbooks/settings', {
      method: 'POST',
      body: JSON.stringify({ allow_online_payment: true }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(200)
    expect(quickBooks.setAllowOnlinePayment).toHaveBeenCalledWith(true)
  })

  it('[api] refuses a value that is not a choice', async () => {
    const quickBooks = service()
    const response = await app(quickBooks).request('/integrations/quickbooks/settings', {
      method: 'POST',
      body: JSON.stringify({ allow_online_payment: 'yes' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(422)
    expect(quickBooks.setAllowOnlinePayment).not.toHaveBeenCalled()
  })
})
