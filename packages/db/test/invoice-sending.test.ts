import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  readAppendPreference,
  readAttachPreference,
  readJournalFormatsPreference,
  readJournalPreference,
  resolveAppendPolicy,
  resolveAttachPolicy,
  resolveFilesPolicy,
  resolveJournalFormats,
  resolveJournalPolicy,
  setInvoiceAppendPolicy,
  setOrganizationAppendPolicy,
  setOrganizationAttachPolicy,
} from '../src/invoice-documents.js'
import { readClientInvoiceExtras, setClientInvoiceExtras } from '../src/invoice-extras.js'
import {
  effectiveClientRecipients,
  readClientInvoiceRecipients,
  readInvoiceEmailDefaults,
  readInvoiceSenderCopy,
  readOrganizationAlwaysCc,
  setClientInvoiceRecipients,
  setInvoiceSenderCopy,
  setOrganizationAlwaysCc,
} from '../src/invoice-sending.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

interface Harness {
  orm: InvoiceStateDatabase
  run(sql: string, ...bindings: unknown[]): Promise<void>
  close(): Promise<void>
}

const at = '2026-10-01T09:00:00.000Z'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...bindings) => void sqlite.prepare(sql).run(...bindings),
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
    close: async () => miniflare.dispose(),
  }
}

const seed = async (database: Harness): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Example Studio LLC', '{"invoices":true}', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Ana', 'Example', 'administrator', '[]', ?, ?)`,
    at,
    at,
  )
  await database.run(
    `INSERT INTO user_emails (user_id, address, is_primary, verified_at, created_at, updated_at)
     VALUES (1, 'ana@example.com', 1, ?, ?, ?)`,
    at,
    at,
    at,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Northwind Example Co', 'USD', ?, ?), (2, 'Other Example', 'USD', ?, ?)`,
    at,
    at,
    at,
    at,
  )
  // Harvest's routing, as the import brings it across: one Recipient, two CC,
  // one not routed, one routed with no address to send to.
  await database.run(
    `INSERT INTO contacts (id, client_id, first_name, last_name, email, invoice_recipient_status,
       created_at, updated_at) VALUES
     (1, 1, 'Accounts', 'Payable', 'AP@Northwind.example ', 'recipient', ?, ?),
     (2, 1, 'Pat', 'Example', 'pat@northwind.example', 'cc', ?, ?),
     (3, 1, 'Lee', NULL, 'lee@northwind.example', 'cc', ?, ?),
     (4, 1, 'Sam', 'Quiet', 'sam@northwind.example', 'none', ?, ?),
     (5, 1, 'No', 'Address', NULL, 'cc', ?, ?)`,
    ...Array.from({ length: 10 }, () => at),
  )
  await database.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
       amount_cents, due_amount_cents, created_at, updated_at)
     VALUES (1, 1, '4021', 'USD', '2026-10-01', '2026-10-31', 'draft', 1250000, 1250000, ?, ?),
            (2, 2, '4022', 'USD', '2026-10-01', '2026-10-31', 'draft', 1000, 1000, ?, ?)`,
    at,
    at,
    at,
    at,
  )
}

for (const [name, factory] of [
  ['SQLite', container],
  ['real D1', d1],
] as const) {
  describe(`invoice sending rules (${name})`, () => {
    let database: Harness | undefined
    afterEach(async () => database?.close())

    it("[unit] opens on the contacts' invoice routing until the client saves its own lists", async () => {
      database = await factory()
      await seed(database)
      const routed = (await readClientInvoiceRecipients(database.orm, 1))!
      expect(routed.saved).toBeNull()
      expect(effectiveClientRecipients(routed)).toEqual({
        source: 'contacts',
        to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        cc: [
          { name: 'Pat Example', email: 'pat@northwind.example' },
          { name: 'Lee', email: 'lee@northwind.example' },
        ],
      })

      const saved = {
        to: [{ name: 'Accounts Payable', email: ' AP@northwind.example' }],
        cc: [
          { name: 'Pat Example', email: 'pat@northwind.example' },
          { name: '', email: 'finance@example.com' },
        ],
      }
      expect(await setClientInvoiceRecipients(database.orm, 1, saved, at)).toBe(true)
      expect(effectiveClientRecipients((await readClientInvoiceRecipients(database.orm, 1))!)).toEqual({
        source: 'client',
        to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
        cc: [
          { name: 'Pat Example', email: 'pat@northwind.example' },
          { name: '', email: 'finance@example.com' },
        ],
      })
      // Another client's lists are its own.
      expect((await readClientInvoiceRecipients(database.orm, 2))!.saved).toBeNull()
      // Null hands the client back to its contacts.
      await setClientInvoiceRecipients(database.orm, 1, null, at)
      expect((await readClientInvoiceRecipients(database.orm, 1))!.saved).toBeNull()
      expect(await readClientInvoiceRecipients(database.orm, 404)).toBeNull()
      expect(await setClientInvoiceRecipients(database.orm, 404, null, at)).toBe(false)
    })

    it("[unit] carries the organization's zone, which the weekday of a send is read in (issue 925)", async () => {
      database = await factory()
      await seed(database)
      const configuration = {
        getTemplate: async () =>
          ({ version: 1, subjectTemplate: 'Invoice', textTemplate: 'Hello' }) as never,
      }
      const opened = async () =>
        (await readInvoiceEmailDefaults(database!.orm, configuration, 1, 1))!.timeZone
      // The column's own default, until somebody sets the company's zone.
      expect(await opened()).toBe('UTC')
      await database.run(`UPDATE organizations SET timezone = 'America/Costa_Rica'`)
      expect(await opened()).toBe('America/Costa_Rica')
    })

    it('[security] refuses an address in both headers, twice in one, or not an address', async () => {
      database = await factory()
      await seed(database)
      const ap = { name: 'AP', email: 'ap@northwind.example' }
      await expect(
        setClientInvoiceRecipients(database.orm, 1, { to: [ap], cc: [{ ...ap, name: 'Again' }] }, at),
      ).rejects.toThrow(/already in To/u)
      await expect(
        setClientInvoiceRecipients(database.orm, 1, { to: [ap, ap], cc: [] }, at),
      ).rejects.toThrow(/listed twice/u)
      await expect(
        setClientInvoiceRecipients(database.orm, 1, { to: [{ name: 'X', email: 'nobody' }], cc: [] }, at),
      ).rejects.toThrow(/not a valid email/u)
    })

    it('[unit] keeps the organization copies and each sender\'s own choice', async () => {
      database = await factory()
      await seed(database)
      expect(await readOrganizationAlwaysCc(database.orm)).toEqual([])
      expect(
        await setOrganizationAlwaysCc(database.orm, [{ name: 'Finance', email: 'Finance@Example.com' }]),
      ).toEqual([{ name: 'Finance', email: 'finance@example.com' }])
      expect(await readOrganizationAlwaysCc(database.orm)).toEqual([
        { name: 'Finance', email: 'finance@example.com' },
      ])

      // On by default: the person who sends sees what the client saw.
      expect(await readInvoiceSenderCopy(database.orm, 1)).toEqual({
        copy: true,
        name: 'Ana Example',
        email: 'ana@example.com',
      })
      expect(await setInvoiceSenderCopy(database.orm, 1, false, at)).toBe(true)
      expect((await readInvoiceSenderCopy(database.orm, 1))!.copy).toBe(false)
      expect(await readInvoiceSenderCopy(database.orm, 404)).toBeNull()
    })

    it('[money] lets the invoice decide, then its client, then the organization', async () => {
      database = await factory()
      await seed(database)
      await setOrganizationAttachPolicy(database.orm, false)
      await setOrganizationAppendPolicy(database.orm, false)
      expect(await setClientInvoiceExtras(database.orm, 1, {
        document: true,
        append: true,
        files: false,
        journal: 'summary',
        journal_formats: ['csv'],
      }, at)).toBe(true)

      // The client's rule reaches its invoice and not another client's.
      expect(await resolveAttachPolicy(database.orm, 1)).toEqual({ attach: true, because: 'client' })
      expect(await resolveAttachPolicy(database.orm, 2)).toEqual({
        attach: false,
        because: 'organization',
      })
      expect(await resolveAppendPolicy(database.orm, 1)).toBe(true)
      expect(await resolveAppendPolicy(database.orm, 2)).toBe(false)
      expect(await resolveFilesPolicy(database.orm, 1)).toBe(false)
      expect(await resolveJournalPolicy(database.orm, 1)).toBe('summary')
      expect(await resolveJournalFormats(database.orm, 1)).toEqual(['csv'])
      expect(await readAttachPreference(database.orm, 1)).toEqual({
        invoice: null,
        client: true,
        organization: false,
      })
      expect(await readJournalPreference(database.orm, 1)).toEqual({
        invoice: null,
        client: 'summary',
        organization: false,
      })
      expect(await readJournalFormatsPreference(database.orm, 1)).toEqual({
        invoice: null,
        client: ['csv'],
        organization: ['pdf'],
      })

      // The invoice's own answer wins over both, and null hands it back.
      await setInvoiceAppendPolicy(database.orm, { invoiceId: 1, enabled: false })
      expect(await readAppendPreference(database.orm, 1)).toEqual({
        invoice: false,
        client: true,
        organization: false,
      })
      expect(await resolveAppendPolicy(database.orm, 1)).toBe(false)
      await setInvoiceAppendPolicy(database.orm, { invoiceId: 1, enabled: null })
      expect(await resolveAppendPolicy(database.orm, 1)).toBe(true)

      // Clearing the client's rules returns its invoices to the organization.
      await setClientInvoiceExtras(database.orm, 1, {}, at)
      expect(await readClientInvoiceExtras(database.orm, 1)).toEqual({})
      expect(await resolveAttachPolicy(database.orm, 1)).toEqual({
        attach: false,
        because: 'organization',
      })
    })

    it('[security] holds a client to the sending kinds and every value to its shape', async () => {
      database = await factory()
      await seed(database)
      // Whether a client's invoices are chased or thanked is not a client rule.
      await expect(
        database.run(`UPDATE clients SET invoice_extras = '{"thank_you":true}' WHERE id = 1`),
      ).rejects.toThrow(/unknown invoice extra/u)
      await expect(
        database.run(`UPDATE clients SET invoice_extras = '{"append":"yes"}' WHERE id = 1`),
      ).rejects.toThrow(/invalid append preference/u)
      await expect(
        database.run(`UPDATE invoices SET invoice_extras = '{"append":1}' WHERE id = 1`),
      ).rejects.toThrow(/invalid append preference/u)
      await expect(
        database.run(`UPDATE clients SET invoice_extras = '{"journal_formats":[]}' WHERE id = 1`),
      ).rejects.toThrow(/invalid journal formats/u)
    })
  })
}
