import { expect, it, vi } from 'vitest'
import { WebhookError, type WebhookManagement, type WebhookDelivery } from '@ezacto/core'
import { createApiApp } from '../src/app.js'
import { installOutboundWebhookRoutes } from '../src/outbound-webhooks.js'
const id = '00000000-0000-4000-8000-000000000001',
  now = '2026-10-22T09:00:00.000Z'
const subscription = {
  id,
  url: 'https://receiver.example/events',
  events: ['invoice.created'] as const,
  isActive: true,
  version: 1,
  generation: 1,
  previousValidUntil: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
}
const setup = () => {
  const service: WebhookManagement = {
    configured: true,
    list: vi.fn(async () => [{ ...subscription, current_secret: 'encrypted-private-value' }]),
    get: vi.fn(async () => subscription),
    create: vi.fn(async () => ({ subscription, secret: 'one-time-secret' })),
    rotate: vi.fn(async () => ({ subscription, secret: 'rotated-once' })),
    setActive: vi.fn(async () => subscription),
    remove: vi.fn(async () => subscription),
    delivery: vi.fn(async () => null),
    replay: vi.fn(async () => {
      throw new WebhookError('webhook_replay_expired', 'id')
    }),
    deliveriesSnapshot: vi.fn(async () => now),
    countDeliveries: vi.fn(async () => 2),
    pageDeliveries: vi.fn(async () => []),
  }
  const app = createApiApp({
    authentication: {
      tokens: {
        authenticate: async () => ({ tokenId: 1, userId: 1, profile: 'administrator', scopes: [] }),
        issue: async () => {
          throw new Error('unused')
        },
        list: async () => [],
        revoke: async () => null,
      },
      sessions: {
        resolve: async (request) => {
          const role = request.headers.get('x-role')
          return role
            ? {
                type: 'user',
                userId: 1,
                profile: role === 'administrator' ? 'administrator' : 'member',
                authentication: { kind: 'session', sessionId: 'fixture' },
              }
            : null
        },
      },
    },
    installApi: (api) =>
      installOutboundWebhookRoutes(api, service, { cursorSigningKey: new Uint8Array(32).fill(11) }),
  })
  const request = (path: string, method = 'GET', body?: object, role = 'administrator') =>
    app.request('/api/v1/' + path, {
      method,
      headers: {
        'x-role': role,
        ...(body ? { 'content-type': 'application/json', origin: 'http://localhost' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  return { app, service, request }
}
it('permits administrator sessions, refuses member sessions and API tokens, and never serializes ciphers', async () => {
  const { app, service, request } = setup()
  expect((await request('webhook-subscriptions', 'GET', undefined, 'member')).status).toBe(403)
  expect(
    (
      await app.request('/api/v1/webhook-subscriptions', {
        headers: { authorization: 'Bearer fixture-token' },
      })
    ).status,
  ).toBe(403)
  const response = await request('webhook-subscriptions')
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const text = await response.text()
  expect(text).not.toContain('encrypted-private-value')
  expect(text).not.toContain('one-time-secret')
  expect(service.list).toHaveBeenCalledOnce()
})
it('validates strict fields and CAS versions before writing; returns newly issued secrets only on creation/rotation', async () => {
  const { service, request } = setup()
  const bad = await request('webhook-subscriptions/' + id, 'PATCH', { is_active: true, version: -1 })
  expect(bad.status).toBe(422)
  expect(service.setActive).not.toHaveBeenCalled()
  expect(
    (
      await request('webhook-subscriptions', 'POST', {
        url: subscription.url,
        events: subscription.events,
        secret: 'injected',
      })
    ).status,
  ).toBe(422)
  expect(service.create).not.toHaveBeenCalled()
  const response = await request('webhook-subscriptions', 'POST', {
    url: subscription.url,
    events: subscription.events,
  })
  expect(response.status).toBe(201)
  expect(await response.json()).toMatchObject({ signing_secret: 'one-time-secret' })
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(
    (
      await request(`webhook-subscriptions/${id}/rotate-secret`, 'POST', {
        version: 1,
        overlap_seconds: 86401,
      })
    ).status,
  ).toBe(422)
  expect(
    (await request('webhook-deliveries/' + 'a'.repeat(32) + '/replay', 'POST', {})).status,
  ).toBe(409)
})
it('uses signed, filter-bound pagination for string delivery IDs', async () => {
  const { service, request } = setup()
  const row = (id: string): WebhookDelivery => ({
    id,
    subscriptionId: subscription.id,
    eventId: id,
    eventType: 'invoice.created',
    payloadJson: '{}',
    status: 'delivered',
    attemptCount: 1,
    cycleAttempts: 1,
    replayCount: 0,
    lastStatus: 200,
    lastErrorCode: null,
    nextAttemptAt: null,
    lastAttemptAt: now,
    deliveredAt: now,
    failedAt: null,
    createdAt: now,
    updatedAt: now,
  })
  vi.mocked(service.pageDeliveries).mockResolvedValueOnce([
    row('b'.repeat(32)),
    row('a'.repeat(32)),
  ])
  const response = await request('webhook-deliveries?per_page=1&status=delivered')
  expect(response.status).toBe(200)
  const page = (await response.json()) as { data: unknown[]; links: { next: string } }
  expect(page.data).toHaveLength(1)
  expect(page.links.next).toContain('cursor=')
  expect(
    (
      await request(
        page.links.next.replace('/api/v1/', '').replace('status=delivered', 'status=failed'),
      )
    ).status,
  ).toBe(422)
  expect((await request('webhook-deliveries?status=nope')).status).toBe(422)
})
