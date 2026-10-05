import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { readInvoiceDefaults, updateInvoiceDefaults } from '../src/invoice-defaults.js'
import { migrateContainer } from '../src/migrate.js'

let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  sqlite = database
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('CONFLICT LLC', '{}', '2026-10-05T10:00:00.000Z', '2026-10-05T10:00:00.000Z');
  `)
  return { database, orm: createContainerDatabase(database) }
}

describe('invoice defaults', () => {
  it('[money] starts empty, saves company information and default values, and reads them back', async () => {
    const { orm } = await fixture()
    expect(await readInvoiceDefaults(orm)).toEqual({
      companyName: 'CONFLICT LLC',
      companyAddress: null,
      notes: null,
      subject: null,
    })
    const notes = 'Beneficiary:\n*CONFLICT LLC*\n100 Example Ave STE 200\nSpringfield, IL 62701\n\n*Account details*'
    const saved = await updateInvoiceDefaults(
      orm,
      {
        companyAddress: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
        notes,
        subject: 'Conflict <> CLIENT Invoice: MONTH YEAR',
      },
      '2026-10-05T11:00:00.000Z',
    )
    expect(saved).toEqual({
      companyName: 'CONFLICT LLC',
      companyAddress: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
      notes,
      subject: 'Conflict <> CLIENT Invoice: MONTH YEAR',
    })
    // Line breaks and the *bold* markup are the author's and survive verbatim.
    expect((await readInvoiceDefaults(orm)).notes).toBe(notes)
  })

  it('[unit] stores blank as no default and leaves fields it was not given alone', async () => {
    const { orm } = await fixture()
    await updateInvoiceDefaults(orm, { notes: 'Pay by wire.', subject: 'Monthly services' }, 't1')
    const cleared = await updateInvoiceDefaults(orm, { notes: '   ' }, 't2')
    expect(cleared.notes).toBeNull()
    expect(cleared.subject).toBe('Monthly services')
    expect((await updateInvoiceDefaults(orm, { companyName: '  CONFLICT, LLC ' }, 't3')).companyName)
      .toBe('CONFLICT, LLC')
  })

  it('[unit] refuses blank text in storage, so none has one spelling', async () => {
    const { database } = await fixture()
    expect(() =>
      database.exec(`UPDATE organizations SET invoice_default_notes = '  '`),
    ).toThrow(/CHECK/u)
  })
})
