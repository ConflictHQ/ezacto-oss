// Provenance: ezacto-pvt #100. The own-payments route: session only, gated by
// own_money, payee-only, and the subject is always the authenticated user.
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { MyPayments } from '@ezacto/core'
import { errorResponse } from '../src/errors.js'
import { installMyPaymentRoutes } from '../src/my-payments.js'
import { installStaffPaymentRoutes } from '../src/staff-payments.js'
import type { ApiContext } from '../src/context.js'

const summary = (month: string): MyPayments => ({
  month,
  hours_seconds: 3600,
  status: 'pending_review',
  owed: null,
  paid_cents: 0,
  balance_cents: null,
  payments: [],
  upcoming: [],
})

const fixture = (options: {
  profile?: string
  kind?: 'session' | 'token'
  ownMoney?: boolean
  payee?: boolean
  userId?: number
} = {}) => {
  const { profile = 'member', kind = 'session', ownMoney = true, payee = true, userId = 7 } = options
  const api = new Hono<ApiContext<object>>()
  const store = { read: vi.fn(async (_user: number, month: string) => (payee ? summary(month) : null)) }
  const staff = { report: vi.fn(), append: vi.fn(), configureProvider: vi.fn() }
  api.use('*', async (context, next) => {
    context.set(
      'principal',
      { type: 'user', userId, profile, managerGrants: [], ownMoneyVisible: ownMoney, authentication: { kind, sessionId: 's', tokenId: 1, scopes: [] } } as never,
    )
    context.set('requestId', 'request')
    await next()
  })
  api.onError((error, context) => errorResponse(error, context))
  installMyPaymentRoutes(api, store)
  installStaffPaymentRoutes(api, staff as never)
  return { api, store, staff }
}
const code = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code

describe('GET /me/payments', () => {
  it('serves every profile its own figures and asks the store only about the caller', async () => {
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager', 'administrator']) {
      const { api, store } = fixture({ profile, userId: 11 })
      const response = await api.request('/me/payments?month=2026-08')
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ data: summary('2026-08') })
      expect(store.read).toHaveBeenCalledWith(11, '2026-08', expect.any(String))
    }
  })

  it('ignores any attempt to name another person', async () => {
    const { api, store } = fixture({ userId: 7 })
    for (const query of ['user_id=2', 'userId=2', 'person=2', 'id=2', 'user_id=2&month=2026-08']) {
      expect((await api.request(`/me/payments?${query}`)).status).toBe(200)
    }
    expect(store.read.mock.calls.every((call) => call[0] === 7)).toBe(true)
    // There is no path that takes a person either.
    expect((await api.request('/me/payments/2')).status).toBe(404)
    expect((await api.request('/me/2/payments')).status).toBe(404)
  })

  it('is off until own_money is on, before it reveals whether the caller is a payee', async () => {
    for (const payee of [true, false]) {
      const { api, store } = fixture({ ownMoney: false, payee })
      const response = await api.request('/me/payments')
      expect(response.status).toBe(403)
      expect(await code(response)).toBe('own_money_disabled')
      expect(store.read).not.toHaveBeenCalled()
    }
  })

  it('refuses a caller who is not a payee', async () => {
    const { api } = fixture({ payee: false })
    const response = await api.request('/me/payments?month=2026-08')
    expect(response.status).toBe(403)
    expect(await code(response)).toBe('not_a_payee')
  })

  it('refuses API tokens, even for a payee with own_money on', async () => {
    const { api, store } = fixture({ kind: 'token', profile: 'administrator' })
    const response = await api.request('/me/payments')
    expect(response.status).toBe(403)
    expect(await code(response)).toBe('session_required')
    expect(store.read).not.toHaveBeenCalled()
  })

  it('validates the month and defaults to the previous completed month', async () => {
    const { api, store } = fixture()
    expect((await api.request('/me/payments?month=2026-13')).status).toBe(422)
    expect((await api.request('/me/payments?month=soon')).status).toBe(422)
    expect(store.read).not.toHaveBeenCalled()
    expect((await api.request('/me/payments')).status).toBe(200)
    expect(store.read.mock.calls[0]![1]).toMatch(/^\d{4}-\d{2}$/)
  })

  it('leaves the administrator register closed to everyone but an administrator session', async () => {
    for (const [profile, kind] of [['member', 'session'], ['accounting', 'session'], ['administrator', 'token']] as const) {
      const { api, staff } = fixture({ profile, kind })
      expect((await api.request('/staff-payments?month=2026-08')).status).toBe(403)
      expect(staff.report).not.toHaveBeenCalled()
    }
  })
})
