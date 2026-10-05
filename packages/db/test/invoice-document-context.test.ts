import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'

/**
 * Issue 626: what the invoice document prints, read as one snapshot on both
 * runtimes -- D1 batches the two reads where SQLite wraps them in a
 * transaction, so each is run against its own real, migrated database.
 *
 * The rows are written directly. The ledger's guards, which refuse a header,
 * a line or a payment no command wrote, are dropped first: the read is what is
 * under test here, and the commands that normally write these rows are tested
 * where they live.
 */

const at = '2026-09-12T12:00:00.000Z'

interface TestDatabase {
  repository: ReturnType<typeof createMoneyResourceRepository>
  run(sql: string): Promise<void>
  rows<T>(sql: string): Promise<T[]>
  close(): Promise<void>
}

const container = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    repository: createMoneyResourceRepository(createContainerDatabase(sqlite)),
    run: async (sql) => {
      sqlite.prepare(sql).run()
    },
    rows: async <T>(sql: string) => sqlite.prepare(sql).all() as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1 = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    repository: createMoneyResourceRepository(createD1Database(database)),
    run: async (sql) => {
      await database.prepare(sql).run()
    },
    rows: async <T>(sql: string) => (await database.prepare(sql).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const seed = async (
  database: TestDatabase,
  options: { readonly addresses: boolean; readonly logo: boolean; readonly payments: boolean },
): Promise<void> => {
  for (const { name } of await database.rows<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'trigger'
       AND tbl_name IN ('invoices', 'invoice_line_items', 'invoice_payments')`,
  )) {
    await database.run(`DROP TRIGGER ${name}`)
  }
  const organizationAddress = options.addresses ? `'100 Example Ave, STE 200' || char(10) || 'Springfield, IL, 62701'` : 'NULL'
  const clientAddress = options.addresses ? `'13031 W. Jefferson Blvd.' || char(10) || 'LA, CA 90094'` : 'NULL'
  for (const statement of [
    `INSERT INTO organizations (id, name, modules, address, created_at, updated_at)
       VALUES (1, 'CONFLICT LLC', '{}', ${organizationAddress}, '${at}', '${at}')`,
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
       VALUES (1, 'Leo', 'Mata', 'administrator', '[]', '${at}', '${at}')`,
    `INSERT INTO clients (id, name, address, currency, created_at, updated_at)
       VALUES (1, 'Acme Retail', ${clientAddress}, 'USD', '${at}', '${at}')`,
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state, subject,
       purchase_order, notes, payment_terms, discount_rate_ppm, tax_rate_ppm, tax2_rate_ppm,
       amount_cents, due_amount_cents, discount_amount_cents, tax_amount_cents, tax2_amount_cents,
       created_at, updated_at)
       VALUES (1, 1, '771', 'USD', '2017-05-01', '2017-06-15', 'open', 'DevOps support retainer',
       '4500000001', 'Beneficiary:' || char(10) || '*CONFLICT LLC*', 'net_45', 200000, 88750, NULL,
       177400, 77400, 40000, 17400, 0, '${at}', '${at}')`,
    // Written out of order: the document reads lines by position.
    `INSERT INTO invoice_line_items (id, invoice_id, position, kind, description, quantity,
       unit_price_cents, amount_cents, created_at, updated_at)
       VALUES (21, 1, 1, 'Product', 'Second', 1, 50000, 50000, '${at}', '${at}')`,
    `INSERT INTO invoice_line_items (id, invoice_id, position, kind, description, quantity,
       unit_price_cents, amount_cents, created_at, updated_at)
       VALUES (20, 1, 0, 'Service', 'DevOps support', 15, 10000, 150000, '${at}', '${at}')`,
    ...(options.payments
      ? [
          `INSERT INTO invoice_payments (id, invoice_id, currency, amount_cents, paid_date, provider,
             provider_shape, created_at, updated_at)
             VALUES (31, 1, 'USD', 60000, '2017-05-10', 'manual', 'manual', '${at}', '${at}')`,
          `INSERT INTO invoice_payments (id, invoice_id, currency, amount_cents, paid_date, provider,
             provider_shape, created_at, updated_at)
             VALUES (32, 1, 'USD', 40000, '2017-05-20', 'manual', 'manual', '${at}', '${at}')`,
        ]
      : []),
    ...(options.logo
      ? [
          `INSERT INTO brand_assets (slot, content_hash, file_key, content_type, byte_size, created_at, updated_at)
             VALUES ('wordmark_light', '${'a'.repeat(64)}', 'brand/sha256/aa/${'a'.repeat(64)}', 'image/png', 4084, '${at}', '${at}')`,
          `INSERT INTO brand_assets (slot, content_hash, file_key, content_type, byte_size, created_at, updated_at)
             VALUES ('wordmark_dark', '${'b'.repeat(64)}', 'brand/sha256/bb/${'b'.repeat(64)}', 'image/png', 3504, '${at}', '${at}')`,
        ]
      : []),
  ]) {
    await database.run(statement)
  }
}

const factories = [
  ['container', container],
  ['D1', d1],
] as const

for (const [runtime, factory] of factories) {
  describe(`the invoice document's snapshot (${runtime})`, () => {
    let active: TestDatabase | undefined
    afterEach(async () => {
      await active?.close()
      active = undefined
    })

    it("[money] reads everything Harvest's page prints", async () => {
      active = await factory()
      await seed(active, { addresses: true, logo: true, payments: true })
      expect(await active.repository.getInvoiceDocumentContext(1)).toEqual({
        invoiceId: 1,
        number: '771',
        subject: 'DevOps support retainer',
        currency: 'USD',
        amountCents: 177_400,
        discountAmountCents: 40_000,
        taxAmountCents: 17_400,
        tax2AmountCents: 0,
        issueDate: '2017-05-01',
        dueDate: '2017-06-15',
        organizationName: 'CONFLICT LLC',
        clientName: 'Acme Retail',
        lineItems: [
          { kind: 'Service', description: 'DevOps support', quantity: 15, unitPriceCents: 10_000, amountCents: 150_000 },
          { kind: 'Product', description: 'Second', quantity: 1, unitPriceCents: 50_000, amountCents: 50_000 },
        ],
        purchaseOrder: '4500000001',
        notes: 'Beneficiary:\n*CONFLICT LLC*',
        paymentTerms: 'net_45',
        discountRatePpm: 200_000,
        taxRatePpm: 88_750,
        tax2RatePpm: null,
        dueAmountCents: 77_400,
        // Every payment against the invoice, summed.
        paidAmountCents: 100_000,
        organizationAddress: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
        clientAddress: '13031 W. Jefferson Blvd.\nLA, CA 90094',
        // The light-ground mark, never the dark one: an invoice is read on white.
        logo: { fileKey: `brand/sha256/aa/${'a'.repeat(64)}`, contentType: 'image/png' },
      })
    })

    it('[unit] answers null where nothing was entered, and zero where nothing was paid', async () => {
      active = await factory()
      await seed(active, { addresses: false, logo: false, payments: false })
      expect(await active.repository.getInvoiceDocumentContext(1)).toMatchObject({
        organizationAddress: null,
        clientAddress: null,
        logo: null,
        paidAmountCents: 0,
      })
    })

    it('[unit] answers nothing for an invoice that does not exist', async () => {
      active = await factory()
      await seed(active, { addresses: false, logo: false, payments: false })
      expect(await active.repository.getInvoiceDocumentContext(404)).toBeNull()
    })
  })
}
