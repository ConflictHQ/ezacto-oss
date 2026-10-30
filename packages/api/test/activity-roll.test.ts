import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installOutboxRoutes,
  type ActivityRollOutcome,
  type ActivityRollPort,
  type OutboxMonitor,
  type UserProfile,
} from '../src/index.js'

const monitor: OutboxMonitor = {
  listActivity: vi.fn(),
  activitySnapshot: vi.fn(),
  deliveriesSnapshot: vi.fn(),
  pageDeliveries: vi.fn(),
  countDeliveries: vi.fn(),
  retryFailed: vi.fn(),
}

const port = (outcome: ActivityRollOutcome = 'rolled') => {
  const roll = vi.fn(async (): Promise<ActivityRollOutcome> => outcome)
  const rollable = vi.fn(async () => [{ year: 2026, entries: 12 }])
  return { roll, rollable } satisfies ActivityRollPort
}

const options = (rolling: ActivityRollPort | undefined, enabled = true) => ({
  cursorSigningKey: new Uint8Array(32).fill(5),
  timezone: async () => 'UTC',
  isActivityLogModuleEnabled: async () => enabled,
  ...(rolling === undefined ? {} : { roll: rolling }),
})

const sessionApp = (
  rolling: ActivityRollPort | undefined,
  profile: UserProfile = 'administrator',
  enabled = true,
) =>
  createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 9,
          profile,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-1' },
        }),
      },
    },
    installApi(api) {
      installOutboxRoutes(api, monitor, options(rolling, enabled))
    },
  })

const post = (app: ReturnType<typeof sessionApp>, body: unknown) =>
  app.request('/api/v1/activity-log/rolls', {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('activity log roll API', () => {
  it('[api] an administrator session rolls a year, as themselves', async () => {
    const rolling = port()
    const response = await post(sessionApp(rolling), { year: 2026 })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ data: { year: 2026, rolled: true } })
    expect(rolling.roll).toHaveBeenCalledWith({
      year: 2026,
      actorUserId: 9,
      requestId: expect.any(String),
    })
  })

  it('[api] offers the finished years that can be rolled', async () => {
    const rolling = port()
    const response = await sessionApp(rolling).request('/api/v1/activity-log/rolls')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { rollable: [{ year: 2026, entries: 12 }] } })
  })

  it.each([
    ['current_year', 'activity_year_not_finished'],
    ['partition_exists', 'activity_year_already_rolled'],
  ] as const)('[api] a refused roll (%s) is a 409 %s', async (outcome, code) => {
    const response = await post(sessionApp(port(outcome)), { year: 2026 })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code } })
  })

  it.each([{}, { year: '2026' }, { year: 2026.5 }, { year: 1999 }, { year: 10000 }, []])(
    '[api] refuses a body that does not name a four-digit year (%j) with a 422',
    async (body) => {
      const rolling = port()
      const response = await post(sessionApp(rolling), body)

      expect(response.status).toBe(422)
      expect(rolling.roll).not.toHaveBeenCalled()
    },
  )

  it.each<UserProfile>(['member', 'project_manager', 'people_admin', 'accounting', 'executive_manager'])(
    '[security] a %s session cannot roll or list',
    async (profile) => {
      const rolling = port()
      const app = sessionApp(rolling, profile)

      expect((await post(app, { year: 2026 })).status).toBe(403)
      expect((await app.request('/api/v1/activity-log/rolls')).status).toBe(403)
      expect(rolling.roll).not.toHaveBeenCalled()
    },
  )

  it('[security] an administrator API token is refused: the roll is session-only', async () => {
    const rolling = port()
    const app = createApiApp({
      authentication: {
        tokens: {
          authenticate: async () => ({
            tokenId: 1,
            userId: 9,
            profile: 'administrator' as const,
            scopes: ['reports:read' as const],
          }),
          issue: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
      },
      installApi(api) {
        installOutboxRoutes(api, monitor, options(rolling))
      },
    })
    const headers = { authorization: 'Bearer admin-token', 'content-type': 'application/json' }

    const rolled = await app.request('/api/v1/activity-log/rolls', {
      method: 'POST',
      headers,
      body: JSON.stringify({ year: 2026 }),
    })
    const listed = await app.request('/api/v1/activity-log/rolls', { headers })

    expect(rolled.status).toBe(403)
    expect(await rolled.json()).toMatchObject({ error: { code: 'session_required' } })
    expect(listed.status).toBe(403)
    expect(rolling.roll).not.toHaveBeenCalled()
  })

  it('[api] follows the module switch like the rest of the surface', async () => {
    const rolling = port()
    const app = sessionApp(rolling, 'administrator', false)

    const response = await post(app, { year: 2026 })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'module_disabled' } })
    expect(rolling.roll).not.toHaveBeenCalled()
  })

  it('[api] is not mounted where the deployment cannot roll', async () => {
    const app = sessionApp(undefined)

    expect((await post(app, { year: 2026 })).status).toBe(404)
  })
})
