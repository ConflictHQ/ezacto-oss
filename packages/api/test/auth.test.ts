import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  requireApiScope,
  type ApiErrorBody,
  type ApiTokenMetadata,
  type ApiTokenService,
  type IssuedApiToken,
} from '../src/index.js'

const bearer = 'ezacto_abcdefghijklmnop_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi1234567'
const createdAt = '2026-08-28T12:00:00.000Z'

const metadata = (changes: Partial<ApiTokenMetadata> = {}): ApiTokenMetadata => ({
  id: 1,
  name: 'CLI',
  scopes: ['reports:read'],
  tokenHint: 'ezacto_abcdefghijklmnop_…',
  createdAt,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...changes,
})

const tokenService = (
  scopes: string[] = ['reports:read'],
  profile: 'member' | 'accounting' = 'accounting',
): ApiTokenService => {
  let current = metadata({ scopes })
  return {
    authenticate: async (token) =>
      token === bearer && current.revokedAt === null
        ? { tokenId: 1, userId: 42, profile, scopes: [...current.scopes] }
        : null,
    issue: async (input): Promise<IssuedApiToken> => {
      current = metadata({ name: input.name, scopes: [...input.scopes], expiresAt: input.expiresAt ?? null })
      return { ...current, token: bearer }
    },
    list: async (userId) => (userId === 42 ? [{ ...current, scopes: [...current.scopes] }] : []),
    revoke: async (userId, tokenId) => {
      if (userId !== 42 || tokenId !== current.id) return null
      current = metadata({ ...current, revokedAt: '2026-08-28T12:01:00.000Z' })
      return current
    },
  }
}

const sessionResolver = {
  resolve: async (request: Request) => {
    const cookie = request.headers.get('cookie')
    if (cookie === 'session=user') {
      return {
        type: 'user' as const,
        userId: 42,
        profile: 'administrator' as const,
        authentication: { kind: 'session' as const, sessionId: 'user-session' },
      }
    }
    if (cookie === 'session=contact') {
      return {
        type: 'contact' as const,
        contactId: 9,
        clientId: 3,
        authentication: { kind: 'session' as const, sessionId: 'contact-session' },
      }
    }
    if (cookie === 'session=member') {
      return {
        type: 'user' as const,
        userId: 43,
        profile: 'member' as const,
        authentication: { kind: 'session' as const, sessionId: 'member-session' },
      }
    }
    return null
  },
}

const createAuthApp = (tokens = tokenService()) =>
  createApiApp({
    authentication: { tokens, sessions: sessionResolver },
    installApi(api) {
      api.get('/principal', (context) => context.json({ data: context.get('principal') }))
      api.get('/reports', (context) => {
        requireApiScope(context, 'reports:read')
        return context.json({ data: { visible: true } })
      })
      api.get('/time', (context) => {
        requireApiScope(context, 'time_entries:write')
        return context.json({ data: { visible: true } })
      })
      api.get('/project-admin', (context) => {
        requireApiScope(context, 'invoices:write')
        return context.json({ data: { visible: true } })
      })
    },
  })

describe('API authentication middleware', () => {
  it('[api] fails closed with the uniform envelope and a bearer challenge', async () => {
    const response = await createAuthApp().request('/api/v1')
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="ezacto"')
    expect((await response.json()) as ApiErrorBody).toEqual({
      error: {
        code: 'authentication_required',
        message: 'A valid API token or user session is required.',
        fields: [],
      },
      request_id: response.headers.get('x-request-id'),
    })
  })

  it('[security] never falls back from a malformed bearer header to a valid session', async () => {
    const resolve = vi.spyOn(sessionResolver, 'resolve')
    const response = await createAuthApp().request('/api/v1/principal', {
      headers: { authorization: 'Basic attacker', cookie: 'session=user' },
    })
    expect(response.status).toBe(401)
    expect(resolve).not.toHaveBeenCalled()
    resolve.mockRestore()
  })

  it('[security] rejects token scopes that exceed the backend-returned current profile', async () => {
    const app = createAuthApp(tokenService(['invoices:write'], 'member'))
    const response = await app.request('/api/v1/principal', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'authentication_required' } })
  })

  it('[api] resolves bearer and session authentication to the same user-principal shape', async () => {
    const app = createAuthApp()
    const viaToken = await app.request('/api/v1/principal', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(await viaToken.json()).toEqual({
      data: {
        type: 'user',
        userId: 42,
        profile: 'accounting',
        managerGrants: [],
        authentication: { kind: 'token', tokenId: 1, scopes: ['reports:read'] },
      },
    })

    const viaSession = await app.request('/api/v1/principal', {
      headers: { cookie: 'session=user' },
    })
    expect(await viaSession.json()).toEqual({
      data: {
        type: 'user',
        userId: 42,
        profile: 'administrator',
        managerGrants: [],
        authentication: { kind: 'session', sessionId: 'user-session' },
      },
    })
  })

  it.each(['bearer', 'BEARER', 'BeArEr'])(
    '[api] accepts the case-insensitive %s authentication scheme',
    async (scheme) => {
      const response = await createAuthApp().request('/api/v1/reports', {
        headers: { authorization: `${scheme} ${bearer}` },
      })
      expect(response.status).toBe(200)
    },
  )

  it('[api] enforces exact token scopes while user sessions retain their profile authority', async () => {
    const app = createAuthApp()
    const allowed = await app.request('/api/v1/reports', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(allowed.status).toBe(200)

    const denied = await app.request('/api/v1/time', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'insufficient_scope' } })

    const session = await app.request('/api/v1/time', {
      headers: { cookie: 'session=user' },
    })
    expect(session.status).toBe(200)

    const profileDenied = await app.request('/api/v1/project-admin', {
      headers: { cookie: 'session=member' },
    })
    expect(profileDenied.status).toBe(403)
    expect(await profileDenied.json()).toMatchObject({ error: { code: 'profile_forbidden' } })

    const administrator = await app.request('/api/v1/project-admin', {
      headers: { cookie: 'session=user' },
    })
    expect(administrator.status).toBe(200)
  })

  it('[api] returns 403 for a contact on every /api/v1 path, including unknown resources', async () => {
    const app = createAuthApp()
    for (const path of ['/api/v1', '/api/v1/principal', '/api/v1/not-a-route']) {
      const response = await app.request(path, { headers: { cookie: 'session=contact' } })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({
        error: { code: 'contact_api_forbidden', fields: [] },
      })
    }
  })
})

describe('API token lifecycle routes', () => {
  it('[api] creates once-visible bearer material and lists scopes without it', async () => {
    const app = createAuthApp()
    const created = await app.request('/api/v1/api-tokens', {
      method: 'POST',
      headers: { cookie: 'session=user', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Reports', scopes: ['reports:read'] }),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    expect(await created.json()).toMatchObject({
      data: { name: 'Reports', scopes: ['reports:read'], token: bearer },
    })

    const listed = await app.request('/api/v1/api-tokens', {
      headers: { cookie: 'session=user' },
    })
    const wire = await listed.text()
    expect(listed.status).toBe(200)
    expect(wire).not.toContain(bearer)
    expect(JSON.parse(wire)).toMatchObject({
      data: [{ name: 'Reports', scopes: ['reports:read'] }],
      links: { self: '/api/v1/api-tokens' },
    })
  })

  it('[api] measures token names in Unicode code points like SQLite', async () => {
    const name = '🙂'.repeat(60)
    const response = await createAuthApp().request('/api/v1/api-tokens', {
      method: 'POST',
      headers: { cookie: 'session=user', 'content-type': 'application/json' },
      body: JSON.stringify({ name, scopes: ['reports:read'] }),
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ data: { name } })
  })

  it('[api] makes a revoked token return 401 on the next request', async () => {
    const app = createAuthApp()
    const before = await app.request('/api/v1/reports', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(before.status).toBe(200)

    const revoked = await app.request('/api/v1/api-tokens/1', {
      method: 'DELETE',
      headers: { cookie: 'session=user' },
    })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({
      data: { id: 1, revoked_at: '2026-08-28T12:01:00.000Z' },
    })

    const after = await app.request('/api/v1/reports', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: { code: 'authentication_required' } })
  })

  it('[security] requires a user session to manage tokens', async () => {
    const response = await createAuthApp().request('/api/v1/api-tokens', {
      headers: { authorization: `Bearer ${bearer}` },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'session_required' } })
  })

  it.each([null, [], 'token'])('[api] rejects a non-object issue body: %j', async (body) => {
    const response = await createAuthApp().request('/api/v1/api-tokens', {
      method: 'POST',
      headers: { cookie: 'session=user', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { code: 'validation_failed', fields: [{ field: 'body', code: 'invalid' }] },
    })
  })

  it('[api] rejects unknown token-issue fields', async () => {
    const response = await createAuthApp().request('/api/v1/api-tokens', {
      method: 'POST',
      headers: { cookie: 'session=user', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'CLI', scopes: ['reports:read'], plaintext: bearer }),
    })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      error: { fields: [{ field: 'plaintext', code: 'unknown' }] },
    })
  })

  it('[api] rejects duplicate, unsupported, and malformed-expiry issue fields', async () => {
    const cases = [
      { scopes: ['reports:read', 'reports:read'], expires_at: null },
      { scopes: ['root:everything'], expires_at: null },
      { scopes: ['reports:read'], expires_at: '2026-02-30T00:00:00Z' },
    ]
    for (const input of cases) {
      const response = await createAuthApp().request('/api/v1/api-tokens', {
        method: 'POST',
        headers: { cookie: 'session=user', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'CLI', ...input }),
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ error: { code: 'validation_failed' } })
    }
  })

  it('[security] prevents a session from minting scopes above its current profile', async () => {
    const response = await createAuthApp().request('/api/v1/api-tokens', {
      method: 'POST',
      headers: { cookie: 'session=member', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Escalation', scopes: ['invoices:write'] }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'profile_forbidden' } })
  })
})
