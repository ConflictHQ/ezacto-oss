import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  readInvoiceHoursReport,
  readInvoiceJournal,
  readJournalFormatsPreference,
  readOrganizationJournalFormats,
  recordAttachedDocument,
  resolveAttachPolicy,
  resolveJournalFormats,
  setInvoiceAttachPolicy,
  setInvoiceJournalFormats,
  setInvoiceJournalPolicy,
  setOrganizationAttachPolicy,
  setOrganizationJournalFormats,
  setOrganizationJournalPolicy,
} from '../src/invoice-documents.js'

/**
 * Issue 626. Whether to attach is a preference; what was attached is a fact.
 * Against a real migrated database, because the fact is kept by constraints.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  // `invoice_messages` requires its pending command, the way every invoice row
  // does. That rule is not what is under test here -- it is exercised where it
  // belongs -- and satisfying it would mean driving the whole lifecycle to
  // reach a foreign key target.
  for (const trigger of database
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='invoice_messages'`)
    .all() as { name: string }[]) {
    database.exec(`DROP TRIGGER ${trigger.name}`)
  }
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'draft', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (2, 1, '1316', 'USD', '2026-09-12', '2026-10-12', 'draft', '${at}', '${at}');
    INSERT INTO invoice_messages (id, invoice_id, event_type, created_at, updated_at)
      VALUES (10, 1, 'send', '${at}', '${at}');
    INSERT INTO invoice_messages (id, invoice_id, event_type, created_at, updated_at)
      VALUES (11, 1, 'send', '${at}', '${at}');
  `)
  sqlite = database
  return createContainerDatabase(database)
}

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('deciding whether the document goes with the invoice', () => {
  it('[unit] attaches nothing until somebody turns it on', async () => {
    // An instance upgrading into this feature should not start attaching
    // documents to mail it was already sending.
    const database = await fixture()
    expect(await resolveAttachPolicy(database, 1)).toEqual({
      attach: false,
      because: 'organization',
    })
  })

  it('[unit] follows the organization when the invoice has no answer', async () => {
    const database = await fixture()
    await setOrganizationAttachPolicy(database, true)
    expect(await resolveAttachPolicy(database, 1)).toEqual({
      attach: true,
      because: 'organization',
    })
  })

  it('[unit] lets one invoice differ from the default, in both directions', async () => {
    const database = await fixture()
    await setOrganizationAttachPolicy(database, true)
    await setInvoiceAttachPolicy(database, { invoiceId: 1, enabled: false })
    expect(await resolveAttachPolicy(database, 1)).toEqual({ attach: false, because: 'invoice' })
    expect(await resolveAttachPolicy(database, 2)).toEqual({
      attach: true,
      because: 'organization',
    })

    await setOrganizationAttachPolicy(database, false)
    await setInvoiceAttachPolicy(database, { invoiceId: 2, enabled: true })
    expect(await resolveAttachPolicy(database, 2)).toEqual({ attach: true, because: 'invoice' })
  })

  it('[unit] asks at send time, not when the invoice was raised', async () => {
    // The same rule the thank-you follows, so the product has one precedence
    // rather than two that drift.
    const database = await fixture()
    await setOrganizationAttachPolicy(database, true)
    expect((await resolveAttachPolicy(database, 1)).attach).toBe(true)
    await setOrganizationAttachPolicy(database, false)
    expect((await resolveAttachPolicy(database, 1)).attach).toBe(false)
  })

  it('[unit] hands an invoice back to the default when its answer is cleared', async () => {
    const database = await fixture()
    await setOrganizationAttachPolicy(database, true)
    await setInvoiceAttachPolicy(database, { invoiceId: 1, enabled: false })
    await setInvoiceAttachPolicy(database, { invoiceId: 1, enabled: null })
    expect(await resolveAttachPolicy(database, 1)).toEqual({
      attach: true,
      because: 'organization',
    })
  })

  it('[unit] says so for an invoice that does not exist', async () => {
    const database = await fixture()
    expect(await resolveAttachPolicy(database, 404)).toEqual({
      attach: false,
      because: 'unknown_invoice',
    })
    expect(await setInvoiceAttachPolicy(database, { invoiceId: 404, enabled: true })).toBe(false)
  })
})

describe('what was actually sent', () => {
  const document = (invoiceMessageId: number) => ({
    invoiceMessageId,
    invoiceId: 1,
    objectKey: invoiceDocumentKey(1, invoiceMessageId),
    filename: invoiceDocumentFilename('1315'),
    contentType: 'application/pdf',
    byteSize: 2048,
    invoiceVersion: 3,
    now: at,
  })

  it('[money] keeps the document that went with a message', async () => {
    const database = await fixture()
    await recordAttachedDocument(database, document(10))
    expect(await readAttachedDocument(database, 10)).toEqual({
      invoiceMessageId: 10,
      invoiceId: 1,
      objectKey: 'invoice-documents/1/10.pdf',
      filename: 'invoice-1315.pdf',
      contentType: 'application/pdf',
      byteSize: 2048,
      invoiceVersion: 3,
    })
  })

  it('[money] records one document per message, so a resend carries its own', async () => {
    // An invoice sent twice is two messages, each carrying what the document
    // said at the time it went.
    const database = await fixture()
    await recordAttachedDocument(database, document(10))
    await recordAttachedDocument(database, { ...document(11), invoiceVersion: 4 })
    expect((await readAttachedDocument(database, 11))?.invoiceVersion).toBe(4)
    // Direct SQL: the query builder wraps a constraint failure in its own
    // message, so asserting through it proves the wrapper rather than the rule.
    expect(() =>
      sqlite!.exec(`
        INSERT INTO invoice_message_documents
          (invoice_message_id, invoice_id, object_key, filename, content_type,
           byte_size, invoice_version, created_at)
          VALUES (10, 1, 'other.pdf', 'invoice-1315.pdf', 'application/pdf', 1, 3, '${at}')`),
    ).toThrow(/UNIQUE|PRIMARY KEY/iu)
  })

  it('[security] keeps the record of what was sent immutable', async () => {
    // A client disputing what they received is answered by this row. One that
    // can be edited afterwards answers a different question.
    const database = await fixture()
    await recordAttachedDocument(database, document(10))
    expect(() =>
      sqlite!.exec(`UPDATE invoice_message_documents SET object_key = 'elsewhere'`),
    ).toThrow(/immutable/u)
    expect(() => sqlite!.exec(`DELETE FROM invoice_message_documents`)).toThrow(/immutable/u)
  })

  it('[security] refuses a filename that would escape the folder it is saved to', async () => {
    // The name reaches the recipient's filesystem.
    await fixture()
    for (const filename of ['../etc/passwd', 'a/b.pdf', 'a\\b.pdf']) {
      expect(() =>
        sqlite!.exec(`
          INSERT INTO invoice_message_documents
            (invoice_message_id, invoice_id, object_key, filename, content_type,
             byte_size, invoice_version, created_at)
            VALUES (10, 1, 'k', '${filename}', 'application/pdf', 1, 3, '${at}')`),
      ).toThrow(/CHECK|constraint/iu)
    }
  })

  it('[unit] refuses an empty document and one that is not a PDF', async () => {
    await fixture()
    const insert = (byteSize: number, contentType: string) => () =>
      sqlite!.exec(`
        INSERT INTO invoice_message_documents
          (invoice_message_id, invoice_id, object_key, filename, content_type,
           byte_size, invoice_version, created_at)
          VALUES (10, 1, 'k', 'a.pdf', '${contentType}', ${String(byteSize)}, 3, '${at}')`)
    expect(insert(0, 'application/pdf')).toThrow(/CHECK|constraint/iu)
    expect(insert(1, 'text/html')).toThrow(/CHECK|constraint/iu)
  })

  it('[unit] answers nothing for a message that carried no document', async () => {
    const database = await fixture()
    expect(await readAttachedDocument(database, 11)).toBeNull()
  })
})

describe('naming the object and the file', () => {
  it('[unit] derives a key from the message, so one message cannot have two objects', () => {
    expect(invoiceDocumentKey(1315, 42)).toBe('invoice-documents/1315/42.pdf')
  })

  it('[security] strips anything from the invoice number that is not a filename', () => {
    // Invoice numbers are operator text and reach the recipient's filesystem.
    expect(invoiceDocumentFilename('1315')).toBe('invoice-1315.pdf')
    expect(invoiceDocumentFilename('../../etc/passwd')).toBe('invoice-..-..-etc-passwd.pdf')
    expect(invoiceDocumentFilename('2026/09 #7')).toBe('invoice-2026-09--7.pdf')
  })
})

describe('the journal a client is sent', () => {
  // The assignment chain a claimed entry needs: a project, a task, and a user
  // and task assignment on that project. Entries are written already claimed
  // by invoice 1, which is what `time_entries.invoice_id` records.
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
  const claim = (id: number, notes: string, clientVisible: 0 | 1 | null, invoiceId = 1) =>
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                task_assignment_id, spent_date, seconds, seconds_without_timer,
                                rounded_seconds, billable, notes, client_visible, invoice_id,
                                created_at, updated_at)
        VALUES (${String(id)}, 1, 1, 1, 1, 1, '2026-09-0${String(id)}', 3600, 3600, 3600, 1,
                '${notes}', ${clientVisible === null ? 'NULL' : String(clientVisible)},
                ${String(invoiceId)}, '${at}', '${at}');
    `)
  const visibleDefault = (value: 0 | 1) =>
    sqlite!.exec(`UPDATE organizations SET report_notes_client_visible_default = ${String(value)}`)

  it('[security] never carries a note its entry marks internal (D20)', async () => {
    const database = await fixture()
    seedWork()
    claim(1, 'Shared with the client', 1)
    claim(2, 'Internal: client is slow to pay', 0)
    claim(3, 'Follows the organization', null)
    const notes = (await readInvoiceJournal(database, 1)).map((entry) => entry.notes)
    // The organization default is visible, so only the entry marked internal goes.
    expect(notes).toEqual(['Shared with the client', null, 'Follows the organization'])
  })

  it('[security] withholds an unmarked note when the organization default is internal', async () => {
    const database = await fixture()
    seedWork()
    visibleDefault(0)
    claim(1, 'Marked for the client', 1)
    claim(2, 'Marked internal', 0)
    claim(3, 'Unmarked', null)
    const notes = (await readInvoiceJournal(database, 1)).map((entry) => entry.notes)
    // The entry's own answer wins over the default in both directions.
    expect(notes).toEqual(['Marked for the client', null, null])
  })

  it('[unit] keeps the entry itself when its note is withheld', async () => {
    // Hours the client was billed for are not internal; only the words are.
    const database = await fixture()
    seedWork()
    claim(1, 'Internal', 0)
    expect(await readInvoiceJournal(database, 1)).toEqual([
      {
        spentDate: '2026-09-01',
        personName: 'R. Adeyemi',
        clientName: 'Kestrel Environmental',
        projectName: 'Phase 1',
        projectCode: 'P1',
        taskName: 'Advisory',
        roles: [],
        notes: null,
        seconds: 3600,
        billable: true,
      },
    ])
  })

  it('[unit] carries the roles its person holds, name-ordered, and whether it was billable', async () => {
    // Roles are read once for everybody on the invoice.
    const database = await fixture()
    seedWork()
    sqlite!.exec(`
      INSERT INTO roles (id, name, created_at, updated_at) VALUES (1, 'QA', '${at}', '${at}'), (2, 'Engineer', '${at}', '${at}');
      INSERT INTO user_roles (user_id, role_id, created_at, updated_at) VALUES (1, 1, '${at}', '${at}'), (1, 2, '${at}', '${at}');
    `)
    claim(1, 'Shared', null)
    sqlite!.exec(`UPDATE time_entries SET billable = 0 WHERE id = 1`)
    expect(await readInvoiceJournal(database, 1)).toEqual([
      expect.objectContaining({ clientName: 'Kestrel Environmental', roles: ['Engineer', 'QA'], billable: false }),
    ])
  })

  it('[money] reads the hours report from the invoice and the work it billed', async () => {
    const database = await fixture()
    seedWork()
    claim(1, 'Shared', null)
    claim(2, 'Internal', 0)
    claim(3, 'Another invoice', null, 2)
    expect(await readInvoiceHoursReport(database, 1)).toEqual({
      invoiceNumber: '1315',
      clientName: 'Kestrel Environmental',
      companyName: 'Fixture',
      // No journal asked for: the report still reads, at no level.
      level: null,
      entries: [
        expect.objectContaining({ spentDate: '2026-09-01', notes: 'Shared' }),
        expect.objectContaining({ spentDate: '2026-09-02', notes: null }),
      ],
    })
    await setOrganizationJournalPolicy(database, 'summary')
    expect((await readInvoiceHoursReport(database, 1))?.level).toBe('summary')
    await setInvoiceJournalPolicy(database, { invoiceId: 1, level: 'detailed' })
    expect((await readInvoiceHoursReport(database, 1))?.level).toBe('detailed')
    expect(await readInvoiceHoursReport(database, 404)).toBeNull()
  })
})

describe('the files the journal goes as', () => {
  it('[money] is the PDF until somebody chooses otherwise', async () => {
    // Every instance upgrading into this keeps sending exactly what it sent.
    const database = await fixture()
    expect(await readOrganizationJournalFormats(database)).toEqual(['pdf'])
    expect(await resolveJournalFormats(database, 1)).toEqual(['pdf'])
    expect(await readJournalFormatsPreference(database, 1)).toEqual({
      invoice: null,
      organization: ['pdf'],
    })
  })

  it('[money] follows the organization, lets one invoice differ, and hands it back on null', async () => {
    const database = await fixture()
    await setOrganizationJournalFormats(database, ['csv', 'pdf'])
    expect(await resolveJournalFormats(database, 1)).toEqual(['pdf', 'csv'])
    expect(await setInvoiceJournalFormats(database, { invoiceId: 1, formats: ['xlsx'] })).toBe(true)
    expect(await readJournalFormatsPreference(database, 1)).toEqual({
      invoice: ['xlsx'],
      organization: ['pdf', 'csv'],
    })
    expect(await resolveJournalFormats(database, 2)).toEqual(['pdf', 'csv'])
    await setInvoiceJournalFormats(database, { invoiceId: 1, formats: null })
    expect(await resolveJournalFormats(database, 1)).toEqual(['pdf', 'csv'])
  })

  it('[money] keeps the level and the files as separate answers', async () => {
    // Setting the files must not disturb the level, and the reverse.
    const database = await fixture()
    await setOrganizationJournalPolicy(database, 'summary')
    await setOrganizationJournalFormats(database, ['xlsx'])
    await setInvoiceJournalPolicy(database, { invoiceId: 1, level: 'detailed' })
    await setInvoiceJournalFormats(database, { invoiceId: 1, formats: ['csv'] })
    expect(
      sqlite!.prepare(`SELECT invoice_extras AS extras FROM invoices WHERE id = 1`).get(),
    ).toEqual({ extras: JSON.stringify({ journal: 'detailed', journal_formats: ['csv'] }) })
    expect(
      JSON.parse(
        (sqlite!.prepare(`SELECT invoice_extras AS extras FROM organizations`).get() as { extras: string })
          .extras,
      ),
    ).toEqual({ journal: 'summary', journal_formats: ['xlsx'] })
  })

  it('[security] refuses a set that is empty, repeats a format or names an unknown one', async () => {
    const database = await fixture()
    for (const formats of [[], ['pdf', 'pdf'], ['docx']] as never[]) {
      await expect(setOrganizationJournalFormats(database, formats)).rejects.toThrow(RangeError)
      await expect(setInvoiceJournalFormats(database, { invoiceId: 1, formats })).rejects.toThrow(
        RangeError,
      )
    }
    expect(await resolveJournalFormats(database, 1)).toEqual(['pdf'])
  })

  it('[unit] answers nothing for an invoice that does not exist', async () => {
    const database = await fixture()
    expect(await resolveJournalFormats(database, 404)).toBeNull()
    expect(await setInvoiceJournalFormats(database, { invoiceId: 404, formats: ['csv'] })).toBe(false)
  })
})
