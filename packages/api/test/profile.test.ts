import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_COOKIE_NAME,
  createApiApp,
  createApiSessionService,
  installProfileRoutes,
  type ProfileRepositoryPort,
  type SessionMetadata,
  type SessionStorePort,
} from '../src/index.js'

const session: SessionMetadata = {
  id: 1,
  userId: 7,
  createdAt: '2026-08-28T00:00:00.000Z',
  lastSeenAt: '2026-08-28T01:00:00.000Z',
  idleExpiresAt: '2026-08-29T01:00:00.000Z',
  absoluteExpiresAt: '2026-09-27T00:00:00.000Z',
  revokedAt: null,
  revocationReason: null,
}

const issuedToken = `ezacto_session_abcdefghijklmnop_${'A'.repeat(43)}`
const at = '2026-09-14T00:00:00.000Z'

const createHarness = () => {
  const store: SessionStorePort = {
    issue: vi.fn(async () => ({ token: issuedToken, session })),
    authenticate: vi.fn(async (presented) =>
      presented === issuedToken
        ? {
            principal: {
              userId: 7,
              profile: 'member' as const,
              managerGrants: [],
            },
            session,
          }
        : null,
    ),
    list: vi.fn(async () => [session]),
    revoke: vi.fn(async () => null),
  }
  const sessions = createApiSessionService(store)
  const updateTimezone = vi.fn<ProfileRepositoryPort['updateTimezone']>(
    async () => undefined,
  )
  const app = createApiApp({
    authentication: { sessions },
    installApi: (api) =>
      installProfileRoutes(api, {
        repository: { updateTimezone },
        clock: () => at,
      }),
  })
  const cookie = `${SESSION_COOKIE_NAME}=${issuedToken}`
  return { app, updateTimezone, cookie }
}

const patch = (
  app: ReturnType<typeof createHarness>['app'],
  body: unknown,
  cookie?: string,
) =>
  app.request('/api/v1/profile', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie, origin: 'http://localhost' } : {}),
    },
    body: JSON.stringify(body),
  })

describe('self-service profile timezone', () => {
  it('[api] sets the current user timezone and echoes it', async () => {
    const { app, updateTimezone, cookie } = createHarness()
    const res = await patch(app, { timezone: 'America/New_York' }, cookie)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { user_id: 7, timezone: 'America/New_York' },
      links: { self: '/api/v1/profile' },
    })
    expect(updateTimezone).toHaveBeenCalledWith(7, 'America/New_York', at)
  })

  it('[api] rejects a non-IANA timezone without writing', async () => {
    const { app, updateTimezone, cookie } = createHarness()
    const res = await patch(app, { timezone: 'Mars/Olympus' }, cookie)
    expect(res.status).toBe(422)
    expect(updateTimezone).not.toHaveBeenCalled()
  })

  it('[api] rejects an empty body and an unknown field', async () => {
    const { app, updateTimezone, cookie } = createHarness()
    expect((await patch(app, {}, cookie)).status).toBe(422)
    expect(
      (await patch(app, { timezone: 'UTC', color: 'blue' }, cookie)).status,
    ).toBe(422)
    expect(updateTimezone).not.toHaveBeenCalled()
  })

  it('[security] requires a session', async () => {
    const { app, updateTimezone } = createHarness()
    const res = await patch(app, { timezone: 'UTC' })
    expect(res.status).toBeGreaterThanOrEqual(401)
    expect(res.status).toBeLessThan(404)
    expect(updateTimezone).not.toHaveBeenCalled()
  })
})
