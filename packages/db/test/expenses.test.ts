import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createExpense } from '../src/expenses.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'

type OrmDatabase = Parameters<typeof createExpense>[0]

interface TestDatabase {
  orm: OrmDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

interface HarvestExpenseCategory {
  id: number
  name: string
  unit_name: string | null
  unit_price: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

interface HarvestExpense {
  id: number
  client: { id: number; name: string; currency: string }
  project: { id: number; name: string; code: string }
  expense_category: {
    id: number
    name: string
    unit_price: number | null
    unit_name: string | null
  }
  user: { id: number; name: string }
  invoice: { id: number; number: string } | null
  receipt: { url: string; file_name: string; file_size: number; content_type: string } | null
  notes: string | null
  units: number | null
  total_cost: number
  billable: boolean
  is_closed: boolean
  approval_status: 'unsubmitted' | 'submitted' | 'approved'
  is_locked: boolean
  is_billed: boolean
  locked_reason: string | null
  spent_date: string
  created_at: string
  updated_at: string
}

const timestamp = '2026-08-27T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })
const migrationsThrough0005 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
] as const

const loadFixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8')) as T

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
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

const installThrough0005 = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const [id, statements] of migrationsThrough0005) {
    for (const statement of statements) await database.run(statement)
    await database.run(
      `INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)`,
      id,
      timestamp,
    )
  }
}

const seedOrganizationPeopleProjects = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', ?, ?, ?)`,
    modules,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users
      (id, harvest_id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 1782959, 'Sanitized', 'Creator', '[]', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES
       (1, 5735776, 'Sanitized Client', 'USD', ?, ?),
       (2, 5735777, 'Other Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects (id, harvest_id, client_id, name, code, created_at, updated_at)
     VALUES
       (1, 14308069, 1, 'Migration', 'MIG', ?, ?),
       (2, 14308070, 2, 'Other', 'OTHER', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const seedInvoices = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO invoices
      (id, harvest_id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES
       (1, 12000001, 1, 'INV-EXPENSE', 'USD', '2026-08-01', '2026-08-31', ?, ?),
       (2, 12000002, 2, 'INV-OTHER', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const insertCategory = async (
  database: TestDatabase,
  id: number,
  name: string,
  unitPriceCents: number | null,
): Promise<void> => {
  await database.run(
    `INSERT INTO expense_categories
      (id, name, unit_name, unit_price_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    name,
    unitPriceCents === null ? null : 'unit',
    unitPriceCents,
    timestamp,
    timestamp,
  )
}

const cents = (value: number): number => {
  const scaled = value * 100
  if (!Number.isSafeInteger(scaled)) {
    throw new Error('Harvest money must have at most two decimal places')
  }
  return scaled
}

for (const [runtime, factory] of factories) {
  describe(`expense schema (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] installs the exact expense/category storage without lock or attachment fields', async () => {
      database = await factory()
      const db = database
      expect(
        await db.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id = '0007_expenses'`,
        ),
      ).toEqual([{ id: '0007_expenses' }])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(expense_categories)`)).map(
          ({ name }) => name,
        ),
      ).toEqual([
        'id',
        'harvest_id',
        'name',
        'unit_name',
        'unit_price_cents',
        'is_active',
        'created_at',
        'updated_at',
      ])
      const expenseColumns = (await db.rows<{ name: string }>(`PRAGMA table_info(expenses)`)).map(
        ({ name }) => name,
      )
      expect(expenseColumns).toEqual([
        'id',
        'harvest_id',
        'user_id',
        'project_id',
        'expense_category_id',
        'spent_date',
        'notes',
        'units',
        'total_cost_cents',
        'billable',
        'approval_status',
        'invoice_id',
        'reimbursable',
        'reimbursement_status',
        'payout_ref',
        'created_at',
        'updated_at',
      ])
      for (const forbidden of [
        'is_locked',
        'locked',
        'locked_reason',
        'locked_reason_code',
        'is_billed',
        'receipt_id',
        'attachment_id',
      ]) {
        expect(expenseColumns).not.toContain(forbidden)
      }
      const tables = (
        await db.rows<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      ).map(({ name }) => name)
      expect(tables).not.toContain('receipts')
      expect(tables).not.toContain('attachments')
      expect(tables).not.toContain('file_objects')
    })

    it('[unit] upgrades a populated invoice-foundation database without row loss', async () => {
      database = await factory(false)
      const db = database
      await installThrough0005(db)
      await seedOrganizationPeopleProjects(db)
      await seedInvoices(db)
      await db.run(
        `INSERT INTO invoice_item_categories
          (id, name, created_at, updated_at) VALUES (1, 'Service', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO invoice_line_items
          (id, invoice_id, position, kind, quantity, unit_price_cents, amount_cents,
           created_at, updated_at)
         VALUES (1, 1, 0, 'Service', 1, 1000, 1000, ?, ?)`,
        timestamp,
        timestamp,
      )
      const before = {
        invoices: await db.rows<Record<string, unknown>>(
          `SELECT id, harvest_id, number FROM invoices ORDER BY id`,
        ),
        lines: await db.rows<Record<string, unknown>>(
          `SELECT id, invoice_id, amount_cents FROM invoice_line_items ORDER BY id`,
        ),
      }

      await db.migrateAgain()
      expect(await db.rows(`SELECT id, harvest_id, number FROM invoices ORDER BY id`)).toEqual(
        before.invoices,
      )
      expect(
        await db.rows(`SELECT id, invoice_id, amount_cents FROM invoice_line_items ORDER BY id`),
      ).toEqual(before.lines)
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
      const ledger = await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`)
      expect(ledger.at(-1)).toEqual({ id: '0007_expenses' })
      await db.migrateAgain()
      expect(await db.rows(`SELECT id FROM _ezacto_migrations ORDER BY id`)).toEqual(ledger)
    })

    it('[unit] rolls back a failed expense migration and retries without partial schema', async () => {
      database = await factory(false)
      const db = database
      await installThrough0005(db)
      await seedOrganizationPeopleProjects(db)
      await seedInvoices(db)
      await db.run(`CREATE TABLE expenses (id INTEGER PRIMARY KEY) STRICT`)

      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id IN
            ('0006_invoice_state_events', '0007_expenses') ORDER BY id`,
        ),
      ).toEqual([{ id: '0006_invoice_state_events' }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('expense_categories', 'expenses') ORDER BY name`,
        ),
      ).toEqual([{ name: 'expenses' }])
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(expenses)`)).map(({ name }) => name),
      ).toEqual(['id'])

      await db.run(`DROP TABLE expenses`)
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations WHERE id = '0007_expenses'`,
        ),
      ).toEqual([{ id: '0007_expenses' }])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] enforces real references and invoice/project client consistency', async () => {
      database = await factory()
      const db = database
      await seedOrganizationPeopleProjects(db)
      await seedInvoices(db)
      await insertCategory(db, 1, 'Travel', null)
      const insert = (
        id: number,
        userId: number,
        projectId: number,
        categoryId: number,
        invoiceId: number | null,
      ) =>
        db.run(
          `INSERT INTO expenses
            (id, user_id, project_id, expense_category_id, spent_date, total_cost_cents,
             invoice_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, '2026-08-15', 1000, ?, ?, ?)`,
          id,
          userId,
          projectId,
          categoryId,
          invoiceId,
          timestamp,
          timestamp,
        )
      await expect(insert(1, 999, 1, 1, null)).rejects.toThrow(/foreign key/i)
      await expect(insert(2, 1, 999, 1, null)).rejects.toThrow(/foreign key/i)
      await expect(insert(3, 1, 1, 999, null)).rejects.toThrow(/foreign key/i)
      await expect(insert(4, 1, 1, 1, 999)).rejects.toThrow()
      await expect(insert(5, 1, 1, 1, 2)).rejects.toThrow(
        /expense project must belong to invoice client/,
      )
      await insert(6, 1, 1, 1, null)
      await db.run(`UPDATE expenses SET invoice_id = 1 WHERE id = 6`)
      await expect(db.run(`UPDATE expenses SET project_id = 2 WHERE id = 6`)).rejects.toThrow(
        /expense project must belong to invoice client/,
      )
      await expect(db.run(`UPDATE expenses SET invoice_id = 2 WHERE id = 6`)).rejects.toThrow(
        /expense project must belong to invoice client/,
      )
      await expect(db.run(`UPDATE invoices SET client_id = 2 WHERE id = 1`)).rejects.toThrow(
        /invoice client must match every linked project/,
      )
      await expect(db.run(`UPDATE projects SET client_id = 2 WHERE id = 1`)).rejects.toThrow(
        /project client is immutable while invoices are linked/,
      )
      await db.run(`UPDATE expense_categories SET is_active = 0 WHERE id = 1`)
      await expect(db.run(`DELETE FROM expense_categories WHERE id = 1`)).rejects.toThrow(
        /foreign key/i,
      )
      expect(await db.rows(`SELECT is_active FROM expense_categories WHERE id = 1`)).toEqual([
        { is_active: 0 },
      ])
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] computes unit-priced cents and accepts direct-cost cents through one operation', async () => {
      database = await factory()
      const db = database
      await seedOrganizationPeopleProjects(db)
      await seedInvoices(db)
      await insertCategory(db, 1, 'Mileage', 65)
      await insertCategory(db, 2, 'Travel', null)
      await insertCategory(db, 3, 'Zero price', 0)
      await insertCategory(db, 4, 'Maximum price', 9_000_000_000_000)
      const base = {
        userId: 1,
        projectId: 1,
        spentDate: '2026-08-15',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const unitExpense = await createExpense(db.orm, {
        ...base,
        expenseCategoryId: 1,
        units: 125,
      })
      expect(unitExpense).toMatchObject({ units: 125, totalCostCents: 8125, billable: true })
      const directExpense = await createExpense(db.orm, {
        ...base,
        expenseCategoryId: 2,
        totalCostCents: 4500,
      })
      expect(directExpense).toMatchObject({ units: null, totalCostCents: 4500 })
      await expect(
        createExpense(db.orm, { ...base, expenseCategoryId: 1, totalCostCents: 8125 }),
      ).rejects.toThrow(/compute totalCostCents/)
      await expect(
        createExpense(db.orm, { ...base, expenseCategoryId: 1, units: 125, totalCostCents: 8125 }),
      ).rejects.toThrow(/compute totalCostCents/)
      await expect(
        createExpense(db.orm, { ...base, expenseCategoryId: 2, units: 1 }),
      ).rejects.toThrow(/do not accept units/)
      await expect(createExpense(db.orm, { ...base, expenseCategoryId: 2 })).rejects.toThrow(
        /requires units or totalCostCents/,
      )
      expect(
        await createExpense(db.orm, { ...base, expenseCategoryId: 3, units: 0 }),
      ).toMatchObject({ units: 0, totalCostCents: 0 })
      expect(
        await createExpense(db.orm, { ...base, expenseCategoryId: 4, units: 1 }),
      ).toMatchObject({ totalCostCents: 9_000_000_000_000 })
      await expect(
        createExpense(db.orm, { ...base, expenseCategoryId: 4, units: 2 }),
      ).rejects.toThrow(/supported money range|at most/)
      await expect(
        createExpense(db.orm, { ...base, expenseCategoryId: 2, totalCostCents: -1 }),
      ).rejects.toThrow(/non-negative/)

      await db.run(`UPDATE expense_categories SET unit_price_cents = 70 WHERE id = 1`)
      await db.run(
        `UPDATE expenses SET notes = 'historical amount retained' WHERE id = ?`,
        unitExpense.id,
      )
      await db.run(
        `UPDATE expenses SET units = units, total_cost_cents = total_cost_cents WHERE id = ?`,
        unitExpense.id,
      )
      await db.run(
        `INSERT INTO expenses
          (harvest_id, user_id, project_id, expense_category_id, spent_date, units,
           total_cost_cents, created_at, updated_at)
         VALUES (990001, 1, 1, 1, '2026-08-14', 125, 8125, ?, ?)`,
        timestamp,
        timestamp,
      )
      const repricedExpense = await createExpense(db.orm, {
        ...base,
        expenseCategoryId: 1,
        units: 125,
      })
      expect(repricedExpense.totalCostCents).toBe(8750)
      expect(
        await db.rows<{ units: number; total_cost_cents: number; notes: string }>(
          `SELECT units, total_cost_cents, notes FROM expenses WHERE id = ?`,
          unitExpense.id,
        ),
      ).toEqual([{ units: 125, total_cost_cents: 8125, notes: 'historical amount retained' }])
    })

    it('[unit] constrains approval/reimbursement enums and keeps payout references nullable', async () => {
      database = await factory()
      const db = database
      await seedOrganizationPeopleProjects(db)
      await insertCategory(db, 1, 'Travel', null)
      for (const [index, status] of ['none', 'pending', 'approved', 'paid'].entries()) {
        await db.run(
          `INSERT INTO expenses
            (id, user_id, project_id, expense_category_id, spent_date, total_cost_cents,
             reimbursable, reimbursement_status, payout_ref, created_at, updated_at)
           VALUES (?, 1, 1, 1, '2026-08-15', 1000, 1, ?, NULL, ?, ?)`,
          index + 1,
          status,
          timestamp,
          timestamp,
        )
      }
      await expect(
        db.run(
          `INSERT INTO expenses
            (user_id, project_id, expense_category_id, spent_date, total_cost_cents,
             reimbursable, reimbursement_status, created_at, updated_at)
           VALUES (1, 1, 1, '2026-08-15', 1000, 1, 'sent', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/check constraint/i)
      await expect(
        db.run(
          `INSERT INTO expenses
            (user_id, project_id, expense_category_id, spent_date, total_cost_cents,
             reimbursable, created_at, updated_at)
           VALUES (1, 1, 1, '2026-08-15', 1000, 2, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/check constraint/i)
      await db.run(
        `INSERT INTO expenses
          (id, user_id, project_id, expense_category_id, spent_date, total_cost_cents,
           reimbursable, reimbursement_status, payout_ref, created_at, updated_at)
         VALUES (5, 1, 1, 1, '2026-08-15', 1000, 0, 'pending', 'payout-123', ?, ?)`,
        timestamp,
        timestamp,
      )
      await expect(
        db.run(
          `INSERT INTO expenses
            (user_id, project_id, expense_category_id, spent_date, total_cost_cents,
             approval_status, created_at, updated_at)
           VALUES (1, 1, 1, '2026-08-15', 1000, 'closed', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/check constraint/i)
      expect(
        await db.rows<{ reimbursement_status: string; payout_ref: string | null }>(
          `SELECT reimbursement_status, payout_ref FROM expenses ORDER BY id`,
        ),
      ).toEqual([
        ...['none', 'pending', 'approved', 'paid'].map((reimbursement_status) => ({
          reimbursement_status,
          payout_ref: null,
        })),
        { reimbursement_status: 'pending', payout_ref: 'payout-123' },
      ])
    })

    it('[unit] maps sanitized Harvest category/expense fixtures without receipt placeholders', async () => {
      database = await factory()
      const db = database
      await seedOrganizationPeopleProjects(db)
      await seedInvoices(db)
      const category = await loadFixture<HarvestExpenseCategory>('harvest-expense-category.json')
      const expense = await loadFixture<HarvestExpense>('harvest-expense.json')
      const directCategory = await loadFixture<HarvestExpenseCategory>(
        'harvest-expense-direct-category.json',
      )
      const directExpense = await loadFixture<HarvestExpense>('harvest-expense-direct.json')
      for (const [index, source] of [category, directCategory].entries()) {
        await db.run(
          `INSERT INTO expense_categories
            (id, harvest_id, name, unit_name, unit_price_cents, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          index + 1,
          source.id,
          source.name,
          source.unit_name,
          source.unit_price === null ? null : cents(source.unit_price),
          source.is_active ? 1 : 0,
          source.created_at,
          source.updated_at,
        )
      }
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT harvest_id, name, unit_name, unit_price_cents, is_active, created_at, updated_at
           FROM expense_categories ORDER BY id`,
        ),
      ).toEqual(
        [category, directCategory].map((source) => ({
          harvest_id: source.id,
          name: source.name,
          unit_name: source.unit_name,
          unit_price_cents: source.unit_price === null ? null : cents(source.unit_price),
          is_active: source.is_active ? 1 : 0,
          created_at: source.created_at,
          updated_at: source.updated_at,
        })),
      )
      for (const [index, source] of [expense, directExpense].entries()) {
        await db.run(
          `INSERT INTO expenses
            (id, harvest_id, user_id, project_id, expense_category_id, spent_date, notes,
             units, total_cost_cents, billable, approval_status, invoice_id, created_at, updated_at)
           VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          index + 1,
          source.id,
          index + 1,
          source.spent_date,
          source.notes,
          source.units,
          cents(source.total_cost),
          source.billable ? 1 : 0,
          source.approval_status,
          source.invoice ? 1 : null,
          source.created_at,
          source.updated_at,
        )
      }
      const roundTrips = await db.rows<Record<string, unknown>>(
        `SELECT expense.harvest_id AS id,
          client.harvest_id AS client_id, client.name AS client_name, client.currency,
          project.harvest_id AS project_id, project.name AS project_name, project.code,
          category.harvest_id AS category_id, category.name AS category_name,
          category.unit_name, category.unit_price_cents,
          user.harvest_id AS user_id,
          invoice.harvest_id AS invoice_id, invoice.number AS invoice_number,
          expense.notes, expense.units, expense.total_cost_cents, expense.billable,
          expense.approval_status, expense.spent_date, expense.created_at, expense.updated_at
         FROM expenses expense
         JOIN projects project ON project.id = expense.project_id
         JOIN clients client ON client.id = project.client_id
         JOIN expense_categories category ON category.id = expense.expense_category_id
         JOIN users user ON user.id = expense.user_id
         LEFT JOIN invoices invoice ON invoice.id = expense.invoice_id
         ORDER BY expense.id`,
      )
      const expectedRoundTrip = (source: HarvestExpense) => ({
        id: source.id,
        client_id: source.client.id,
        client_name: source.client.name,
        currency: source.client.currency,
        project_id: source.project.id,
        project_name: source.project.name,
        code: source.project.code,
        category_id: source.expense_category.id,
        category_name: source.expense_category.name,
        unit_name: source.expense_category.unit_name,
        unit_price_cents:
          source.expense_category.unit_price === null
            ? null
            : cents(source.expense_category.unit_price),
        user_id: source.user.id,
        invoice_id: source.invoice?.id ?? null,
        invoice_number: source.invoice?.number ?? null,
        notes: source.notes,
        units: source.units,
        total_cost_cents: cents(source.total_cost),
        billable: source.billable ? 1 : 0,
        approval_status: source.approval_status,
        spent_date: source.spent_date,
        created_at: source.created_at,
        updated_at: source.updated_at,
      })
      expect(roundTrips).toEqual([expectedRoundTrip(expense), expectedRoundTrip(directExpense)])
      expect(expense.receipt).not.toBeNull()
      expect(
        (await db.rows<{ name: string }>(`PRAGMA table_info(expenses)`)).map(({ name }) => name),
      ).not.toEqual(expect.arrayContaining(['receipt_id', 'attachment_id', 'is_locked']))
      expect(expense.is_billed).toBe(true)
      expect(expense.is_closed).toBe(false)
      expect(directExpense.units).toBe(1)
      expect(directExpense.expense_category.unit_price).toBeNull()
      expect(await db.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })
  })
}

it('[unit] rejects silently rounded Harvest money', () => {
  expect(cents(81.25)).toBe(8125)
  expect(() => cents(0.585)).toThrow(/at most two decimal places/)
})
