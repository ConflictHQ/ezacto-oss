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
    readInvoiceJournal?: ReturnType<typeof vi.fn>
    setInvoiceJournal?: ReturnType<typeof vi.fn>
    readOrganizationJournal?: ReturnType<typeof vi.fn>
    setOrganizationJournal?: ReturnType<typeof vi.fn>
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
    readInvoiceJournal:
      overrides.readInvoiceJournal ?? vi.fn(async () => ({ invoice: null, organization: false })),
    setInvoiceJournal: overrides.setInvoiceJournal ?? vi.fn(async () => true),
    readOrganizationJournal: overrides.readOrganizationJournal ?? vi.fn(async () => false),
    setOrganizationJournal: overrides.setOrganizationJournal ?? vi.fn(async () => undefined),
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
        attach_files: null,
        organization_attach_files: true,
        effective_files: true,
        attach_journal: null,
        organization_attach_journal: false,
        effective_journal: false,
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
      expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, 'document', wanted)
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
    ).toEqual({ data: { attach_pdf: true, attach_files: true, attach_journal: false } })

    const response = await post(
      instance as never as Hono<never>,
      '/settings/invoice-documents',
      { attach_pdf: false },
    )
    expect(response.status).toBe(200)
    expect(service.setOrganizationPreference).toHaveBeenCalledWith('document', false)
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

describe('the files staged against an invoice', () => {
  it('[unit] is a separate answer from the document', async () => {
    // Wanting a purchase order returned is not wanting the invoice as a PDF.
    const { app: instance, service } = app()
    const response = await post(
      instance as never as Hono<never>,
      '/invoices/1315/document-preference',
      { attach_files: true },
    )
    expect(response.status).toBe(200)
    expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, 'files', true)
    expect(service.setInvoicePreference).not.toHaveBeenCalledWith(1315, 'document', expect.anything())
  })

  it('[unit] can be set alongside the document in one call', async () => {
    const { app: instance, service } = app()
    await post(instance as never as Hono<never>, '/invoices/1315/document-preference', {
      attach_pdf: true,
      attach_files: false,
    })
    expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, 'document', true)
    expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, 'files', false)
  })

  it('[api] refuses a body that sets neither, rather than reporting a save', async () => {
    // A write that changes nothing and answers 200 reads as a saved setting
    // that was never saved.
    const { app: instance, service } = app()
    const response = await post(
      instance as never as Hono<never>,
      '/invoices/1315/document-preference',
      { something_else: true },
    )
    expect(response.status).toBe(422)
    expect(service.setInvoicePreference).not.toHaveBeenCalled()
  })

  it('[api] names attach_files when that is the field at fault', async () => {
    const { app: instance } = app()
    const response = await post(
      instance as never as Hono<never>,
      '/invoices/1315/document-preference',
      { attach_files: 'yes' },
    )
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { fields: { field: string }[] } }
    expect(body.error.fields.map((field) => field.field)).toEqual(['attach_files'])
  })

  it('[unit] sets the organization default for files too', async () => {
    const { app: instance, service } = app()
    await post(instance as never as Hono<never>, '/settings/invoice-documents', {
      attach_files: true,
    })
    expect(service.setOrganizationPreference).toHaveBeenCalledWith('files', true)
  })

  it('[api] refuses null on the organization for files as well', async () => {
    const { app: instance, service } = app()
    const response = await post(
      instance as never as Hono<never>,
      '/settings/invoice-documents',
      { attach_files: null },
    )
    expect(response.status).toBe(422)
    expect(service.setOrganizationPreference).not.toHaveBeenCalled()
  })
})

describe('the work journal, which is not a yes or no', () => {
  it('[unit] accepts a level, false, and null to follow the organization', async () => {
    // Three answers plus defer. This is the value a fourth boolean pair could
    // not have carried, and the reason 647 made these a set.
    for (const wanted of ['detailed', 'summary', false, null] as const) {
      const { app: instance, service } = app()
      const response = await post(
        instance as never as Hono<never>,
        '/invoices/1315/document-preference',
        { attach_journal: wanted },
      )
      expect(response.status).toBe(200)
      expect(service.setInvoiceJournal).toHaveBeenCalledWith(1315, wanted)
    }
  })

  it('[api] names attach_journal, and never writes, on anything else', async () => {
    for (const wanted of ['yes', true, 1, {}, 'DETAILED']) {
      const { app: instance, service } = app()
      const response = await post(
        instance as never as Hono<never>,
        '/invoices/1315/document-preference',
        { attach_journal: wanted },
      )
      expect(response.status).toBe(422)
      const body = (await response.json()) as { error: { fields: { field: string }[] } }
      expect(body.error.fields.map((field) => field.field)).toEqual(['attach_journal'])
      expect(service.setInvoiceJournal).not.toHaveBeenCalled()
    }
  })

  it('[unit] reports the level and which side decided it', async () => {
    const { app: instance } = app({
      readInvoiceJournal: vi.fn(async () => ({ invoice: 'summary', organization: 'detailed' })),
    })
    const body = (await (
      await (instance as never as Hono<never>).request('/invoices/1315/document-preference')
    ).json()) as { data: Record<string, unknown> }
    expect(body.data).toMatchObject({
      attach_journal: 'summary',
      organization_attach_journal: 'detailed',
      effective_journal: 'summary',
    })
  })

  it('[unit] falls back to the organization when the invoice has not said', async () => {
    const { app: instance } = app({
      readInvoiceJournal: vi.fn(async () => ({ invoice: null, organization: 'detailed' })),
    })
    const body = (await (
      await (instance as never as Hono<never>).request('/invoices/1315/document-preference')
    ).json()) as { data: Record<string, unknown> }
    expect(body.data.effective_journal).toBe('detailed')
  })

  it('[api] refuses null on the organization, which has nothing to fall back to', async () => {
    const { app: instance, service } = app()
    const response = await post(
      instance as never as Hono<never>,
      '/settings/invoice-documents',
      { attach_journal: null },
    )
    expect(response.status).toBe(422)
    expect(service.setOrganizationJournal).not.toHaveBeenCalled()
  })

  it('[unit] sets the organization default to a level', async () => {
    const { app: instance, service } = app()
    await post(instance as never as Hono<never>, '/settings/invoice-documents', {
      attach_journal: 'summary',
    })
    expect(service.setOrganizationJournal).toHaveBeenCalledWith('summary')
  })

  it('[unit] can be set alongside the other two in one call', async () => {
    const { app: instance, service } = app()
    await post(instance as never as Hono<never>, '/invoices/1315/document-preference', {
      attach_pdf: true,
      attach_files: false,
      attach_journal: 'detailed',
    })
    expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, 'document', true)
    expect(service.setInvoicePreference).toHaveBeenCalledWith(1315, 'files', false)
    expect(service.setInvoiceJournal).toHaveBeenCalledWith(1315, 'detailed')
  })
})
