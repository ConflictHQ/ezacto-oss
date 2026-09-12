import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '@ezacto/db'
import { migrateContainer } from '@ezacto/db'
import { setOrganizationAttachPolicy, setInvoiceAttachPolicy } from '@ezacto/db'
import { createAttachmentResolver, createInvoiceDocumentPort } from '../src/invoice-documents.js'

/**
 * Issue 626, the entry's half. `@ezacto/api` asks for a reference and knows
 * nothing about PDFs or buckets; `@ezacto/core` renders and knows nothing about
 * invoices in a database. This is what joins them, so it is tested against a
 * real migrated database and a real render.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const context = {
  invoiceId: 1,
  number: '1315',
  subject: 'Tracked work',
  currency: 'USD',
  amountCents: 319_495,
  discountAmountCents: 0,
  taxAmountCents: 0,
  tax2AmountCents: 0,
  issueDate: '2026-09-12',
  dueDate: '2026-10-12',
  organizationName: 'CONFLICT',
  clientName: 'Kestrel Environmental',
  lineItems: [
    { kind: 'Service', description: 'Advisory', quantity: 1, unitPriceCents: 319_495, amountCents: 319_495 },
  ],
}

const objectStore = () => {
  const written = new Map<string, Uint8Array>()
  return {
    written,
    put: vi.fn(async (key: string, bytes: ArrayBuffer, _contentType: string) => {
      written.set(key, new Uint8Array(bytes))
    }),
    get: vi.fn(async (key: string) => {
      const bytes = written.get(key)
      return bytes === undefined ? null : { body: bytes as unknown as BodyInit }
    }),
  }
}

const harness = async (overrides: { paymentUrl?: () => Promise<string | null> } = {}) => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  for (const trigger of database
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='invoice_messages'`)
    .all() as { name: string }[]) {
    database.exec(`DROP TRIGGER ${trigger.name}`)
  }
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('CONFLICT', '{}', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, version, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'draft', 7, '${at}', '${at}');
    INSERT INTO invoice_messages (id, invoice_id, event_type, created_at, updated_at)
      VALUES (100, 1, 'send', '${at}', '${at}');
  `)
  sqlite = database
  const orm = createContainerDatabase(database)
  const objects = objectStore()
  const port = createInvoiceDocumentPort({
    database: orm as never,
    objects,
    now: () => at,
    source: {
      deliveryContext: async () => context as never,
      invoiceVersion: async () => 7,
      paymentUrl: overrides.paymentUrl ?? (async () => null),
    },
  })
  return { orm, objects, port }
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('preparing the document an invoice carries', () => {
  it('[unit] attaches nothing while the preference is off, and writes no object', async () => {
    const { port, objects } = await harness()
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toBeNull()
    expect(objects.put).not.toHaveBeenCalled()
  })

  it('[money] renders, stores and records once the preference says so', async () => {
    const { orm, port, objects } = await harness()
    await setOrganizationAttachPolicy(orm as never, true)
    const reference = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })

    expect(reference).toEqual({
      key: 'invoice-documents/1/100.pdf',
      filename: 'invoice-1315.pdf',
      contentType: 'application/pdf',
    })
    // A real render, not a stand-in: the bytes are a PDF.
    const stored = objects.written.get('invoice-documents/1/100.pdf')!
    expect(Array.from(stored.slice(0, 5), (b) => String.fromCharCode(b)).join('')).toBe('%PDF-')

    const recorded = sqlite!
      .prepare(`SELECT object_key, filename, byte_size, invoice_version FROM invoice_message_documents`)
      .all()
    expect(recorded).toEqual([
      {
        object_key: 'invoice-documents/1/100.pdf',
        filename: 'invoice-1315.pdf',
        byte_size: stored.byteLength,
        invoice_version: 7,
      },
    ])
  })

  it('[money] returns what already went rather than rendering a second one', async () => {
    // A retried outbox delivery must attach the file that went the first time.
    // The record is keyed on the message precisely so this has an answer.
    const { orm, port, objects } = await harness()
    await setOrganizationAttachPolicy(orm as never, true)
    const first = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const second = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(second).toEqual(first)
    expect(objects.put).toHaveBeenCalledTimes(1)
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM invoice_message_documents`).get(),
    ).toEqual({ n: 1 })
  })

  it('[unit] honours an invoice that refuses while the organization agrees', async () => {
    const { orm, port, objects } = await harness()
    await setOrganizationAttachPolicy(orm as never, true)
    await setInvoiceAttachPolicy(orm as never, { invoiceId: 1, enabled: false })
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toBeNull()
    expect(objects.put).not.toHaveBeenCalled()
  })

  it('[money] still sends the invoice when no payment link can be minted', async () => {
    // A failure to mint a link is not a reason to send no invoice at all.
    const { orm, port, objects } = await harness({
      paymentUrl: async () => {
        throw new Error('stripe is unreachable')
      },
    })
    await setOrganizationAttachPolicy(orm as never, true)
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).not.toBeNull()
    expect(objects.put).toHaveBeenCalledTimes(1)
  })

  it('[unit] prints the link on the document when there is one', async () => {
    const { orm, port, objects } = await harness({
      paymentUrl: async () => 'https://buy.stripe.com/test_abc',
    })
    await setOrganizationAttachPolicy(orm as never, true)
    await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const stored = objects.written.get('invoice-documents/1/100.pdf')!
    const text = Array.from(stored, (b) => String.fromCharCode(b)).join('')
    expect(text).toContain('(https://buy.stripe.com/test_abc) Tj')
  })
})

describe('fetching it back for the queue consumer', () => {
  it('[unit] returns the bytes that were stored', async () => {
    const objects = objectStore()
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    await objects.put('k', bytes.buffer as ArrayBuffer, 'application/pdf')
    const resolve = createAttachmentResolver(objects)
    expect(
      await resolve({ key: 'k', filename: 'a.pdf', contentType: 'application/pdf' }),
    ).toEqual(bytes)
  })

  it('[unit] answers nothing for an object that is not there', async () => {
    // Null rather than a throw: the consumer turns absence into a refusal, so
    // the decision about what a missing file means stays in one place.
    const resolve = createAttachmentResolver(objectStore())
    expect(
      await resolve({ key: 'missing', filename: 'a.pdf', contentType: 'application/pdf' }),
    ).toBeNull()
  })
})
