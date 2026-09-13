import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installThankYouPreferenceRoutes } from '../src/thank-you-preference.js'
import { errorResponse } from '../src/errors.js'

/**
 * Issue 545. The opt-out is the load-bearing half: some invoices settle a
 * dispute, and a cheerful automated note is the wrong thing to send about
 * those. An operator has to be able to suppress one before the payment lands.
 */

const app = (
  overrides: Record<string, ReturnType<typeof vi.fn>> = {},
  profile = 'administrator',
) => {
  const service = {
    readInvoiceThankYou:
      overrides.readInvoiceThankYou ?? vi.fn(async () => ({ invoice: null, organization: true })),
    setInvoiceThankYou: overrides.setInvoiceThankYou ?? vi.fn(async () => true),
    readOrganizationThankYou: overrides.readOrganizationThankYou ?? vi.fn(async () => true),
    setOrganizationThankYou: overrides.setOrganizationThankYou ?? vi.fn(async () => undefined),
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
  installThankYouPreferenceRoutes(instance as never, service as never)
  return { app: instance as never as Hono<never>, service }
}

const post = (instance: Hono<never>, path: string, body: unknown) =>
  instance.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('what an invoice will do', () => {
  it('[unit] reports both answers and which one wins', async () => {
    // "Off" and "off because the whole organization is off" are different
    // things to be looking at, and only one of them is changed here.
    const { app: instance } = app()
    const response = await instance.request('/invoices/1315/thank-you-preference')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        invoice_id: 1315,
        auto_thank_you: null,
        organization_auto_thank_you: true,
        effective: true,
      },
    })
  })

  it('[money] lets one invoice override a default that is on', async () => {
    const { app: instance } = app({
      readInvoiceThankYou: vi.fn(async () => ({ invoice: false, organization: true })),
    })
    const body = (await (
      await instance.request('/invoices/1315/thank-you-preference')
    ).json()) as { data: { effective: boolean } }
    expect(body.data.effective).toBe(false)
  })

  it('[api] answers 404 for an invoice that does not exist', async () => {
    const { app: instance } = app({ readInvoiceThankYou: vi.fn(async () => null) })
    expect((await instance.request('/invoices/1315/thank-you-preference')).status).toBe(404)
  })
})

describe('setting it', () => {
  it('[unit] accepts true, false, and null to follow the organization', async () => {
    for (const wanted of [true, false, null]) {
      const { app: instance, service } = app()
      const response = await post(instance, '/invoices/1315/thank-you-preference', {
        auto_thank_you: wanted,
      })
      expect(response.status).toBe(200)
      expect(service.setInvoiceThankYou).toHaveBeenCalledWith(1315, wanted)
    }
  })

  it('[api] names the field at fault, and never writes, on anything else', async () => {
    for (const wanted of ['yes', 1, {}]) {
      const { app: instance, service } = app()
      const response = await post(instance, '/invoices/1315/thank-you-preference', {
        auto_thank_you: wanted,
      })
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: { fields: { field: string }[] } }
      expect(body.error.fields.map((field) => field.field)).toEqual(['auto_thank_you'])
      expect(service.setInvoiceThankYou).not.toHaveBeenCalled()
    }
  })

  it('[api] refuses a body that omits the field rather than reporting a save', async () => {
    // A write that changes nothing and answers 200 reads as a saved setting
    // that was never saved.
    const { app: instance, service } = app()
    const response = await post(instance, '/invoices/1315/thank-you-preference', { other: true })
    expect(response.status).toBe(422)
    expect(service.setInvoiceThankYou).not.toHaveBeenCalled()
  })

  it('[api] answers 404 when the invoice does not exist', async () => {
    const { app: instance } = app({ setInvoiceThankYou: vi.fn(async () => false) })
    expect(
      (await post(instance, '/invoices/1315/thank-you-preference', { auto_thank_you: true }))
        .status,
    ).toBe(404)
  })
})

describe('the organization default', () => {
  it('[unit] reads and sets it', async () => {
    const { app: instance, service } = app()
    expect(await (await instance.request('/settings/invoice-thank-you')).json()).toEqual({
      data: { auto_thank_you: true },
    })
    const response = await post(instance, '/settings/invoice-thank-you', {
      auto_thank_you: false,
    })
    expect(response.status).toBe(200)
    expect(service.setOrganizationThankYou).toHaveBeenCalledWith(false)
  })

  it('[api] refuses null on the organization, which has nothing to fall back to', async () => {
    const { app: instance, service } = app()
    const response = await post(instance, '/settings/invoice-thank-you', {
      auto_thank_you: null,
    })
    expect(response.status).toBe(422)
    expect(service.setOrganizationThankYou).not.toHaveBeenCalled()
  })
})

describe('who may change it', () => {
  it('[security] refuses a profile that does not raise invoices', async () => {
    for (const profile of ['member', 'project_manager']) {
      const { app: instance, service } = app({}, profile)
      expect(
        (await post(instance, '/settings/invoice-thank-you', { auto_thank_you: true })).status,
      ).toBe(403)
      expect(service.setOrganizationThankYou).not.toHaveBeenCalled()
    }
  })

  it('[security] admits accounting and an executive manager', async () => {
    for (const profile of ['accounting', 'executive_manager']) {
      const { app: instance } = app({}, profile)
      expect(
        (await post(instance, '/settings/invoice-thank-you', { auto_thank_you: true })).status,
      ).toBe(200)
    }
  })
})
