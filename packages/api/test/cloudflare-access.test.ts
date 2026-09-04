import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUDFLARE_ACCESS_JWT_HEADER,
  assertValidCloudflareAccessConfig,
  createApiApp,
  createCloudflareAccessSessionResolver,
  createCloudflareAccessVerifier,
  type CloudflareAccessFetch,
  type CloudflareAccessIdentityResolver,
  type CloudflareAccessSessionService,
} from '../src/index.js'

const teamDomain = 'https://ezacto-test.cloudflareaccess.com'
const audience = 'a'.repeat(64)
const fixedNow = new Date('2026-08-31T12:00:00.000Z')
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
  email?: string | null
  subject?: string
  type?: string
  issuedAt?: number
  notBefore?: number
  expiresAt?: number
  typ?: string
}

const accessToken = async (
  key: SigningKey,
  changes: TokenChanges = {},
): Promise<string> => {
  const email =
    changes.email === undefined ? 'owner@example.test' : changes.email
  return new SignJWT({
    ...(email === null ? {} : { email }),
    type: changes.type ?? 'app',
  })
    .setProtectedHeader({
      alg: 'RS256',
      kid: key.kid,
      typ: changes.typ ?? 'JWT',
    })
    .setIssuer(changes.issuer ?? teamDomain)
    .setAudience(changes.audience ?? [audience])
    .setSubject(changes.subject ?? 'access-user-1')
    .setIssuedAt(changes.issuedAt ?? fixedEpoch - 10)
    .setNotBefore(changes.notBefore ?? fixedEpoch - 10)
    .setExpirationTime(changes.expiresAt ?? fixedEpoch + 600)
    .sign(key.privateKey)
}

const jwksFetch = (keys: () => readonly JWK[]) => {
  const calls: string[] = []
  const fetch: CloudflareAccessFetch = async (url, init) => {
    calls.push(url)
    expect(url).toBe(`${teamDomain}/cdn-cgi/access/certs`)
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    return Response.json({ keys: keys() })
  }
  return { calls, fetch }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Cloudflare Access assertion verification', () => {
  it.each([
    { teamDomain: 'http://team.cloudflareaccess.com', audience },
    { teamDomain: 'https://team.cloudflareaccess.com/path', audience },
    { teamDomain: 'https://team.cloudflareaccess.com/', audience },
    { teamDomain: 'https://attacker.example', audience },
    { teamDomain, audience: '' },
    { teamDomain, audience: ` ${audience}` },
    { teamDomain, audience, timeoutMs: 0 },
    { teamDomain, audience, cooldownMs: 601_000 },
  ])('[security] rejects invalid fixed provider configuration %#', (config) => {
    expect(() => assertValidCloudflareAccessConfig(config)).toThrow()
  })

  it('[unit] verifies RS256 against the configured remote JWKS and caches successful keys', async () => {
    const key = await signingKey('key-1')
    const remote = jwksFetch(() => [key.jwk])
    const verifier = createCloudflareAccessVerifier({
      teamDomain,
      audience,
      fetch: remote.fetch,
      now: () => fixedNow,
    })
    const token = await accessToken(key, { email: ' Owner@Example.Test ' })

    await expect(verifier.verify(token)).resolves.toEqual({
      email: 'owner@example.test',
    })
    await expect(verifier.verify(token)).resolves.toEqual({
      email: 'owner@example.test',
    })
    expect(remote.calls).toHaveLength(1)
  })

  it('[unit] throttles unknown-key fetches, then accepts a rotated signing key after cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(fixedNow)
    const first = await signingKey('key-1')
    const second = await signingKey('key-2')
    let keys: readonly JWK[] = [first.jwk]
    const remote = jwksFetch(() => keys)
    const verifier = createCloudflareAccessVerifier({
      teamDomain,
      audience,
      fetch: remote.fetch,
    })
    const firstToken = await accessToken(first)
    const secondToken = await accessToken(second)

    await expect(verifier.verify(firstToken)).resolves.toEqual({
      email: 'owner@example.test',
    })
    keys = [second.jwk]
    await expect(verifier.verify(secondToken)).resolves.toBeNull()
    expect(remote.calls).toHaveLength(1)

    vi.setSystemTime(fixedNow.valueOf() + 30_001)
    await expect(verifier.verify(secondToken)).resolves.toEqual({
      email: 'owner@example.test',
    })
    expect(remote.calls).toHaveLength(2)
  })

  it.each([
    ['wrong issuer', { issuer: 'https://other.cloudflareaccess.com' }],
    ['wrong audience', { audience: ['b'.repeat(64)] }],
    ['expired', { expiresAt: fixedEpoch }],
    ['not active', { notBefore: fixedEpoch + 1 }],
    ['future issued-at', { issuedAt: fixedEpoch + 1 }],
    ['non-app token', { type: 'service' }],
    ['empty subject', { subject: '' }],
    ['missing email', { email: null }],
    ['malformed email', { email: 'not-an-email' }],
    ['wrong token type', { typ: 'not-jwt' }],
  ] satisfies Array<[string, TokenChanges]>)(
    '[security] rejects %s claims after valid signing',
    async (_name, changes) => {
      const key = await signingKey('claims-key')
      const remote = jwksFetch(() => [key.jwk])
      const verifier = createCloudflareAccessVerifier({
        teamDomain,
        audience,
        fetch: remote.fetch,
        now: () => fixedNow,
      })

      await expect(
        verifier.verify(await accessToken(key, changes)),
      ).resolves.toBeNull()
    },
  )

  it('[security] rejects a forged signature even when its kid and claims look valid', async () => {
    const trusted = await signingKey('shared-kid')
    const attacker = await signingKey('shared-kid')
    const remote = jwksFetch(() => [trusted.jwk])
    const verifier = createCloudflareAccessVerifier({
      teamDomain,
      audience,
      fetch: remote.fetch,
      now: () => fixedNow,
    })

    await expect(
      verifier.verify(await accessToken(attacker)),
    ).resolves.toBeNull()
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
    const verifier = createCloudflareAccessVerifier({
      teamDomain,
      audience,
      fetch: remote.fetch,
      now: () => fixedNow,
    })
    const token = await new SignJWT({
      email: 'owner@example.test',
      type: 'app',
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'ec-key', typ: 'JWT' })
      .setIssuer(teamDomain)
      .setAudience([audience])
      .setSubject('access-user-1')
      .setIssuedAt(fixedEpoch - 10)
      .setNotBefore(fixedEpoch - 10)
      .setExpirationTime(fixedEpoch + 600)
      .sign(pair.privateKey)

    await expect(verifier.verify(token)).resolves.toBeNull()
  })

  it.each([
    ['network error', async () => Promise.reject(new Error('offline'))],
    ['redirect', async () => new Response('', { status: 302 })],
    ['server error', async () => new Response('', { status: 503 })],
    ['malformed JSON', async () => new Response('{', { status: 200 })],
    ['malformed JWKS', async () => Response.json({ keys: 'not-an-array' })],
  ] satisfies Array<[string, CloudflareAccessFetch]>)(
    '[security] fails closed for JWKS %s',
    async (_name, fetch) => {
      const key = await signingKey('unavailable-key')
      const verifier = createCloudflareAccessVerifier({
        teamDomain,
        audience,
        fetch,
        now: () => fixedNow,
      })
      await expect(verifier.verify(await accessToken(key))).resolves.toBeNull()
    },
  )
})

const activeIdentity = {
  status: 'active' as const,
  userId: 42,
  profile: 'administrator' as const,
  managerGrants: ['team:all'],
}

const sessionHarness = () => {
  const sessions: CloudflareAccessSessionService = {
    resolve: vi.fn(async () => null),
    issue: vi.fn(async (userId) => ({
      session: { id: 9, userId },
      setCookie:
        '__Host-ezacto_session=test; Path=/; HttpOnly; Secure; SameSite=Lax',
    })),
  }
  const identities = {
    resolveEmail: vi.fn<CloudflareAccessIdentityResolver['resolveEmail']>(
      async () => activeIdentity,
    ),
  }
  return { identities, sessions }
}

describe('Cloudflare Access application-session composition', () => {
  it('[api] resolves a valid assertion only through a verified app email and issues the normal session', async () => {
    const key = await signingKey('api-key')
    const remote = jwksFetch(() => [key.jwk])
    const verifier = createCloudflareAccessVerifier({
      teamDomain,
      audience,
      fetch: remote.fetch,
      now: () => fixedNow,
    })
    const { identities, sessions } = sessionHarness()
    const resolver = createCloudflareAccessSessionResolver({
      identities,
      sessions,
      verifier,
    })
    const app = createApiApp({ authentication: { sessions: resolver } })

    const response = await app.request('/api/v1/whoami', {
      headers: { [CLOUDFLARE_ACCESS_JWT_HEADER]: await accessToken(key) },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain(
      '__Host-ezacto_session=',
    )
    expect(await response.json()).toEqual({
      data: {
        user_id: 42,
        profile: 'administrator',
        manager_grants: ['team:all'],
        authentication: { kind: 'session' },
      },
      links: { self: '/api/v1/whoami' },
    })
    expect(identities.resolveEmail).toHaveBeenCalledWith('owner@example.test')
    expect(sessions.issue).toHaveBeenCalledWith(42)
  })

  it('[api] rejects forged identity headers without a valid JWT and never resolves their email', async () => {
    const { identities, sessions } = sessionHarness()
    const verifier = { verify: vi.fn(async () => null) }
    const app = createApiApp({
      authentication: {
        sessions: createCloudflareAccessSessionResolver({
          identities,
          sessions,
          verifier,
        }),
      },
    })

    for (const headers of [
      { 'cf-access-authenticated-user-email': 'attacker@example.test' },
      {
        'cf-access-authenticated-user-email': 'attacker@example.test',
        [CLOUDFLARE_ACCESS_JWT_HEADER]: 'forged.header.signature',
      },
    ]) {
      const response = await app.request('/api/v1/whoami', { headers })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({
        error: { code: 'authentication_required' },
      })
    }
    expect(identities.resolveEmail).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
    expect(verifier.verify).toHaveBeenCalledTimes(1)
  })

  it('[security] denies an unverified app identity without creating or linking one', async () => {
    const { identities, sessions } = sessionHarness()
    identities.resolveEmail.mockResolvedValue({
      status: 'verification_required',
    })
    const app = createApiApp({
      authentication: {
        sessions: createCloudflareAccessSessionResolver({
          identities,
          sessions,
          verifier: {
            verify: async () => ({ email: 'unverified@example.test' }),
          },
        }),
      },
    })

    const response = await app.request('/api/v1/whoami', {
      headers: { [CLOUDFLARE_ACCESS_JWT_HEADER]: 'signed-assertion' },
    })
    expect(response.status).toBe(401)
    expect(identities.resolveEmail).toHaveBeenCalledWith(
      'unverified@example.test',
    )
    expect(sessions.issue).not.toHaveBeenCalled()
  })

  it('[security] keeps an existing app session authoritative without consulting Access', async () => {
    const { identities, sessions } = sessionHarness()
    sessions.resolve = vi.fn(async () => ({
      type: 'user' as const,
      userId: 7,
      profile: 'accounting' as const,
      managerGrants: [],
      authentication: {
        kind: 'session' as const,
        sessionId: 'existing-session',
      },
    }))
    const verifier = {
      verify: vi.fn(async () => ({ email: 'owner@example.test' })),
    }
    const resolver = createCloudflareAccessSessionResolver({
      identities,
      sessions,
      verifier,
    })

    await expect(
      resolver.resolve(
        new Request('https://ezacto.test/api/v1/whoami', {
          headers: { [CLOUDFLARE_ACCESS_JWT_HEADER]: 'forged' },
        }),
      ),
    ).resolves.toMatchObject({ userId: 7 })
    expect(verifier.verify).not.toHaveBeenCalled()
    expect(identities.resolveEmail).not.toHaveBeenCalled()
    expect(sessions.issue).not.toHaveBeenCalled()
  })
})
