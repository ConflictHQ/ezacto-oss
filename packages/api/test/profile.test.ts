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

const createHarness = (stored: string | null = 'UTC') => {
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
  const readTimezone = vi.fn<ProfileRepositoryPort['readTimezone']>(
    async () => stored,
  )
  const app = createApiApp({
    authentication: { sessions },
    installApi: (api) =>
      installProfileRoutes(api, {
        repository: { readTimezone, updateTimezone },
        clock: () => at,
      }),
  })
  const cookie = `${SESSION_COOKIE_NAME}=${issuedToken}`
  return { app, readTimezone, updateTimezone, cookie }
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

describe('reading your own profile', () => {
  it('[unit] answers with the stored timezone', async () => {
    const { app, cookie } = createHarness('America/Costa_Rica')
    const response = await app.request('/api/v1/profile', { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { user_id: 7, timezone: 'America/Costa_Rica' },
    })
  })

  it("[unit] answers 'UTC' for someone who has never set one", async () => {
    // Which is the column default, and means "unset": the organization zone is
    // what actually decides their day until they choose.
    const { app, cookie } = createHarness(null)
    const response = await app.request('/api/v1/profile', { headers: { cookie } })
    expect(await response.json()).toMatchObject({ data: { timezone: 'UTC' } })
  })

  it('[security] refuses an unauthenticated read', async () => {
    const { app, readTimezone } = createHarness()
    const response = await app.request('/api/v1/profile')
    expect(response.status).toBe(401)
    expect(readTimezone).not.toHaveBeenCalled()
  })
})
