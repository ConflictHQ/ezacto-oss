import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { SenderIdentityUnavailableError } from '@ezacto/mailer'
import type { SenderIdentityConfigurationRecord } from '../src/email-configuration.js'
import { errorResponse } from '../src/errors.js'
import {
  installInvoiceSendingRoutes,
  type ClientInvoiceSending,
  type InvoiceSendingService,
} from '../src/invoice-sending.js'
import type { InvoiceEmailReadinessPorts } from '../src/money-resources.js'

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

/** An organization sender as the configuration store returns it. */
const sender = (
  over: Partial<SenderIdentityConfigurationRecord> = {},
): SenderIdentityConfigurationRecord => ({
  id: 91,
  email: 'billing@studio.example',
  displayName: 'Example Studio Billing',
  replyToEmail: null,
  provider: 'mailgun',
  providerIdentity: 'studio.example',
  isDefault: true,
  version: 1,
  archivedAt: null,
  createdByUserId: 1,
  createdAt: '2026-09-01T09:00:00.000Z',
  updatedAt: '2026-09-01T09:00:00.000Z',
  evidence: {
    version: 1,
    source: 'provider_api',
    identityKind: 'domain',
    verificationStatus: 'verified',
    dkimStatus: 'verified',
    mailFromDomain: null,
    mailFromStatus: 'not_configured',
    observedAt: '2026-09-01T09:00:00.000Z',
  },
  ...over,
})

/** The senders and the mailer the send itself would use. */
const mail = (
  senders: readonly SenderIdentityConfigurationRecord[],
  assertAvailable: InvoiceEmailReadinessPorts['mailer']['assertAvailable'] = async () => undefined,
) => ({
  configuration: { listSenderIdentities: vi.fn(async () => senders) },
  mailer: { assertAvailable: vi.fn(assertAvailable) },
})

const harness = (
  profile = 'accounting',
  over: Partial<InvoiceSendingService> = {},
  delivery?: InvoiceEmailReadinessPorts,
) => {
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
  installInvoiceSendingRoutes(app as never, {
    service,
    clock: () => '2026-10-01T09:00:00.000Z',
    ...(delivery === undefined ? {} : { delivery }),
  })
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
        // No organization mail is composed here, so that is the answer, in
        // the words a send would be refused with.
        delivery: {
          available: false,
          code: 'email_delivery_unavailable',
          message: 'Invoice email delivery is not configured.',
        },
      },
    })
    expect((await request('/invoices/404/email-defaults')).status).toBe(404)
  })

  const deliveryOf = async (response: Response): Promise<unknown> =>
    ((await response.json()) as { data: { delivery: unknown } }).data.delivery

  it('[api] says the email can go when the default sender is vouched for and accepted', async () => {
    // The Send dialog used to open with delivery unticked whatever the
    // answer, so a confirmed send recorded the invoice and emailed nobody. It
    // opens delivering on this answer.
    const ports = mail([sender({ id: 7, isDefault: false }), sender()])
    const { request } = harness('accounting', {}, ports)
    const response = await request('/invoices/4021/email-defaults')
    expect(response.status).toBe(200)
    expect(await deliveryOf(response)).toEqual({ available: true, code: null, message: null })
    // The default, as a send naming no sender would pick it.
    expect(ports.mailer.assertAvailable).toHaveBeenCalledWith(91)
  })

  it('[api] says why the email cannot go, in the words a send would be refused with', async () => {
    const missing = {
      available: false,
      code: 'sender_identity_missing',
      message: 'Configure and verify an organization sender before sending.',
    }
    for (const senders of [
      [],
      [sender({ isDefault: false })],
      [sender({ archivedAt: '2026-09-20T09:00:00.000Z' })],
      [sender({ evidence: null })],
    ]) {
      const ports = mail(senders)
      const { request } = harness('accounting', {}, ports)
      expect(await deliveryOf(await request('/invoices/4021/email-defaults'))).toEqual(missing)
      expect(ports.mailer.assertAvailable).not.toHaveBeenCalled()
    }

    // A sender the provider has not finished verifying: the mailer's refusal,
    // as the send would surface it.
    const pending = new SenderIdentityUnavailableError('sender_verification_pending', 91)
    const { request } = harness(
      'accounting',
      {},
      mail([sender()], async () => {
        throw pending
      }),
    )
    expect(await deliveryOf(await request('/invoices/4021/email-defaults'))).toEqual({
      available: false,
      code: 'sender_verification_pending',
      message: pending.message,
    })
  })

  it('[reliability] fails the read when the senders cannot be read, rather than calling email off', async () => {
    // "Not configured" would untick delivery on a deployment that can send.
    const { request } = harness('accounting', {}, {
      configuration: {
        listSenderIdentities: vi.fn(async () => {
          throw new Error('database is locked')
        }),
      },
      mailer: { assertAvailable: vi.fn(async () => undefined) },
    })
    const response = await request('/invoices/4021/email-defaults')
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error' } })
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
