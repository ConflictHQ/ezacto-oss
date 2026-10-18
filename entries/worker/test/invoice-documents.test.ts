import BetterSqlite3 from 'better-sqlite3'
import { crc32, deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '@ezacto/db'
import { migrateContainer } from '@ezacto/db'
import { PDFDocument, PageSizes, StandardFonts } from 'pdf-lib'
import { renderInvoiceDocument } from '@ezacto/core'
import {
  setOrganizationAppendPolicy,
  setOrganizationAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationFilesPolicy,
  setInvoiceFilesPolicy,
  setOrganizationJournalPolicy,
  setInvoiceJournalPolicy,
  setOrganizationJournalFormats,
  setInvoiceJournalFormats,
} from '@ezacto/db'
import type { InvoiceDocumentContext } from '@ezacto/db/d1'
import { createAttachmentResolver, createInvoiceDocumentPort } from '../src/invoice-documents.js'

/**
 * Issue 626, the entry's half. `@ezacto/api` asks for a reference and knows
 * nothing about PDFs or buckets; `@ezacto/core` renders and knows nothing about
 * invoices in a database. This is what joins them, so it is tested against a
 * real migrated database and a real render.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const context: InvoiceDocumentContext = {
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
  organizationName: 'Halcyon Studio',
  clientName: 'Kestrel Environmental',
  lineItems: [
    {
      kind: 'Service',
      description: 'Advisory',
      quantity: 1,
      unitPriceCents: 319_495,
      amountCents: 319_495,
      endClientId: null,
      endClientName: null,
    },
  ],
  purchaseOrder: null,
  notes: null,
  paymentTerms: 'net_30',
  discountRatePpm: null,
  taxRatePpm: null,
  tax2RatePpm: null,
  dueAmountCents: 319_495,
  periodStart: null,
  periodEnd: null,
  organizationTimeZone: 'UTC',
  paidAmountCents: 0,
  organizationAddress: null,
  clientAddress: null,
  logo: null,
}

const objectStore = () => {
  const written = new Map<string, Uint8Array>()
  const types = new Map<string, string>()
  return {
    written,
    types,
    put: vi.fn(async (key: string, bytes: ArrayBuffer, contentType: string) => {
      written.set(key, new Uint8Array(bytes))
      types.set(key, contentType)
    }),
    get: vi.fn(async (key: string) => {
      const bytes = written.get(key)
      return bytes === undefined ? null : { body: bytes as unknown as BodyInit }
    }),
  }
}

const harness = async (
  overrides: {
    paymentUrl?: () => Promise<string | null>
    documentContext?: () => Promise<InvoiceDocumentContext>
  } = {},
) => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  for (const trigger of database
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='invoice_messages'`)
    .all() as { name: string }[]) {
    database.exec(`DROP TRIGGER ${trigger.name}`)
  }
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Halcyon Studio', '{}', '${at}', '${at}');
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
      documentContext: overrides.documentContext ?? (async () => context),
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

/**
 * The document goes: the organization says so, and the message was composed
 * saying so. The body is written when the send is accepted and the document
 * prepared when the email is queued, so the port follows the message's own
 * record of the decision rather than asking the preference a second time.
 */
const documentGoes = async (orm: ReturnType<typeof createContainerDatabase>): Promise<void> => {
  await setOrganizationAttachPolicy(orm as never, true)
  sqlite!.exec(`UPDATE invoice_messages SET attach_pdf = 1 WHERE id = 100`)
}

describe('preparing the document an invoice carries', () => {
  it('[unit] attaches nothing while the preference is off, and writes no object', async () => {
    const { port, objects } = await harness()
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
    expect(objects.put).not.toHaveBeenCalled()
  })

  it('[money] renders, stores and records once the preference says so', async () => {
    const { orm, port, objects } = await harness()
    await documentGoes(orm)
    const reference = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })

    expect(reference).toEqual([
      {
        key: 'invoice-documents/1/100.pdf',
        filename: 'INVOICE_1315_HALCYON_STUDIO.pdf',
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
        filename: 'INVOICE_1315_HALCYON_STUDIO.pdf',
        byte_size: stored.byteLength,
        invoice_version: 7,
      },
    ])
  })

  it('[money] returns what already went rather than rendering a second one', async () => {
    // A retried outbox delivery must attach the file that went the first time.
    // The record is keyed on the message precisely so this has an answer.
    const { orm, port, objects } = await harness()
    await documentGoes(orm)
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
    // What the send is told, so its body promises no document...
    expect(await port.attachesPdf(1)).toBe(false)
    // ...and what the delivery then carries.
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
    expect(objects.put).not.toHaveBeenCalled()
  })

  it('[money] carries the document only where the message said it would', async () => {
    // The body was written promising no PDF; a preference turned on between
    // the send and the queue must not attach one the text never mentions.
    const { orm, port, objects } = await harness()
    await setOrganizationAttachPolicy(orm as never, true)
    expect(await port.attachesPdf(1)).toBe(true)
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
    await documentGoes(orm)
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toHaveLength(1)
    expect(objects.put).toHaveBeenCalledTimes(1)
  })

  it('[unit] prints the link on the document when there is one', async () => {
    const { orm, port, objects } = await harness({
      paymentUrl: async () => 'https://buy.stripe.com/test_abc',
    })
    await documentGoes(orm)
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
    await documentGoes(orm)
    const withDocument = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(withDocument).toHaveLength(1)
  })

  it('[unit] carries them once enabled, after the invoice itself', async () => {
    // A client opening the attachments in order should meet the invoice before
    // what supports it.
    const { orm, port } = await harness()
    stage('purchase-order.pdf', 'files/po-1')
    stage('order-form.pdf', 'files/of-1')
    await documentGoes(orm)
    await setOrganizationFilesPolicy(orm as never, true)

    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual([
      'INVOICE_1315_HALCYON_STUDIO.pdf',
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

  const claim = (
    seconds: number,
    notes: string,
    spentDate = '2026-09-01',
    clientVisible: 0 | 1 | null = null,
  ) => {
    entryId += 1
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                task_assignment_id, spent_date, seconds, seconds_without_timer,
                                rounded_seconds, billable, notes, client_visible, invoice_id,
                                created_at, updated_at)
        VALUES (${String(entryId)}, 1, 1, 1, 1, 1, '${spentDate}', ${String(seconds)},
                ${String(seconds)}, ${String(seconds)}, 1, '${notes}',
                ${clientVisible === null ? 'NULL' : String(clientVisible)}, 1, '${at}', '${at}');
    `)
  }

  it('[unit] sends no journal until somebody asks for one', async () => {
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await documentGoes(orm)
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual(['INVOICE_1315_HALCYON_STUDIO.pdf'])
  })

  it('[money] attaches it after the invoice and names the level', async () => {
    // A client opening the attachments in order meets the invoice, then the
    // work behind it.
    const { orm, port } = await harness()
    seedWork()
    claim(3600, 'Reviewed the forecast model')
    await documentGoes(orm)
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual([
      'INVOICE_1315_HALCYON_STUDIO.pdf',
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
    expect(text).toContain('(Detailed time report) Tj')
    expect(text).toContain('(1.50) Tj')
  })
})

describe('the files the work goes as', () => {
  // The same chain as the journal tests above.
  let entryId = 100
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
  const claim = (notes: string, clientVisible: 0 | 1 | null = null) => {
    entryId += 1
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                task_assignment_id, spent_date, seconds, seconds_without_timer,
                                rounded_seconds, billable, notes, client_visible, invoice_id,
                                created_at, updated_at)
        VALUES (${String(entryId)}, 1, 1, 1, 1, 1, '2026-09-01', 5400, 5400, 5400, 1, '${notes}',
                ${clientVisible === null ? 'NULL' : String(clientVisible)}, 1, '${at}', '${at}');
    `)
  }
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

  it('[money] attaches one file per format, in order, each typed for what it is', async () => {
    const { orm, port, objects } = await harness()
    seedWork()
    claim('Reviewed the forecast model')
    await documentGoes(orm)
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setOrganizationJournalFormats(orm as never, ['xlsx', 'csv', 'pdf'])
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs).toEqual([
      { key: 'invoice-documents/1/100.pdf', filename: 'INVOICE_1315_HALCYON_STUDIO.pdf', contentType: 'application/pdf' },
      {
        key: 'invoice-documents/1/100-journal.pdf',
        filename: 'work-detailed-1315.pdf',
        contentType: 'application/pdf',
      },
      {
        key: 'invoice-documents/1/100-journal.csv',
        filename: 'work-detailed-1315.csv',
        contentType: 'text/csv; charset=utf-8',
      },
      {
        key: 'invoice-documents/1/100-journal.xlsx',
        filename: 'work-detailed-1315.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ])
    // Stored as what they are, so the queue consumer attaches real files.
    for (const ref of refs) expect(objects.types.get(ref.key)).toBe(ref.contentType)
    expect(text(objects.written.get('invoice-documents/1/100-journal.csv')!)).toContain(
      'Reviewed the forecast model,1.50',
    )
    expect(Array.from(objects.written.get('invoice-documents/1/100-journal.xlsx')!.slice(0, 4))).toEqual([
      0x50, 0x4b, 0x03, 0x04,
    ])
  })

  it('[money] sends exactly the PDF it always sent when nobody chose a format', async () => {
    const { orm, port, objects } = await harness()
    seedWork()
    claim('Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'summary')
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([
      {
        key: 'invoice-documents/1/100-journal.pdf',
        filename: 'work-summary-1315.pdf',
        contentType: 'application/pdf',
      },
    ])
    expect(objects.put).toHaveBeenCalledTimes(1)
  })

  it("[money] lets one invoice send a spreadsheet while the default sends the PDF", async () => {
    const { orm, port } = await harness()
    seedWork()
    claim('Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setInvoiceJournalFormats(orm as never, { invoiceId: 1, formats: ['csv'] })
    expect((await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).map((ref) => ref.filename)).toEqual([
      'work-detailed-1315.csv',
    ])
  })

  it('[money] renders none of the files when the invoice claimed no time', async () => {
    const { orm, port, objects } = await harness()
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setOrganizationJournalFormats(orm as never, ['pdf', 'csv', 'xlsx'])
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual([])
    expect(objects.put).not.toHaveBeenCalled()
  })

  it('[security] sends no internal note in any file (D20)', async () => {
    const { orm, port, objects } = await harness()
    seedWork()
    claim('Shared with the client', 1)
    claim('Internal: discount fight', 0)
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setOrganizationJournalFormats(orm as never, ['pdf', 'csv', 'xlsx'])
    await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const csv = text(objects.written.get('invoice-documents/1/100-journal.csv')!)
    expect(csv).toContain('Shared with the client')
    expect(csv).not.toContain('discount fight')
    // The PDF sets text as Latin-1 literals and the workbook stores it as
    // UTF-8 XML; neither carries the note.
    for (const key of ['invoice-documents/1/100-journal.pdf', 'invoice-documents/1/100-journal.xlsx']) {
      const raw = Array.from(objects.written.get(key)!, (byte) => String.fromCharCode(byte)).join('')
      expect(raw).not.toContain('discount fight')
    }
    // The hours are still billed and still shown.
    expect(csv.split('\r\n').filter((row) => row.endsWith(',1.50'))).toHaveLength(2)
  })

  it('[money] renders the same files to the same keys on a retried delivery', async () => {
    // Rendered rather than recorded, so a retry must reproduce what the first
    // attempt wrote, byte for byte, under the same names.
    const { orm, port, objects } = await harness()
    seedWork()
    claim('Reviewed the forecast model')
    await setOrganizationJournalPolicy(orm as never, 'detailed')
    await setOrganizationJournalFormats(orm as never, ['pdf', 'csv', 'xlsx'])
    const first = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const bytes = new Map([...objects.written].map(([key, value]) => [key, Array.from(value)]))
    const second = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(second).toEqual(first)
    for (const [key, value] of bytes) expect(Array.from(objects.written.get(key)!)).toEqual(value)
  })
})

describe('the files bound into the back of the invoice', () => {
  // A client's accounts payable wants one PDF: the invoice first, then the
  // purchase order behind it. These put real files in the store, because the
  // binding reads them.
  let nextId = 900
  const put = async (
    objects: ReturnType<typeof objectStore>,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<number> => {
    const id = (nextId += 1)
    const key = `files/${String(id)}`
    await objects.put(key, bytes.slice().buffer as ArrayBuffer, contentType)
    sqlite!.exec(`
      BEGIN;
      INSERT INTO file_objects (content_hash, file_key, byte_size, content_type, created_at, updated_at)
        VALUES ('${String(id).padStart(64, '0')}', '${key}', ${String(bytes.byteLength)}, '${contentType}', '${at}', '${at}');
      INSERT INTO attachments (id, file_object_id, name, invoice_attachment_link_id, created_at, updated_at)
        VALUES (${String(id)}, (SELECT id FROM file_objects WHERE file_key = '${key}'), '${name}', ${String(id)}, '${at}', '${at}');
      INSERT INTO invoice_attachments (attachment_id, invoice_id) VALUES (${String(id)}, 1);
      COMMIT;
    `)
    objects.put.mockClear()
    return id
  }
  const letter = async (text: string, pages = 1): Promise<Uint8Array> => {
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (let page = 0; page < pages; page += 1) {
      document.addPage(PageSizes.A4).drawText(`${text}, page ${String(page + 1)}`, { font, size: 12, x: 72, y: 760 })
    }
    return document.save()
  }
  const pageCount = async (bytes: Uint8Array): Promise<number> =>
    (await PDFDocument.load(bytes)).getPageCount()
  const invoicePages = renderInvoiceDocument({
    number: context.number,
    companyName: context.organizationName,
    clientName: context.clientName,
    issueDate: context.issueDate,
    dueDate: context.dueDate,
    currency: context.currency,
    subject: context.subject,
    lines: context.lineItems,
    subtotalCents: context.amountCents,
    discountCents: 0,
    taxCents: 0,
    totalCents: context.amountCents,
  })

  it('[money] binds the purchase order behind the invoice and does not send it twice', async () => {
    const { orm, port, objects } = await harness()
    await documentGoes(orm)
    await setOrganizationAppendPolicy(orm as never, true)
    await setOrganizationFilesPolicy(orm as never, true)
    const po = await put(objects, 'PO-778812 letter.pdf', await letter('Purchase order PO-778812', 2), 'application/pdf')
    await put(objects, 'Timesheet.csv', new TextEncoder().encode('date,hours\n'), 'text/csv')

    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    // The invoice -- with the letter inside it -- then the file that is not a PDF.
    expect(refs.map((r) => r.filename)).toEqual(['INVOICE_1315_HALCYON_STUDIO.pdf', 'Timesheet.csv'])
    const stored = objects.written.get('invoice-documents/1/100.pdf')!
    expect(await pageCount(stored)).toBe((await pageCount(invoicePages)) + 2)
    expect(
      sqlite!.prepare(`SELECT appended_attachment_ids AS ids FROM invoice_message_documents`).get(),
    ).toEqual({ ids: JSON.stringify([po]) })

    // A retried delivery carries the identical document, and still not the
    // letter beside it.
    objects.put.mockClear()
    expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toEqual(refs)
    expect(objects.put).not.toHaveBeenCalledWith('invoice-documents/1/100.pdf', expect.anything(), expect.anything())
  })

  it('[money] sends a file that will not bind beside the invoice, even where other files stay home', async () => {
    const { orm, port, objects } = await harness()
    await documentGoes(orm)
    await setOrganizationAppendPolicy(orm as never, true)
    // Files are not sent on their own here; the rule asked for this one to go
    // behind the invoice, so when it cannot, it goes beside it instead.
    await put(objects, 'Damaged.pdf', new TextEncoder().encode('%PDF-1.7 not really'), 'application/pdf')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refs = await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    expect(refs.map((r) => r.filename)).toEqual(['INVOICE_1315_HALCYON_STUDIO.pdf', 'Damaged.pdf'])
    expect(await pageCount(objects.written.get('invoice-documents/1/100.pdf')!)).toBe(
      await pageCount(invoicePages),
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Damaged.pdf could not be bound'))
    warn.mockRestore()
  })

  it('[money] previews the document a send would carry, stamped, and keeps nothing', async () => {
    const { orm, port, objects } = await harness()
    await setOrganizationAttachPolicy(orm as never, true)
    await put(objects, 'PO-778812 letter.pdf', await letter('Purchase order PO-778812'), 'application/pdf')

    // The dialog's choice -- bind it in -- laid over an organization that
    // would not, without saving anything.
    expect(await port.preview({ invoiceId: 1, choices: { append: true } })).toEqual([
      expect.objectContaining({
        kind: 'invoice',
        filename: 'INVOICE_1315_HALCYON_STUDIO.pdf',
        appended: ['PO-778812 letter.pdf'],
      }),
    ])
    const previewed = await port.previewDocument({ invoiceId: 1, choices: { append: true } })
    expect(previewed!.filename).toBe('INVOICE_1315_HALCYON_STUDIO.pdf')
    expect(await pageCount(previewed!.bytes)).toBe((await pageCount(invoicePages)) + 1)
    const text = Array.from(previewed!.bytes, (byte) => String.fromCharCode(byte)).join('')
    expect(text).toContain('(PREVIEW) Tj')
    expect(objects.put).not.toHaveBeenCalled()
    expect(sqlite!.prepare(`SELECT count(*) AS n FROM invoice_message_documents`).get()).toEqual({ n: 0 })

    // The email preview stores its stamped document under keys of its own.
    const staged = await port.stagePreview({ invoiceId: 1, previewId: 'p1', choices: { append: true } })
    expect(staged).toEqual([
      { key: 'invoice-previews/1/p1.pdf', filename: 'INVOICE_1315_HALCYON_STUDIO.pdf', contentType: 'application/pdf' },
    ])
    expect(sqlite!.prepare(`SELECT count(*) AS n FROM invoice_message_documents`).get()).toEqual({ n: 0 })

    // And the real send carries no stamp.
    sqlite!.exec(`UPDATE invoice_messages SET attach_pdf = 1 WHERE id = 100`)
    await setOrganizationAppendPolicy(orm as never, true)
    await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const sent = Array.from(objects.written.get('invoice-documents/1/100.pdf')!, (byte) =>
      String.fromCharCode(byte),
    ).join('')
    expect(sent).not.toContain('PREVIEW')
  })
})

describe('the document laid out as Harvest\'s', () => {
  /** A 1x1 RGB PNG, built here: the real wordmark is the operator's to upload. */
  const tinyPng = (): Uint8Array => {
    const chunk = (type: string, data: number[]) => {
      const body = [...[...type].map((c) => c.charCodeAt(0)), ...data]
      const crc = crc32(Uint8Array.from(body))
      return [0, 0, 0, data.length, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]
    }
    return Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
      ...chunk('IDAT', [...deflateSync(Uint8Array.from([0, 37, 79, 232]))]),
      ...chunk('IEND', []),
    ])
  }
  const pdfText = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('')

  it('[unit] draws the uploaded light wordmark where the logo goes', async () => {
    const key = 'brand/sha256/ab/' + 'a'.repeat(64)
    const { orm, port, objects } = await harness({
      documentContext: async () => ({ ...context, logo: { fileKey: key, contentType: 'image/png' } }),
    })
    await objects.put(key, tinyPng().buffer as ArrayBuffer, 'image/png')
    await documentGoes(orm)
    await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const rendered = pdfText(objects.written.get('invoice-documents/1/100.pdf')!)
    expect(rendered).toContain('/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB')
    // The name stays in the From block; it is not also set where the logo went.
    expect(rendered).not.toContain('39 738.5 Td\n(Halcyon Studio) Tj')
  })

  it('[unit] sets the company name instead when the mark cannot be fetched or decoded', async () => {
    // A logo is never why an invoice does not go.
    for (const stored of [null, Uint8Array.from([1, 2, 3])]) {
      const key = 'brand/sha256/cd/' + 'c'.repeat(64)
      const { orm, port, objects } = await harness({
        documentContext: async () => ({ ...context, logo: { fileKey: key, contentType: 'image/png' } }),
      })
      if (stored !== null) await objects.put(key, stored.buffer as ArrayBuffer, 'image/png')
      await documentGoes(orm)
      expect(await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })).toHaveLength(1)
      const rendered = pdfText(objects.written.get('invoice-documents/1/100.pdf')!)
      expect(rendered).not.toContain('/Subtype /Image')
      expect(rendered).toContain('39 738.5 Td\n(Halcyon Studio) Tj')
      sqlite?.close()
      sqlite = null
    }
  })

  it('[money] prints the purchase order, terms, adjustments, payments and notes it is given', async () => {
    const { orm, port, objects } = await harness({
      documentContext: async () => ({
        ...context,
        purchaseOrder: '4500000001',
        paymentTerms: 'net_45',
        discountAmountCents: 40_000,
        discountRatePpm: 200_000,
        amountCents: 160_000,
        dueAmountCents: 0,
        paidAmountCents: 160_000,
        organizationAddress: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
        clientAddress: '13031 W. Jefferson Blvd.\nLA, CA 90094',
        notes: 'Beneficiary:\n*Halcyon Studio LLC*',
      }),
    })
    await documentGoes(orm)
    await port.prepare({ invoiceId: 1, invoiceMessageId: 100 })
    const rendered = pdfText(objects.written.get('invoice-documents/1/100.pdf')!)
    for (const shown of [
      '(PO Number) Tj',
      '(4500000001) Tj',
      '(2026-10-12 \\(Net 45\\)) Tj',
      '(Discount \\(20%\\)) Tj',
      '(-$400.00 USD) Tj',
      '(Payments) Tj',
      '(-$1,600.00 USD) Tj',
      '(Amount Due) Tj',
      '($0.00 USD) Tj',
      '(Springfield, IL, 62701) Tj',
      '(LA, CA 90094) Tj',
      '(Notes) Tj',
    ]) {
      expect(rendered).toContain(shown)
    }
  })
})
