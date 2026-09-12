import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installBillRoutes, type BillService } from '../src/bill.js'
import { errorResponse } from '../src/errors.js'

type Principal = { userId: number; profile: string } | null

const service = (overrides: Partial<BillService> = {}): BillService => ({
  status: vi.fn(() => ({
    configured: true,
    companyId: '008EXAMPLE',
    environment: 'sandbox' as const,
    canSendFromBill: true,
  })),
  isOptedIn: vi.fn(async () => false),
  setOptedIn: vi.fn(async () => true),
  ...overrides,
})

const app = (
  bill: BillService,
  principal: Principal = { userId: 1, profile: 'administrator' },
) => {
  const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  instance.use('*', async (context, next) => {
    if (principal !== null) {
      context.set('principal', {
        ...principal,
        authentication: { kind: 'session', sessionId: 'session-1' },
      })
    }
    await next()
  })
  instance.onError((error, context) => errorResponse(error, context as never))
  installBillRoutes(instance as never, bill)
  return instance
}

const setDelivery = (instance: ReturnType<typeof app>, id: string, body: unknown) =>
  instance.request(`/integrations/bill/clients/${id}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('what the deployment says about BILL', () => {
  it('[api] reports whether it is configured and how it can deliver', async () => {
    const response = await app(service()).request('/integrations/bill')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        configured: true,
        company_id: '008EXAMPLE',
        environment: 'sandbox',
        can_send_from_bill: true,
      },
    })
  })

  it('[security] says when it cannot have BILL send the email', async () => {
    // A sync token cannot. An operator told their client will be emailed by
    // BILL when nobody will email them is the failure this prevents.
    const response = await app(
      service({
        status: vi.fn(() => ({
          configured: true,
          companyId: '008EXAMPLE',
          environment: 'production' as const,
          canSendFromBill: false,
        })),
      }),
    ).request('/integrations/bill')
    const body = (await response.json()) as { data: { can_send_from_bill: boolean } }
    expect(body.data.can_send_from_bill).toBe(false)
  })
})

describe('billing a client through BILL', () => {
  it('[api] turns it on and reports the new state', async () => {
    const bill = service()
    const response = await setDelivery(app(bill), '7', { deliver_via_bill: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { client_id: 7, deliver_via_bill: true },
    })
    expect(bill.setOptedIn).toHaveBeenCalledWith(7, true)
  })

  it('[api] turns it off again', async () => {
    const bill = service()
    expect((await setDelivery(app(bill), '7', { deliver_via_bill: false })).status).toBe(200)
    expect(bill.setOptedIn).toHaveBeenCalledWith(7, false)
  })

  it('[api] reads the current state back', async () => {
    const bill = service({ isOptedIn: vi.fn(async () => true) })
    const response = await app(bill).request('/integrations/bill/clients/7')
    expect(await response.json()).toEqual({
      data: { client_id: 7, deliver_via_bill: true },
    })
  })

  it('[api] refuses a value that is not a choice, naming the field', async () => {
    const bill = service()
    const response = await setDelivery(app(bill), '7', { deliver_via_bill: 'yes' })
    expect(response.status).toBe(422)
    const body = (await response.json()) as {
      error: { fields: { field: string }[] }
    }
    expect(body.error.fields[0]?.field).toBe('deliver_via_bill')
    expect(bill.setOptedIn).not.toHaveBeenCalled()
  })

  it('[api] refuses an id that is not a positive integer', async () => {
    const bill = service()
    for (const id of ['abc', '0', '-3', '1.5']) {
      expect((await setDelivery(app(bill), id, { deliver_via_bill: true })).status).toBe(422)
    }
    expect(bill.setOptedIn).not.toHaveBeenCalled()
  })

  it('[api] says so when the client does not exist', async () => {
    const bill = service({ setOptedIn: vi.fn(async () => false) })
    expect((await setDelivery(app(bill), '999', { deliver_via_bill: true })).status).toBe(404)
  })

  it('[security] refuses to turn it on where the deployment cannot reach BILL', async () => {
    // Otherwise it is a setting that looks saved and delivers nothing: the
    // invoice would go out by the normal path and the operator would believe
    // it had gone through BILL.
    const bill = service({
      status: vi.fn(() => ({
        configured: false,
        companyId: null,
        environment: 'production' as const,
        canSendFromBill: false,
      })),
    })
    const response = await setDelivery(app(bill), '7', { deliver_via_bill: true })
    expect(response.status).toBe(503)
    expect(bill.setOptedIn).not.toHaveBeenCalled()
  })
})

describe('who may change how a client is billed', () => {
  it('[security] only an administrator', async () => {
    // Sending a client's invoice through a third party changes how that client
    // is billed. It is not a preference a project manager sets in passing.
    for (const profile of ['member', 'project_manager', 'accounting', 'executive_manager']) {
      const bill = service()
      const instance = app(bill, { userId: 2, profile })
      expect((await instance.request('/integrations/bill')).status).toBe(403)
      expect((await instance.request('/integrations/bill/clients/7')).status).toBe(403)
      expect((await setDelivery(instance, '7', { deliver_via_bill: true })).status).toBe(403)
      expect(bill.setOptedIn).not.toHaveBeenCalled()
    }
  })

  it('[security] an API token cannot change it either', async () => {
    const bill = service()
    const instance = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
    instance.use('*', async (context, next) => {
      context.set('principal', {
        userId: 1,
        profile: 'administrator',
        authentication: { kind: 'api_token', tokenId: 7 },
      })
      await next()
    })
    instance.onError((error, context) => errorResponse(error, context as never))
    installBillRoutes(instance as never, bill)

    const response = await instance.request('/integrations/bill/clients/7', {
      method: 'POST',
      body: JSON.stringify({ deliver_via_bill: true }),
      headers: { 'content-type': 'application/json' },
    })
    expect(response.status).toBe(403)
    expect(bill.setOptedIn).not.toHaveBeenCalled()
  })
})
