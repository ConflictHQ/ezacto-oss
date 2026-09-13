import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer, migrateContainerThrough } from '../src/migrate.js'
import { invoiceExtrasSetMigration } from '../src/migrations/0058_invoice_extras_set.js'
import {
  parseInvoiceExtras,
  readInvoiceExtras,
  resolveInvoiceExtra,
  setInvoiceExtra,
  setOrganizationInvoiceExtra,
} from '../src/invoice-extras.js'
import {
  readAttachPreference,
  resolveAttachPolicy,
  setInvoiceAttachPolicy,
  setOrganizationAttachPolicy,
} from '../src/invoice-documents.js'
import { resolveThankYouPolicy } from '../src/automatic-thank-you.js'

/**
 * Issue 647. Three booleans, each a nullable column on `invoices` paired with a
 * NOT NULL default on `organizations`, folded into one set.
 *
 * The part worth testing hardest is the translation: these columns are live and
 * one of them sends email, so an answer lost in the move is a client who stops
 * getting their invoice as a PDF, or starts getting one they never asked for.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

/**
 * Runs the ledger up to 0057, seeds the old columns, then applies 0058 alone --
 * so what is asserted is the migration's own translation rather than a fixture
 * written in the new shape.
 */
const upgradeFrom = async (
  organization: { pdf: number; files: number; thankYou: number },
  invoice: { pdf: number | null; files: number | null; thankYou: number | null },
) => {
  const database = new BetterSqlite3(':memory:')
  migrateContainerThrough(database, '0057_recurring_definition_repair')
  database.exec(`
    INSERT INTO organizations
      (name, modules, attach_invoice_pdf, attach_invoice_files, auto_thank_you, created_at, updated_at)
      VALUES ('CONFLICT', '{}', ${organization.pdf}, ${organization.files},
              ${organization.thankYou}, '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          attach_invoice_pdf, attach_invoice_files, auto_thank_you,
                          created_at, updated_at)
      VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'draft',
              ${invoice.pdf ?? 'NULL'}, ${invoice.files ?? 'NULL'},
              ${invoice.thankYou ?? 'NULL'}, '${at}', '${at}');
  `)
  for (const statement of invoiceExtrasSetMigration) database.exec(statement)
  sqlite = database
  return createContainerDatabase(database)
}

describe('carrying the old answers across', () => {
  it('[money] keeps every organization answer, true and false alike', async () => {
    const database = await upgradeFrom(
      { pdf: 1, files: 0, thankYou: 1 },
      { pdf: null, files: null, thankYou: null },
    )
    const both = await readInvoiceExtras(database, 1)
    expect(both!.organization).toEqual({ document: true, files: false, thank_you: true })
  })

  it('[money] keeps an invoice that said no, distinct from one that said nothing', async () => {
    // The whole point of the per-invoice half. Collapsing "no" into "not set"
    // would hand the invoice back to an organization default that says yes.
    const database = await upgradeFrom(
      { pdf: 1, files: 1, thankYou: 1 },
      { pdf: 0, files: null, thankYou: null },
    )
    const both = await readInvoiceExtras(database, 1)
    expect(both!.invoice).toEqual({ document: false })
    expect(resolveInvoiceExtra(both!.organization, both!.invoice, 'document')).toEqual({
      invoice: false,
      organization: true,
      effective: false,
    })
    // The two it never answered still follow the organization.
    expect(resolveInvoiceExtra(both!.organization, both!.invoice, 'files').effective).toBe(true)
  })

  it('[money] leaves an invoice that answered nothing with nothing', async () => {
    const database = await upgradeFrom(
      { pdf: 0, files: 0, thankYou: 0 },
      { pdf: null, files: null, thankYou: null },
    )
    expect((await readInvoiceExtras(database, 1))!.invoice).toEqual({})
    expect(
      sqlite!.prepare(`SELECT invoice_extras AS extras FROM invoices WHERE id = 1`).get(),
    ).toEqual({ extras: null })
  })

  it('[security] the old columns are gone, not merely unread', async () => {
    // Two places to read what a client receives is worse than the longhand this
    // replaces.
    const database = await upgradeFrom(
      { pdf: 1, files: 1, thankYou: 1 },
      { pdf: 1, files: 1, thankYou: 1 },
    )
    expect(await readInvoiceExtras(database, 1)).not.toBeNull()
    for (const table of ['organizations', 'invoices']) {
      const columns = (
        sqlite!.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name)
      expect(columns).not.toContain('attach_invoice_pdf')
      expect(columns).not.toContain('attach_invoice_files')
      expect(columns).not.toContain('auto_thank_you')
      expect(columns).toContain('invoice_extras')
    }
  })
})

describe('the surfaces that were three triples', () => {
  const fresh = async () => {
    const database = new BetterSqlite3(':memory:')
    await migrateContainer(database)
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('CONFLICT', '{}', '${at}', '${at}');
      INSERT INTO clients (id, name, currency, created_at, updated_at)
        VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
      INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                            created_at, updated_at)
        VALUES (1, 1, '1315', 'USD', '2026-09-12', '2026-10-12', 'draft', '${at}', '${at}');
    `)
    sqlite = database
    return createContainerDatabase(database)
  }

  it('[money] everything is off until somebody turns it on', async () => {
    // A deployment upgrading into any of these must not begin sending because
    // it was deployed.
    const database = await fresh()
    expect(await resolveAttachPolicy(database, 1)).toEqual({
      attach: false,
      because: 'organization',
    })
    expect(await resolveThankYouPolicy(database, 1)).toEqual({
      send: false,
      because: 'organization',
    })
  })

  it('[money] still answers through the names the routes already use', async () => {
    const database = await fresh()
    await setOrganizationAttachPolicy(database, true)
    expect(await readAttachPreference(database, 1)).toEqual({
      invoice: null,
      organization: true,
    })
    expect(await setInvoiceAttachPolicy(database, { invoiceId: 1, enabled: false })).toBe(true)
    expect(await resolveAttachPolicy(database, 1)).toEqual({ attach: false, because: 'invoice' })
    // Null hands it back, and the organization answers again.
    await setInvoiceAttachPolicy(database, { invoiceId: 1, enabled: null })
    expect(await resolveAttachPolicy(database, 1)).toEqual({
      attach: true,
      because: 'organization',
    })
  })

  it('[money] one kind does not disturb another', async () => {
    // The failure a shared column invites. Setting the thank-you must not clear
    // what was decided about the document.
    const database = await fresh()
    await setInvoiceExtra(database, 1, 'document', true)
    await setInvoiceExtra(database, 1, 'thank_you', false)
    expect((await readInvoiceExtras(database, 1))!.invoice).toEqual({
      document: true,
      thank_you: false,
    })
    await setOrganizationInvoiceExtra(database, 'files', true)
    await setOrganizationInvoiceExtra(database, 'document', true)
    expect((await readInvoiceExtras(database, 1))!.organization).toEqual({
      files: true,
      document: true,
    })
  })

  it('[money] carries a value that is not a boolean, which is why it is a set', async () => {
    // The journal renders detailed or summary. A preference that could only say
    // yes would have forced a second column beside it the day it landed.
    const database = await fresh()
    await setOrganizationInvoiceExtra(database, 'journal', 'summary')
    await setInvoiceExtra(database, 1, 'journal', 'detailed')
    const both = await readInvoiceExtras(database, 1)
    expect(resolveInvoiceExtra(both!.organization, both!.invoice, 'journal')).toEqual({
      invoice: 'detailed',
      organization: 'summary',
      effective: 'detailed',
    })
  })

  it('[security] refuses a kind nobody defined', async () => {
    // A typo becomes a refusal rather than a preference that silently never
    // applies.
    await fresh()
    expect(() =>
      sqlite!.exec(`UPDATE invoices SET invoice_extras = '{"attach_the_cat":true}' WHERE id = 1`),
    ).toThrow(/unknown invoice extra/u)
    expect(() =>
      sqlite!.exec(`UPDATE organizations SET invoice_extras = '{"whatever":true}'`),
    ).toThrow(/unknown invoice extra/u)
  })

  it('[unit] ignores a stored value it cannot interpret', async () => {
    // A row written by a later deployment may carry something this one has
    // never heard of. Acting on a preference you cannot read is worse than
    // ignoring it.
    expect(parseInvoiceExtras('{"document":"perhaps","files":true}')).toEqual({ files: true })
    expect(parseInvoiceExtras('not json')).toEqual({})
    expect(parseInvoiceExtras('[1,2]')).toEqual({})
    expect(parseInvoiceExtras(null)).toEqual({})
  })
})
