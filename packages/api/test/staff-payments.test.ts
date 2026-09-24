import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import { installStaffPaymentRoutes } from '../src/staff-payments.js'
import type { ApiContext } from '../src/context.js'
const store = () => ({
  configureProvider: vi.fn(async () => {}),
  report: vi.fn(async (month: string, as_of: string) => ({ month, as_of, rows: [], provider_settings: { default_provider: 'wise' as const, version: 0, events: [] } })),
  append: vi.fn(async () => {}),
})
const fixture = (profile = 'administrator', kind = 'session') => {
  const api = new Hono<ApiContext<object>>()
  const service = store()
  api.use('*', async (context, next) => {
    context.set('principal', {
      type: 'user',
      userId: 1,
      profile,
      authentication: { kind, sessionId: 'test' },
    } as never)
    context.set('requestId', 'audit-request')
    await next()
  })
  api.onError((error, context) => errorResponse(error, context))
  installStaffPaymentRoutes(api, service)
  return { api, service }
}
describe('staff payment permissions and request validation', () => {
  it.each(['member', 'accounting', 'executive_manager', 'project_manager'])(
    'refuses %s before reading payroll or accepting a command',
    async (profile) => {
      const { api, service } = fixture(profile)
      expect((await api.request('/staff-payments?month=2026-08')).status).toBe(403)
      expect((await api.request('/staff-payments/events', { method: 'POST' })).status).toBe(403)
      expect(service.report).not.toHaveBeenCalled()
      expect(service.append).not.toHaveBeenCalled()
    },
  )
  it('allows an administrator session and refuses tokens', async () => {
    expect((await fixture().api.request('/staff-payments?month=2026-08')).status).toBe(200)
    expect(
      (await fixture('administrator', 'token').api.request('/staff-payments?month=2026-08')).status,
    ).toBe(403)
  })
  it('rejects invalid months and malformed commands before persistence', async () => {
    const { api, service } = fixture()
    expect((await api.request('/staff-payments?month=2026-99')).status).toBe(422)
    expect(
      (
        await api.request('/staff-payments/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(422)
    expect(service.append).not.toHaveBeenCalled()
  })
  it('records the authenticated actor and request identifier', async () => {
    const { api, service } = fixture()
    const body = {
      id: 'opening-1',
      user_id: 2,
      month: '2026-08',
      expected_version: 0,
      kind: 'opening',
      amount_cents: null,
      currency: null,
      paid_on: null,
      due_on: null,
      reference: '',
      note: 'Historical settlement',
      payment_id: null,
      source: 'historical',
    }
    expect(
      (
        await api.request('/staff-payments/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(204)
    expect(service.append).toHaveBeenCalledWith(body, 1, 'audit-request', expect.any(String))
  })
})
