import { describe, expect, it, vi } from 'vitest'
import { DeelStageError } from '@ezacto/core'
import { createApiApp } from '../src/app.js'
import { installDeelPaymentStatusRoutes } from '../src/deel-payment-status.js'

const fixture = () => {
  const runtime = {
    refresh: vi.fn(async () => ({ configured: true, checked: 5, failed: 1, remaining: 4, retry_after_ms: 300_000 })),
  }
  const app = createApiApp({
    authentication: {
      tokens: {
        authenticate: async token => token === 'test-api-token'
          ? { tokenId: 1, userId: 1, profile: 'administrator' as const, scopes: ['reports:read' as const] }
          : null,
        issue: vi.fn(), list: vi.fn(), revoke: vi.fn(),
      },
      sessions: {
        resolve: async request => {
          const cookie = request.headers.get('cookie')
          if (!['session=admin', 'session=member', 'session=bad-id'].includes(cookie ?? '')) return null
          return {
            type: 'user' as const,
            userId: 1,
            profile: cookie === 'session=member' ? 'member' as const : 'administrator' as const,
            authentication: { kind: 'session' as const, sessionId: cookie === 'session=bad-id' ? 'invalid' : '7' },
          }
        },
      },
    },
    installApi: api => installDeelPaymentStatusRoutes(api, runtime),
  })
  const post = (body: unknown = { month: '2026-09' }, headers: Record<string, string> = {}) => app.request('/api/v1/deel-staging/payment-status', {
    method: 'POST',
    headers: { cookie: 'session=admin', origin: 'http://localhost', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { app, post, runtime }
}

describe('Deel payment status HTTP boundary', () => {
  it('refreshes the requested month with native administrator identity and returns only summary counts', async () => {
    const { post, runtime } = fixture()
    const response = await post()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(runtime.refresh).toHaveBeenCalledExactlyOnceWith('2026-09', { userId: 1, sessionId: 7 })
    expect(await response.json()).toEqual({ data: { configured: true, checked: 5, failed: 1, remaining: 4, retry_after_ms: 300_000 } })
  })

  it.each([
    [{ cookie: '' }, 401],
    [{ cookie: 'session=member' }, 403],
    [{ cookie: 'session=bad-id' }, 403],
    [{ cookie: '', authorization: 'Bearer test-api-token' }, 403],
    [{ origin: 'https://other.example' }, 403],
    [{ origin: '' }, 403],
  ] as const)('refuses unauthorized access before provider work: %j', async (headers, status) => {
    const { post, runtime } = fixture()
    const response = await post({ month: '2026-09' }, headers)
    expect(response.status).toBe(status)
    expect(runtime.refresh).not.toHaveBeenCalled()
  })

  it.each([{}, { month: null }, { month: 202609 }, { month: '2026-13' }, { month: '2026-9' }, { month: '2026-09-01' }, { month: '2026-09', user_id: 2 }])('refuses invalid or extended request %j before provider work', async body => {
    const { post, runtime } = fixture()
    expect((await post(body)).status).toBe(422)
    expect(runtime.refresh).not.toHaveBeenCalled()
  })

  it('returns unconfigured explicitly without inventing a successful provider check', async () => {
    const { post, runtime } = fixture()
    runtime.refresh.mockResolvedValueOnce({ configured: false, checked: 0, failed: 0, remaining: 0, retry_after_ms: 0 })
    const response = await post()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { configured: false, checked: 0, failed: 0, remaining: 0, retry_after_ms: 0 } })
  })

  it('refuses a session revoked between authentication and the store check', async () => {
    const { post, runtime } = fixture()
    runtime.refresh.mockRejectedValueOnce(new DeelStageError('forbidden'))
    const response = await post()
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'profile_forbidden' } })
  })

  it('returns a sanitized retryable failure while retaining prior status', async () => {
    const { post, runtime } = fixture()
    runtime.refresh.mockRejectedValueOnce(new Error('private-token-and-provider-payload'))
    const response = await post()
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body).toMatchObject({ error: { code: 'internal_error', message: 'The request could not be completed.' } })
    expect(JSON.stringify(body)).not.toContain('private-token-and-provider-payload')
  })
})
