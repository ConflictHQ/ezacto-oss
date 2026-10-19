import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installInvoiceDefaultsRoutes } from '../src/invoice-defaults.js'
import { errorResponse } from '../src/errors.js'

const stored = {
  companyName: 'CONFLICT LLC',
  companyAddress: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
  notes: 'Beneficiary:\n*CONFLICT LLC*',
  subject: null,
  estimateValidityDays: null,
}

const app = (profile = 'administrator') => {
  const service = {
    read: vi.fn(async () => stored),
    update: vi.fn(async (patch: Record<string, unknown>) => ({ ...stored, ...patch })),
  }
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 1,
      profile,
      authentication: { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installInvoiceDefaultsRoutes(instance as never, service as never)
  return { app: instance as never as Hono<never>, service }
}

const post = (instance: Hono<never>, body: unknown) =>
  instance.request('/settings/invoice-defaults', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('invoice company information and default values', () => {
  it('[unit] reads them in the wire shape', async () => {
    const { app: instance } = app()
    const response = await instance.request('/settings/invoice-defaults')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      data: {
        company_name: 'CONFLICT LLC',
        company_address: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
        notes: 'Beneficiary:\n*CONFLICT LLC*',
        subject: null,
        estimate_validity_days: null,
      },
    })
  })

  it('[unit] saves how long an estimate stays answerable, and clears it with null', async () => {
    const { app: instance, service } = app()
    expect((await post(instance, { estimate_validity_days: 30 })).status).toBe(200)
    expect(service.update).toHaveBeenLastCalledWith({ estimateValidityDays: 30 })
    expect((await post(instance, { estimate_validity_days: null })).status).toBe(200)
    expect(service.update).toHaveBeenLastCalledWith({ estimateValidityDays: null })
    const response = await post(instance, { estimate_validity_days: 14, subject: 'S' })
    expect((await response.json()) as unknown).toMatchObject({ data: { estimate_validity_days: 14 } })
  })

  it('[unit] refuses a validity that is not a whole number of days from 1 to 3650', async () => {
    const { app: instance, service } = app()
    for (const days of [0, -1, 3651, 1.5, '30', true]) {
      expect((await post(instance, { estimate_validity_days: days })).status).toBe(422)
    }
    expect(service.update).not.toHaveBeenCalled()
  })

  it('[unit] saves a partial change and clears a default with null', async () => {
    const { app: instance, service } = app()
    const response = await post(instance, { subject: 'Monthly services', notes: null })
    expect(response.status).toBe(200)
    expect(service.update).toHaveBeenCalledWith({ subject: 'Monthly services', notes: null })
  })

  it('[unit] refuses a bad field without saving the good ones', async () => {
    const { app: instance, service } = app()
    for (const body of [
      { company_name: '   ' },
      { company_name: null },
      { subject: 'x'.repeat(999) },
      { notes: 12 },
      { subject: 'fine', colour: 'red' },
      {},
    ]) {
      expect((await post(instance, body)).status).toBe(422)
    }
    expect(service.update).not.toHaveBeenCalled()
  })

  it('[security] is for the people who raise invoices', async () => {
    const { app: instance, service } = app('member')
    expect((await instance.request('/settings/invoice-defaults')).status).toBe(403)
    expect((await post(instance, { subject: 'x' })).status).toBe(403)
    expect(service.read).not.toHaveBeenCalled()
  })
})
