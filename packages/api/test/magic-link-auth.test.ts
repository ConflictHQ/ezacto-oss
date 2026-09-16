import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installMagicLinkRoutes,
  createPortalSessionResolver,
  createCompositeSessionResolver,
  type MagicLinkDelivery,
  type MagicLinkService,
  type PortalSessionIssuer,
  type PortalSessionStore,
  type PortalStatementReader,
  type PortalInvoiceSummary,
  portalSessionCookie,
} from '../src/index.js'

const portalToken =
  'ezacto_portal_AAAAAAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

const sessionStore: PortalSessionStore = {
  authenticate: vi.fn(async (token) => {
    if (token === portalToken) {
      return {
        contactId: 1,
        clientId: 10,
        session: {
          id: 42,
          absoluteExpiresAt: '2026-09-08T00:00:00.000Z',
        },
      }
    }
    return null
  }),
}

const magicLinkService: MagicLinkService = {
  findContactByEmail: vi.fn(async (email) =>
    email === 'alice@acme.test'
      ? {
          contactId: 1,
          clientId: 10,
          email: 'alice@acme.test',
          firstName: 'Alice',
          lastName: 'Smith',
        }
      : null,
  ),
  createToken: vi.fn(async () => ({
    token: 'ezacto_magic_testpayload.testsignature',
    jti: 'test-jti-001',
    expiresAt: '2026-09-01T00:15:00.000Z',
  })),
  recordToken: vi.fn(async () => undefined),
  verifyAndConsume: vi.fn(async (token) =>
    token === 'valid-magic-token'
      ? { contactId: 1, clientId: 10, contactEmail: 'alice@acme.test' }
      : null,
  ),
}

const portalSessions: PortalSessionIssuer = {
  issue: vi.fn(async () => ({
    setCookie: `__Host-ezacto_portal=${portalToken}; Path=/; Expires=Thu, 08 Sep 2026 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
    sessionId: '42',
  })),
}

const invoiceSummary: PortalInvoiceSummary = {
  id: 100,
  number: 'INV-001',
  subject: 'August 2026 Services',
  currency: 'USD',
  issueDate: '2026-09-01',
  dueDate: '2026-09-30',
  state: 'open',
  amountCents: 500000,
  dueAmountCents: 500000,
}

const statements: PortalStatementReader = {
  listClientInvoices: vi.fn(async () => [invoiceSummary]),
}

const deliveries: MagicLinkDelivery[] = []

const mailer = {
  enqueue: async (delivery: MagicLinkDelivery) => void deliveries.push(delivery),
}

const createHarness = () => {
  deliveries.length = 0
  const app = createApiApp({
    installApp(app) {
      installMagicLinkRoutes(app, {
        service: magicLinkService,
        sessions: portalSessions,
        sessionStore,
        mailer,
        statements,
      })
    },
  })
  return app
}

const post = (
  app: ReturnType<typeof createApiApp>,
  path: string,
  body: unknown,
) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('magic-link authentication routes', () => {
  it('[api] POST /portal/magic-link returns 202 for known contact and enqueues mail', async () => {
    const app = createHarness()
    const response = await post(app, '/portal/magic-link', {
      email: 'alice@acme.test',
    })
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body).toEqual({ data: { status: 'magic_link_sent' } })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      kind: 'magic_link',
      to: 'alice@acme.test',
    })
  })

  it('[security] POST /portal/magic-link returns 202 for unknown email (no enumeration)', async () => {
    const app = createHarness()
    const response = await post(app, '/portal/magic-link', {
      email: 'unknown@example.com',
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ data: { status: 'magic_link_sent' } })
    // No delivery should be enqueued for unknown contact
    expect(deliveries).toHaveLength(0)
  })

  it('[api] POST /portal/magic-link rejects missing email', async () => {
    const app = createHarness()
    const response = await post(app, '/portal/magic-link', {})
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: Array<{ field: string }> } }
    expect(body.error.fields[0]!.field).toBe('email')
  })

  it('[api] POST /portal/magic-link rejects unknown fields', async () => {
    const app = createHarness()
    const response = await post(app, '/portal/magic-link', {
      email: 'alice@acme.test',
      extra: 'nope',
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: Array<{ field: string }> } }
    expect(body.error.fields.some((f) => f.field === 'extra')).toBe(true)
  })

  it('[api] GET /portal/verify creates a session for a valid token', async () => {
    const app = createHarness()
    const response = await app.request('/portal/verify?token=valid-magic-token')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      data: {
        status: 'authenticated',
        contact_id: 1,
        client_id: 10,
      },
    })
    expect(response.headers.get('set-cookie')).toContain('__Host-ezacto_portal')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('[api] GET /portal/verify returns 401 for invalid/expired/used token', async () => {
    const app = createHarness()
    const response = await app.request('/portal/verify?token=bogus-token')
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_magic_link')
  })

  it('[api] GET /portal/verify returns 400 for missing token', async () => {
    const app = createHarness()
    const response = await app.request('/portal/verify')
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('missing_token')
  })

  it('[api] GET /portal/statements returns invoices for authenticated portal session', async () => {
    const app = createHarness()
    const response = await app.request('/portal/statements', {
      headers: {
        cookie: `__Host-ezacto_portal=${portalToken}`,
      },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: {
        contact_id: number
        client_id: number
        invoices: Array<{ number: string }>
      }
    }
    expect(body.data.contact_id).toBe(1)
    expect(body.data.client_id).toBe(10)
    expect(body.data.invoices).toHaveLength(1)
    expect(body.data.invoices[0]!.number).toBe('INV-001')
  })

  it('[api] GET /portal/statements returns 401 without portal session', async () => {
    const app = createHarness()
    const response = await app.request('/portal/statements')
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('authentication_required')
  })
})

describe('portal session resolver', () => {
  it('[unit] resolves a contact principal from the portal cookie', async () => {
    const resolver = createPortalSessionResolver(sessionStore)
    const request = new Request('https://example.com/portal/statements', {
      headers: { cookie: `__Host-ezacto_portal=${portalToken}` },
    })
    const principal = await resolver.resolve(request)
    expect(principal).toMatchObject({
      type: 'contact',
      contactId: 1,
      clientId: 10,
      authentication: { kind: 'session', sessionId: '42' },
    })
  })

  it('[unit] returns null when no portal cookie', async () => {
    const resolver = createPortalSessionResolver(sessionStore)
    const request = new Request('https://example.com/portal/statements')
    const principal = await resolver.resolve(request)
    expect(principal).toBeNull()
  })

  it('[unit] returns null for invalid portal session token', async () => {
    const resolver = createPortalSessionResolver(sessionStore)
    const request = new Request('https://example.com/portal/statements', {
      headers: { cookie: '__Host-ezacto_portal=bad-token' },
    })
    const principal = await resolver.resolve(request)
    expect(principal).toBeNull()
  })
})

describe('composite session resolver', () => {
  it('[unit] user resolver takes priority over portal resolver', async () => {
    const userResolver = {
      resolve: vi.fn(async () => ({
        type: 'user' as const,
        userId: 42,
        profile: 'administrator' as const,
        authentication: { kind: 'session' as const, sessionId: 'user-session' },
      })),
    }
    const portalResolver = {
      resolve: vi.fn(async () => ({
        type: 'contact' as const,
        contactId: 1,
        clientId: 10,
        authentication: { kind: 'session' as const, sessionId: 'portal-session' },
      })),
    }
    const composite = createCompositeSessionResolver(userResolver, portalResolver)
    const request = new Request('https://example.com/')
    const result = await composite.resolve(request)
    expect(result).toMatchObject({ type: 'user' })
    expect(portalResolver.resolve).not.toHaveBeenCalled()
  })

  it('[unit] falls through to portal resolver when user resolver returns null', async () => {
    const userResolver = { resolve: vi.fn(async () => null) }
    const portalResolver = {
      resolve: vi.fn(async () => ({
        type: 'contact' as const,
        contactId: 1,
        clientId: 10,
        authentication: { kind: 'session' as const, sessionId: 'portal-session' },
      })),
    }
    const composite = createCompositeSessionResolver(userResolver, portalResolver)
    const request = new Request('https://example.com/')
    const result = await composite.resolve(request)
    expect(result).toMatchObject({ type: 'contact' })
    expect(userResolver.resolve).toHaveBeenCalled()
    expect(portalResolver.resolve).toHaveBeenCalled()
  })

  it('[unit] returns null when both resolvers return null', async () => {
    const userResolver = { resolve: vi.fn(async () => null) }
    const portalResolver = { resolve: vi.fn(async () => null) }
    const composite = createCompositeSessionResolver(userResolver, portalResolver)
    const request = new Request('https://example.com/')
    const principal = await composite.resolve(request)
    expect(principal).toBeNull()
  })
})

/**
 * #733. The cookie string used to be asserted only through a hand-written fake
 * in this file, so the real builder's `Path` was never checked and shipped
 * broken. These call the builder itself.
 *
 * `__Host-` is a promise to the browser: Secure, no Domain, Path=/. A cookie
 * carrying the prefix and breaking any part of it is dropped outright by
 * Chrome, Firefox and Safari, so the portal could never sign anyone in.
 */
describe('portal session cookie', () => {
  const cookie = () => portalSessionCookie(`ezacto_portal_${'a'.repeat(16)}_${'b'.repeat(43)}`, '2026-09-08T00:00:00.000Z')

  it('satisfies every __Host- requirement, so a browser will actually store it', () => {
    const value = cookie()
    expect(value.startsWith('__Host-')).toBe(true)
    expect(value).toContain('; Path=/;')
    expect(value).not.toMatch(/; Path=\/[^;]/)
    expect(value).toContain('; Secure')
    expect(value).not.toContain('Domain=')
  })

  it('stays HttpOnly and SameSite=Lax', () => {
    expect(cookie()).toContain('; HttpOnly')
    expect(cookie()).toContain('; SameSite=Lax')
  })

  it('refuses malformed bearer material rather than setting a cookie', () => {
    expect(() => portalSessionCookie('not-a-portal-token', '2026-09-08T00:00:00.000Z')).toThrow()
  })
})
