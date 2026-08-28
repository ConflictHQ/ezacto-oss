import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  canonicalizeHarvestPaymentDates,
  confirmBankDeposit,
  percentageToRatePpm,
  refreshInvoiceSourceObservation,
  reemitHarvestPaymentDates,
  setInvoicePaymentOptions,
} from '../src/invoice-payments.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'

type OperationDatabase = Parameters<typeof confirmBankDeposit>[0]

interface TestDatabase {
  orm: OperationDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

interface HarvestPayment {
  id: number
  amount: number
  paid_at: string | null
  paid_date: string | null
  notes: string | null
  transaction_id: string | null
  recorded_by: string | null
  recorded_by_email: string | null
  payment_gateway: { id: number; name: string } | null
  created_at: string
  updated_at: string
}

interface HarvestInvoiceObservation {
  amount: number
  due_amount: number
  tax_amount: number
  tax2_amount: number
  discount_amount: number
  payment_options: string[]
  updated_at: string
}

const timestamp = '2026-08-27T00:00:00.000Z'
const laterTimestamp = '2026-08-27T00:00:00.001Z'
const centsLimit = 9_000_000_000_000
const migrationsThrough0004 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
] as const

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (migrate = true): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (migrate) await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<T>()).results,
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

const installThrough0004 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0004) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const installBaseFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users
      (id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 'Sanitized', 'Recorder', '[]', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices
      (id, harvest_id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES
      (1, 7001, 1, 'INV-001', 'USD', '2026-08-01', '2026-08-31', ?, ?),
      (2, NULL, 1, 'INV-002', 'EUR', '2026-08-01', '2026-08-31', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const amountToExactCents = (amount: number): number => {
  const scaled = amount * 100
  if (!Number.isSafeInteger(scaled)) throw new Error('money has more than two decimal places')
  return scaled
}

for (const [runtime, factory] of factories) {
  describe(`invoice payments and totals (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] creates the exact physical money foundation and reruns idempotently', async () => {
      database = await factory()
      const db = database
      expect(
        (
          await db.rows<{ name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN
               ('payment_provider_accounts','bank_deposits','invoice_payments')
             ORDER BY name`,
          )
        ).map(({ name }) => name),
      ).toEqual(['bank_deposits', 'invoice_payments', 'payment_provider_accounts'])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(({ name }) => name),
      ).toEqual(
        expect.arrayContaining([
          'tax_rate_ppm',
          'tax2_rate_ppm',
          'discount_rate_ppm',
          'amount_cents',
          'due_amount_cents',
          'tax_amount_cents',
          'tax2_amount_cents',
          'discount_amount_cents',
          'written_off_cents',
          'payment_options',
          'reference_token',
          'source_amount_cents',
          'source_due_amount_cents',
          'source_tax_amount_cents',
          'source_tax2_amount_cents',
          'source_discount_amount_cents',
          'source_payment_options',
          'source_updated_at',
        ]),
      )
      const paymentColumns = await db.rows<{
        name: string
        notnull: number
        dflt_value: string | null
      }>(`PRAGMA table_info(invoice_payments)`)
      expect(paymentColumns.map(({ name }) => name)).toEqual([
        'id',
        'harvest_id',
        'invoice_id',
        'currency',
        'amount_cents',
        'paid_at',
        'paid_date',
        'source_paid_at',
        'source_paid_date',
        'source_recorded_by_name',
        'source_recorded_by_email',
        'source_gateway_id',
        'source_gateway_name',
        'notes',
        'recorded_by_user_id',
        'provider',
        'provider_shape',
        'provider_account_id',
        'provider_transaction_id',
        'bank_deposit_id',
        'created_at',
        'updated_at',
      ])
      expect(paymentColumns.find(({ name }) => name === 'id')?.dflt_value).toBeNull()
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(payment_provider_accounts)`)).map(
          ({ name }) => name,
        ),
      ).toEqual([
        'id',
        'provider',
        'provider_shape',
        'external_account_id',
        'display_name',
        'created_at',
        'updated_at',
      ])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(bank_deposits)`)).map(
          ({ name }) => name,
        ),
      ).toEqual([
        'id',
        'provider_account_id',
        'provider_transaction_id',
        'currency',
        'posted_at',
        'amount_cents',
        'memo',
        'counterparty',
        'match_state',
        'suggested_invoice_id',
        'created_at',
        'updated_at',
      ])
      const foreignKeys = (
        await db.rows<{
        from: string
        table: string
        to: string
        on_delete: string
        }>(`PRAGMA foreign_key_list(invoice_payments)`)
      ).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete }))
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          { from: 'invoice_id', table: 'invoices', to: 'id', on_delete: 'CASCADE' },
          {
            from: 'recorded_by_user_id',
            table: 'users',
            to: 'id',
            on_delete: 'SET NULL',
          },
          {
            from: 'provider_account_id',
            table: 'payment_provider_accounts',
            to: 'id',
            on_delete: 'RESTRICT',
          },
          {
            from: 'bank_deposit_id',
            table: 'bank_deposits',
            to: 'id',
            on_delete: 'RESTRICT',
          },
        ]),
      )
      expect(
        (
          await db.rows<{ from: string; table: string; to: string; on_delete: string }>(
            `PRAGMA foreign_key_list(bank_deposits)`,
          )
        ).map(({ from, table, to, on_delete }) => ({ from, table, to, on_delete })),
      ).toEqual(
        expect.arrayContaining([
          {
            from: 'provider_account_id',
            table: 'payment_provider_accounts',
            to: 'id',
            on_delete: 'RESTRICT',
          },
          {
            from: 'suggested_invoice_id',
            table: 'invoices',
            to: 'id',
            on_delete: 'RESTRICT',
          },
        ]),
      )
      const indexColumns = async (name: string): Promise<string[]> =>
        (await db.rows<{ name: string }>(`PRAGMA index_info('${name}')`)).map(
          ({ name: column }) => column,
        )
      const accountIdentity = (
        await db.rows<{ name: string; unique: number; origin: string }>(
          `PRAGMA index_list(payment_provider_accounts)`,
        )
      ).find(({ unique, origin }) => unique === 1 && origin === 'u')
      const depositIdentity = (
        await db.rows<{ name: string; unique: number; origin: string }>(
          `PRAGMA index_list(bank_deposits)`,
        )
      ).find(({ unique, origin }) => unique === 1 && origin === 'u')
      expect(accountIdentity).toBeDefined()
      expect(depositIdentity).toBeDefined()
      expect(await indexColumns(accountIdentity?.name ?? '')).toEqual([
        'provider',
        'provider_shape',
        'external_account_id',
      ])
      expect(await indexColumns(depositIdentity?.name ?? '')).toEqual([
        'provider_account_id',
        'provider_transaction_id',
      ])
      expect(await indexColumns('bank_deposits_suggested_invoice_id')).toEqual([
        'suggested_invoice_id',
      ])
      expect(await indexColumns('bank_deposits_match_posted_id')).toEqual([
        'match_state',
        'posted_at',
        'id',
      ])
      expect(await indexColumns('invoice_payments_provider_transaction_unique')).toEqual([
        'provider_account_id',
        'provider_transaction_id',
      ])
      expect(await indexColumns('invoice_payments_invoice_id')).toEqual(['invoice_id'])
      expect(await indexColumns('invoice_payments_recorded_by_user_id')).toEqual([
        'recorded_by_user_id',
      ])
      expect(await indexColumns('invoice_payments_provider_account_id')).toEqual([
        'provider_account_id',
      ])
      expect(await indexColumns('invoices_reference_token_unique')).toEqual([
        'reference_token',
      ])
      const ledger = await db.rows<{ id: string; applied_at: string }>(
        `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
      )
      expect(ledger.at(-1)?.id).toBe('0005_invoice_payments_totals')
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string; applied_at: string }>(
          `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
        ),
      ).toEqual(ledger)
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] upgrades populated 0004 rows in place and backfills authoritative totals', async () => {
      database = await factory(false)
      const db = database
      await installThrough0004(db)
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           taxed, taxed2, created_at, updated_at)
         VALUES (1, 1, 0, 'Service', 999.123, 1, 12345, 1, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      const invoiceSql = await db.rows<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'invoices'`,
      )
      await db.migrateAgain()
      expect(
        await db.rows<{ amount_cents: number; due_amount_cents: number }>(
          `SELECT amount_cents, due_amount_cents FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ amount_cents: 12345, due_amount_cents: 12345 }])
      expect(
        await db.rows<{ quantity: number; amount_cents: number }>(
          `SELECT quantity, amount_cents FROM invoice_line_items WHERE id = 1`,
        ),
      ).toEqual([{ quantity: 999.123, amount_cents: 12345 }])
      expect(invoiceSql[0]?.sql).not.toContain('tax_rate_ppm')
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toContainEqual({ id: '0005_invoice_payments_totals' })
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] applies exact discount-first parallel taxes and recomputes every mutation', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, amount_cents,
           due_amount_cents, created_at, updated_at)
         VALUES (3, 1, 'INV-FORGED-TOTAL', 'USD', '2026-08-01', '2026-08-31',
           999, 999, ?, ?)`,
        timestamp,
        timestamp,
      )
      expect(
        await db.rows<{ amount: number; due: number }>(
          `SELECT amount_cents AS amount, due_amount_cents AS due FROM invoices WHERE id = 3`,
        ),
      ).toEqual([{ amount: 0, due: 0 }])
      await db.run(
        `UPDATE invoices SET discount_rate_ppm = 100000, tax_rate_ppm = 50000,
           tax2_rate_ppm = 200000 WHERE id = 1`,
      )
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           taxed, taxed2, created_at, updated_at)
         VALUES
          (1, 1, 0, 'Service', 1, 10000, 10000, 1, 1, ?, ?),
          (2, 1, 1, 'Service', 1, 5000, 5000, 0, 1, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      expect(
        await db.rows<Record<string, number>>(
          `SELECT discount_amount_cents, tax_amount_cents, tax2_amount_cents,
             amount_cents, due_amount_cents FROM invoices WHERE id = 1`,
        ),
      ).toEqual([
        {
          discount_amount_cents: 1500,
          tax_amount_cents: 450,
          tax2_amount_cents: 2700,
          amount_cents: 16650,
          due_amount_cents: 16650,
        },
      ])
      await db.run(
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_at, provider, provider_shape,
           created_at, updated_at)
         VALUES (1, 1, 'USD', 1000, ?, 'manual', 'manual', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      expect(await db.rows<{ due: number }>(`SELECT due_amount_cents AS due FROM invoices WHERE id = 1`)).toEqual([
        { due: 15650 },
      ])
      await db.run(`CREATE TABLE recompute_observations (kind TEXT NOT NULL) STRICT`)
      await db.run(
        `CREATE TRIGGER observe_invoice_recompute AFTER UPDATE OF amount_cents ON invoices
         BEGIN INSERT INTO recompute_observations(kind) VALUES ('recomputed'); END`,
      )
      await db.run(`UPDATE invoice_line_items SET description = 'Non-financial edit' WHERE id = 1`)
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM recompute_observations`),
      ).toEqual([{ count: 1 }])
      await db.run(`DELETE FROM recompute_observations`)
      await db.run(
        `UPDATE invoice_payments SET notes = 'Non-financial edit', updated_at = ? WHERE id = 1`,
        laterTimestamp,
      )
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM recompute_observations`),
      ).toEqual([{ count: 1 }])
      await db.run(`UPDATE invoice_payments SET amount_cents = 1200, updated_at = ? WHERE id = 1`, laterTimestamp)
      expect(await db.rows<{ due: number }>(`SELECT due_amount_cents AS due FROM invoices WHERE id = 1`)).toEqual([
        { due: 15450 },
      ])
      await db.run(`DELETE FROM invoice_payments WHERE id = 1`)
      await db.run(`UPDATE invoices SET written_off_cents = 50 WHERE id = 1`)
      expect(await db.rows<{ due: number }>(`SELECT due_amount_cents AS due FROM invoices WHERE id = 1`)).toEqual([
        { due: 16600 },
      ])
      await db.run(`UPDATE invoice_line_items SET amount_cents = -1 WHERE id = 2`)
      await db.run(
        `UPDATE invoices SET discount_rate_ppm = 500000, tax_rate_ppm = NULL,
           tax2_rate_ppm = NULL, written_off_cents = 0 WHERE id = 1`,
      )
      expect(
        await db.rows<{ discount: number }>(
          `SELECT discount_amount_cents AS discount FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ discount: 5000 }])
      await db.run(`UPDATE invoice_line_items SET amount_cents = -1 WHERE id = 1`)
      expect(
        await db.rows<{ discount: number }>(
          `SELECT discount_amount_cents AS discount FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ discount: -1 }])
      await db.run(`DELETE FROM invoice_line_items WHERE id = 2`)
      expect(
        await db.rows<{ amount: number; due: number }>(
          `SELECT amount_cents AS amount, due_amount_cents AS due FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ amount: 0, due: 0 }])
      await db.run(`UPDATE invoices SET discount_rate_ppm = 500000 WHERE id = 3`)
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (3, 3, 0, 'Positive midpoint', 1, 1, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      expect(
        await db.rows<{ discount: number }>(
          `SELECT discount_amount_cents AS discount FROM invoices WHERE id = 3`,
        ),
      ).toEqual([{ discount: 1 }])
      await db.run(`UPDATE invoice_line_items SET amount_cents = -1 WHERE id = 3`)
      expect(
        await db.rows<{ discount: number }>(
          `SELECT discount_amount_cents AS discount FROM invoices WHERE id = 3`,
        ),
      ).toEqual([{ discount: -1 }])
    })

    it('[unit] keeps source observations atomic, strictly newer, bounded, and separate', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      const fixture = JSON.parse(
        await readFile(new URL('fixtures/harvest-invoice.json', import.meta.url), 'utf8'),
      ) as HarvestInvoiceObservation
      expect(
        await refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 1,
          sourceAmountCents: amountToExactCents(fixture.amount),
          sourceDueAmountCents: amountToExactCents(fixture.due_amount),
          sourceTaxAmountCents: amountToExactCents(fixture.tax_amount),
          sourceTax2AmountCents: amountToExactCents(fixture.tax2_amount),
          sourceDiscountAmountCents: amountToExactCents(fixture.discount_amount),
          sourcePaymentOptions: fixture.payment_options,
          sourceUpdatedAt: fixture.updated_at,
        }),
      ).toBe(true)
      expect(
        await refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 1,
          sourceAmountCents: 1,
          sourceDueAmountCents: 1,
          sourceTaxAmountCents: 1,
          sourceTax2AmountCents: 1,
          sourceDiscountAmountCents: 1,
          sourcePaymentOptions: [],
          sourceUpdatedAt: '2026-08-16T15:29:59.999Z',
        }),
      ).toBe(false)
      expect(
        await refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 1,
          sourceAmountCents: 9,
          sourceDueAmountCents: 9,
          sourceTaxAmountCents: 9,
          sourceTax2AmountCents: 9,
          sourceDiscountAmountCents: 9,
          sourcePaymentOptions: [],
          sourceUpdatedAt: '2026-08-16T15:30:00.000Z',
        }),
      ).toBe(false)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT source_amount_cents, source_due_amount_cents, source_tax_amount_cents,
             source_tax2_amount_cents, source_discount_amount_cents, source_payment_options,
             source_updated_at, amount_cents, due_amount_cents FROM invoices WHERE id = 1`,
        ),
      ).toEqual([
        {
          source_amount_cents: 227500,
          source_due_amount_cents: 227500,
          source_tax_amount_cents: 4375,
          source_tax2_amount_cents: 0,
          source_discount_amount_cents: 0,
          source_payment_options: '["ach"]',
          source_updated_at: fixture.updated_at,
          amount_cents: 0,
          due_amount_cents: 0,
        },
      ])
      expect(
        await refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 1,
          sourceAmountCents: 2,
          sourceDueAmountCents: 3,
          sourceTaxAmountCents: 4,
          sourceTax2AmountCents: 5,
          sourceDiscountAmountCents: 6,
          sourcePaymentOptions: ['future_source_option'],
          sourceUpdatedAt: '2026-08-16T15:30:00.001Z',
        }),
      ).toBe(true)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT source_amount_cents, source_due_amount_cents, source_tax_amount_cents,
             source_tax2_amount_cents, source_discount_amount_cents, source_payment_options,
             source_updated_at FROM invoices WHERE id = 1`,
        ),
      ).toEqual([
        {
          source_amount_cents: 2,
          source_due_amount_cents: 3,
          source_tax_amount_cents: 4,
          source_tax2_amount_cents: 5,
          source_discount_amount_cents: 6,
          source_payment_options: '["future_source_option"]',
          source_updated_at: '2026-08-16T15:30:00.001Z',
        },
      ])
      await expect(
        db.run(`UPDATE invoices SET harvest_id = NULL WHERE id = 1`),
      ).rejects.toThrow(/source observation identity is immutable/)
      await expect(
        db.run(`UPDATE invoices SET harvest_id = 7999 WHERE id = 1`),
      ).rejects.toThrow(/source observation identity is immutable/)
      expect(
        await db.rows<{ harvest_id: number; source_amount_cents: number }>(
          `SELECT harvest_id, source_amount_cents FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ harvest_id: 7001, source_amount_cents: 2 }])
      await expect(
        refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 1,
          sourceAmountCents: centsLimit + 1,
          sourceDueAmountCents: null,
          sourceTaxAmountCents: null,
          sourceTax2AmountCents: null,
          sourceDiscountAmountCents: null,
          sourcePaymentOptions: null,
          sourceUpdatedAt: '2026-08-27T00:00:00.101Z',
        }),
      ).rejects.toThrow()
      await expect(
        refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 1,
          sourceAmountCents: 2,
          sourceDueAmountCents: 2,
          sourceTaxAmountCents: 2,
          sourceTax2AmountCents: 2,
          sourceDiscountAmountCents: 2,
          sourcePaymentOptions: [],
          sourceUpdatedAt: '2026-02-30T00:00:00Z',
        }),
      ).rejects.toThrow(/real canonical UTC instant/)
      expect(
        await refreshInvoiceSourceObservation(db.orm, {
          invoiceId: 2,
          sourceAmountCents: 1,
          sourceDueAmountCents: 1,
          sourceTaxAmountCents: null,
          sourceTax2AmountCents: null,
          sourceDiscountAmountCents: null,
          sourcePaymentOptions: [],
          sourceUpdatedAt: laterTimestamp,
        }),
      ).toBe(false)
      await expect(
        db.run(
          `UPDATE invoices SET source_amount_cents = 1, source_updated_at = ? WHERE id = 2`,
          laterTimestamp,
        ),
      ).rejects.toThrow(/requires an import identity|strictly newer/)
      await expect(
        db.run(
          `INSERT INTO invoices
            (id, harvest_id, client_id, number, currency, issue_date, due_date,
             source_amount_cents, created_at, updated_at)
           VALUES (3, 7003, 1, 'INV-UNPAIRED-SOURCE', 'USD', '2026-08-01',
             '2026-08-31', 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/requires an import identity/)
    })

    it('[unit] generates transfer references at the operation boundary and rejects Bill.com', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      await setInvoicePaymentOptions(db.orm, {
        invoiceId: 1,
        paymentOptions: ['wise_transfer', 'stripe_checkout'],
        updatedAt: laterTimestamp,
      })
      const enabled = await db.rows<{ payment_options: string; reference_token: string }>(
        `SELECT payment_options, reference_token FROM invoices WHERE id = 1`,
      )
      expect(enabled[0]?.payment_options).toBe('["wise_transfer","stripe_checkout"]')
      expect(enabled[0]?.reference_token).toMatch(/^EZ-[0-9A-F]{12}$/)
      await expect(
        setInvoicePaymentOptions(db.orm, {
          invoiceId: 1,
          paymentOptions: ['bill_com_transfer'],
          updatedAt: laterTimestamp,
        }),
      ).rejects.toThrow(/unavailable/)
      await expect(
        setInvoicePaymentOptions(db.orm, {
          invoiceId: 999,
          paymentOptions: [],
          updatedAt: laterTimestamp,
        }),
      ).rejects.toThrow(/invoice does not exist/)
      await expect(
        setInvoicePaymentOptions(db.orm, {
          invoiceId: 1,
          paymentOptions: ['wise_transfer', 'wise_transfer'],
          updatedAt: laterTimestamp,
        }),
      ).rejects.toThrow(/must be unique/)
      await expect(
        db.run(`UPDATE invoices SET payment_options = '["unknown"]' WHERE id = 1`),
      ).rejects.toThrow(/invalid or unavailable/)
      await expect(
        db.run(
          `UPDATE invoices SET payment_options = '["wise_transfer","wise_transfer"]'
           WHERE id = 1`,
        ),
      ).rejects.toThrow(/invalid or unavailable/)
      await expect(
        setInvoicePaymentOptions(db.orm, {
          invoiceId: 1,
          paymentOptions: ['wise_transfer'],
          updatedAt: laterTimestamp,
          referenceToken: 'EZ-AAAAAAAAAAAA',
        } as Parameters<typeof setInvoicePaymentOptions>[1]),
      ).rejects.toThrow(/server-generated/)
      await expect(
        db.run(`UPDATE invoices SET reference_token = NULL WHERE id = 1`),
      ).rejects.toThrow(/requires a transfer option/)
      await setInvoicePaymentOptions(db.orm, {
        invoiceId: 1,
        paymentOptions: [],
        updatedAt: laterTimestamp,
      })
      expect(
        await db.rows<{ reference_token: string | null }>(
          `SELECT reference_token FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ reference_token: null }])
      await db.run(
        `UPDATE invoices SET payment_options = '["bill_com_transfer"]', updated_at = ?
         WHERE id = 1`,
        laterTimestamp,
      )
      expect(
        await db.rows<{ payment_options: string; reference_token: string }>(
          `SELECT payment_options, reference_token FROM invoices WHERE id = 1`,
        ),
      ).toEqual([
        {
          payment_options: '["bill_com_transfer"]',
          reference_token: expect.stringMatching(/^EZ-[0-9A-F]{12}$/),
        },
      ])
      await setInvoicePaymentOptions(db.orm, {
        invoiceId: 1,
        paymentOptions: [],
        updatedAt: laterTimestamp,
      })
    })

    it('[unit] confirms only an exact suggestion and reverses it on payment deletion', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES
          (1, 'wise', 'reconciliation', 'acct-safe-1', ?, ?),
          (2, 'bill_com', 'reconciliation', 'acct-reserved', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO users
          (id, first_name, last_name, manager_grants, created_at, updated_at)
         VALUES (2, 'External', 'Recorder', '[]', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (3, 'stripe', 'checkout', 'checkout-not-feed', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES
          (1, 1, 'deposit-safe-1', 'USD', ?, 2500, 'suggested', 1, ?, ?),
          (2, 2, 'deposit-reserved', 'USD', ?, 1000, 'suggested', 1, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO bank_deposits
            (id, provider_account_id, provider_transaction_id, currency, posted_at,
             amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
           VALUES (3, 1, 'forged-confirmed', 'USD', ?, 10, 'confirmed', 1, ?, ?)`,
          timestamp,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/invalid bank deposit suggestion/)
      for (const statement of [
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, created_at, updated_at)
         VALUES (3, 3, 'checkout-shape', 'USD', '${timestamp}', 10, '${timestamp}', '${timestamp}')`,
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES (3, 1, 'currency-mismatch', 'EUR', '${timestamp}', 10, 'suggested', 1,
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES (3, 1, 'invalid-invoice', 'USD', '${timestamp}', 10, 'suggested', 999,
           '${timestamp}', '${timestamp}')`,
      ]) {
        await expect(db.run(statement)).rejects.toThrow()
      }
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT (SELECT count(*) FROM invoice_payments) AS payments,
             invoice.due_amount_cents AS due, invoice.state,
             (SELECT count(*) FROM event_outbox) AS outbox
           FROM invoices invoice WHERE invoice.id = 1`,
        ),
      ).toEqual([{ payments: 0, due: 0, state: 'draft', outbox: 0 }])
      await confirmBankDeposit(db.orm, {
        depositId: 1,
        invoiceId: 1,
        paidAt: timestamp,
        notes: 'Explicitly confirmed',
        recordedByUserId: 2,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT invoice_id, currency, amount_cents, provider, provider_shape,
             provider_account_id, provider_transaction_id, bank_deposit_id
           FROM invoice_payments`,
        ),
      ).toEqual([
        {
          invoice_id: 1,
          currency: 'USD',
          amount_cents: 2500,
          provider: 'wise',
          provider_shape: 'reconciliation',
          provider_account_id: 1,
          provider_transaction_id: 'deposit-safe-1',
          bank_deposit_id: 1,
        },
      ])
      expect(
        await db.rows<{ match_state: string; suggested_invoice_id: number }>(
          `SELECT match_state, suggested_invoice_id FROM bank_deposits WHERE id = 1`,
        ),
      ).toEqual([{ match_state: 'confirmed', suggested_invoice_id: 1 }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT due_amount_cents AS due, state,
             (SELECT count(*) FROM event_outbox) AS outbox
           FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ due: -2500, state: 'draft', outbox: 0 }])
      await expect(
        db.run(`UPDATE bank_deposits SET amount_cents = 2600 WHERE id = 1`),
      ).rejects.toThrow(/tuple is immutable/)
      await expect(
        db.run(`UPDATE invoice_payments SET recorded_by_user_id = 1 WHERE bank_deposit_id = 1`),
      ).rejects.toThrow(/external invoice payment is immutable/)
      await db.run(`DELETE FROM users WHERE id = 2`)
      expect(
        await db.rows<{ recorded_by_user_id: number | null }>(
          `SELECT recorded_by_user_id FROM invoice_payments WHERE bank_deposit_id = 1`,
        ),
      ).toEqual([{ recorded_by_user_id: null }])
      await expect(
        confirmBankDeposit(db.orm, {
          depositId: 1,
          invoiceId: 1,
          paidAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow(/not confirmable/)
      await expect(
        confirmBankDeposit(db.orm, {
          depositId: 2,
          invoiceId: 1,
          paidAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow(/not confirmable/)
      await expect(db.run(`UPDATE invoices SET currency = 'EUR' WHERE id = 1`)).rejects.toThrow(
        /currency is immutable/,
      )
      await db.run(`DELETE FROM invoice_payments WHERE bank_deposit_id = 1`)
      expect(
        await db.rows<{ match_state: string }>(
          `SELECT match_state FROM bank_deposits WHERE id = 1`,
        ),
      ).toEqual([{ match_state: 'suggested' }])
      await db.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, created_at, updated_at)
         VALUES (3, 1, 'deposit-unmatched', 'USD', ?, 500, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      await confirmBankDeposit(db.orm, {
        depositId: 3,
        invoiceId: 1,
        paidAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      await db.run(`DELETE FROM invoice_payments WHERE bank_deposit_id = 3`)
      expect(
        await db.rows<{ match_state: string; suggested_invoice_id: number | null }>(
          `SELECT match_state, suggested_invoice_id FROM bank_deposits WHERE id = 3`,
        ),
      ).toEqual([{ match_state: 'unmatched', suggested_invoice_id: null }])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] preserves Harvest recorder, gateway, transaction, and dual-date evidence', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      const fixture = JSON.parse(
        await readFile(new URL('fixtures/harvest-invoice-payment.json', import.meta.url), 'utf8'),
      ) as HarvestPayment
      const dates = canonicalizeHarvestPaymentDates({
        paidAt: fixture.paid_at,
        paidDate: fixture.paid_date,
      })
      expect(dates.sourceDateDisagrees).toBe(true)
      expect(reemitHarvestPaymentDates(dates)).toEqual({
        paidAt: fixture.paid_at,
        paidDate: fixture.paid_date,
      })
      await db.run(
        `INSERT INTO invoice_payments
          (id, harvest_id, invoice_id, currency, amount_cents, paid_at, paid_date,
           source_paid_at, source_paid_date, source_recorded_by_name,
           source_recorded_by_email, source_gateway_id, source_gateway_name, notes,
           provider, provider_shape, provider_transaction_id, created_at, updated_at)
         VALUES (1, ?, 1, 'USD', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?,
           'manual', 'manual', ?, ?, ?)`,
        fixture.id,
        amountToExactCents(fixture.amount),
        dates.paidAt,
        dates.sourcePaidAt,
        dates.sourcePaidDate,
        fixture.recorded_by,
        fixture.recorded_by_email,
        fixture.payment_gateway?.id ?? null,
        fixture.payment_gateway?.name ?? null,
        fixture.notes,
        fixture.transaction_id,
        fixture.created_at,
        fixture.updated_at,
      )
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT harvest_id, amount_cents, paid_at, paid_date, source_paid_at,
             source_paid_date, source_recorded_by_name, source_recorded_by_email,
             source_gateway_id, source_gateway_name, provider_transaction_id
           FROM invoice_payments`,
        ),
      ).toEqual([
        {
          harvest_id: fixture.id,
          amount_cents: 12550,
          paid_at: dates.paidAt,
          paid_date: null,
          source_paid_at: dates.sourcePaidAt,
          source_paid_date: dates.sourcePaidDate,
          source_recorded_by_name: fixture.recorded_by,
          source_recorded_by_email: fixture.recorded_by_email,
          source_gateway_id: fixture.payment_gateway?.id,
          source_gateway_name: fixture.payment_gateway?.name,
          provider_transaction_id: fixture.transaction_id,
        },
      ])
      await expect(
        db.run(`UPDATE invoice_payments SET amount_cents = 1 WHERE id = 1`),
      ).rejects.toThrow(/imported invoice payment is immutable/)
      await expect(
        db.run(`UPDATE invoice_payments SET created_at = ? WHERE id = 1`, laterTimestamp),
      ).rejects.toThrow(/created timestamp is immutable/)
      await db.run(
        `INSERT INTO users
          (id, first_name, last_name, manager_grants, created_at, updated_at)
         VALUES (2, 'Resolved', 'Recorder', '[]', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(`UPDATE invoice_payments SET recorded_by_user_id = 2 WHERE id = 1`)
      await db.run(`DELETE FROM users WHERE id = 2`)
      expect(
        await db.rows<{ recorded_by_user_id: number | null; source_recorded_by_name: string }>(
          `SELECT recorded_by_user_id, source_recorded_by_name FROM invoice_payments`,
        ),
      ).toEqual([
        { recorded_by_user_id: null, source_recorded_by_name: 'Sanitized Recorder' },
      ])
      await expect(
        db.run(
          `INSERT INTO invoice_payments
            (id, invoice_id, currency, amount_cents, paid_date, source_paid_date,
             provider, provider_shape, created_at, updated_at)
           VALUES (2, 1, 'USD', 1, '2026-08-27', '2026-08-27',
             'manual', 'manual', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO invoice_payments
            (id, harvest_id, invoice_id, currency, amount_cents, paid_date,
             source_paid_at, source_paid_date, provider, provider_shape, created_at, updated_at)
           VALUES (2, 9002, 1, 'USD', 1, '2026-08-27', ?, '2026-08-26',
             'manual', 'manual', ?, ?)`,
          timestamp,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
    })

    it('[unit] rejects identity replacement, malformed shapes, and aggregate overflow', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (1, 'wise', 'reconciliation', 'account-1', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (2, 'stripe', 'checkout', 'checkout-account', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, created_at, updated_at)
         VALUES (1, 1, 'transaction-1', 'USD', ?, 10, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT OR REPLACE INTO bank_deposits
            (id, provider_account_id, provider_transaction_id, currency, posted_at,
             amount_cents, created_at, updated_at)
           VALUES (2, 1, 'transaction-1', 'USD', ?, 999, ?, ?)`,
          timestamp,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `INSERT OR REPLACE INTO payment_provider_accounts
            (id, provider, provider_shape, external_account_id, created_at, updated_at)
           VALUES (2, 'wise', 'reconciliation', 'account-1', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await db.run(
        `INSERT INTO invoice_payments
          (id, harvest_id, invoice_id, currency, amount_cents, paid_date, source_paid_date, provider,
           provider_shape, provider_transaction_id, created_at, updated_at)
         VALUES (1, 9001, 1, 'USD', 10, '2026-08-27', '2026-08-27', 'manual', 'manual',
           'historical-transaction', ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoice_payments
            (id, harvest_id, invoice_id, currency, amount_cents, paid_date, provider,
             provider_shape, created_at, updated_at)
           VALUES (2, 9001, 1, 'USD', 999, '2026-08-27', 'manual', 'manual', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await expect(
        db.run(
          `INSERT INTO invoice_payments
            (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
             provider_transaction_id, created_at, updated_at)
           VALUES (2, 1, 'usd', 1, '2026-08-27', 'manual', 'manual', '', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/currency must match|CHECK constraint/i)
      await expect(
        db.run(
          `INSERT INTO invoice_payments
            (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
             provider_account_id, created_at, updated_at)
           VALUES (2, 1, 'USD', 1, '2026-08-27', 'stripe', 'checkout', 2, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/CHECK constraint/i)
      for (const statement of [
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           created_at, updated_at)
         VALUES (10, 999, 'USD', 1, '2026-08-27', 'manual', 'manual',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, recorded_by_user_id,
           provider, provider_shape, created_at, updated_at)
         VALUES (10, 1, 'USD', 1, '2026-08-27', 999, 'manual', 'manual',
           '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           provider_account_id, provider_transaction_id, created_at, updated_at)
         VALUES (10, 1, 'USD', 1, '2026-08-27', 'stripe', 'checkout', 999,
           'invalid-account', '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           provider_account_id, provider_transaction_id, bank_deposit_id, created_at, updated_at)
         VALUES (10, 1, 'USD', 1, '2026-08-27', 'wise', 'reconciliation', 1,
           'missing-deposit', 999, '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           provider_account_id, provider_transaction_id, bank_deposit_id, created_at, updated_at)
         VALUES (10, 1, 'USD', 10, '2026-08-27', 'mercury', 'reconciliation', 1,
           'transaction-1', 1, '${timestamp}', '${timestamp}')`,
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           created_at, updated_at)
         VALUES (10, 1, 'EUR', 1, '2026-08-27', 'manual', 'manual',
           '${timestamp}', '${timestamp}')`,
      ]) {
        await expect(db.run(statement)).rejects.toThrow()
      }
      await db.run(
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           provider_account_id, provider_transaction_id, created_at, updated_at)
         VALUES (10, 1, 'USD', 1, '2026-08-27', 'stripe', 'checkout', 2,
           'checkout-transaction', ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO invoice_payments
            (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
             provider_account_id, provider_transaction_id, created_at, updated_at)
           VALUES (11, 1, 'USD', 1, '2026-08-27', 'stripe', 'checkout', 2,
             'checkout-transaction', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
      await db.run(`DELETE FROM invoice_payments WHERE id = 10`)
      await db.run(
        `INSERT INTO invoice_line_items
          (id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
           amount_cents, created_at, updated_at)
         VALUES (10, 500, 1, 0, 'Protected line', 1, 100, 100, ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT OR REPLACE INTO invoice_line_items
            (id, harvest_id, invoice_id, position, kind, quantity, unit_price_cents,
             amount_cents, created_at, updated_at)
           VALUES (11, 500, 2, 1, 'Forged line', 1, 999, 999, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/line identity already exists/)
      await db.run(
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
         VALUES (3, 1, 'INV-LINE-COLLISION', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (12, 3, 0, 'Collision target', 1, 1, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 2, 0, 'Bound', 1, ?, ?, ?, ?)`,
        centsLimit,
        centsLimit,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(`UPDATE OR REPLACE invoice_line_items SET id = 1 WHERE id = 10`),
      ).rejects.toThrow(/line identity already exists/)
      await expect(
        db.run(
          `UPDATE OR REPLACE invoice_line_items
           SET invoice_id = 3, position = 0 WHERE id = 10`,
        ),
      ).rejects.toThrow(/line identity already exists/)
      await expect(
        db.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             created_at, updated_at)
           VALUES (2, 2, 1, 'Overflow', 1, 1, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/absolute aggregate exceeds limit/)
      await db.run(`UPDATE invoices SET tax_rate_ppm = 1000000 WHERE id = 2`)
      await expect(
        db.run(`UPDATE invoice_line_items SET taxed = 1 WHERE id = 1`),
      ).rejects.toThrow(/invoice financial result exceeds limit/)
      expect(
        await db.rows<{ taxed: number; amount: number }>(
          `SELECT line.taxed, invoice.amount_cents AS amount
           FROM invoice_line_items line JOIN invoices invoice ON invoice.id = line.invoice_id
           WHERE line.id = 1`,
        ),
      ).toEqual([{ taxed: 0, amount: centsLimit }])
      await db.run(
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
           created_at, updated_at)
         VALUES (2, 2, 'EUR', ?, '2026-08-27', 'manual', 'manual', ?, ?)`,
        centsLimit,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO invoice_payments
            (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
             created_at, updated_at)
           VALUES (3, 2, 'EUR', 1, '2026-08-27', 'manual', 'manual', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/payment absolute aggregate exceeds limit/)
      await setInvoicePaymentOptions(db.orm, {
        invoiceId: 1,
        paymentOptions: ['wise_transfer'],
        updatedAt: laterTimestamp,
      })
      await setInvoicePaymentOptions(db.orm, {
        invoiceId: 2,
        paymentOptions: ['mercury_transfer'],
        updatedAt: laterTimestamp,
      })
      const references = await db.rows<{ id: number; reference_token: string }>(
        `SELECT id, reference_token FROM invoices WHERE id IN (1, 2) ORDER BY id`,
      )
      await expect(
        db.run(
          `UPDATE OR REPLACE invoices SET reference_token = ? WHERE id = 2`,
          references[0]?.reference_token,
        ),
      ).rejects.toThrow(/reference token already exists/)
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, harvest_id, amount_cents FROM invoice_payments ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, harvest_id: 9001, amount_cents: 10 },
        { id: 2, harvest_id: null, amount_cents: centsLimit },
      ])
      expect(
        await db.rows<Record<string, unknown>>(`SELECT id, amount_cents FROM bank_deposits`),
      ).toEqual([{ id: 1, amount_cents: 10 }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, provider, provider_shape, external_account_id
           FROM payment_provider_accounts ORDER BY id`,
        ),
      ).toEqual([
        {
          id: 1,
          provider: 'wise',
          provider_shape: 'reconciliation',
          external_account_id: 'account-1',
        },
        {
          id: 2,
          provider: 'stripe',
          provider_shape: 'checkout',
          external_account_id: 'checkout-account',
        },
      ])
      expect(
        await db.rows<{ id: number; reference_token: string }>(
          `SELECT id, reference_token FROM invoices WHERE id IN (1, 2) ORDER BY id`,
        ),
      ).toEqual(references)
      expect(
        await db.rows<{ amount: number; due: number }>(
          `SELECT amount_cents AS amount, due_amount_cents AS due FROM invoices WHERE id = 2`,
        ),
      ).toEqual([{ amount: centsLimit, due: 0 }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, harvest_id, invoice_id, position, amount_cents
           FROM invoice_line_items WHERE id = 10`,
        ),
      ).toEqual([{ id: 10, harvest_id: 500, invoice_id: 1, position: 0, amount_cents: 100 }])
      expect(
        await db.rows<{ amount: number; due: number }>(
          `SELECT amount_cents AS amount, due_amount_cents AS due FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ amount: 100, due: 90 }])
    })

    it('[unit] rolls back late failures in line, payment, and confirmation mutations', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Rollback', 1, 100, 100, ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_payments
          (id, invoice_id, currency, amount_cents, paid_at, provider, provider_shape,
           created_at, updated_at)
         VALUES (1, 1, 'USD', 10, ?, 'manual', 'manual', ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO payment_provider_accounts
          (id, provider, provider_shape, external_account_id, created_at, updated_at)
         VALUES (1, 'wise', 'reconciliation', 'rollback-account', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO bank_deposits
          (id, provider_account_id, provider_transaction_id, currency, posted_at,
           amount_cents, match_state, suggested_invoice_id, created_at, updated_at)
         VALUES (1, 1, 'rollback-deposit', 'USD', ?, 25, 'suggested', 1, ?, ?)`,
        timestamp,
        timestamp,
        timestamp,
      )
      await db.run(
        `CREATE TRIGGER invoice_totals_injected_failure
         AFTER UPDATE OF amount_cents ON invoices WHEN NEW.id = 1
         BEGIN SELECT RAISE(ABORT, 'injected totals failure'); END`,
      )
      await expect(
        db.run(`UPDATE invoice_line_items SET amount_cents = 200 WHERE id = 1`),
      ).rejects.toThrow(/injected totals failure/)
      await expect(
        db.run(`UPDATE invoice_payments SET amount_cents = 20 WHERE id = 1`),
      ).rejects.toThrow(/injected totals failure/)
      await expect(
        confirmBankDeposit(db.orm, {
          depositId: 1,
          invoiceId: 1,
          paidAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow()
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT amount_cents FROM invoice_line_items WHERE id = 1`,
        ),
      ).toEqual([{ amount_cents: 100 }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT id, amount_cents, bank_deposit_id FROM invoice_payments ORDER BY id`,
        ),
      ).toEqual([{ id: 1, amount_cents: 10, bank_deposit_id: null }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT match_state, suggested_invoice_id FROM bank_deposits WHERE id = 1`,
        ),
      ).toEqual([{ match_state: 'suggested', suggested_invoice_id: 1 }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT amount_cents, due_amount_cents FROM invoices WHERE id = 1`,
        ),
      ).toEqual([{ amount_cents: 100, due_amount_cents: 90 }])
    })

    it('[unit] defeats outer IGNORE and FAIL policies for overflowing derived results', async () => {
      database = await factory()
      const db = database
      await installBaseFixture(db)
      for (const [offset, policy] of ['IGNORE', 'FAIL'].entries()) {
        const lineInvoiceId = 20 + offset
        const paymentInvoiceId = 30 + offset
        await db.run(
          `INSERT INTO invoices
            (id, client_id, number, currency, issue_date, due_date, tax_rate_ppm,
             tax2_rate_ppm, created_at, updated_at)
           VALUES (?, 1, ?, 'USD', '2026-08-01', '2026-08-31', 1000000, 1000000, ?, ?)`,
          lineInvoiceId,
          `INV-CONFLICT-LINE-${offset}`,
          timestamp,
          timestamp,
        )
        await expect(
          db.run(
            `INSERT OR ${policy} INTO invoice_line_items
              (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
               taxed, taxed2, created_at, updated_at)
             VALUES (?, ?, 0, 'Overflow conflict policy', 1, ?, ?, 1, 1, ?, ?)`,
            20 + offset,
            lineInvoiceId,
            centsLimit,
            centsLimit,
            timestamp,
            timestamp,
          ),
        ).rejects.toThrow(/invoice financial result exceeds limit/)
        expect(
          await db.rows<Record<string, unknown>>(
            `SELECT invoice.amount_cents, invoice.due_amount_cents,
               calculation.amount_cents AS calculated_amount,
               calculation.due_amount_cents AS calculated_due,
               (SELECT count(*) FROM invoice_line_items WHERE invoice_id = ?) AS line_count
             FROM invoices invoice
             JOIN invoice_financial_calculation calculation
               ON calculation.invoice_id = invoice.id
             WHERE invoice.id = ?`,
            lineInvoiceId,
            lineInvoiceId,
          ),
        ).toEqual([
          {
            amount_cents: 0,
            due_amount_cents: 0,
            calculated_amount: 0,
            calculated_due: 0,
            line_count: 0,
          },
        ])

        await db.run(
          `INSERT INTO invoices
            (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
           VALUES (?, 1, ?, 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
          paymentInvoiceId,
          `INV-CONFLICT-PAYMENT-${offset}`,
          timestamp,
          timestamp,
        )
        await db.run(
          `INSERT INTO invoice_line_items
            (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
             created_at, updated_at)
           VALUES (?, ?, 0, 'Negative bound', 1, ?, ?, ?, ?)`,
          30 + offset,
          paymentInvoiceId,
          -centsLimit,
          -centsLimit,
          timestamp,
          timestamp,
        )
        await expect(
          db.run(
            `INSERT OR ${policy} INTO invoice_payments
              (id, invoice_id, currency, amount_cents, paid_date, provider, provider_shape,
               created_at, updated_at)
             VALUES (?, ?, 'USD', ?, '2026-08-27', 'manual', 'manual', ?, ?)`,
            30 + offset,
            paymentInvoiceId,
            centsLimit,
            timestamp,
            timestamp,
          ),
        ).rejects.toThrow(/invoice financial result exceeds limit/)
        expect(
          await db.rows<Record<string, unknown>>(
            `SELECT amount_cents, due_amount_cents,
               (SELECT count(*) FROM invoice_payments WHERE invoice_id = ?) AS payment_count
             FROM invoices WHERE id = ?`,
            paymentInvoiceId,
            paymentInvoiceId,
          ),
        ).toEqual([
          {
            amount_cents: -centsLimit,
            due_amount_cents: -centsLimit,
            payment_count: 0,
          },
        ])
      }
    })

    it('[unit] rejects unsafe legacy line aggregates without floating point', async () => {
      database = await factory(false)
      const db = database
      await installThrough0004(db)
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Unsafe legacy', 1, 9223372036854775807,
           9223372036854775807, ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(({ name }) => name),
      ).not.toContain('tax_rate_ppm')
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE name = 'invoice_payments'`,
        ),
      ).toEqual([])
      await db.run(`DELETE FROM invoice_line_items`)
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toContainEqual({ id: '0005_invoice_payments_totals' })
    })

    it('[unit] rolls back a final-trigger conflict after every ALTER and retries cleanly', async () => {
      database = await factory(false)
      const db = database
      await installThrough0004(db)
      await installBaseFixture(db)
      await db.run(
        `CREATE TRIGGER invoices_derived_totals_canonical
         AFTER UPDATE ON invoices BEGIN SELECT 1; END`,
      )
      const before = await db.rows<Record<string, unknown>>(
        `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
      )
      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
        ),
      ).toEqual(before)
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(invoices)`)).map(({ name }) => name),
      ).not.toContain('tax_rate_ppm')
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).not.toContainEqual({ id: '0005_invoice_payments_totals' })
      await db.run(`DROP TRIGGER invoices_derived_totals_canonical`)
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toContainEqual({ id: '0005_invoice_payments_totals' })
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })
  })
}

describe('invoice money helpers', () => {
  it('[unit] converts exact decimal percentages to ppm without floating point', () => {
    expect(percentageToRatePpm('0')).toBe(0)
    expect(percentageToRatePpm('2')).toBe(20_000)
    expect(percentageToRatePpm('7.25')).toBe(72_500)
    expect(percentageToRatePpm('100.0000')).toBe(1_000_000)
    for (const invalid of ['-1', '1.00001', '100.0001', '101', '1e1', '.5']) {
      expect(() => percentageToRatePpm(invalid)).toThrow()
    }
  })

  it('[unit] refuses to round imported payment money', () => {
    expect(amountToExactCents(125.5)).toBe(12550)
    expect(() => amountToExactCents(1.001)).toThrow(/two decimal places/)
  })

  it('[unit] re-emits native payment dates with Harvest-compatible paired fields', () => {
    expect(
      reemitHarvestPaymentDates({
        paidAt: '2026-08-27T14:15:16Z',
        paidDate: null,
        sourcePaidAt: null,
        sourcePaidDate: null,
      }),
    ).toEqual({ paidAt: '2026-08-27T14:15:16Z', paidDate: '2026-08-27' })
    expect(
      reemitHarvestPaymentDates({
        paidAt: null,
        paidDate: '2026-08-27',
        sourcePaidAt: null,
        sourcePaidDate: null,
      }),
    ).toEqual({ paidAt: '2026-08-27T00:00:00Z', paidDate: '2026-08-27' })
  })
})
