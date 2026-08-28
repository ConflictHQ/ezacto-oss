import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_COOKIE_NAME,
  createApiApp,
  createApiSessionService,
  installSessionRoutes,
  type SessionMetadata,
  type SessionStorePort,
} from '../src/index.js'

const current: SessionMetadata = {
  id: 1,
  userId: 7,
  createdAt: '2026-08-28T00:00:00.000Z',
  lastSeenAt: '2026-08-28T01:00:00.000Z',
  idleExpiresAt: '2026-08-29T01:00:00.000Z',
  absoluteExpiresAt: '2026-09-27T00:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
}

const other: SessionMetadata = {
  ...current,
  id: 2,
  createdAt: '2026-08-27T00:00:00.000Z',
  revokedAt: '2026-08-28T02:00:00.000Z',
  revocationReason: 'user_revoked',
}

const token = (selector: string, secret: string) =>
  `ezacto_session_${selector}_${secret}`

const issuedToken = token('abcdefghijklmnop', 'A'.repeat(43))
const rotatedToken = token('qrstuvwxyzABCDEF', 'B'.repeat(43))

const createHarness = () => {
  const store: SessionStorePort = {
    issue: vi.fn(async () => ({ token: issuedToken, session: current })),
    authenticate: vi.fn(async (presented) => {
      if (presented === 'old-cookie') {
        return {
          principal: {
            userId: 7,
            profile: 'accounting' as const,
            managerGrants: ['team:finance'],
          },
          session: { ...current, id: 3 },
          rotatedToken,
        }
      }
      if (presented !== issuedToken) return null
      return {
        principal: {
          userId: 7,
          profile: 'accounting' as const,
          managerGrants: ['team:finance'],
        },
        session: current,
      }
    }),
    list: vi.fn(async () => [current, other]),
    revoke: vi.fn(async (userId, id) =>
      userId === 7 && (id === 1 || id === 2)
        ? {
            ...(id === 1 ? current : other),
            revokedAt: '2026-08-28T02:00:00.000Z',
            revocationReason: 'user_revoked' as const,
          }
        : null,
    ),
  }
  const sessions = createApiSessionService(store)
  const app = createApiApp({
    authentication: { sessions },
    installApi: (api) => installSessionRoutes(api, sessions),
  })
  const cookie = `${SESSION_COOKIE_NAME}=${issuedToken}`
  return { app, sessions, store, cookie }
}

describe('browser sessions', () => {
  it('[security] issues a host-only secure HttpOnly SameSite cookie without leaking it', async () => {
    const { sessions } = createHarness()
    const issued = await sessions.issue(7)
    expect(issued.session).toEqual(current)
    expect(issued.setCookie).toContain(`${SESSION_COOKIE_NAME}=${issuedToken}`)
    expect(issued.setCookie).toContain('Path=/')
    expect(issued.setCookie).toContain('HttpOnly')
    expect(issued.setCookie).toContain('Secure')
    expect(issued.setCookie).toContain('SameSite=Lax')
    expect(issued.setCookie).toContain('Expires=Sun, 27 Sep 2026 00:00:00 GMT')
    expect(issued.setCookie).not.toContain('Domain=')
  })

  it('[api] propagates a privilege-rotation cookie and rejects duplicate cookie names', async () => {
    const { app } = createHarness()
    const rotated = await app.request('/api/v1/whoami', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=old-cookie` },
    })
    expect(rotated.status).toBe(200)
    expect(rotated.headers.get('set-cookie')).toContain(
      `${SESSION_COOKIE_NAME}=${rotatedToken}`,
    )
    expect(await rotated.json()).toMatchObject({
      data: {
        user_id: 7,
        profile: 'accounting',
        authentication: { kind: 'session' },
      },
    })

    const duplicate = await app.request('/api/v1/whoami', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${issuedToken}; ${SESSION_COOKIE_NAME}=${issuedToken}`,
      },
    })
    expect(duplicate.status).toBe(401)
  })

  it('[api] lists sessions and revokes another or the current session per user', async () => {
    const { app, store, cookie } = createHarness()
    const listed = await app.request('/api/v1/sessions', {
      headers: { cookie },
    })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      data: [
        expect.objectContaining({ id: 1, current: true, revoked_at: null }),
        expect.objectContaining({
          id: 2,
          current: false,
          revocation_reason: 'user_revoked',
        }),
      ],
      links: { self: '/api/v1/sessions' },
    })

    const revokedOther = await app.request('/api/v1/sessions/2', {
      method: 'DELETE',
      headers: { cookie, origin: 'http://localhost' },
    })
    expect(revokedOther.status).toBe(200)
    expect(revokedOther.headers.get('set-cookie')).toBeNull()

    const revokedCurrent = await app.request('/api/v1/sessions/1', {
      method: 'DELETE',
      headers: { cookie, origin: 'http://localhost' },
    })
    expect(revokedCurrent.status).toBe(200)
    expect(revokedCurrent.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(store.revoke).toHaveBeenCalledWith(7, 1)

    const missing = await app.request('/api/v1/sessions/999', {
      method: 'DELETE',
      headers: { cookie, origin: 'http://localhost' },
    })
    expect(missing.status).toBe(404)
  })
})
