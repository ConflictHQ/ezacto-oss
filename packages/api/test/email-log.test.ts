import { describe, expect, it, vi } from 'vitest'
import type { EmailLogRecord } from '@ezacto/mailer'
import { createApiApp, installEmailLogRoutes } from '../src/index.js'

const delivery: EmailLogRecord = {
  id: 4,
  to: [{ email: 'owner@example.test', name: 'Avery' }],
  template: 'password_reset',
  subject: 'Reset your ezacto password',
  provider: 'test-http',
  providerMessageId: null,
  status: 'failed',
  relatedType: 'user',
  relatedId: 1,
  attemptCount: 5,
  failureCode: 'provider_timeout',
  createdAt: '2026-08-28T20:00:00.000Z',
  updatedAt: '2026-08-28T20:15:00.000Z',
}

const harness = (profile: 'administrator' | 'member') => {
  const list = vi.fn(async () => [delivery])
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
      installEmailLogRoutes(api, { list })
    },
  })
  return { app, list }
}

describe('email log API', () => {
  it('[api] makes terminal send failure visible to an administrator', async () => {
    const { app, list } = harness('administrator')
    const response = await app.request('/api/v1/email-log?status=failed&per_page=25')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: [
        {
          id: 4,
          to: [{ email: 'owner@example.test', name: 'Avery' }],
          template: 'password_reset',
          subject: 'Reset your ezacto password',
          provider: 'test-http',
          provider_message_id: null,
          status: 'failed',
          related_type: 'user',
          related_id: 1,
          attempt_count: 5,
          failure_code: 'provider_timeout',
          created_at: '2026-08-28T20:00:00.000Z',
          updated_at: '2026-08-28T20:15:00.000Z',
        },
      ],
      links: { self: '/api/v1/email-log' },
    })
    expect(list).toHaveBeenCalledWith({ status: 'failed', limit: 25 })
  })

  it('[security] requires an administrator session and rejects bearer tokens', async () => {
    const member = harness('member')
    expect((await member.app.request('/api/v1/email-log')).status).toBe(403)

    const bearerOnly = createApiApp({
      authentication: {
        tokens: {
          authenticate: async () => ({
            tokenId: 1,
            userId: 1,
            profile: 'administrator',
            scopes: ['time_entries:read'],
          }),
          issue: vi.fn(),
          list: vi.fn(),
          revoke: vi.fn(),
        },
      },
      installApi(api) {
        installEmailLogRoutes(api, { list: async () => [delivery] })
      },
    })
    const response = await bearerOnly.request('/api/v1/email-log', {
      headers: { authorization: 'Bearer api-token' },
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'session_required' },
    })
  })

  it('[api] validates status and page size before querying the log', async () => {
    const { app, list } = harness('administrator')
    expect((await app.request('/api/v1/email-log?status=delivered')).status).toBe(422)
    expect((await app.request('/api/v1/email-log?per_page=0')).status).toBe(422)
    expect(list).not.toHaveBeenCalled()
  })
})
