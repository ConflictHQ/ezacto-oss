import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '@ezacto/db'
import { migrateContainer } from '@ezacto/db'
import {
  setOrganizationAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationFilesPolicy,
  setInvoiceFilesPolicy,
  setOrganizationJournalPolicy,
  setInvoiceJournalPolicy,
} from '@ezacto/db'
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
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
    expect(objects.put).not.toHaveBeenCalled()
  })

  it('[money] renders, stores and records once the preference says so', async () => {
    const { orm, port, objects } = await harness()
    await setOrganizationAttachPolicy(orm as never, true)
    const reference = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })

    expect(reference).toEqual([
      {
        key: 'invoice-documents/1/100.pdf',
        filename: 'invoice-1315.pdf',
        contentType: 'application/pdf',
      },
    ])
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
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
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
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toHaveLength(1)
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

describe('the files an operator staged against the invoice', () => {
  // An attachment declares exactly one owner, and its link id is its own id --
  // the schema says so, which is what keeps a file from belonging to an invoice
  // and an expense at once.
  let nextAttachmentId = 500
  const stage = (name: string, key: string) => {
    const id = (nextAttachmentId += 1)
    const hash = key.replace(/[^a-f0-9]/gu, '').padEnd(64, 'a').slice(0, 64)
    // One transaction: the attachment names its link and the link names the
    // attachment, and those keys are deferred precisely so the pair can be
    // written together.
    sqlite!.exec(`
      BEGIN;
      INSERT INTO file_objects (content_hash, file_key, byte_size, content_type, created_at, updated_at)
        VALUES ('${hash}', '${key}', 2048, 'application/pdf', '${at}', '${at}');
      INSERT INTO attachments
        (id, file_object_id, name, invoice_attachment_link_id, created_at, updated_at)
        VALUES (${String(id)},
                (SELECT id FROM file_objects WHERE file_key = '${key}'),
                '${name}', ${String(id)}, '${at}', '${at}');
      INSERT INTO invoice_attachments (attachment_id, invoice_id)
        VALUES (${String(id)}, 1);
      COMMIT;
    `)
  }

  it('[unit] sends nothing staged until somebody turns it on', async () => {
    // Attachments are already on invoices in this account. Turning this on by
    // default would email files to clients that nobody chose to send.
    const { orm, port } = await harness()
    stage('purchase-order.pdf', 'files/po-1')
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
    await setOrganizationAttachPolicy(orm as never, true)
    const withDocument = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(withDocument).toHaveLength(1)
  })

  it('[unit] carries them once enabled, after the invoice itself', async () => {
    // A client opening the attachments in order should meet the invoice before
    // what supports it.
    const { orm, port } = await harness()
    stage('purchase-order.pdf', 'files/po-1')
    stage('order-form.pdf', 'files/of-1')
    await setOrganizationAttachPolicy(orm as never, true)
    await setOrganizationFilesPolicy(orm as never, true)

    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual([
      'invoice-1315.pdf',
      'purchase-order.pdf',
      'order-form.pdf',
    ])
  })

  it('[unit] sends the staged files even when the invoice document is off', async () => {
    // The two are separate choices: wanting a purchase order returned is not
    // wanting the invoice as a PDF.
    const { orm, port } = await harness()
    stage('purchase-order.pdf', 'files/po-1')
    await setOrganizationFilesPolicy(orm as never, true)
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual(['purchase-order.pdf'])
  })

  it('[unit] lets one invoice refuse the staged files while the default says send', async () => {
    const { orm, port } = await harness()
    stage('purchase-order.pdf', 'files/po-1')
    await setOrganizationFilesPolicy(orm as never, true)
    await setInvoiceFilesPolicy(orm as never, { invoiceId: 1, enabled: false })
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
  })

  it('[unit] carries the file key and type from the stored object, not a guess', async () => {
    const { orm, port } = await harness()
    stage('purchase-order.pdf', 'files/po-1')
    await setOrganizationFilesPolicy(orm as never, true)
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([
      { key: 'files/po-1', filename: 'purchase-order.pdf', contentType: 'application/pdf' },
    ])
  })
})

describe('the work behind the invoice', () => {
  // Entries the invoice actually claimed, which is what `time_entries.invoice_id`
  // records. A date range would drift: entries can be released from an invoice,
  // and two invoices can cover overlapping weeks for different projects.
  // Borrowed from the release-invoiced-time fixture, which already satisfies
  // the assignment chain a claimed entry needs: a project, a task, and a user
  // and task assignment on that project. Hand-seeding fewer rows than that is
  // how the earlier version of this fixture quietly inserted no project at all.
  let entryId = 0
  const seedWork = () =>
    sqlite!.exec(`
      INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (1, 'R.', 'Adeyemi', 'administrator', '[]', '${at}', '${at}');
      INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
        VALUES (1, 1, 'Phase 1', 'P1', 1, 'time_materials', '${at}', '${at}');
      INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
        VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
      INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
        VALUES (1, 1, 1, '${at}', '${at}');
      INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
        VALUES (1, 1, 1, 1, '${at}', '${at}');
    `)

  const claim = (seconds: number, notes: string, spentDate = '2026-09-01') => {
    entryId += 1
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                task_assignment_id, spent_date, seconds, seconds_without_timer,
                                rounded_seconds, billable, notes, invoice_id, created_at, updated_at)
        VALUES (${String(entryId)}, 1, 1, 1, 1, 1, '${spentDate}', ${String(seconds)},
                ${String(seconds)}, ${String(seconds)}, 1, '${notes}', 1, '${at}', '${at}');
    `)
  }

  it('[unit] sends no journal until somebody asks for one', async () => {
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await setOrganizationAttachPolicy(orm as never, true)
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual(['invoice-1315.pdf'])
  })

  it('[money] attaches it after the invoice and names the level', async () => {
    // A client opening the attachments in order meets the invoice, then the
    // work behind it.
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await setOrganizationAttachPolicy(orm as never, true)
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual([
      'invoice-1315.pdf',
      'work-detailed-1315.pdf',
    ])
  })

  it('[money] goes on its own when the invoice document is off', async () => {
    // The two are separate choices. Wanting the work does not mean wanting the
    // invoice as a PDF.
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'summary')
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual(['work-summary-1315.pdf'])
  })

  it('[money] lets one invoice choose a different level from the default', async () => {
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setInvoiceJournalPolicy(orm as never, { invoiceId: 1, level: 'summary' })
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual(['work-summary-1315.pdf'])
  })

  it('[money] lets one invoice refuse a journal the default asks for', async () => {
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setInvoiceJournalPolicy(orm as never, { invoiceId: 1, level: false })
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
  })

  it('[money] sends nothing when the invoice claimed no time at all', async () => {
    // An empty journal would tell a client their invoice is backed by no work,
    // which is a stronger claim than "this was not raised from tracked time".
    const { orm, port } = await harness()
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
  })

  it('[unit] renders a real PDF of the claimed work', async () => {
    const { orm, port, objects } = await harness()
    seedWork()
    claim(5400, 'Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    const [ref] = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const stored = objects.written.get(ref!.key)!
    const text = Array.from(stored, (b) => String.fromCharCode(b)).join('')
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text).toContain('(WORK DETAIL) Tj')
    expect(text).toContain('(1.50) Tj')
  })
})
