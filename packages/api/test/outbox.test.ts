import { describe, expect, it, vi } from 'vitest'
import {
  createApiApp,
  installOutboxRoutes,
  type ActivityLogResource,
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
  payload: { schema_version: 1, event_type: 'invoice.paid' },
  occurredAt: '2026-09-02T12:00:00.000Z',
  availableAt: '2026-09-02T12:00:00.000Z',
  recordedAt: '2026-09-02T12:00:01.000Z',
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

const harness = (
  profile: UserProfile,
  monitorOverrides: Partial<OutboxMonitor> = {},
) => {
  const monitor: OutboxMonitor = {
    listActivity: vi.fn(async () => [activity]),
    listDeliveries: vi.fn(async () => [failedDelivery]),
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
      installOutboxRoutes(api, monitor)
    },
  })
  return { app, monitor }
}

describe('outbox observability API', () => {
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
          payload: { schema_version: 1, event_type: 'invoice.paid' },
          occurred_at: '2026-09-02T12:00:00.000Z',
          available_at: '2026-09-02T12:00:00.000Z',
          recorded_at: '2026-09-02T12:00:01.000Z',
        },
      ],
      links: { self: '/api/v1/activity-log' },
    })
    expect(monitor.listActivity).toHaveBeenCalledWith({ limit: 25 })
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
          listDeliveries: vi.fn(),
          retryFailed: vi.fn(),
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
    })
    expect(monitor.listDeliveries).toHaveBeenCalledWith({ status: 'failed', limit: 10 })

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
          listDeliveries: vi.fn(),
          retryFailed: vi.fn(),
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
    expect(monitor.listDeliveries).not.toHaveBeenCalled()
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
})
