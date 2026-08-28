import { describe, expect, it, vi } from 'vitest'
import {
  OIDC_STATE_COOKIE_NAME,
  createApiApp,
  installOidcRoutes,
  type OidcProviderConfig,
  type OidcTransaction,
  type OidcTransactionStorePort,
} from '../src/index.js'

const fixedNow = '2026-08-28T12:00:00.000Z'

const base64Url = (value: string | Uint8Array): string => {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const sha256Hex = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

class MemoryTransactions implements OidcTransactionStorePort {
  private readonly rows = new Map<string, OidcTransaction>()
  readonly created: Array<{ stateHash: string; provider: string }> = []
  consumeCalls = 0

  async create(input: {
    provider: string
    issuer: string
    clientId: string
    clientKeyHash: string
    stateHash: string
    codeVerifier: string
    nonce: string
    redirectUri: string
    expiresAt: string
    createdAt: string
    rateWindowStart: string
    cleanupBefore: string
  }): Promise<'created' | 'collision' | 'rate_limited'> {
    if (this.rows.has(input.stateHash)) return 'collision'
    this.created.push({ stateHash: input.stateHash, provider: input.provider })
    this.rows.set(input.stateHash, {
      id: this.rows.size + 1,
      provider: input.provider,
      issuer: input.issuer,
      clientId: input.clientId,
      codeVerifier: input.codeVerifier,
      nonce: input.nonce,
      redirectUri: input.redirectUri,
      expiresAt: input.expiresAt,
      consumedAt: null,
      createdAt: input.createdAt,
    })
    return 'created'
  }

  async consume(
    provider: string,
    stateHash: string,
    now: string,
  ): Promise<OidcTransaction | null> {
    this.consumeCalls += 1
    const row = this.rows.get(stateHash)
    if (
      row === undefined ||
      row.provider !== provider ||
      row.consumedAt !== null ||
      Date.parse(row.expiresAt) <= Date.parse(now)
    ) {
      return null
    }
    const consumed = { ...row, consumedAt: now }
    this.rows.set(stateHash, consumed)
    return consumed
  }
}

interface FakeProvider {
  config: OidcProviderConfig
  calls: string[]
  tokenBodies: URLSearchParams[]
  setNonce(value: string): void
  setIdTokenClaims(claims: Readonly<Record<string, unknown>>): void
  setUserInfoClaims(claims: Readonly<Record<string, unknown>>): void
  rejectSignature(): void
}

const fakeProvider = async (issuer: string): Promise<FakeProvider> => {
  const signingKey = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const untrustedKey = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', signingKey.publicKey)) as JsonWebKey
  const issuerUrl = new URL(issuer)
  const endpoint = (path: string) => new URL(path, issuerUrl).href
  const calls: string[] = []
  const tokenBodies: URLSearchParams[] = []
  let expectedNonce = ''
  let invalidSignature = false
  let idTokenClaims: Readonly<Record<string, unknown>> = {}
  let userInfoClaims: Readonly<Record<string, unknown>> = {}

  const signedIdToken = async (): Promise<string> => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }))
    const epoch = Math.floor(Date.now() / 1_000)
    const payload = base64Url(
      JSON.stringify({
        iss: issuerUrl.href.replace(/\/$/, ''),
        aud: 'test-client',
        sub: 'provider-subject-7',
        iat: epoch - 1,
        exp: epoch + 600,
        nonce: expectedNonce,
        email: 'owner@example.test',
        email_verified: true,
        given_name: 'Avery',
        family_name: 'Ng',
        ...idTokenClaims,
      }),
    )
    const input = `${header}.${payload}`
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      invalidSignature ? untrustedKey.privateKey : signingKey.privateKey,
      new TextEncoder().encode(input),
    )
    return `${input}.${base64Url(new Uint8Array(signature))}`
  }

  const transport = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push(url)
    if (url === endpoint('/.well-known/openid-configuration')) {
      return Response.json({
        issuer: issuerUrl.href.replace(/\/$/, ''),
        authorization_endpoint: endpoint('/authorize'),
        token_endpoint: endpoint('/token'),
        jwks_uri: endpoint('/jwks'),
        userinfo_endpoint: endpoint('/userinfo'),
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      })
    }
    if (url === endpoint('/token')) {
      const body = new URLSearchParams(String(init.body))
      tokenBodies.push(body)
      if (body.get('code') !== 'test-authorization-code') {
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return Response.json({
        access_token: 'provider-access-token',
        token_type: 'Bearer',
        expires_in: 600,
        id_token: await signedIdToken(),
      })
    }
    if (url === endpoint('/jwks')) {
      return Response.json({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] })
    }
    if (url === endpoint('/userinfo')) {
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer provider-access-token',
      )
      return Response.json({
        sub: 'provider-subject-7',
        email: 'owner@example.test',
        email_verified: true,
        given_name: 'Avery',
        family_name: 'Ng',
        ...userInfoClaims,
      })
    }
    return new Response('not found', { status: 404 })
  }

  return {
    config: {
      issuer: issuerUrl.href.replace(/\/$/, ''),
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectOrigin: 'https://ezacto.io',
      clientAuthentication: 'client_secret_post',
      idTokenSigningAlgorithm: 'RS256',
      fetch: transport,
    },
    calls,
    tokenBodies,
    setNonce: (value) => {
      expectedNonce = value
    },
    setIdTokenClaims: (claims) => {
      idTokenClaims = { ...claims }
    },
    setUserInfoClaims: (claims) => {
      userInfoClaims = { ...claims }
    },
    rejectSignature: () => {
      invalidSignature = true
    },
  }
}

const harness = async (
  configured: Readonly<Record<string, FakeProvider>>,
) => {
  const transactions = new MemoryTransactions()
  const identities = {
    resolveProvider: vi.fn(async () => ({
      status: 'active' as const,
      matchedBy: 'verified_email' as const,
      userId: 7,
      profile: 'administrator' as const,
      managerGrants: [] as string[],
    })),
  }
  const sessions = {
    issue: vi.fn(async () => ({
      setCookie:
        '__Host-ezacto_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax',
    })),
  }
  const app = createApiApp({
    installApp(app) {
      installOidcRoutes(app, {
        transactions,
        identities,
        sessions,
        provider: (key) => configured[key]?.config ?? null,
        clientKey: () => '198.51.100.8',
        now: () => fixedNow,
      })
    },
  })
  return { app, transactions, identities, sessions }
}

const start = async (
  app: Awaited<ReturnType<typeof harness>>['app'],
  provider: FakeProvider,
  key = 'google',
) => {
  const response = await app.request(`https://ezacto.io/auth/oidc/${key}`)
  expect(response.status).toBe(302)
  const authorization = new URL(response.headers.get('location')!)
  provider.setNonce(authorization.searchParams.get('nonce')!)
  return {
    authorization,
    state: authorization.searchParams.get('state')!,
    cookie: response.headers.get('set-cookie')!.split(';', 1)[0]!,
  }
}

describe('OpenID Connect browser authentication', () => {
  it('[api] completes discovery, PKCE, nonce, JWKS, UserInfo, identity, and session issuance', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    const { app, transactions, identities, sessions } = await harness({ google })
    const pending = await start(app, google)

    expect(pending.authorization.origin).toBe('https://accounts.example.test')
    expect(pending.authorization.pathname).toBe('/authorize')
    expect(pending.authorization.searchParams.get('redirect_uri')).toBe(
      'https://ezacto.io/auth/oidc/google/callback',
    )
    expect(pending.authorization.searchParams.get('response_type')).toBe('code')
    expect(pending.authorization.searchParams.get('scope')).toBe('openid email profile')
    expect(pending.authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(pending.authorization.searchParams.get('code_challenge')).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    )
    expect(transactions.created[0]?.stateHash).toBe(await sha256Hex(pending.state))
    expect(transactions.created[0]?.stateHash).not.toContain(pending.state)

    const callback = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.get('location')).toBe('/')
    expect(callback.headers.get('cache-control')).toBe('no-store')
    expect(callback.headers.get('referrer-policy')).toBe('no-referrer')
    expect(callback.headers.get('set-cookie')).toContain(`${OIDC_STATE_COOKIE_NAME}=;`)
    expect(callback.headers.get('set-cookie')).toContain('__Host-ezacto_session=test-session')
    expect(google.calls).toContain('https://accounts.example.test/jwks')
    expect(google.tokenBodies[0]?.get('client_id')).toBe('test-client')
    expect(google.tokenBodies[0]?.get('client_secret')).toBe('test-secret')
    expect(google.tokenBodies[0]?.get('redirect_uri')).toBe(
      'https://ezacto.io/auth/oidc/google/callback',
    )
    expect(google.tokenBodies[0]?.get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
    expect(identities.resolveProvider).toHaveBeenCalledWith({
      provider: 'google',
      subject: 'provider-subject-7',
      email: 'owner@example.test',
      emailVerified: true,
      firstName: 'Avery',
      lastName: 'Ng',
    })
    expect(sessions.issue).toHaveBeenCalledWith(7)

    const replay = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(replay.status).toBe(401)
    expect(google.tokenBodies).toHaveLength(1)
  })

  it('[acceptance] supports a second issuer through configuration only', async () => {
    const workforce = await fakeProvider('https://workforce.example.test')
    const { app, identities } = await harness({ workforce })
    const pending = await start(app, workforce, 'workforce')
    const callback = await app.request(
      `https://ezacto.io/auth/oidc/workforce/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(303)
    expect(workforce.calls).toContain('https://workforce.example.test/jwks')
    expect(identities.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'workforce' }),
    )
  })

  it('[security] consumes state before rejecting an ID token with an untrusted signature', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    google.rejectSignature()
    const { app, identities, sessions } = await harness({ google })
    const pending = await start(app, google)
    const callback = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(401)
    expect(await callback.json()).toMatchObject({
      error: { code: 'oidc_authentication_failed' },
    })
    expect(google.calls).toContain('https://accounts.example.test/jwks')
    expect(identities.resolveProvider).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()

    const retry = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(retry.status).toBe(401)
    expect(google.tokenBodies).toHaveLength(1)
  })

  it('[security] never splices email and verification claims across provider sources', async () => {
    const conflictingClaims = [
      {
        idToken: { email: 'old-owner@example.test', email_verified: true },
        userInfo: { email: 'victim@example.test', email_verified: undefined },
      },
      {
        idToken: { email: 'owner@example.test', email_verified: true },
        userInfo: { email: 'victim@example.test', email_verified: true },
      },
      {
        idToken: { email: 'owner@example.test', email_verified: true },
        userInfo: { email: 'OWNER@example.test', email_verified: false },
      },
    ] as const

    for (const claims of conflictingClaims) {
      const google = await fakeProvider('https://accounts.example.test')
      google.setIdTokenClaims(claims.idToken)
      google.setUserInfoClaims(claims.userInfo)
      const { app, identities, sessions } = await harness({ google })
      const pending = await start(app, google)
      const callback = await app.request(
        `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
        { headers: { cookie: pending.cookie } },
      )
      expect(callback.status).toBe(401)
      expect(await callback.json()).toMatchObject({
        error: { code: 'oidc_authentication_failed' },
      })
      expect(identities.resolveProvider).not.toHaveBeenCalled()
      expect(sessions.issue).not.toHaveBeenCalled()
    }
  })

  it('[security] compares complete email claim sets canonically', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    google.setIdTokenClaims({ email: ' Owner@Example.Test ', email_verified: true })
    google.setUserInfoClaims({ email: 'owner@example.test', email_verified: true })
    const { app, identities } = await harness({ google })
    const pending = await start(app, google)
    const callback = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(303)
    expect(identities.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'owner@example.test', emailVerified: true }),
    )
  })

  it('[api] accepts a complete email claim set from exactly one provider source', async () => {
    for (const absentSource of ['id-token', 'userinfo'] as const) {
      const google = await fakeProvider('https://accounts.example.test')
      const absentClaims = { email: undefined, email_verified: undefined }
      if (absentSource === 'id-token') google.setIdTokenClaims(absentClaims)
      else google.setUserInfoClaims(absentClaims)
      const { app, identities } = await harness({ google })
      const pending = await start(app, google)
      const callback = await app.request(
        `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
        { headers: { cookie: pending.cookie } },
      )
      expect(callback.status).toBe(303)
      expect(identities.resolveProvider).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'owner@example.test', emailVerified: true }),
      )
    }
  })

  it('[security] rejects absent, duplicate, and mismatched browser state before token exchange', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    const { app, transactions } = await harness({ google })
    const pending = await start(app, google)
    const noCookie = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
    )
    expect(noCookie.status).toBe(401)

    const mismatch = await app.request(
      'https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=attacker-state',
      { headers: { cookie: pending.cookie } },
    )
    expect(mismatch.status).toBe(401)

    const duplicate = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(duplicate.status).toBe(401)

    for (const query of [
      `code=one&code=two&state=${encodeURIComponent(pending.state)}`,
      `error=access_denied&error=server_error&state=${encodeURIComponent(pending.state)}`,
      `code=one&error=access_denied&state=${encodeURIComponent(pending.state)}`,
      `code=one&state=${encodeURIComponent(pending.state)}&iss=one&iss=two`,
    ]) {
      const malformed = await app.request(
        `https://ezacto.io/auth/oidc/google/callback?${query}`,
        { headers: { cookie: pending.cookie } },
      )
      expect(malformed.status).toBe(401)
    }
    expect(transactions.consumeCalls).toBe(0)
    expect(google.tokenBodies).toHaveLength(0)
  })

  it('[security] binds a pending transaction to the exact issuer, client, and callback config', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    const { app, identities } = await harness({ google })
    const pending = await start(app, google)
    google.config.clientId = 'replacement-client'
    const callback = await app.request(
      `https://ezacto.io/auth/oidc/google/callback?code=test-authorization-code&state=${encodeURIComponent(pending.state)}`,
      { headers: { cookie: pending.cookie } },
    )
    expect(callback.status).toBe(401)
    expect(google.tokenBodies).toHaveLength(0)
    expect(identities.resolveProvider).not.toHaveBeenCalled()
  })

  it('[security] rejects non-HTTPS discovered endpoints before creating state', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    const originalFetch = google.config.fetch!
    google.config.fetch = async (url, init) => {
      const response = await originalFetch(url, init)
      if (!url.endsWith('/.well-known/openid-configuration')) return response
      const discovery = (await response.json()) as Record<string, unknown>
      return Response.json({ ...discovery, token_endpoint: 'http://idp.invalid/token' })
    }
    const { app, transactions } = await harness({ google })
    const response = await app.request('https://ezacto.io/auth/oidc/google')
    expect(response.status).toBe(503)
    expect(transactions.created).toHaveLength(1)
  })

  it('[security] surfaces the DB-backed start bound as a rate limit', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    const { app, transactions } = await harness({ google })
    transactions.create = vi.fn(async (): Promise<'rate_limited'> => 'rate_limited')
    const response = await app.request('https://ezacto.io/auth/oidc/google')
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({
      error: { code: 'oidc_start_rate_limited' },
    })
    expect(google.calls).toHaveLength(0)
  })

  it('[api] exposes only configured provider keys and fails closed on bad configuration', async () => {
    const google = await fakeProvider('https://accounts.example.test')
    const { app } = await harness({ google })
    const unknown = await app.request('https://ezacto.io/auth/oidc/github')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({
      error: { code: 'oidc_provider_not_found' },
    })

    const broken = createApiApp({
      installApp(app) {
        installOidcRoutes(app, {
          transactions: new MemoryTransactions(),
          identities: { resolveProvider: vi.fn() },
          sessions: { issue: vi.fn() },
          provider: () => ({ ...google.config, clientSecret: '' }),
          clientKey: () => '198.51.100.8',
        })
      },
    })
    const unavailable = await broken.request('https://ezacto.io/auth/oidc/google')
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({
      error: { code: 'internal_error' },
    })
  })
})
