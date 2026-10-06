import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse } from '../src/errors.js'
import {
  installInvoiceSendingRoutes,
  type ClientInvoiceSending,
  type InvoiceSendingService,
} from '../src/invoice-sending.js'

/**
 * The standing rules an invoice email opens on: the Send dialog's defaults, a
 * client's To, Cc and attachment rules, and the organization's copies.
 */

const sending = (over: Partial<ClientInvoiceSending> = {}): ClientInvoiceSending => ({
  clientId: 7,
  recipients: null,
  contacts: {
    to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
    cc: [{ name: 'Pat Example', email: 'pat@northwind.example' }],
  },
  rules: { attachPdf: null, appendPdfs: true, attachFiles: null, attachJournal: null, journalFormats: null },
  organization: {
    attachPdf: true,
    appendPdfs: false,
    attachFiles: false,
    attachJournal: false,
    journalFormats: ['pdf'],
  },
  ...over,
})

const harness = (profile = 'accounting', over: Partial<InvoiceSendingService> = {}) => {
  const service: InvoiceSendingService = {
    emailDefaults: vi.fn(async (invoiceId: number) =>
      invoiceId === 404
        ? null
        : {
            invoiceId,
            clientId: 7,
            companyName: 'Example Studio LLC',
            clientName: 'Northwind Example Co',
            templateVersion: 2,
            subject: 'Invoice #%invoice_number% from %company_name%',
            message: 'Hello,',
            to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
            cc: [],
            recipientsSource: 'contacts' as const,
            alwaysCc: [{ name: 'Finance', email: 'finance@example.com' }],
            sender: { name: 'Ana Example', email: 'ana@example.com' },
            sendMeACopy: true,
          },
    ),
    readClientSending: vi.fn(async (clientId: number) => (clientId === 404 ? null : sending())),
    saveClientSending: vi.fn(async () => sending()),
    readAlwaysCc: vi.fn(async () => []),
    saveAlwaysCc: vi.fn(async (addresses) => addresses),
    ...over,
  }
  const app = new Hono<{ Bindings: object; Variables: Record<string, unknown> }>()
  app.use('*', async (context, next) => {
    context.set('requestId', 'test-request')
    context.set('principal', {
      userId: 1,
      profile,
      authentication: { kind: 'session', sessionId: 'session-1' },
    })
    await next()
  })
  app.onError((error, context) => errorResponse(error, context as never))
  installInvoiceSendingRoutes(app as never, { service, clock: () => '2026-10-01T09:00:00.000Z' })
  const request = (path: string, init?: { method: string; body: unknown }) =>
    (app as unknown as Hono).request(
      path,
      init === undefined
        ? undefined
        : {
            method: init.method,
            body: JSON.stringify(init.body),
            headers: { 'content-type': 'application/json' },
          },
    )
  return { service, request }
}

describe('what the Send dialog opens on', () => {
  it('[api] answers the template, the lists and the copies in one read', async () => {
    const { request, service } = harness()
    const response = await request('/invoices/4021/email-defaults')
    expect(response.status).toBe(200)
    expect(service.emailDefaults).toHaveBeenCalledWith(4021, 1)
    expect(await response.json()).toEqual({
      data: {
        invoice_id: 4021,
        client_id: 7,
        company_name: 'Example Studio LLC',
        client_name: 'Northwind Example Co',
        template_version: 2,
        subject: 'Invoice #%invoice_number% from %company_name%',
        message: 'Hello,',
        to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        cc: [],
        recipients_source: 'contacts',
        always_cc: [{ name: 'Finance', email: 'finance@example.com' }],
        sender: { name: 'Ana Example', email: 'ana@example.com' },
        send_me_a_copy: true,
      },
    })
    expect((await request('/invoices/404/email-defaults')).status).toBe(404)
  })
})

describe("a client's sending profile", () => {
  it('[api] saves lists and rules, normalized, and hands a rule back with null', async () => {
    const { request, service } = harness()
    const response = await request('/clients/7/invoice-sending', {
      method: 'POST',
      body: {
        recipients: {
          to: [{ name: 'Accounts Payable', email: ' AP@Northwind.example ' }],
          cc: [{ name: 'Pat Example', email: 'pat@northwind.example' }],
        },
        append_pdfs: true,
        attach_files: null,
        attach_journal: 'summary',
        journal_formats: ['csv', 'pdf'],
      },
    })
    expect(response.status).toBe(200)
    expect(service.saveClientSending).toHaveBeenCalledWith(
      7,
      {
        recipients: {
          to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
          cc: [{ name: 'Pat Example', email: 'pat@northwind.example' }],
        },
        rules: {
          appendPdfs: true,
          attachFiles: null,
          attachJournal: 'summary',
          journalFormats: ['pdf', 'csv'],
        },
      },
      '2026-10-01T09:00:00.000Z',
    )
    expect(((await response.json()) as { data: { contacts: unknown } }).data.contacts).toEqual({
      to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
      cc: [{ name: 'Pat Example', email: 'pat@northwind.example' }],
    })
  })

  it('[api] hands the lists back to the contacts with null', async () => {
    const { request, service } = harness()
    expect((await request('/clients/7/invoice-sending', { method: 'POST', body: { recipients: null } })).status).toBe(200)
    expect(service.saveClientSending).toHaveBeenCalledWith(7, { recipients: null }, '2026-10-01T09:00:00.000Z')
  })

  it('[security] refuses an address in both headers, an unknown field, and a body that says nothing', async () => {
    const { request, service } = harness()
    const both = await request('/clients/7/invoice-sending', {
      method: 'POST',
      body: {
        recipients: {
          to: [{ name: 'AP', email: 'ap@northwind.example' }],
          cc: [{ name: 'AP', email: 'AP@northwind.example' }],
        },
      },
    })
    expect(both.status).toBe(422)
    expect(JSON.stringify(await both.json())).toContain('cc[0]')
    expect((await request('/clients/7/invoice-sending', { method: 'POST', body: { bcc: [] } })).status).toBe(422)
    expect((await request('/clients/7/invoice-sending', { method: 'POST', body: {} })).status).toBe(422)
    expect(
      (await request('/clients/7/invoice-sending', { method: 'POST', body: { append_pdfs: 'yes' } })).status,
    ).toBe(422)
    expect(service.saveClientSending).not.toHaveBeenCalled()
  })

  it('[security] keeps it to the people who raise invoices', async () => {
    for (const profile of ['member', 'project_manager']) {
      const { request, service } = harness(profile)
      expect((await request('/clients/7/invoice-sending')).status).toBe(403)
      expect(
        (await request('/clients/7/invoice-sending', { method: 'POST', body: { recipients: null } })).status,
      ).toBe(403)
      expect((await request('/invoices/4021/email-defaults')).status).toBe(403)
      expect(service.saveClientSending).not.toHaveBeenCalled()
    }
  })

  it('[api] answers 404 for a client that does not exist', async () => {
    const { request } = harness()
    expect((await request('/clients/404/invoice-sending')).status).toBe(404)
  })
})

describe("the organization's copies", () => {
  it('[api] saves a normalized list and refuses a duplicate', async () => {
    const { request, service } = harness()
    const saved = await request('/settings/invoice-sending', {
      method: 'POST',
      body: { always_cc: [{ name: 'Finance', email: 'Finance@Example.com' }] },
    })
    expect(saved.status).toBe(200)
    expect(service.saveAlwaysCc).toHaveBeenCalledWith([{ name: 'Finance', email: 'finance@example.com' }])
    const doubled = await request('/settings/invoice-sending', {
      method: 'POST',
      body: {
        always_cc: [
          { name: 'Finance', email: 'finance@example.com' },
          { name: 'Again', email: 'FINANCE@example.com' },
        ],
      },
    })
    expect(doubled.status).toBe(422)
  })
})
