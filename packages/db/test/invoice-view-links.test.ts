import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { readInvoiceDefaults, updateInvoiceDefaults } from '../src/invoice-defaults.js'
import { recordAttachedDocument } from '../src/invoice-documents.js'
import { executeInvoiceLifecycleCommand, type InvoiceStateDatabase } from '../src/invoice-state.js'
import {
  allowViewLinkRequest,
  constantTimeEqual,
  createInvoiceViewLinkIssuer,
  hashViewLinkToken,
  invoiceViewLinkOrigin,
  mintViewLinkToken,
  readInvoiceViewPage,
  readViewReceipts,
  readViewReceiptsEnabled,
  recordInvoiceView,
  VIEW_LINK_REQUESTS_PER_MINUTE,
  viewLinkExpiry,
} from '../src/invoice-view-links.js'
import { createInvoiceViewService } from '../src/invoice-view-service.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  orm: InvoiceStateDatabase
  run(sql: string, ...bindings: unknown[]): Promise<void>
  rows<T>(sql: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const at = '2026-09-02T12:00:00.000Z'
const later = '2026-09-03T08:30:00.000Z'
const latest = '2026-09-04T09:00:00.000Z'
const origin = 'https://billing.example.test'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...bindings) => void sqlite.prepare(sql).run(...bindings),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      sqlite.prepare(sql).all(...bindings) as T[],
    close: async () => void sqlite.close(),
  }
}

const d1 = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    orm: createD1Database(database),
    run: async (sql, ...bindings) => void (await database.prepare(sql).bind(...bindings).run()),
    rows: async <T>(sql: string, ...bindings: unknown[]) =>
      (await database.prepare(sql).bind(...bindings).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const seed = async (database: Harness): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('View Org', '{"invoices":true}', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Avery', 'Ng', 'administrator', '[]', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'View Client', 'USD', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
       subject, created_at, updated_at)
     VALUES (1, 1, 'INV-1', 'USD', '2026-09-01', '2026-09-30', 'draft', 'September', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO invoice_line_items
       (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
        created_at, updated_at)
     VALUES (1101, 1, 0, 'Service', 1, 1234, 1234, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO sender_identities
       (id, email, display_name, provider, provider_identity, is_default, version,
        created_by_user_id, created_at, updated_at)
     VALUES (10, 'billing@example.com', 'View Org', 'ses', 'example.com', 0, 0, 1, ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO sender_identity_evidence
       (sender_identity_id, evidence_version, source, identity_kind, verification_status,
        dkim_status, mail_from_domain, mail_from_status, observed_at)
     VALUES (10, 1, 'provider_api', 'domain', 'verified', 'verified', NULL, 'not_configured', ?)`,
    at,
  )
}

/** Sends invoice 1, with a link where a token is given. */
const send = (
  database: Harness,
  token: string | null,
  sequence: { n: number; expectedVersion: number; occurredAt: string } = {
    n: 1,
    expectedVersion: 0,
    occurredAt: at,
  },
) =>
  (async () =>
    executeInvoiceLifecycleCommand(database.orm, {
      invoiceId: 1,
      commandId: `send-invoice-${String(sequence.n)}`,
      command: 'send',
      actor: { type: 'user', id: 1 },
      authorize: async () => true,
      expectedVersion: sequence.expectedVersion,
      occurredAt: sequence.occurredAt,
      messageId: 99 + sequence.n,
      eventId: `evt-send-${String(sequence.n)}`,
      ...(token === null
        ? {}
        : {
            viewLink: {
              tokenHash: await hashViewLinkToken(token),
              expiresAt: viewLinkExpiry(sequence.occurredAt),
            },
          }),
      message: {
        sentBy: 'Avery Ng',
        sentByEmail: null,
        sentFrom: 'View Org',
        sentFromEmail: 'billing@example.com',
        recipients: [{ name: 'Client', email: 'client@example.net' }],
        cc: [{ name: 'Pat', email: 'pat@example.net' }],
        subject: 'Invoice INV-1',
        body: 'Amount $12.34',
        attachPdf: true,
        sendMeACopy: false,
        thankYou: false,
        reminder: false,
        sendReminderOn: null,
      },
      delivery: {
        templateVersion: 1,
        senderIdentityId: 10,
        senderIdentityVersion: 0,
        senderEvidenceVersion: 1,
        fromName: 'View Org',
        fromEmail: 'billing@example.com',
        replyToEmail: null,
        subject: 'Invoice INV-1',
        textBody: 'Amount $12.34',
        htmlBody: null,
        deliveryId: 699 + sequence.n,
        recipients: [
          { name: 'Client', email: 'client@example.net', role: 'to' },
          { name: 'Pat', email: 'pat@example.net', role: 'cc' },
        ],
      },
    }))()

/** A lifecycle command from a person, to move invoice 1 out of a viewable state. */
const lifecycle = (
  database: Harness,
  command: 'draft' | 'cancel',
  expectedVersion: number,
  occurredAt: string,
) =>
  executeInvoiceLifecycleCommand(database.orm, {
    invoiceId: 1,
    commandId: `${command}-invoice-1`,
    command,
    actor: { type: 'user', id: 1 },
    authorize: async () => true,
    expectedVersion,
    occurredAt,
    messageId: 300,
    eventId: `evt-${command}-1`,
  })

for (const [name, factory] of [
  ['SQLite', container],
  ['real D1', d1],
] as const) {
  describe(`invoice view links (${name})`, () => {
    let database: Harness | undefined
    afterEach(async () => database?.close())

    const sentWithLink = async () => {
      database = await factory()
      await seed(database)
      const token = mintViewLinkToken()
      await send(database, token)
      return { harness: database, token }
    }

    it('[unit] mints unguessable tokens and stores only their hash', async () => {
      const { harness, token } = await sentWithLink()
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(mintViewLinkToken()).not.toBe(token)
      const rows = await harness.rows<Record<string, unknown>>('SELECT * FROM invoice_view_links')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        invoice_message_id: 100,
        invoice_id: 1,
        token_hash: await hashViewLinkToken(token),
        expires_at: viewLinkExpiry(at),
        first_viewed_at: null,
        view_count: 0,
      })
      // The secret is nowhere in the row, and not in the message the email is kept as.
      expect(JSON.stringify(rows)).not.toContain(token)
      expect(JSON.stringify(await harness.rows('SELECT * FROM invoice_messages'))).not.toContain(token)
      expect(JSON.stringify(await harness.rows('SELECT * FROM event_outbox'))).not.toContain(token)
    })

    it('[unit] a send without a link, such as with the setting off, writes none', async () => {
      database = await factory()
      await seed(database)
      await send(database, null)
      expect(await database.rows('SELECT * FROM invoice_view_links')).toEqual([])
    })

    it('[unit] a send that is refused leaves no link behind', async () => {
      database = await factory()
      await seed(database)
      const token = mintViewLinkToken()
      await expect(
        executeInvoiceLifecycleCommand(database.orm, {
          invoiceId: 1,
          commandId: 'stale-send',
          command: 'send',
          actor: { type: 'user', id: 1 },
          authorize: async () => true,
          expectedVersion: 7,
          occurredAt: at,
          messageId: 101,
          eventId: 'evt-stale',
          viewLink: { tokenHash: await hashViewLinkToken(token), expiresAt: viewLinkExpiry(at) },
        }),
      ).rejects.toThrow()
      expect(await database.rows('SELECT * FROM invoice_view_links')).toEqual([])
    })

    it('[security] opens for the token and for nothing else, without saying why not', async () => {
      const { harness, token } = await sentWithLink()
      expect(await readInvoiceViewPage(harness.orm, token, later)).toMatchObject({
        number: 'INV-1',
        clientName: 'View Client',
        companyName: 'View Org',
        state: 'open',
        amountCents: 1234,
        dueAmountCents: 1234,
        firstViewedAt: null,
      })
      // One character different, the wrong length, another alphabet, nothing.
      const flipped = `${token.slice(0, 42)}${token.endsWith('A') ? 'B' : 'A'}`
      for (const refused of [
        flipped,
        token.slice(1),
        `${token}x`,
        mintViewLinkToken(),
        '',
        '../../etc/passwd',
        ' '.repeat(43),
        "' OR 1=1 --".padEnd(43, 'a'),
        token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(),
      ]) {
        expect(await readInvoiceViewPage(harness.orm, refused, later)).toBeNull()
      }
    })

    it('[security] a link expires, at the instant it says', async () => {
      const { harness, token } = await sentWithLink()
      const expires = viewLinkExpiry(at)
      expect(
        await readInvoiceViewPage(harness.orm, token, new Date(Date.parse(expires) - 1).toISOString()),
      ).not.toBeNull()
      expect(await readInvoiceViewPage(harness.orm, token, expires)).toBeNull()
      expect(
        await readInvoiceViewPage(harness.orm, token, new Date(Date.parse(expires) + 1).toISOString()),
      ).toBeNull()
    })

    it('[security] an invoice no longer sent opens nothing', async () => {
      const { harness, token } = await sentWithLink()
      await lifecycle(harness, 'draft', 1, later)
      expect(await readInvoiceViewPage(harness.orm, token, later)).toBeNull()
    })

    it('[security] a link is immutable and cannot be rewritten to another invoice or token', async () => {
      const { harness } = await sentWithLink()
      await expect(
        harness.run(`UPDATE invoice_view_links SET token_hash = ?`, 'a'.repeat(64)),
      ).rejects.toThrow()
      await expect(harness.run(`UPDATE invoice_view_links SET expires_at = ?`, latest)).rejects.toThrow()
      await expect(harness.run(`DELETE FROM invoice_view_links`)).rejects.toThrow()
      await expect(
        harness.run(`UPDATE invoice_view_links SET token_hash = 'not-a-hash'`),
      ).rejects.toThrow()
    })

    it('[unit] looking at the page records nothing', async () => {
      const { harness, token } = await sentWithLink()
      const service = createInvoiceViewService({ database: harness.orm })
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await service.open(token, later)).toMatchObject({ number: 'INV-1' })
      }
      expect(await harness.rows('SELECT * FROM invoice_messages WHERE event_type = ?', 'view')).toEqual([])
      expect(
        await harness.rows(`SELECT * FROM event_outbox WHERE event_type = 'invoice.viewed'`),
      ).toEqual([])
      expect(
        await harness.rows('SELECT first_viewed_at, view_count FROM invoice_view_links'),
      ).toEqual([{ first_viewed_at: null, view_count: 0 }])
    })

    it('[unit] the first view runs invoice.view once, as the system; later ones only count', async () => {
      const { harness, token } = await sentWithLink()
      const page = (await readInvoiceViewPage(harness.orm, token, later))!
      expect(await recordInvoiceView(harness.orm, page, later)).toBe(true)

      const views = await harness.rows<Record<string, unknown>>(
        `SELECT id, event_type, recipients, cc_recipients, body, subject, created_at
         FROM invoice_messages WHERE event_type = 'view'`,
      )
      expect(views).toHaveLength(1)
      expect(views[0]).toMatchObject({
        event_type: 'view',
        created_at: later,
        subject: null,
        body: 'First opened from the email sent on 2026-09-02.',
        recipients: JSON.stringify([{ name: 'Client', email: 'client@example.net' }]),
        cc_recipients: JSON.stringify([{ name: 'Pat', email: 'pat@example.net' }]),
      })
      const ledger = await harness.rows(
        `SELECT command_kind, actor_type, actor_id, completed FROM invoice_command_ledger
         WHERE command_kind = 'invoice.view'`,
      )
      expect(ledger).toEqual([
        { command_kind: 'invoice.view', actor_type: 'system', actor_id: null, completed: 1 },
      ])
      expect(
        await harness.rows(`SELECT event_type FROM event_outbox WHERE event_type = 'invoice.viewed'`),
      ).toHaveLength(1)

      // A second look, from the fresh read a later request would make.
      const again = (await readInvoiceViewPage(harness.orm, token, latest))!
      expect(again.firstViewedAt).toBe(later)
      expect(await recordInvoiceView(harness.orm, again, latest)).toBe(true)
      expect(await harness.rows(`SELECT id FROM invoice_messages WHERE event_type = 'view'`)).toHaveLength(1)
      expect(
        await harness.rows(`SELECT event_type FROM event_outbox WHERE event_type = 'invoice.viewed'`),
      ).toHaveLength(1)
      expect(
        await harness.rows(
          'SELECT first_viewed_at, last_viewed_at, view_count, view_message_id FROM invoice_view_links',
        ),
      ).toEqual([
        {
          first_viewed_at: later,
          last_viewed_at: latest,
          view_count: 2,
          view_message_id: views[0]!.id,
        },
      ])
      // The invoice itself did not move: viewing is not an edit.
      expect(await harness.rows('SELECT state, version FROM invoices')).toEqual([
        { state: 'open', version: 1 },
      ])
    })

    it('[unit] two first views racing from the same stale read make one view', async () => {
      const { harness, token } = await sentWithLink()
      const stale = (await readInvoiceViewPage(harness.orm, token, later))!
      expect(await recordInvoiceView(harness.orm, stale, later)).toBe(true)
      expect(await recordInvoiceView(harness.orm, stale, latest)).toBe(true)
      expect(await harness.rows(`SELECT id FROM invoice_messages WHERE event_type = 'view'`)).toHaveLength(1)
      expect(
        await harness.rows(`SELECT id FROM event_outbox WHERE event_type = 'invoice.viewed'`),
      ).toHaveLength(1)
      expect(
        await harness.rows('SELECT first_viewed_at, view_count FROM invoice_view_links'),
      ).toEqual([{ first_viewed_at: later, view_count: 2 }])
    })

    it('[unit] a view of an invoice that is no longer viewable records nothing', async () => {
      const { harness, token } = await sentWithLink()
      const page = (await readInvoiceViewPage(harness.orm, token, later))!
      await lifecycle(harness, 'draft', 1, later)
      expect(await recordInvoiceView(harness.orm, page, later)).toBe(false)
      expect(
        await harness.rows('SELECT first_viewed_at, view_count FROM invoice_view_links'),
      ).toEqual([{ first_viewed_at: null, view_count: 0 }])
    })

    it('[unit] each send has its own link, so a receipt is per send', async () => {
      const { harness, token } = await sentWithLink()
      // The same invoice sent again, with a link of its own.
      const second = mintViewLinkToken()
      await send(harness, second, { n: 2, expectedVersion: 1, occurredAt: later })
      const first = (await readInvoiceViewPage(harness.orm, token, latest))!
      await recordInvoiceView(harness.orm, first, latest)
      expect(await readViewReceipts(harness.orm, [100, 101])).toEqual(new Map([[100, latest]]))
      expect((await readInvoiceViewPage(harness.orm, second, latest))!.firstViewedAt).toBeNull()
      expect(await readViewReceipts(harness.orm, [])).toEqual(new Map())
    })

    it('[unit] downloading the document is a view; no document is neither', async () => {
      const { harness, token } = await sentWithLink()
      const bytes = new Uint8Array([37, 80, 68, 70])
      const service = createInvoiceViewService({
        database: harness.orm,
        readDocument: async (key) => (key === 'invoice-documents/1/100.pdf' ? bytes : null),
      })
      expect(await service.open(token, later)).toMatchObject({ hasDocument: false })
      expect(await service.download(token, later)).toBeNull()
      expect(
        await harness.rows('SELECT first_viewed_at FROM invoice_view_links'),
      ).toEqual([{ first_viewed_at: null }])

      await recordAttachedDocument(harness.orm, {
        invoiceMessageId: 100,
        invoiceId: 1,
        objectKey: 'invoice-documents/1/100.pdf',
        filename: 'INVOICE_INV-1_VIEW_ORG.pdf',
        contentType: 'application/pdf',
        byteSize: bytes.byteLength,
        invoiceVersion: 1,
        appendedAttachmentIds: [],
        now: at,
      })
      expect(await service.open(token, later)).toMatchObject({ hasDocument: true })
      expect(await service.download(token, later)).toEqual({
        filename: 'INVOICE_INV-1_VIEW_ORG.pdf',
        bytes,
      })
      expect(
        await harness.rows('SELECT first_viewed_at, view_count FROM invoice_view_links'),
      ).toEqual([{ first_viewed_at: later, view_count: 1 }])
      expect(await service.download(mintViewLinkToken(), later)).toBeNull()
    })

    it('[unit] offers a way to pay only on an open invoice with something owed', async () => {
      const { harness, token } = await sentWithLink()
      const service = createInvoiceViewService({
        database: harness.orm,
        paymentUrl: async () => 'https://pay.example.test/x',
      })
      expect((await service.open(token, later))!.paymentUrl).toBe('https://pay.example.test/x')
      const failing = createInvoiceViewService({
        database: harness.orm,
        paymentUrl: async () => {
          throw new Error('provider down')
        },
      })
      expect((await failing.open(token, later))!.paymentUrl).toBeNull()
      // Cancelled, the page still opens but nothing is owed to be paid.
      await lifecycle(harness, 'cancel', 1, later)
      expect((await service.open(token, later))).toMatchObject({ state: 'closed', paymentUrl: null })
    })

    it('[security] refuses a caller over its allowance, per caller, until the minute turns', async () => {
      database = await factory()
      await seed(database)
      for (let request = 0; request < VIEW_LINK_REQUESTS_PER_MINUTE; request += 1) {
        expect(await allowViewLinkRequest(database.orm, '203.0.113.9', later)).toBe(true)
      }
      expect(await allowViewLinkRequest(database.orm, '203.0.113.9', later)).toBe(false)
      expect(await allowViewLinkRequest(database.orm, '203.0.113.9', later)).toBe(false)
      expect(await allowViewLinkRequest(database.orm, '203.0.113.10', later)).toBe(true)
      expect(
        await allowViewLinkRequest(database.orm, '203.0.113.9', '2026-09-03T08:31:00.000Z'),
      ).toBe(true)
      // The table never holds an address.
      expect(JSON.stringify(await database.rows('SELECT * FROM invoice_view_limits'))).not.toContain(
        '203.0.113',
      )
    })

    it('[unit] the company setting is off until somebody turns it on', async () => {
      database = await factory()
      await seed(database)
      expect(await readViewReceiptsEnabled(database.orm)).toBe(false)
      expect((await readInvoiceDefaults(database.orm)).viewReceipts).toBe(false)
      const saved = await updateInvoiceDefaults(database.orm, { viewReceipts: true }, later)
      expect(saved.viewReceipts).toBe(true)
      expect(saved.companyName).toBe('View Org')
      expect(await readViewReceiptsEnabled(database.orm)).toBe(true)
      expect((await updateInvoiceDefaults(database.orm, { subject: 'x' }, later)).viewReceipts).toBe(true)
      expect((await updateInvoiceDefaults(database.orm, { viewReceipts: false }, later)).viewReceipts).toBe(
        false,
      )
    })

    it('[unit] the issuer links under the configured origin and a preview opens nothing', async () => {
      const { harness } = await sentWithLink()
      const issuer = createInvoiceViewLinkIssuer(harness.orm, `${origin}/`)
      expect(await issuer.enabled()).toBe(false)
      const minted = await issuer.mint(at)
      expect(minted.url).toMatch(/^https:\/\/billing\.example\.test\/portal\/invoices\/[A-Za-z0-9_-]{43}$/u)
      const token = minted.url.slice(minted.url.lastIndexOf('/') + 1)
      expect(minted.tokenHash).toBe(await hashViewLinkToken(token))
      expect(minted.url).not.toContain(minted.tokenHash)
      expect(minted.expiresAt).toBe(viewLinkExpiry(at))
      expect(await readInvoiceViewPage(harness.orm, issuer.previewUrl.slice(issuer.previewUrl.lastIndexOf('/') + 1), later)).toBeNull()
      expect(await harness.rows('SELECT id FROM invoice_view_links')).toHaveLength(1)
    })
  })
}

describe('invoice view link helpers', () => {
  it('[unit] compares without stopping at the first difference, and refuses other lengths', () => {
    expect(constantTimeEqual('abcd', 'abcd')).toBe(true)
    expect(constantTimeEqual('abcd', 'abce')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
  })

  it('[security] links only to a configured https origin, never one with credentials', () => {
    expect(invoiceViewLinkOrigin('https://time.example.test/')).toBe('https://time.example.test')
    expect(invoiceViewLinkOrigin('https://time.example.test/app?x=1')).toBe('https://time.example.test')
    expect(invoiceViewLinkOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    expect(invoiceViewLinkOrigin('http://time.example.test')).toBeNull()
    expect(invoiceViewLinkOrigin('https://good.example@evil.example')).toBeNull()
    expect(invoiceViewLinkOrigin('not a url')).toBeNull()
    expect(invoiceViewLinkOrigin('')).toBeNull()
    expect(invoiceViewLinkOrigin(undefined)).toBeNull()
  })
})
