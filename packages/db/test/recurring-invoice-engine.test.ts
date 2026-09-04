import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createRecurringInvoiceDefinition,
  type CreateRecurringInvoiceDefinitionInput,
  type RecurringInvoiceDatabase,
} from '../src/recurring-invoices.js'
import {
  anchoredDate,
  advanceIssueDate,
  createRecurringInvoiceEngine,
  RecurringEngineError,
  type RecurringEngineDatabase,
} from '../src/recurring-invoice-engine.js'

interface TestDatabase {
  orm: RecurringEngineDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const timestamp = '2026-08-28T12:00:00.000Z'

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<T>()).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

const seedDatabase = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?),
            (2, 'Other Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users (id, email, display_name, profile, is_active, created_at, updated_at)
     VALUES (1, 'admin@sanitized.example', 'Admin', 'administrator', 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
     VALUES (1, 1, 'Sanitized Project', 'SAN-1', ?, ?)`,
    timestamp,
    timestamp,
  )
}

const seedRetainer = async (database: TestDatabase, retainerId: number, clientId: number, balanceCents: number): Promise<void> => {
  await database.run(
    `INSERT INTO retainers (id, client_id, denomination, amount_cents, seconds, created_at, updated_at)
     VALUES (?, ?, 'money', ?, NULL, ?, ?)`,
    retainerId,
    clientId,
    balanceCents,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO retainer_ledger (id, retainer_id, kind, unit, amount, occurred_on, notes, created_at)
     VALUES (?, ?, 'deposit', 'cents', ?, '2026-08-01', 'Initial deposit', ?)`,
    `seed:${retainerId}`,
    retainerId,
    balanceCents,
    timestamp,
  )
}

const fixedAmountConfig = {
  schema_version: 1 as const,
  type: 'fixed_lines' as const,
  line_items: [
    {
      kind: 'Service',
      description: 'Sanitized monthly service',
      quantity: 1,
      unit_price_cents: 125_000,
      taxed: true,
      taxed2: false,
      project_id: null,
    },
  ],
}

const createInput = (
  overrides: Partial<CreateRecurringInvoiceDefinitionInput> = {},
): CreateRecurringInvoiceDefinitionInput => ({
  clientId: 1,
  subjectTemplate: 'Services for %invoice_issue_month_name%',
  notesTemplate: '',
  everyNMonths: 1,
  dayOfMonth: 31,
  nextIssueOn: '2026-08-31',
  amountConfig: fixedAmountConfig,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
})

const principal = { userId: 1, profile: 'administrator' }

describe('anchoredDate', () => {
  it('[unit] handles month-end anchors across short months', () => {
    expect(anchoredDate(31, 2026, 1)).toBe('2026-01-31')
    expect(anchoredDate(31, 2026, 2)).toBe('2026-02-28')
    expect(anchoredDate(31, 2024, 2)).toBe('2024-02-29')
    expect(anchoredDate(30, 2026, 2)).toBe('2026-02-28')
    expect(anchoredDate(29, 2026, 2)).toBe('2026-02-28')
    expect(anchoredDate(29, 2024, 2)).toBe('2024-02-29')
    expect(anchoredDate(31, 2026, 4)).toBe('2026-04-30')
    expect(anchoredDate(31, 2026, 6)).toBe('2026-06-30')
    expect(anchoredDate(31, 2026, 9)).toBe('2026-09-30')
    expect(anchoredDate(31, 2026, 11)).toBe('2026-11-30')
    expect(anchoredDate(15, 2026, 3)).toBe('2026-03-15')
    expect(anchoredDate(1, 2026, 12)).toBe('2026-12-01')
  })
})

describe('advanceIssueDate', () => {
  it('[unit] advances by N months preserving day anchoring', () => {
    expect(advanceIssueDate('2026-01-31', 1, 31)).toBe('2026-02-28')
    expect(advanceIssueDate('2026-02-28', 1, 31)).toBe('2026-03-31')
    expect(advanceIssueDate('2026-08-31', 1, 31)).toBe('2026-09-30')
    expect(advanceIssueDate('2026-09-30', 1, 31)).toBe('2026-10-31')
    expect(advanceIssueDate('2026-10-31', 1, 31)).toBe('2026-11-30')
    expect(advanceIssueDate('2026-11-30', 1, 31)).toBe('2026-12-31')
    expect(advanceIssueDate('2026-12-31', 1, 31)).toBe('2027-01-31')

    expect(advanceIssueDate('2026-01-15', 3, 15)).toBe('2026-04-15')
    expect(advanceIssueDate('2026-10-15', 3, 15)).toBe('2027-01-15')

    expect(advanceIssueDate('2026-01-31', 12, 31)).toBe('2027-01-31')
  })
})

for (const [runtime, factory] of factories) {
  describe(`recurring invoice engine (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] generates a fixed-lines invoice from a due definition', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31', dayOfMonth: 31 }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })
      const result = await engine.generate(definition.id, '2026-08-31', principal)

      expect(result).toMatchObject({
        definitionId: definition.id,
        period: '2026-08-31',
        nextIssueOn: '2026-09-30',
      })
      expect(result.invoiceId).toBeGreaterThan(0)

      const invoice = await database.rows<{
        id: number
        subject: string
        client_id: number
        recurring_invoice_id: number
        amount_cents: number
      }>(
        `SELECT id, subject, client_id, recurring_invoice_id, amount_cents
         FROM invoices WHERE id = ?`,
        result.invoiceId,
      )
      expect(invoice).toHaveLength(1)
      expect(invoice[0]).toMatchObject({
        subject: 'Services for August',
        client_id: 1,
        recurring_invoice_id: definition.id,
      })

      const lineItems = await database.rows<{
        kind: string
        description: string
        quantity: number
        unit_price_cents: number
        amount_cents: number
      }>(
        `SELECT kind, description, quantity, unit_price_cents, amount_cents
         FROM invoice_line_items WHERE invoice_id = ?`,
        result.invoiceId,
      )
      expect(lineItems).toHaveLength(1)
      expect(lineItems[0]).toMatchObject({
        kind: 'Service',
        description: 'Sanitized monthly service',
        quantity: 1,
        unit_price_cents: 125_000,
        amount_cents: 125_000,
      })

      const updatedDef = await database.rows<{ next_issue_on: string }>(
        `SELECT next_issue_on FROM recurring_invoices WHERE id = ?`,
        definition.id,
      )
      expect(updatedDef[0]!.next_issue_on).toBe('2026-09-30')
    }, 20_000)

    it('[unit] month-end anchors (29/30/31) generate correctly across short months', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-01-31', dayOfMonth: 31 }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-01-31T10:00:00.000Z',
      })

      const jan = await engine.generate(definition.id, '2026-01-31', principal)
      expect(jan.period).toBe('2026-01-31')
      expect(jan.nextIssueOn).toBe('2026-02-28')

      await database.run(
        `UPDATE recurring_invoices SET next_issue_on = ? WHERE id = ?`,
        '2026-02-28',
        definition.id,
      )
      const feb = await engine.generate(definition.id, '2026-02-28', principal)
      expect(feb.period).toBe('2026-02-28')
      expect(feb.nextIssueOn).toBe('2026-03-31')

      await database.run(
        `UPDATE recurring_invoices SET next_issue_on = ? WHERE id = ?`,
        '2026-03-31',
        definition.id,
      )
      const mar = await engine.generate(definition.id, '2026-03-31', principal)
      expect(mar.period).toBe('2026-03-31')
      expect(mar.nextIssueOn).toBe('2026-04-30')
    }, 20_000)

    it('[unit] generation is idempotent per (definition, period)', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31', dayOfMonth: 31 }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      const first = await engine.generate(definition.id, '2026-08-31', principal)
      const second = await engine.generate(definition.id, '2026-08-31', principal)

      expect(first.invoiceId).toBe(second.invoiceId)
      expect(first.period).toBe(second.period)
      expect(first.nextIssueOn).toBe(second.nextIssueOn)

      const invoices = await database.rows<{ count: number }>(
        `SELECT count(*) AS count FROM invoices WHERE recurring_invoice_id = ?`,
        definition.id,
      )
      expect(invoices[0]!.count).toBe(1)
    }, 20_000)

    it('[api] recurring linked to retainer decrements ledger on generation', async () => {
      database = await factory()
      await seedDatabase(database)
      await seedRetainer(database, 1, 1, 500_000)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-08-31',
          dayOfMonth: 31,
          canDrawFromRetainerId: 1,
        }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      const result = await engine.generate(definition.id, '2026-08-31', principal)
      expect(result.retainerDrawdownCents).toBe(125_000)

      const ledger = await database.rows<{ kind: string; amount: number; invoice_id: number }>(
        `SELECT kind, amount, invoice_id FROM retainer_ledger
         WHERE retainer_id = 1 AND kind = 'drawdown'`,
      )
      expect(ledger).toHaveLength(1)
      expect(ledger[0]).toMatchObject({
        kind: 'drawdown',
        amount: -125_000,
        invoice_id: result.invoiceId,
      })

      const balance = await database.rows<{ balance: number }>(
        `SELECT balance FROM retainer_balances WHERE retainer_id = 1`,
      )
      expect(balance[0]!.balance).toBe(375_000)
    }, 20_000)

    it('[unit] generation consumes only schema-validated recurring config; unknown versions fail closed', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31' }),
      )

      await database.run(
        `UPDATE recurring_invoices SET amount_config = ? WHERE id = ?`,
        JSON.stringify({ schema_version: 2, type: 'fixed_lines', line_items: [] }),
        definition.id,
      )

      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })
      await expect(
        engine.generate(definition.id, '2026-08-31', principal),
      ).rejects.toThrow()
    }, 20_000)

    it('[unit] rejects generation when definition is not yet due', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-30' }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      await expect(
        engine.generate(definition.id, '2026-08-31', principal),
      ).rejects.toThrow(RecurringEngineError)
    }, 20_000)

    it('[unit] rejects generation with wrong profile', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31' }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      await expect(
        engine.generate(definition.id, '2026-08-31', { userId: 1, profile: 'member' }),
      ).rejects.toThrow(RecurringEngineError)
    }, 20_000)

    it('[unit] rejects generation for nonexistent definition', async () => {
      database = await factory()
      await seedDatabase(database)
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      await expect(
        engine.generate(99999, '2026-08-31', principal),
      ).rejects.toThrow(RecurringEngineError)
    }, 20_000)

    it('[unit] rejects generation with invalid attachment policy version', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31' }),
      )
      await database.run(
        `UPDATE recurring_invoices SET attachment_policy = ? WHERE id = ?`,
        JSON.stringify({ schema_version: 2, type: 'static', attachment_ids: [1] }),
        definition.id,
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      await expect(
        engine.generate(definition.id, '2026-08-31', principal),
      ).rejects.toThrow()
    }, 20_000)

    it('[unit] generates invoices with multi-line definitions', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-08-31',
          amountConfig: {
            schema_version: 1,
            type: 'fixed_lines',
            line_items: [
              {
                kind: 'Service',
                description: 'Development',
                quantity: 40,
                unit_price_cents: 15_000,
                taxed: true,
                taxed2: false,
                project_id: 1,
              },
              {
                kind: 'Service',
                description: 'Hosting',
                quantity: 1,
                unit_price_cents: 5_000,
                taxed: false,
                taxed2: false,
                project_id: null,
              },
            ],
          },
        }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      const result = await engine.generate(definition.id, '2026-08-31', principal)
      const lineItems = await database.rows<{ kind: string; description: string; amount_cents: number }>(
        `SELECT kind, description, amount_cents FROM invoice_line_items
         WHERE invoice_id = ? ORDER BY position`,
        result.invoiceId,
      )
      expect(lineItems).toHaveLength(2)
      expect(lineItems[0]!.description).toBe('Development')
      expect(lineItems[0]!.amount_cents).toBe(600_000)
      expect(lineItems[1]!.description).toBe('Hosting')
      expect(lineItems[1]!.amount_cents).toBe(5_000)
    }, 20_000)
  })
}
