import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import {
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  recordAttachedDocument,
  resolveAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationAttachPolicy,
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
