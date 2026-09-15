import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import {
  APPLE_ISSUER,
  APPLE_JWKS_URI,
  assertValidAppleProviderConfig,
  createApiApp,
  createAppleIdentityTokenVerifier,
  installAppleRoutes,
  type AppleFetch,
  type AppleIdentityResolver,
  type AppleIdentityTokenVerifier,
  type AppleProviderConfig,
  type AppleSessionIssuer,
} from '../src/index.js'

const clientId = 'media.conflict.ezacto'
const subject = '000123.4d5e6f.0001'
const fixedNow = new Date('2026-09-15T12:00:00.000Z')
const fixedEpoch = Math.floor(fixedNow.valueOf() / 1_000)

interface SigningKey {
  kid: string
  privateKey: CryptoKey
  jwk: JWK
}

const signingKey = async (kid: string): Promise<SigningKey> => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: {
      ...(await exportJWK(pair.publicKey)),
      alg: 'RS256',
      kid,
      use: 'sig',
    },
  }
}

interface TokenChanges {
  issuer?: string
  audience?: string | string[]
  subject?: string
  email?: string
  includeEmail?: boolean
  emailVerified?: boolean | string
  isPrivateEmail?: boolean | string
  issuedAt?: number
  expiresAt?: number
  kid?: string
}

const identityToken = async (
  key: SigningKey,
  changes: TokenChanges = {},
): Promise<string> => {
  const payload: Record<string, unknown> = {}
  if (changes.includeEmail !== false) {
    payload.email = changes.email ?? 'ada@example.test'
  }
  payload.email_verified = changes.emailVerified ?? true
  if (changes.isPrivateEmail !== undefined) {
    payload.is_private_email = changes.isPrivateEmail
  }
  // Apple's identity-token header carries alg and kid but no typ; the verifier
  // must not require one.
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: changes.kid ?? key.kid })
    .setIssuer(changes.issuer ?? APPLE_ISSUER)
    .setAudience(changes.audience ?? clientId)
    .setSubject(changes.subject ?? subject)
    .setIssuedAt(changes.issuedAt ?? fixedEpoch - 10)
    .setExpirationTime(changes.expiresAt ?? fixedEpoch + 600)
    .sign(key.privateKey)
}

const jwksFetch = (keys: () => readonly JWK[]) => {
  const calls: string[] = []
  const fetch: AppleFetch = async (url) => {
    calls.push(url)
    expect(url).toBe(APPLE_JWKS_URI)
    return Response.json({ keys: keys() })
  }
  return { calls, fetch }
}

describe('Apple identity token verification', () => {
  it.each([
    { clientId: '' },
    { clientId: '   ' },
    { clientId: `${clientId} ${clientId}` },
    { clientId, timeoutMs: 0 },
    { clientId, timeoutMs: 60_001 },
    { clientId, cacheMaxAgeMs: 0 },
    { clientId, cooldownMs: -1 },
  ])('[security] rejects invalid provider configuration %#', (config) => {
    expect(() =>
      assertValidAppleProviderConfig(config as AppleProviderConfig),
    ).toThrow()
  })

  it('[unit] verifies RS256 against Apple JWKS, normalizes the email, and caches the key', async () => {
    const key = await signingKey('apple-key-1')
    const remote = jwksFetch(() => [key.jwk])
    const verifier = createAppleIdentityTokenVerifier({
      clientId,
      fetch: remote.fetch,
      now: () => fixedNow,
    })
    const token = await identityToken(key, { email: ' Ada@Example.Test ' })

    await expect(verifier.verify(token)).resolves.toEqual({
      subject,
      email: 'ada@example.test',
      emailVerified: true,
    })
    await expect(verifier.verify(token)).resolves.toMatchObject({ subject })
    expect(remote.calls).toHaveLength(1)
  })

  it('[unit] reads Apple string booleans for email_verified', async () => {
    const key = await signingKey('bool-key')
    const remote = jwksFetch(() => [key.jwk])
    const verifier = createAppleIdentityTokenVerifier({
      clientId,
      fetch: remote.fetch,
      now: () => fixedNow,
    })

    await expect(
      verifier.verify(await identityToken(key, { emailVerified: 'true' })),
    ).resolves.toMatchObject({ emailVerified: true })
    await expect(
      verifier.verify(await identityToken(key, { emailVerified: 'false' })),
    ).resolves.toMatchObject({ emailVerified: false })
    await expect(
      verifier.verify(await identityToken(key, { emailVerified: false })),
    ).resolves.toMatchObject({ emailVerified: false })
  })

  it('[unit] accepts a token whose aud is one of several configured audiences', async () => {
    const key = await signingKey('multi-aud')
    const remote = jwksFetch(() => [key.jwk])
    const verifier = createAppleIdentityTokenVerifier({
      clientId: `${clientId}, media.conflict.ezacto.web`,
      fetch: remote.fetch,
      now: () => fixedNow,
    })

    await expect(
      verifier.verify(
        await identityToken(key, { audience: 'media.conflict.ezacto.web' }),
      ),
    ).resolves.toMatchObject({ subject })
  })

  it.each([
    ['wrong issuer', { issuer: 'https://appleid.evil.example' }],
    ['wrong audience', { audience: 'com.someone.else' }],
    ['expired', { expiresAt: fixedEpoch - 1 }],
    ['future issued-at', { issuedAt: fixedEpoch + 5 }],
    ['issued-at at expiry', { issuedAt: fixedEpoch, expiresAt: fixedEpoch }],
    ['empty subject', { subject: '' }],
    ['missing email', { includeEmail: false }],
    ['malformed email', { email: 'not-an-email' }],
  ] satisfies Array<[string, TokenChanges]>)(
    '[security] rejects %s after valid signing',
    async (_name, changes) => {
      const key = await signingKey('claims-key')
      const remote = jwksFetch(() => [key.jwk])
      const verifier = createAppleIdentityTokenVerifier({
        clientId,
        fetch: remote.fetch,
        now: () => fixedNow,
      })

      await expect(
        verifier.verify(await identityToken(key, changes)),
      ).resolves.toBeNull()
    },
  )

  it('[security] rejects a forged signature even when its kid and claims look valid', async () => {
    const trusted = await signingKey('shared-kid')
    const attacker = await signingKey('shared-kid')
    const remote = jwksFetch(() => [trusted.jwk])
    const verifier = createAppleIdentityTokenVerifier({
      clientId,
      fetch: remote.fetch,
      now: () => fixedNow,
    })

    await expect(verifier.verify(await identityToken(attacker))).resolves.toBeNull()
  })

  it('[security] rejects a valid signature made with a non-RS256 algorithm', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true })
    const jwk = {
      ...(await exportJWK(pair.publicKey)),
      alg: 'ES256',
      kid: 'ec-key',
      use: 'sig',
    }
    const remote = jwksFetch(() => [jwk])
    const verifier = createAppleIdentityTokenVerifier({
      clientId,
      fetch: remote.fetch,
      now: () => fixedNow,
    })
    const token = await new SignJWT({ email: 'ada@example.test', email_verified: true })
      .setProtectedHeader({ alg: 'ES256', kid: 'ec-key' })
      .setIssuer(APPLE_ISSUER)
      .setAudience(clientId)
      .setSubject(subject)
      .setIssuedAt(fixedEpoch - 10)
      .setExpirationTime(fixedEpoch + 600)
      .sign(pair.privateKey)

    await expect(verifier.verify(token)).resolves.toBeNull()
  })

  it.each(['', 'not-a-jwt', 'only.two', 'a.b.c.d'])(
    '[security] rejects the malformed token %j before any network call',
    async (token) => {
      const remote = jwksFetch(() => [])
      const verifier = createAppleIdentityTokenVerifier({
        clientId,
        fetch: remote.fetch,
        now: () => fixedNow,
      })
      await expect(verifier.verify(token)).resolves.toBeNull()
      expect(remote.calls).toHaveLength(0)
    },
  )

  it.each([
    ['network error', async () => Promise.reject(new Error('offline'))],
    ['server error', async () => new Response('', { status: 503 })],
    ['malformed JSON', async () => new Response('{', { status: 200 })],
    ['malformed JWKS', async () => Response.json({ keys: 'not-an-array' })],
  ] satisfies Array<[string, AppleFetch]>)(
    '[security] fails closed for JWKS %s',
    async (_name, fetch) => {
      const key = await signingKey('unavailable-key')
      const verifier = createAppleIdentityTokenVerifier({
        clientId,
        fetch,
        now: () => fixedNow,
      })
      await expect(verifier.verify(await identityToken(key))).resolves.toBeNull()
    },
  )
})

const activeIdentity = {
  status: 'active' as const,
  matchedBy: 'created' as const,
  userId: 7,
  profile: 'administrator' as const,
  managerGrants: [] as string[],
}

const sessionCookie =
  '__Host-ezacto_session=test-session; Path=/; HttpOnly; Secure; SameSite=Lax'

const routeHarness = (
  options: {
    provider?: () => AppleProviderConfig | null
    verifier?: AppleIdentityTokenVerifier
    injectVerifier?: boolean
  } = {},
) => {
  const identities = {
    resolveProvider: vi.fn<AppleIdentityResolver['resolveProvider']>(
      async () => activeIdentity,
    ),
  }
  const sessions = {
    issue: vi.fn<AppleSessionIssuer['issue']>(async () => ({
      setCookie: sessionCookie,
    })),
  }
  const verifier: AppleIdentityTokenVerifier = options.verifier ?? {
    verify: vi.fn<AppleIdentityTokenVerifier['verify']>(async () => ({
      subject,
      email: 'ada@example.test',
      emailVerified: true,
    })),
  }
  const provider = options.provider ?? (() => ({ clientId }))
  const injectVerifier = options.injectVerifier ?? true
  const app = createApiApp({
    installApp(app) {
      installAppleRoutes(app, {
        identities,
        sessions,
        provider,
        ...(injectVerifier ? { verifier } : {}),
      })
    },
  })
  return { app, identities, sessions, verifier }
}

const post = (
  app: ReturnType<typeof routeHarness>['app'],
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) =>
  app.request('https://ezacto.io/auth/apple', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('Apple native sign-in route', () => {
  it('[api] verifies the token, links the user, and issues the ordinary session', async () => {
    const { app, identities, sessions, verifier } = routeHarness()
    const response = await post(app, {
      identityToken: 'signed.apple.token',
      fullName: { givenName: 'Ada', familyName: 'Lovelace' },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { ok: true } })
    expect(response.headers.get('set-cookie')).toContain(
      '__Host-ezacto_session=test-session',
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(
      (verifier.verify as ReturnType<typeof vi.fn>),
    ).toHaveBeenCalledWith('signed.apple.token')
    expect(identities.resolveProvider).toHaveBeenCalledWith({
      provider: 'apple',
      subject,
      email: 'ada@example.test',
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
    expect(sessions.issue).toHaveBeenCalledWith(7)
  })

  it('[api] omits the name on later sign-ins, when Apple sends none', async () => {
    const { app, identities } = routeHarness()
    const response = await post(app, { identityToken: 'signed.apple.token' })

    expect(response.status).toBe(200)
    expect(identities.resolveProvider).toHaveBeenCalledWith({
      provider: 'apple',
      subject,
      email: 'ada@example.test',
      emailVerified: true,
    })
  })

  it('[security] rejects an unverifiable token without touching the resolver or session', async () => {
    const { app, identities, sessions } = routeHarness({
      verifier: { verify: vi.fn(async () => null) },
    })
    const response = await post(app, { identityToken: 'forged.apple.token' })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'apple_authentication_failed' },
    })
    expect(identities.resolveProvider).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[api] answers 404 when Apple is not configured, before reading the body', async () => {
    const { app, verifier, sessions } = routeHarness({ provider: () => null })
    const response = await post(app, { identityToken: 'signed.apple.token' })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'apple_provider_not_found' },
    })
    expect((verifier.verify as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[api] answers 503 when the Apple configuration is malformed', async () => {
    const { app } = routeHarness({ provider: () => ({ clientId: '' }) })
    const response = await post(app, { identityToken: 'signed.apple.token' })

    expect(response.status).toBe(503)
    // 5xx bodies are masked to `internal_error`; only the status is public.
    expect(await response.json()).toMatchObject({
      error: { code: 'internal_error' },
    })
  })

  it('[security] requires an identity token', async () => {
    const { app, verifier } = routeHarness()
    const response = await post(app, { fullName: { givenName: 'Ada' } })

    expect(response.status).toBe(422)
    expect((verifier.verify as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('[security] rejects unknown fields rather than silently ignoring them', async () => {
    const { app } = routeHarness()
    const response = await post(app, {
      identityToken: 'signed.apple.token',
      authorizationCode: 'code',
      email: 'someone@example.test',
    })

    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { fields: Array<{ field: string }> }
    }
    expect(body.error.fields.map((field) => field.field).sort()).toEqual([
      'authorizationCode',
      'email',
    ])
  })

  it('[security] rejects a non-object fullName', async () => {
    const { app } = routeHarness()
    const response = await post(app, {
      identityToken: 'signed.apple.token',
      fullName: 'Ada Lovelace',
    })
    expect(response.status).toBe(422)
  })

  it('[security] refuses to provision from a domain the instance does not own', async () => {
    const { app, identities, sessions } = routeHarness()
    identities.resolveProvider.mockResolvedValue({
      status: 'provisioning_not_permitted',
    })
    const response = await post(app, { identityToken: 'signed.apple.token' })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'provisioning_not_permitted' },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] refuses a disabled user', async () => {
    const { app, identities, sessions } = routeHarness()
    identities.resolveProvider.mockResolvedValue({
      ...activeIdentity,
      status: 'disabled',
      matchedBy: 'subject',
    })
    const response = await post(app, { identityToken: 'signed.apple.token' })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'account_disabled' },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[api] maps a rejected profile to a 400 without a session', async () => {
    const { app, identities, sessions } = routeHarness()
    identities.resolveProvider.mockRejectedValue(new RangeError('bad name'))
    const response = await post(app, {
      identityToken: 'signed.apple.token',
      fullName: { givenName: 'x'.repeat(200) },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'apple_profile_incomplete' },
    })
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[api] builds a real verifier from configuration and caches the JWKS across sign-ins', async () => {
    const key = await signingKey('route-key')
    const remote = jwksFetch(() => [key.jwk])
    const { app, sessions } = routeHarness({
      provider: () => ({ clientId, fetch: remote.fetch, now: () => fixedNow }),
      injectVerifier: false,
    })
    const token = await identityToken(key)

    const first = await post(app, { identityToken: token })
    expect(first.status).toBe(200)
    expect(sessions.issue).toHaveBeenCalledWith(7)

    const second = await post(app, { identityToken: token })
    expect(second.status).toBe(200)
    expect(remote.calls).toHaveLength(1)
  })
})
