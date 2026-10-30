// Provenance: ezacto-pvt #899. The allocation routes: administrator sessions
// only, strict bodies, and the store's conflicts surface as 409.
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { StaffPaymentError } from '@ezacto/core'
import { errorResponse } from '../src/errors.js'
import { installStaffPaymentRoutes } from '../src/staff-payments.js'
import type { ApiContext } from '../src/context.js'

const command = {
  id: 'a1',
  payment_kind: 'event',
  payment_id: 'p1',
  user_id: 2,
  month: '2026-08',
  scope: 'entry',
  project_id: 1,
  entry_id: 10,
  seconds: 3600,
  amount_cents: null,
  reason: 'Reconciled',
}
const fixture = (profile = 'administrator', kind = 'session') => {
  const api = new Hono<ApiContext<object>>()
  const service = {
    allocationReport: vi.fn(async (month: string) => ({ month, people: [] })),
    previewAllocation: vi.fn(async () => ({ amount_cents: 5000 })),
    allocatePayment: vi.fn(async () => {}),
    reverseAllocation: vi.fn(async () => {}),
  }
  api.use('*', async (context, next) => {
    context.set('principal', { type: 'user', userId: 1, profile, authentication: { kind, sessionId: 'test' } } as never)
    context.set('requestId', 'audit-request')
    await next()
  })
  api.onError((error, context) => errorResponse(error, context))
  installStaffPaymentRoutes(api, service as never)
  return { api, service }
}
const post = (api: Hono<ApiContext<object>>, path: string, body: unknown) =>
  api.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('payment allocation routes', () => {
  it('serves administrator sessions only', async () => {
    for (const [profile, kind] of [['member', 'session'], ['accounting', 'session'], ['administrator', 'token']] as const) {
      const { api, service } = fixture(profile, kind)
      expect((await api.request('/staff-payments/allocations?month=2026-08')).status).toBe(403)
      expect((await post(api, '/staff-payments/allocations', command)).status).toBe(403)
      expect(service.allocationReport).not.toHaveBeenCalled()
      expect(service.allocatePayment).not.toHaveBeenCalled()
    }
  })

  it('reports, previews, allocates and reverses with the acting administrator', async () => {
    const { api, service } = fixture()
    expect((await api.request('/staff-payments/allocations?month=2026-08')).status).toBe(200)
    expect((await api.request('/staff-payments/allocations?month=2026-99')).status).toBe(422)
    expect(await (await post(api, '/staff-payments/allocations/preview', command)).json()).toEqual({ data: { amount_cents: 5000 } })
    expect((await post(api, '/staff-payments/allocations', command)).status).toBe(204)
    expect(service.allocatePayment).toHaveBeenCalledWith(command, 1, 'audit-request', expect.any(String))
    const reversal = { id: 'r1', allocation_id: 'a1', reason: 'Wrong entry' }
    expect((await post(api, '/staff-payments/allocations/reversals', reversal)).status).toBe(204)
    expect(service.reverseAllocation).toHaveBeenCalledWith(reversal, 1, 'audit-request', expect.any(String))
  })

  it('rejects malformed bodies before persistence and maps store errors', async () => {
    const { api, service } = fixture()
    expect((await post(api, '/staff-payments/allocations', { ...command, seconds: '3600' })).status).toBe(422)
    expect((await post(api, '/staff-payments/allocations', { ...command, reason: 7 })).status).toBe(422)
    expect((await post(api, '/staff-payments/allocations/reversals', { id: 'r' })).status).toBe(422)
    expect(service.allocatePayment).not.toHaveBeenCalled()
    service.allocatePayment.mockRejectedValueOnce(new StaffPaymentError('conflict', 'exceeds'))
    expect((await post(api, '/staff-payments/allocations', command)).status).toBe(409)
    service.allocatePayment.mockRejectedValueOnce(new StaffPaymentError('invalid', 'bad'))
    expect((await post(api, '/staff-payments/allocations', command)).status).toBe(422)
    service.reverseAllocation.mockRejectedValueOnce(new StaffPaymentError('not_found', 'missing'))
    expect((await post(api, '/staff-payments/allocations/reversals', { id: 'r', allocation_id: 'x', reason: 'y' })).status).toBe(404)
  })

  it('reports unavailable when the store has no allocation support', async () => {
    const api = new Hono<ApiContext<object>>()
    api.use('*', async (context, next) => {
      context.set('principal', { type: 'user', userId: 1, profile: 'administrator', authentication: { kind: 'session', sessionId: 't' } } as never)
      context.set('requestId', 'r')
      await next()
    })
    api.onError((error, context) => errorResponse(error, context))
    installStaffPaymentRoutes(api, {} as never)
    expect((await post(api, '/staff-payments/allocations', command)).status).toBe(503)
  })
})
