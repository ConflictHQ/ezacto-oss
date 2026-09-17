import { beforeEach, describe, expect, it } from 'vitest'
import {
  QUICKBOOKS_ACCOUNTING_SCOPE,
  QUICKBOOKS_DEFAULT_ENDPOINTS,
  QUICKBOOKS_DISCOVERY_URL,
  QUICKBOOKS_SANDBOX_DISCOVERY_URL,
  discoverEndpoints,
  forgetDiscoveredEndpoints,
  QuickBooksOAuthError,
  accessTokenNeedsRefresh,
  authorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeConnection,
} from '../src/quickbooks/oauth.js'

const now = new Date('2026-09-11T12:00:00.000Z')

const tokenResponse = (overrides: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3_600,
      x_refresh_token_expires_in: 8_726_400,
      token_type: 'bearer',
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('Intuit OAuth', () => {
  it('[unit] asks for accounting alone, and carries the state it was given', () => {
    const url = new URL(
      authorizeUrl({
        clientId: 'client-id',
        redirectUri: 'https://app.example.test/api/v1/integrations/quickbooks/callback',
        state: 'opaque-state',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2')
    // Accounting covers customers, invoices and the payments recorded against
    // them. The card-processing scope is a different grant and asking for it
    // would ask every operator to hand over card processing to an app that does
    // not process cards.
    expect(url.searchParams.get('scope')).toBe(QUICKBOOKS_ACCOUNTING_SCOPE)
    expect(url.searchParams.get('scope')).not.toContain('payment')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('state')).toBe('opaque-state')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.test/api/v1/integrations/quickbooks/callback',
    )
  })

  it('[security] refuses to build an authorize URL with no state', () => {
    // State is the only thing between the callback and a forged authorization:
    // without it, a third party can walk an administrator through connecting
    // somebody else's QuickBooks company to this instance. Refusing here means
    // the mistake cannot be made silently upstream.
    expect(() =>
      authorizeUrl({ clientId: 'client-id', redirectUri: 'https://app.example.test/cb', state: '' }),
    ).toThrow(QuickBooksOAuthError)
    expect(() =>
      authorizeUrl({
        clientId: 'client-id',
        redirectUri: 'https://app.example.test/cb',
        state: '   ',
      }),
    ).toThrow(QuickBooksOAuthError)
  })

  it('[unit] turns Intuit lifetimes into instants at the clock it was given', async () => {
    const tokens = await exchangeAuthorizationCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.example.test/cb',
      code: 'authorization-code',
      fetch: async () => tokenResponse(),
      now,
    })
    // A stored `expires_in` is wrong the moment it is read back; an instant is
    // not. 3600s from noon is one o'clock, and the refresh token's 101 days
    // land where the arithmetic says.
    expect(tokens.accessTokenExpiresAt).toBe('2026-09-11T13:00:00.000Z')
    expect(tokens.refreshTokenExpiresAt).toBe('2026-12-21T12:00:00.000Z')
    expect(tokens.accessToken).toBe('access-token-value')
    expect(tokens.refreshToken).toBe('refresh-token-value')
  })

  it('[security] sends the client secret as Basic auth and never in the query string', async () => {
    let seen: Request | null = null
    await exchangeAuthorizationCode({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.example.test/cb',
      code: 'authorization-code',
      fetch: async (request) => {
        seen = request.clone()
        return tokenResponse()
      },
      now,
    })
    const request = seen as unknown as Request
    // A secret in a URL is a secret in every proxy log and every browser
    // history between here and Intuit.
    expect(request.url).not.toContain('client-secret')
    expect(request.url).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer')
    expect(request.headers.get('authorization')).toBe(`Basic ${btoa('client-id:client-secret')}`)
    const body = await request.text()
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code=authorization-code')
    expect(body).not.toContain('client_secret')
  })

  it('[unit] reports what Intuit said when an exchange is refused', async () => {
    await expect(
      exchangeAuthorizationCode({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://app.example.test/cb',
        code: 'already-used',
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: 'invalid_grant',
              error_description: 'Token invalid or expired',
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        now,
      }),
    ).rejects.toMatchObject({
      name: 'QuickBooksOAuthError',
      status: 400,
      // The code is what tells a caller this is terminal for that authorization
      // code rather than something to retry.
      code: 'invalid_grant',
    })
  })

  it('[unit] a refresh returns a new refresh token, which is the one to store', async () => {
    const tokens = await refreshAccessToken({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'old-refresh-token',
      fetch: async () =>
        tokenResponse({ access_token: 'next-access', refresh_token: 'next-refresh' }),
      now,
    })
    // Intuit rotates it on every refresh and the one just used stops working.
    // A caller that keeps the old one has a connection it cannot refresh and
    // cannot tell apart from one the operator revoked.
    expect(tokens.refreshToken).toBe('next-refresh')
    expect(tokens.refreshToken).not.toBe('old-refresh-token')
    expect(tokens.accessToken).toBe('next-access')
  })

  it('[unit] treats an unrecognised token as already revoked', async () => {
    // 400 from revoke means Intuit does not know the token, which is the state
    // the caller was asking for. Throwing would leave a disconnect button that
    // fails on its second press.
    await expect(
      revokeConnection({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        token: 'unknown',
        fetch: async () => new Response('{}', { status: 400 }),
      }),
    ).resolves.toBeUndefined()
    await expect(
      revokeConnection({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        token: 'known',
        fetch: async () => new Response(null, { status: 200 }),
      }),
    ).resolves.toBeUndefined()
    await expect(
      revokeConnection({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        token: 'known',
        fetch: async () => new Response('{}', { status: 500 }),
      }),
    ).rejects.toThrow(QuickBooksOAuthError)
  })

  it('[unit] refreshes before expiry rather than on it', () => {
    const tokens = { accessTokenExpiresAt: '2026-09-11T12:05:00.000Z' }
    // Five minutes out: no.
    expect(accessTokenNeedsRefresh(tokens, new Date('2026-09-11T12:00:00.000Z'))).toBe(false)
    // Inside the margin: yes, because a token that expires mid-flight fails a
    // mirror that had already decided what to write.
    expect(accessTokenNeedsRefresh(tokens, new Date('2026-09-11T12:03:30.000Z'))).toBe(true)
    expect(accessTokenNeedsRefresh(tokens, new Date('2026-09-11T12:06:00.000Z'))).toBe(true)
  })

  it('[unit] refuses a token response that is missing what it must carry', async () => {
    for (const missing of ['access_token', 'refresh_token', 'expires_in']) {
      await expect(
        exchangeAuthorizationCode({
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUri: 'https://app.example.test/cb',
          code: 'code',
          fetch: async () => tokenResponse({ [missing]: undefined }),
          now,
        }),
      ).rejects.toThrow(QuickBooksOAuthError)
    }
  })
})

describe('the discovery document', () => {
  beforeEach(() => {
    forgetDiscoveredEndpoints()
  })

  const document = (overrides: Record<string, unknown> = {}): Response =>
    new Response(
      JSON.stringify({
        issuer: 'https://oauth.platform.intuit.com/op/v1',
        authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
        token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
        revocation_endpoint: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
        ...overrides,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  it('[unit] reads the three endpoints from the document, and every call follows them', async () => {
    const seen: string[] = []
    const fetch = async (request: Request): Promise<Response> => {
      seen.push(request.url)
      if (request.url === QUICKBOOKS_DISCOVERY_URL) {
        return document({
          authorization_endpoint: 'https://appcenter.intuit.example/connect/oauth2',
          token_endpoint: 'https://oauth.intuit.example/oauth2/v2/tokens/bearer',
          revocation_endpoint: 'https://developer.intuit.example/v3/oauth2/tokens/revoke',
        })
      }
      return tokenResponse()
    }
    const endpoints = await discoverEndpoints({ fetch, now })
    expect(endpoints).toEqual({
      authorizationEndpoint: 'https://appcenter.intuit.example/connect/oauth2',
      tokenEndpoint: 'https://oauth.intuit.example/oauth2/v2/tokens/bearer',
      revocationEndpoint: 'https://developer.intuit.example/v3/oauth2/tokens/revoke',
    })
    expect(
      authorizeUrl({ clientId: 'c', redirectUri: 'https://a.test/cb', state: 's1', endpoints }),
    ).toContain('https://appcenter.intuit.example/connect/oauth2?')
    await refreshAccessToken({
      clientId: 'c', clientSecret: 'x', refreshToken: 'r', fetch, now, endpoints,
    })
    await revokeConnection({ clientId: 'c', clientSecret: 'x', token: 'r', fetch, endpoints })
    expect(seen.slice(1)).toEqual([
      'https://oauth.intuit.example/oauth2/v2/tokens/bearer',
      'https://developer.intuit.example/v3/oauth2/tokens/revoke',
    ])
  })

  it('[unit] the sandbox environment reads the sandbox document', async () => {
    const seen: string[] = []
    await discoverEndpoints({
      fetch: async (request) => {
        seen.push(request.url)
        return document()
      },
      now,
      environment: 'sandbox',
    })
    expect(seen).toEqual([QUICKBOOKS_SANDBOX_DISCOVERY_URL])
  })

  it('[unit] is read once an hour, not once a call', async () => {
    let reads = 0
    const fetch = async (): Promise<Response> => {
      reads += 1
      return document()
    }
    await discoverEndpoints({ fetch, now })
    await discoverEndpoints({ fetch, now: new Date(now.getTime() + 30 * 60 * 1_000) })
    expect(reads).toBe(1)
    await discoverEndpoints({ fetch, now: new Date(now.getTime() + 61 * 60 * 1_000) })
    expect(reads).toBe(2)
  })

  it('[reliability] an unreachable or malformed document yields the published defaults', async () => {
    expect(
      await discoverEndpoints({
        fetch: async () => {
          throw new TypeError('network down')
        },
        now,
      }),
    ).toEqual(QUICKBOOKS_DEFAULT_ENDPOINTS)
    forgetDiscoveredEndpoints()
    expect(
      await discoverEndpoints({
        fetch: async () => new Response('<html>', { status: 503 }),
        now,
      }),
    ).toEqual(QUICKBOOKS_DEFAULT_ENDPOINTS)
    forgetDiscoveredEndpoints()
    // A document that names one endpoint over plain http, or omits one, is
    // not followed for that endpoint: a secret goes only where TLS goes.
    const partial = await discoverEndpoints({
      fetch: async () =>
        document({ token_endpoint: 'http://oauth.intuit.example/tokens', revocation_endpoint: undefined }),
      now,
    })
    expect(partial.tokenEndpoint).toBe(QUICKBOOKS_DEFAULT_ENDPOINTS.tokenEndpoint)
    expect(partial.revocationEndpoint).toBe(QUICKBOOKS_DEFAULT_ENDPOINTS.revocationEndpoint)
  })
})
