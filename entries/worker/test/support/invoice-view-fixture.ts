import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeInvoiceLifecycleCommand, type InvoiceStateDatabase } from '../../../../packages/db/src/invoice-state.js'
import {
  hashViewLinkToken,
  mintViewLinkToken,
  viewLinkExpiry,
} from '../../../../packages/db/src/invoice-view-links.js'

/**
 * A migrated database holding one sent invoice that carries a view link (issue
 * 936), shared by the Worker's and the container's tests of the hosted page so
 * both runtimes are held to the same sequence.
 *
 * The send is the real lifecycle command, with the link written in its own
 * batch, exactly as the delivery route writes it.
 */
export const seedSentInvoice = async (
  run: (sql: string, ...bindings: unknown[]) => Promise<void>,
  orm: InvoiceStateDatabase,
  sentAt = new Date().toISOString(),
): Promise<{ readonly token: string; readonly sentAt: string }> => {
  await run(
    `INSERT OR IGNORE INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Page Org', '{"invoices":true}', ?, ?)`,
    sentAt,
    sentAt,
  )
  await run(
    `INSERT OR IGNORE INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (9001, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`,
    sentAt,
    sentAt,
  )
  await run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (9001, 'Page Client', 'USD', ?, ?)`,
    sentAt,
    sentAt,
  )
  await run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
       subject, created_at, updated_at)
     VALUES (9001, 9001, 'INV-9001', 'USD', '2026-09-01', '2026-09-30', 'draft', 'September', ?, ?)`,
    sentAt,
    sentAt,
  )
  await run(
    `INSERT INTO invoice_line_items
       (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents, created_at, updated_at)
     VALUES (9101, 9001, 0, 'Service', 1, 4200, 4200, ?, ?)`,
    sentAt,
    sentAt,
  )
  await run(
    `INSERT INTO sender_identities
       (id, email, display_name, provider, provider_identity, is_default, version,
        created_by_user_id, created_at, updated_at)
     VALUES (9010, 'billing@example.com', 'Page Org', 'ses', 'example.com', 0, 0, 9001, ?, ?)`,
    sentAt,
    sentAt,
  )
  await run(
    `INSERT INTO sender_identity_evidence
       (sender_identity_id, evidence_version, source, identity_kind, verification_status,
        dkim_status, mail_from_domain, mail_from_status, observed_at)
     VALUES (9010, 1, 'provider_api', 'domain', 'verified', 'verified', NULL, 'not_configured', ?)`,
    sentAt,
  )
  const token = mintViewLinkToken()
  await executeInvoiceLifecycleCommand(orm, {
    invoiceId: 9001,
    commandId: 'send-page-invoice',
    command: 'send',
    actor: { type: 'user', id: 9001 },
    authorize: async () => true,
    expectedVersion: 0,
    occurredAt: sentAt,
    messageId: 9200,
    eventId: 'evt-send-page-invoice',
    viewLink: { tokenHash: await hashViewLinkToken(token), expiresAt: viewLinkExpiry(sentAt) },
    message: {
      sentBy: 'Avery Ng',
      sentByEmail: null,
      sentFrom: 'Page Org',
      sentFromEmail: 'billing@example.com',
      recipients: [{ name: 'Client', email: 'client@example.net' }],
      cc: [],
      subject: 'Invoice INV-9001',
      body: 'Amount',
      attachPdf: false,
      sendMeACopy: false,
      thankYou: false,
      reminder: false,
      sendReminderOn: null,
    },
    delivery: {
      templateVersion: 1,
      senderIdentityId: 9010,
      senderIdentityVersion: 0,
      senderEvidenceVersion: 1,
      fromName: 'Page Org',
      fromEmail: 'billing@example.com',
      replyToEmail: null,
      subject: 'Invoice INV-9001',
      textBody: 'Amount',
      htmlBody: null,
      deliveryId: 9300,
      recipients: [{ name: 'Client', email: 'client@example.net', role: 'to' }],
    },
  })
  return { token, sentAt }
}

/** What a runtime hands the shared suite: its app, and its database, with the link seeded. */
export interface PageRuntime {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly rows: <T>(sql: string, ...bindings: unknown[]) => Promise<T[]>
  readonly token: string
  readonly close: () => Promise<void>
}

const forwarded = (address: string): RequestInit => ({ headers: { 'cf-connecting-ip': address } })

/**
 * What both runtimes owe the hosted invoice page (issue 936). The app is
 * shared and the services are not, so each entry boots its own and runs the
 * same assertions: a refusal path that held on one and not the other is a
 * public surface that behaves differently by where it is hosted.
 */
export const invoicePageSuite = (
  name: string,
  boot: () => Promise<PageRuntime>,
  timeout = 120_000,
): void => {
  describe(`the hosted invoice page on ${name}`, () => {
    let runtime: PageRuntime
    beforeAll(async () => {
      runtime = await boot()
    }, timeout)
    afterAll(async () => runtime.close())

    const views = () =>
      runtime.rows<{ id: number }>(`SELECT id FROM invoice_messages WHERE event_type = 'view'`)
    const link = () =>
      runtime.rows<{ first_viewed_at: string | null; view_count: number }>(
        'SELECT first_viewed_at, view_count FROM invoice_view_links',
      )

    it('[security] serves the page with no session, hardened, and a fetch is not a view', async () => {
      const response = await runtime.request(`/portal/invoices/${runtime.token}`, forwarded('198.51.100.1'))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
      const html = await response.text()
      expect(html).toContain('INV-9001')
      expect(html).toContain('Page Client')
      expect(html).toContain('/assets/portal-invoice.js')
      // A mail scanner fetching the address, over and over, records nothing.
      await runtime.request(`/portal/invoices/${runtime.token}`, forwarded('198.51.100.2'))
      await runtime.request(`/portal/invoices/${runtime.token}`, forwarded('198.51.100.3'))
      expect(await views()).toEqual([])
      expect(await link()).toEqual([{ first_viewed_at: null, view_count: 0 }])
    })

    it('[api] serves the script the page loads', async () => {
      const response = await runtime.request('/assets/portal-invoice.js')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/javascript')
      expect(await response.text()).toContain('/viewed')
    })

    it('[security] refuses every token that is not the one issued, identically and without recording', async () => {
      const probes = [
        'A'.repeat(43),
        runtime.token.slice(0, 42),
        `${runtime.token}x`,
        'not-a-token',
        "1' OR '1'='1",
        runtime.token.toLowerCase() === runtime.token ? runtime.token.toUpperCase() : runtime.token.toLowerCase(),
      ]
      const bodies = new Set<string>()
      for (const probe of probes) {
        for (const [path, init] of [
          [`/portal/invoices/${encodeURIComponent(probe)}`, undefined],
          [`/portal/invoices/${encodeURIComponent(probe)}/viewed`, { method: 'POST' }],
          [`/portal/invoices/${encodeURIComponent(probe)}/document`, undefined],
        ] as const) {
          const response = await runtime.request(path, {
            ...init,
            headers: { 'cf-connecting-ip': '198.51.100.4' },
          })
          expect(response.status, path).toBe(404)
          expect(response.headers.get('cache-control')).toBe('no-store')
          const text = await response.text()
          expect(text).not.toContain(probe)
          bodies.add(text)
        }
      }
      expect([...bodies]).toEqual(['Not found'])
      expect(await views()).toEqual([])
    })

    it('[security] rate limits a caller that keeps asking, and only that caller', async () => {
      const statuses: number[] = []
      // More than two windows' worth of allowance, so a minute turning
      // mid-loop cannot let all of them through.
      for (let request = 0; request < 125; request += 1) {
        statuses.push(
          (await runtime.request(`/portal/invoices/${'Z'.repeat(43)}`, forwarded('192.0.2.77'))).status,
        )
      }
      expect(statuses).toContain(429)
      expect(statuses.filter((status) => status === 404).length).toBeGreaterThan(0)
      const refused = await runtime.request(`/portal/invoices/${runtime.token}`, forwarded('192.0.2.77'))
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).toBe('60')
      // Somebody else is unaffected.
      const other = await runtime.request(`/portal/invoices/${runtime.token}`, forwarded('192.0.2.78'))
      expect(other.status).toBe(200)
    })

    it('[api] a download of a document that was never sent is a 404 and not a view', async () => {
      const response = await runtime.request(
        `/portal/invoices/${runtime.token}/document`,
        forwarded('198.51.100.5'),
      )
      expect(response.status).toBe(404)
      expect(await views()).toEqual([])
    })

    it('[api] the page reporting it was shown records the first view once, in invoice history', async () => {
      const first = await runtime.request(`/portal/invoices/${runtime.token}/viewed`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.6' },
      })
      expect(first.status).toBe(204)
      const second = await runtime.request(`/portal/invoices/${runtime.token}/viewed`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': '198.51.100.6' },
      })
      expect(second.status).toBe(204)
      expect(await views()).toHaveLength(1)
      const [receipt] = await link()
      expect(receipt!.first_viewed_at).not.toBeNull()
      expect(receipt!.view_count).toBe(2)
      expect(
        await runtime.rows(`SELECT event_type FROM event_outbox WHERE event_type = 'invoice.viewed'`),
      ).toHaveLength(1)
      expect(
        await runtime.rows<{ body: string }>(`SELECT body FROM invoice_messages WHERE event_type = 'view'`),
      ).toEqual([{ body: expect.stringMatching(/^First opened from the email sent on \d{4}-\d{2}-\d{2}\.$/u) }])
    })
  })
}
