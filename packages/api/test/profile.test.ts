import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_COOKIE_NAME,
  createApiApp,
  createApiSessionService,
  installProfileRoutes,
  type AccountDeletionMailer,
  type AccountDeletionRequest,
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

const createHarness = (
  stored: string | null = 'UTC',
  deletion: {
    requestDeletion?: ProfileRepositoryPort['requestDeletion']
    deletionMailer?: AccountDeletionMailer
    readIdentity?: ProfileRepositoryPort['readIdentity']
  } = {},
) => {
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
        repository: {
          readTimezone,
          updateTimezone,
          ...(deletion.readIdentity === undefined ? {} : { readIdentity: deletion.readIdentity }),
          ...(deletion.requestDeletion === undefined
            ? {}
            : { requestDeletion: deletion.requestDeletion }),
        },
        clock: () => at,
        ...(deletion.deletionMailer === undefined
          ? {}
          : { deletionMailer: deletion.deletionMailer }),
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

describe('being copied on the invoice emails you send', () => {
  const copyHarness = () => {
    const store: SessionStorePort = {
      issue: vi.fn(async () => ({ token: issuedToken, session })),
      authenticate: vi.fn(async (presented) =>
        presented === issuedToken
          ? { principal: { userId: 7, profile: 'member' as const, managerGrants: [] }, session }
          : null,
      ),
      list: vi.fn(async () => [session]),
      revoke: vi.fn(async () => null),
    }
    let copy = true
    const updateInvoiceCopy = vi.fn(async (_userId: number, value: boolean) => {
      copy = value
    })
    const updateTimezone = vi.fn(async () => undefined)
    const app = createApiApp({
      authentication: { sessions: createApiSessionService(store) },
      installApi: (api) =>
        installProfileRoutes(api, {
          repository: {
            readTimezone: async () => 'America/Costa_Rica',
            updateTimezone,
            readInvoiceCopy: async () => copy,
            updateInvoiceCopy,
          },
          clock: () => at,
        }),
    })
    return { app, updateInvoiceCopy, updateTimezone, cookie: `${SESSION_COOKIE_NAME}=${issuedToken}` }
  }

  it('[api] reads it on, and turns it off without touching the timezone', async () => {
    const { app, updateInvoiceCopy, updateTimezone, cookie } = copyHarness()
    const read = await app.request('/api/v1/profile', { headers: { cookie } })
    expect(((await read.json()) as { data: unknown }).data).toEqual({
      user_id: 7,
      timezone: 'America/Costa_Rica',
      invoice_copy_to_self: true,
    })
    const res = await patch(app, { invoice_copy_to_self: false }, cookie)
    expect(res.status).toBe(200)
    expect(updateInvoiceCopy).toHaveBeenCalledWith(7, false, at)
    expect(updateTimezone).not.toHaveBeenCalled()
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      user_id: 7,
      timezone: 'America/Costa_Rica',
      invoice_copy_to_self: false,
    })
  })

  it('[api] refuses a value that is not true or false', async () => {
    const { app, updateInvoiceCopy, cookie } = copyHarness()
    expect((await patch(app, { invoice_copy_to_self: 'yes' }, cookie)).status).toBe(422)
    expect(updateInvoiceCopy).not.toHaveBeenCalled()
  })
})

/**
 * Asking for one's own account to be deleted, from the mobile app. The app is
 * reviewed against App Store Guideline 5.1.1(v) and Google Play's account
 * deletion policy: a person who can create an account in it must be able to
 * start its deletion from it.
 */
describe('asking for your own account to be deleted', () => {
  const recorded = (overrides: Partial<AccountDeletionRequest> = {}): AccountDeletionRequest => ({
    requestedAt: '2026-09-01T09:30:00.000Z',
    recorded: true,
    person: { name: 'Pat Example', email: 'pat@example.test' },
    administrators: ['admin@example.test'],
    ...overrides,
  })
  const ask = (app: ReturnType<typeof createHarness>['app'], cookie?: string) =>
    app.request('/api/v1/profile/deletion-request', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie, origin: 'http://localhost' } : {}),
      },
      body: '{}',
    })

  it('[api] records the request for the signed-in person and tells the administrators', async () => {
    const requestDeletion = vi.fn<NonNullable<ProfileRepositoryPort['requestDeletion']>>(
      async () => recorded(),
    )
    const notify = vi.fn<AccountDeletionMailer['notify']>(async () => undefined)
    const { app, cookie } = createHarness('UTC', { requestDeletion, deletionMailer: { notify } })

    const response = await ask(app, cookie)
    expect(response.status).toBe(202)
    expect(response.headers.get('cache-control')).toBe('no-store')
    // The first request's time, which a later ask keeps.
    expect(await response.json()).toEqual({
      data: { user_id: 7, requested_at: '2026-09-01T09:30:00.000Z' },
      links: { self: '/api/v1/profile/deletion-request' },
    })
    expect(requestDeletion).toHaveBeenCalledWith({
      userId: 7,
      occurredAt: at,
      requestId: expect.any(String),
    })
    expect(notify).toHaveBeenCalledWith(recorded())
  })

  it('[api] tells nobody twice for a retry of a request already recorded', async () => {
    const notify = vi.fn<AccountDeletionMailer['notify']>(async () => undefined)
    const { app, cookie } = createHarness('UTC', {
      requestDeletion: async () => recorded({ recorded: false }),
      deletionMailer: { notify },
    })
    expect((await ask(app, cookie)).status).toBe(202)
    expect(notify).not.toHaveBeenCalled()
  })

  it('[api] still records the request where there is no administrator address or no mail', async () => {
    const notify = vi.fn<AccountDeletionMailer['notify']>(async () => undefined)
    const unaddressed = createHarness('UTC', {
      requestDeletion: async () => recorded({ administrators: [] }),
      deletionMailer: { notify },
    })
    expect((await ask(unaddressed.app, unaddressed.cookie)).status).toBe(202)
    expect(notify).not.toHaveBeenCalled()

    const unmailed = createHarness('UTC', { requestDeletion: async () => recorded() })
    expect((await ask(unmailed.app, unmailed.cookie)).status).toBe(202)
  })

  it('[api] says so where the deployment cannot record one, rather than pretending', async () => {
    const { app, cookie } = createHarness()
    const response = await ask(app, cookie)
    // A 503, which every client reads as "not here, not now". The body of a
    // 5xx names nothing, by design of the error handler.
    expect(response.status).toBe(503)
  })

  it('[security] requires a signed-in person', async () => {
    const requestDeletion = vi.fn<NonNullable<ProfileRepositoryPort['requestDeletion']>>(
      async () => recorded(),
    )
    const { app } = createHarness('UTC', { requestDeletion })
    const response = await ask(app)
    expect(response.status).toBeGreaterThanOrEqual(401)
    expect(response.status).toBeLessThan(404)
    expect(requestDeletion).not.toHaveBeenCalled()
  })
})

describe('the signed-in person on their profile', () => {
  const get = (app: ReturnType<typeof createHarness>['app'], cookie: string) =>
    app.request('/api/v1/profile', { headers: { cookie } })

  it('[api] carries the name and primary address, so the shell can show who is signed in', async () => {
    const readIdentity = vi.fn<NonNullable<ProfileRepositoryPort['readIdentity']>>(async () => ({
      firstName: 'Ada',
      lastName: 'Quill',
      email: 'ada@example.test',
    }))
    const { app, cookie } = createHarness('UTC', { readIdentity })
    const res = await get(app, cookie)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({
      user_id: 7,
      first_name: 'Ada',
      last_name: 'Quill',
      email: 'ada@example.test',
      timezone: 'UTC',
    })
    // Only ever the caller's own record.
    expect(readIdentity).toHaveBeenCalledWith(7)
  })

  it('[api] leaves the fields out where the deployment has no reader', async () => {
    const { app, cookie } = createHarness('UTC')
    const data = (await (await get(app, cookie)).json()).data
    expect(data).toEqual({ user_id: 7, timezone: 'UTC' })
  })
})
