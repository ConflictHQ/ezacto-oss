import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { installInvoiceDocumentPreferenceRoutes } from '../src/invoice-document-preference.js'
import { errorResponse } from '../src/errors.js'

/**
 * Issue 626. The preference existed before anything could set it, which is a
 * decision the product had made on the operator's behalf and would not let them
 * revisit. These are the controls.
 */

const app = (
  overrides: {
    readInvoicePreference?: ReturnType<typeof vi.fn>
    setInvoicePreference?: ReturnType<typeof vi.fn>
    readOrganizationPreference?: ReturnType<typeof vi.fn>
    setOrganizationPreference?: ReturnType<typeof vi.fn>
  } = {},
  profile = 'administrator',
) => {
  const service = {
    readInvoicePreference:
      overrides.readInvoicePreference ??
      vi.fn(async () => ({ invoice: null, organization: true })),
    setInvoicePreference: overrides.setInvoicePreference ?? vi.fn(async () => true),
    readOrganizationPreference: overrides.readOrganizationPreference ?? vi.fn(async () => true),
    setOrganizationPreference: overrides.setOrganizationPreference ?? vi.fn(async () => undefined),
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
  installInvoiceDocumentPreferenceRoutes(instance as never, service as never)
  return { app: instance, service }
}

const post = (instance: Hono<never>, path: string, body: unknown) =>
  instance.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('reading what an invoice will do', () => {
  it('[unit] reports both answers and which one wins', async () => {
    // A screen should not have to work out the precedence a second time and
    // reach a different answer than the sender will.
    const { app: instance } = app()
    const response = await (instance as never as Hono<never>).request(
      '/invoices/1315/document-preference',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: {
        invoice_id: 1315,
        attach_pdf: null,
        organization_attach_pdf: true,
        effective: true,
      },
    })
  })

  it('[unit] lets an invoice override the organization in both directions', async () => {
    for (const [invoice, organization, effective] of [
      [false, true, false],
      [true, false, true],
    ] as const) {
      const { app: instance } = app({
        readInvoicePreference: vi.fn(async () => ({ invoice, organization })),
      })
      const body = (await (
        await (instance as never as Hono<never>).request('/invoices/1315/document-preference')
      ).json()) as { data: { effective: boolean } }
      expect(body.data.effective).toBe(effective)
    }
  })

  it('[api] answers 404 for an invoice that does not exist', async () => {
    const { app: instance } = app({ readInvoicePreference: vi.fn(async () => null) })
    expect(
      (await (instance as never as Hono<never>).request('/invoices/1315/document-preference'))
        .status,
    ).toBe(404)
  })
})

describe('setting it', () => {
  it('[unit] accepts true, false, and null to follow the organization', async () => {
    // Null is a third answer rather than a missing one, so it cannot be spelled
    // by leaving the field out.
    for (const wanted of [true, false, null]) {
      const { app: instance, service } = app()
      const response = await post(
        instance as never as Hono<never>,
        '/invoices/1315/document-preference',
        { attach_pdf: wanted },
      )
      expect(response.status).toBe(200)
      expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, wanted)
    }
  })

  it('[api] names the field at fault, and never writes, when the value is not one of the three', async () => {
    for (const wanted of ['yes', 1, undefined, {}]) {
      const { app: instance, service } = app()
      const response = await post(
        instance as never as Hono<never>,
        '/invoices/1315/document-preference',
        { attach_pdf: wanted },
      )
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: { fields: { field: string }[] } }
      expect(body.error.fields.map((field) => field.field)).toEqual(['attach_pdf'])
      expect(service.setInvoicePreference).not.toHaveBeenCalled()
    }
  })

  it('[api] answers 404 when the invoice does not exist', async () => {
    const { app: instance } = app({ setInvoicePreference: vi.fn(async () => false) })
    expect(
      (
        await post(instance as never as Hono<never>, '/invoices/1315/document-preference', {
          attach_pdf: true,
        })
      ).status,
    ).toBe(404)
  })
})

describe('the organization default', () => {
  it('[unit] reads and sets it', async () => {
    const { app: instance, service } = app()
    expect(
      await (
        await (instance as never as Hono<never>).request('/settings/invoice-documents')
      ).json(),
    ).toEqual({ data: { attach_pdf: true } })

    const response = await post(
      instance as never as Hono<never>,
      '/settings/invoice-documents',
      { attach_pdf: false },
    )
    expect(response.status).toBe(200)
    expect(service.setOrganizationPreference).toHaveBeenCalledWith(false)
  })

  it('[api] refuses null on the organization, which has nothing to fall back to', async () => {
    // An invoice can defer; the organization is where the answer stops.
    const { app: instance, service } = app()
    const response = await post(
      instance as never as Hono<never>,
      '/settings/invoice-documents',
      { attach_pdf: null },
    )
    expect(response.status).toBe(422)
    expect(service.setOrganizationPreference).not.toHaveBeenCalled()
  })
})

describe('who may change it', () => {
  it('[security] refuses a profile that does not raise invoices', async () => {
    for (const profile of ['member', 'project_manager']) {
      const { app: instance, service } = app({}, profile)
      expect(
        (
          await post(instance as never as Hono<never>, '/settings/invoice-documents', {
            attach_pdf: true,
          })
        ).status,
      ).toBe(403)
      expect(service.setOrganizationPreference).not.toHaveBeenCalled()
    }
  })

  it('[security] admits accounting and an executive manager', async () => {
    for (const profile of ['accounting', 'executive_manager']) {
      const { app: instance } = app({}, profile)
      expect(
        (
          await post(instance as never as Hono<never>, '/settings/invoice-documents', {
            attach_pdf: true,
          })
        ).status,
      ).toBe(200)
    }
  })
})
