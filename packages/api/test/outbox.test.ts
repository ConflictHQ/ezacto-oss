import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installOutboxRoutes,
  type ActivityLogResource,
  type OutboxDeliveryPageWindow,
  type OutboxDeliveryResource,
  type OutboxMonitor,
  type UserProfile,
} from '../src/index.js'

const activity: ActivityLogResource = {
  id: 'event-paid',
  eventType: 'invoice.paid',
  aggregateType: 'invoice',
  aggregateId: 41,
  aggregateSequence: 3,
  payload: { schema_version: 1, event_type: 'invoice.paid', actor: { type: 'user', id: 4 } },
  occurredAt: '2026-09-02T12:00:00.000Z',
  availableAt: '2026-09-02T12:00:00.000Z',
  recordedAt: '2026-09-02T12:00:01.000Z',
  actor: { type: 'user', id: 4, name: 'Robin Vale' },
}

const failedDelivery: OutboxDeliveryResource = {
  subscriberId: 'activity_log',
  eventId: 'event-paid',
  eventType: 'invoice.paid',
  aggregateType: 'invoice',
  aggregateId: 41,
  aggregateSequence: 3,
  status: 'failed',
  attemptCount: 5,
  nextAttemptAt: null,
  lastErrorCode: 'subscriber_timeout',
  deliveredAt: null,
  failedAt: '2026-09-02T12:20:00.000Z',
  occurredAt: '2026-09-02T12:00:00.000Z',
  createdAt: '2026-09-02T12:00:01.000Z',
  updatedAt: '2026-09-02T12:20:00.000Z',
}

const routeOptions = (timezone: string) => ({
  cursorSigningKey: new Uint8Array(32).fill(5),
  timezone: async () => timezone,
})

const harness = (
  profile: UserProfile,
  monitorOverrides: Partial<OutboxMonitor> = {},
  activityLogEnabled = true,
) => {
  const monitor: OutboxMonitor = {
    listActivity: vi.fn(async () => [activity]),
    deliveriesSnapshot: vi.fn(async () => failedDelivery.createdAt),
    pageDeliveries: vi.fn(async (window: OutboxDeliveryPageWindow) =>
      [failedDelivery].slice(0, window.take),
    ),
    countDeliveries: vi.fn(async () => 1),
    retryFailed: vi.fn(async (): Promise<OutboxDeliveryResource> => {
      return {
        ...failedDelivery,
        status: 'pending',
        attemptCount: 0,
        lastErrorCode: null,
        failedAt: null,
        nextAttemptAt: '2026-09-02T12:21:00.000Z',
        updatedAt: '2026-09-02T12:21:00.000Z',
      }
    }),
    ...monitorOverrides,
  }
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async () => ({
          type: 'user' as const,
          userId: 1,
          profile,
          managerGrants: [],
          authentication: { kind: 'session' as const, sessionId: 'session-1' },
        }),
      },
    },
    installApi(api) {
      installOutboxRoutes(api, monitor, {
        ...routeOptions('UTC'),
        isActivityLogModuleEnabled: async () => activityLogEnabled,
      })
    },
  })
  return { app, monitor }
}

describe('outbox observability API', () => {
  it('[api] passes every filter through to the repository', async () => {
    // The route holds no filtering logic of its own on purpose: the repository
    // validates each bound and rejects a date the calendar does not have, so a
    // bad request fails loudly here rather than returning an empty page that
    // reads as "nothing happened".
    const { app, monitor } = harness('administrator')
    const response = await app.request(
      '/api/v1/activity-log?per_page=10&from=2026-09-01&to=2026-09-08' +
        '&event_type=auth.signed_in&actor_id=4',
    )
    expect(response.status).toBe(200)
    expect(monitor.listActivity).toHaveBeenCalledWith({
      limit: 10,
      from: '2026-09-01',
      to: '2026-09-08',
      eventType: 'auth.signed_in',
      actorId: 4,
    })
  })

  it('[api] omits a filter that was not asked for rather than sending undefined', async () => {
    // `{ from: undefined }` and no `from` are the same to a caller and not to a
    // repository that checks `!== undefined` before validating. Sending the key
    // would make every unfiltered request carry four invisible ones.
    const { app, monitor } = harness('administrator')
    await app.request('/api/v1/activity-log?per_page=5')
    // Asserted on the keys, not with toHaveBeenCalledWith: that matcher treats
    // an explicit `undefined` as equal to a missing key, so it cannot tell the
    // two apart -- which is the whole distinction being made here.
    const [call] = (monitor.listActivity as unknown as { mock: { calls: unknown[][] } }).mock
      .calls
    expect(Object.keys(call![0] as object)).toEqual(['limit'])
  })

  it('[api] exposes the applied activity stream to a money-report viewer', async () => {
    const { app, monitor } = harness('accounting')
    const response = await app.request('/api/v1/activity-log?per_page=25')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: [
        {
          event_id: 'event-paid',
          event_type: 'invoice.paid',
          aggregate: { type: 'invoice', id: 41, sequence: 3 },
          actor: { type: 'user', id: 4, name: 'Robin Vale' },
          payload: {
            schema_version: 1,
            event_type: 'invoice.paid',
            actor: { type: 'user', id: 4 },
          },
          occurred_at: '2026-09-02T12:00:00.000Z',
          available_at: '2026-09-02T12:00:00.000Z',
          recorded_at: '2026-09-02T12:00:01.000Z',
        },
      ],
      links: { self: '/api/v1/activity-log' },
    })
    // A money-report viewer reads the log without the identity events (issue 740).
    expect(monitor.listActivity).toHaveBeenCalledWith({
      limit: 25,
      excludeEventTypes: expect.arrayContaining(['auth.signed_in', 'api_token.created']),
    })
  })

  it('[api] names the actor beside the recorded payload, for the report audience only (issue 862)', async () => {
    // The name rides next to the payload, never inside it: the payload is the
    // event as recorded, and a name read today is not something it said. A
    // system event and an actor the log cannot read stay nameless rather than
    // borrowing anyone's name.
    const exported: ActivityLogResource = {
      ...activity,
      id: 'event-exported',
      eventType: 'backup.exported',
      payload: { actor: { type: 'system', id: null } },
      actor: { type: 'system', id: null, name: null },
    }
    const foreign: ActivityLogResource = {
      ...activity,
      id: 'event-foreign',
      payload: {},
      actor: null,
    }
    const listActivity = vi.fn(async () => [activity, exported, foreign])
    const { app } = harness('executive_manager', { listActivity })
    const response = await app.request('/api/v1/activity-log')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { event_id: string; actor: unknown; payload: Record<string, unknown> }[]
    }
    expect(body.data.map(({ event_id, actor }) => ({ event_id, actor }))).toEqual([
      { event_id: 'event-paid', actor: { type: 'user', id: 4, name: 'Robin Vale' } },
      { event_id: 'event-exported', actor: { type: 'system', id: null, name: null } },
      { event_id: 'event-foreign', actor: null },
    ])
    expect(body.data[0]!.payload).toEqual(activity.payload)

    // The names come out of the same gate as the log itself. A profile that
    // may not read reports is refused before the repository is asked, so no
    // name is looked up on its behalf.
    const refused = harness('project_manager')
    expect((await refused.app.request('/api/v1/activity-log')).status).toBe(403)
    expect(refused.monitor.listActivity).not.toHaveBeenCalled()
  })

  it('[security] applies report scope/profile ceilings to the organization activity stream', async () => {
    expect((await harness('member').app.request('/api/v1/activity-log')).status).toBe(403)

    const listActivity = vi.fn(async () => [activity])
    const bearer = createApiApp({
      authentication: {
        tokens: {
          authenticate: async () => ({
            tokenId: 1,
            userId: 1,
            profile: 'accounting',
            scopes: ['reports:read'],
          }),
          issue: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
      },
      installApi(api) {
        installOutboxRoutes(api, {
          listActivity,
          deliveriesSnapshot: vi.fn(),
          pageDeliveries: vi.fn(),
          countDeliveries: vi.fn(),
          retryFailed: vi.fn(),
        }, {
          ...routeOptions('UTC'),
          isActivityLogModuleEnabled: async () => true,
        })
      },
    })
    expect(
      (
        await bearer.request('/api/v1/activity-log', {
          headers: { authorization: 'Bearer report-token' },
        })
      ).status,
    ).toBe(200)
  })

  it('[security] keeps sign-in, token and deletion events out of the log for everyone but an administrator (issue 740)', async () => {
    const sensitive = [
      'auth.signed_in',
      'auth.signed_out',
      'api_token.created',
      'api_token.revoked',
      'account.deletion_requested',
    ]
    const sessionRead = async (profile: UserProfile) => {
      const { app, monitor } = harness(profile)
      expect((await app.request('/api/v1/activity-log?event_type=auth.signed_in')).status).toBe(200)
      return (monitor.listActivity as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]
    }
    for (const profile of ['executive_manager', 'accounting'] as const) {
      expect(await sessionRead(profile)).toMatchObject({ excludeEventTypes: sensitive })
    }
    expect(await sessionRead('administrator')).not.toHaveProperty('excludeEventTypes')

    // A bearer token is held to its owner's profile, same as a session.
    const listActivity = vi.fn<OutboxMonitor['listActivity']>(async () => [activity])
    const bearer = (profile: UserProfile) =>
      createApiApp({
        authentication: {
          tokens: {
            authenticate: async () => ({ tokenId: 1, userId: 1, profile, scopes: ['reports:read'] }),
            issue: vi.fn(),
            list: vi.fn(),
            revoke: vi.fn(),
          },
        },
        installApi(api) {
          installOutboxRoutes(
            api,
            {
              listActivity,
              deliveriesSnapshot: vi.fn(),
              pageDeliveries: vi.fn(),
              countDeliveries: vi.fn(),
              retryFailed: vi.fn(),
            },
            { ...routeOptions('UTC'), isActivityLogModuleEnabled: async () => true },
          )
        },
      })
    const headers = { authorization: 'Bearer report-token' }
    await bearer('accounting').request('/api/v1/activity-log', { headers })
    expect(listActivity).toHaveBeenLastCalledWith(expect.objectContaining({ excludeEventTypes: sensitive }))
    await bearer('administrator').request('/api/v1/activity-log', { headers })
    expect(listActivity.mock.calls.at(-1)![0]).not.toHaveProperty('excludeEventTypes')
  })

  it('[api] makes terminal subscriber failures visible and retryable to administrators', async () => {
    const { app, monitor } = harness('administrator')
    const listed = await app.request('/api/v1/outbox-deliveries?status=failed&per_page=10')
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      data: [
        {
          subscriber_id: 'activity_log',
          event_id: 'event-paid',
          status: 'failed',
          attempt_count: 5,
          last_error_code: 'subscriber_timeout',
        },
      ],
      page: { per_page: 10, next_cursor: null, total: 1 },
    })
    expect(monitor.pageDeliveries).toHaveBeenCalledWith({
      status: 'failed',
      order: 'newest',
      after: null,
      createdThrough: '2026-09-02T12:00:01.000Z',
      take: 11,
    })

    const retried = await app.request(
      '/api/v1/outbox-deliveries/activity_log/event-paid/retry',
      { method: 'POST', headers: { origin: 'http://localhost' } },
    )
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({
      data: { status: 'pending', attempt_count: 0, last_error_code: null },
    })
    expect(monitor.retryFailed).toHaveBeenCalledWith('activity_log', 'event-paid')
  })

  it('[api] refuses the activity log with module_disabled when the module is off, without reading it', async () => {
    const { app, monitor } = harness('administrator', {}, false)
    const response = await app.request('/api/v1/activity-log?per_page=25')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'module_disabled' } })
    expect(monitor.listActivity).not.toHaveBeenCalled()
  })

  it('[api] answers the status route in both states so the browser can hide the surface', async () => {
    const off = await harness('administrator', {}, false).app.request('/api/v1/activity-log/status')
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ data: { enabled: false } })
    const on = await harness('administrator').app.request('/api/v1/activity-log/status')
    expect(await on.json()).toMatchObject({ data: { enabled: true } })
    expect((await harness('member').app.request('/api/v1/activity-log/status')).status).toBe(403)
  })

  it('[security] keeps delivery failure internals session-only and administrator-only', async () => {
    expect(
      (await harness('accounting').app.request('/api/v1/outbox-deliveries')).status,
    ).toBe(403)

    const app = createApiApp({
      authentication: {
        tokens: {
          authenticate: async () => ({
            tokenId: 1,
            userId: 1,
            profile: 'administrator',
            scopes: ['reports:read'],
          }),
          issue: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
      },
      installApi(api) {
        installOutboxRoutes(api, {
          listActivity: vi.fn(),
          deliveriesSnapshot: vi.fn(),
          pageDeliveries: vi.fn(),
          countDeliveries: vi.fn(),
          retryFailed: vi.fn(),
        }, {
          ...routeOptions('UTC'),
          isActivityLogModuleEnabled: async () => true,
        })
      },
    })
    const response = await app.request('/api/v1/outbox-deliveries', {
      headers: { authorization: 'Bearer admin-token' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'session_required' },
    })
  })

  it('[api] validates filters and reports retry races without touching the service', async () => {
    const retryFailed = vi.fn(async () => null)
    const { app, monitor } = harness('administrator', { retryFailed })
    expect(
      (await app.request('/api/v1/outbox-deliveries?status=unknown')).status,
    ).toBe(422)
    expect((await app.request('/api/v1/activity-log?per_page=0')).status).toBe(422)
    expect((await app.request('/api/v1/outbox-deliveries?event_type=a%20b')).status).toBe(422)
    expect((await app.request('/api/v1/outbox-deliveries?to=2026-13-01')).status).toBe(422)
    expect(monitor.pageDeliveries).not.toHaveBeenCalled()
    expect(monitor.listActivity).not.toHaveBeenCalled()

    const response = await app.request(
      '/api/v1/outbox-deliveries/activity_log/event-paid/retry',
      { method: 'POST', headers: { origin: 'http://localhost' } },
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'delivery_not_failed' },
    })
  })

  it('[api] narrows deliveries by event type and by the days it spans in the organization timezone', async () => {
    const monitor: OutboxMonitor = {
      listActivity: vi.fn(),
      deliveriesSnapshot: vi.fn(async () => failedDelivery.createdAt),
      pageDeliveries: vi.fn(async () => []),
      countDeliveries: vi.fn(async () => 0),
      retryFailed: vi.fn(),
    }
    const app = createApiApp({
      authentication: {
        sessions: {
          resolve: async () => ({
            type: 'user' as const,
            userId: 1,
            profile: 'administrator' as const,
            managerGrants: [],
            authentication: { kind: 'session' as const, sessionId: 'session-1' },
          }),
        },
      },
      installApi(api) {
        installOutboxRoutes(api, monitor, {
          ...routeOptions('Asia/Tokyo'),
          isActivityLogModuleEnabled: async () => true,
        })
      },
    })
    const response = await app.request(
      '/api/v1/outbox-deliveries?event_type=invoice.paid&from=2026-09-02&to=2026-09-02&order=oldest',
    )
    expect(response.status).toBe(200)
    expect(monitor.pageDeliveries).toHaveBeenCalledWith({
      eventType: 'invoice.paid',
      createdFrom: '2026-09-01T15:00:00.000Z',
      createdBefore: '2026-09-02T15:00:00.000Z',
      order: 'oldest',
      after: null,
      createdThrough: failedDelivery.createdAt,
      take: 51,
    })
    expect(await response.json()).toMatchObject({ data: [], page: { total: 0 } })
  })
})
