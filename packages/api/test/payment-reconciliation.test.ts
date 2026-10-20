// Provenance: ezacto-pvt 902 slice 1. The reconciliation read route is
// administrator-session only, like its sibling money reads, and writes nothing.
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { StaffPaymentError } from '@ezacto/core'
import { errorResponse } from '../src/errors.js'
import { installStaffPaymentRoutes } from '../src/staff-payments.js'
import type { ApiContext } from '../src/context.js'

const fixture = (profile = 'administrator', kind = 'session') => {
  const api = new Hono<ApiContext<object>>()
  const service = {
    reconciliation: vi.fn(async (month: string) => ({
      month,
      currency: 'USD',
      completed: true,
      people: [],
    })),
  }
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
  installStaffPaymentRoutes(api, service as never)
  return { api, service }
}

describe('payment reconciliation route', () => {
  it('serves administrator sessions only', async () => {
    for (const [profile, kind] of [
      ['member', 'session'],
      ['accounting', 'session'],
      ['administrator', 'token'],
    ] as const) {
      const { api, service } = fixture(profile, kind)
      expect((await api.request('/staff-payments/reconciliation?month=2026-08')).status).toBe(403)
      expect(service.reconciliation).not.toHaveBeenCalled()
    }
  })

  it('returns the proposal uncached and validates the month', async () => {
    const { api, service } = fixture()
    const response = await api.request('/staff-payments/reconciliation?month=2026-08')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: { month: '2026-08', currency: 'USD', completed: true, people: [] },
    })
    expect(service.reconciliation).toHaveBeenCalledWith('2026-08', expect.any(String))
    expect((await api.request('/staff-payments/reconciliation?month=2026-99')).status).toBe(422)
  })

  it('maps store errors and a missing store', async () => {
    const { api, service } = fixture()
    service.reconciliation.mockRejectedValueOnce(new StaffPaymentError('invalid', 'Bad month.'))
    expect((await api.request('/staff-payments/reconciliation?month=2026-08')).status).toBe(422)
    const bare = new Hono<ApiContext<object>>()
    bare.use('*', async (context, next) => {
      context.set('principal', {
        type: 'user',
        userId: 1,
        profile: 'administrator',
        authentication: { kind: 'session', sessionId: 'test' },
      } as never)
      await next()
    })
    bare.onError((error, context) => errorResponse(error, context))
    installStaffPaymentRoutes(bare, {} as never)
    expect((await bare.request('/staff-payments/reconciliation?month=2026-08')).status).toBe(503)
  })
})
