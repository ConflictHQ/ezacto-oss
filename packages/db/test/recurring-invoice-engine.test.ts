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
    `INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
     VALUES (1, 'Admin', 'User', 'administrator', 1, '[]', ?, ?)`,
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
    // 'deposit' and 'drawdown' must reference an invoice; an opening balance has
    // no invoice behind it, and 'reset' is the kind the schema provides for
    // establishing one.
    `INSERT INTO retainer_ledger (id, retainer_id, kind, unit, amount, occurred_on, notes, created_at)
     VALUES (?, ?, 'reset', 'cents', ?, '2026-08-01', 'Opening balance', ?)`,
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

/** A line that stops, alongside one that does not. */
const decayingLine = (through: string | null) => ({
  kind: 'Service' as const,
  description: 'Credit 1 of 4',
  quantity: 1,
  unit_price_cents: -62_500,
  taxed: false,
  taxed2: false,
  project_id: null,
  through,
})

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

const principal = { type: 'user', userId: 1, profile: 'administrator' } as const
const systemPrincipal = { type: 'system' } as const

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

    it('[unit] drops a line once the issue date passes its through date', async () => {
      // The case this exists for: an imported definition carrying a credit that
      // decays. Harvest tracked "CREDIT 1 of 4" in the description, where no
      // software could act on it, so the credit either ran forever or somebody
      // remembered to delete it.
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-08-31',
          dayOfMonth: 31,
          amountConfig: {
            ...fixedAmountConfig,
            line_items: [fixedAmountConfig.line_items[0]!, decayingLine('2026-08-31')],
          },
        }),
      )

      // On the through date itself the line still appears -- `through` is the
      // last date it is on, not the first it is off.
      const onTheDay = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      }).generate(definition.id, '2026-08-31', principal)
      const included = await database.rows<{ amount_cents: number }>(
        `SELECT amount_cents FROM invoice_line_items WHERE invoice_id = ? ORDER BY position`,
        onTheDay.invoiceId,
      )
      expect(included.map((line) => line.amount_cents)).toEqual([125_000, -62_500])

      // The month after, only the line that never stops.
      const after = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-30T10:00:00.000Z',
      }).generate(definition.id, '2026-09-30', principal)
      const remaining = await database.rows<{ amount_cents: number; position: number }>(
        `SELECT amount_cents, position FROM invoice_line_items WHERE invoice_id = ? ORDER BY position`,
        after.invoiceId,
      )
      expect(remaining.map((line) => line.amount_cents)).toEqual([125_000])
      // And it is line 0, not line 0 with a hole where the credit was.
      expect(remaining.map((line) => line.position)).toEqual([0])
    })

    it('[unit] counts a finite line off against its own total as it runs out', async () => {
      // The other half of the `through` story. That test proved a decaying line
      // stops; this one proves it can say where it is while it runs. The comment
      // above notes Harvest wrote "CREDIT 1 of 4" as prose no software could act
      // on, so the number was either right by luck or wrong by inattention --
      // and a definition imported from it carries whichever ordinal happened to
      // be on the last invoice, forever.
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-09-10',
          dayOfMonth: 10,
          everyNMonths: 1,
          amountConfig: {
            ...fixedAmountConfig,
            line_items: [
              fixedAmountConfig.line_items[0]!,
              {
                ...decayingLine('2026-11-10'),
                description:
                  '*CREDIT %line_installment_number% of %line_installment_total%:* $6,250.00',
                installments: 4,
              },
            ],
          },
        }),
      )

      const creditOn = async (period: string, at: string): Promise<string | null> => {
        const result = await createRecurringInvoiceEngine(database!.orm, {
          clock: () => at,
        }).generate(definition.id, period, principal)
        const rows = await database!.rows<{ description: string | null; amount_cents: number }>(
          `SELECT description, amount_cents FROM invoice_line_items
            WHERE invoice_id = ? ORDER BY position`,
          result.invoiceId,
        )
        return rows.find((row) => row.amount_cents < 0)?.description ?? null
      }

      // Three payments remain after this one, so this is the second of four --
      // counted backwards from `through`, because the definition does not record
      // when the run began.
      expect(await creditOn('2026-09-10', '2026-09-10T10:00:00.000Z')).toBe(
        '*CREDIT 2 of 4:* $6,250.00',
      )
      expect(await creditOn('2026-10-10', '2026-10-10T10:00:00.000Z')).toBe(
        '*CREDIT 3 of 4:* $6,250.00',
      )
      // The through date itself is the last one, and it reads as the last one.
      expect(await creditOn('2026-11-10', '2026-11-10T10:00:00.000Z')).toBe(
        '*CREDIT 4 of 4:* $6,250.00',
      )
      // And then it is gone, rather than counting on to five.
      expect(await creditOn('2026-12-10', '2026-12-10T10:00:00.000Z')).toBeNull()
    })


    it('[unit] refuses to issue an invoice whose every line has expired', async () => {
      // An empty invoice reaches the client as a demand for zero, and silently
      // skipping leaves a definition that looks live and never produces. Both
      // are worse than saying so.
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-08-31',
          dayOfMonth: 31,
          amountConfig: {
            ...fixedAmountConfig,
            line_items: [decayingLine('2026-07-31')],
          },
        }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })
      await expect(engine.generate(definition.id, '2026-08-31', principal)).rejects.toThrow(
        /every line on this definition has passed its through date/,
      )
    })

    it('[unit] expands the issue-date tokens in a line description, not only the subject', async () => {
      // The tokens were expanded in the subject and the line descriptions were
      // copied verbatim. Every definition migrated from Harvest names its month
      // in the description -- "for the month of September 2026" -- so a frozen
      // description sends a client the wrong month, on every invoice after the
      // first, with nothing failing. Harvest expands them there, so a definition
      // brought across arrives expecting it to.
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-10-01',
          dayOfMonth: 1,
          amountConfig: {
            schema_version: 1,
            type: 'fixed_lines',
            line_items: [
              {
                kind: 'Service',
                description:
                  'Software development for the month of %invoice_issue_month_name% %invoice_issue_year%',
                quantity: 1,
                unit_price_cents: 1_620_000,
                taxed: false,
                taxed2: false,
                project_id: null,
              },
            ],
          },
        }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-10-01T10:00:00.000Z',
      })
      const result = await engine.generate(definition.id, '2026-10-01', principal)

      const lines = await database.rows<{ description: string }>(
        `SELECT description FROM invoice_line_items WHERE invoice_id = ?`,
        result.invoiceId,
      )
      expect(lines).toHaveLength(1)
      expect(lines[0]?.description).toBe(
        'Software development for the month of October 2026',
      )
    })

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
    })

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
    })

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
    })

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
    })

    it('[unit] generation consumes only schema-validated recurring config; unknown versions fail closed', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31' }),
      )

      // Failing closed is enforced in the schema, not only in the engine: the
      // database refuses to store a config version it does not know, so
      // generation can never be handed one. Asserting it here tests the
      // invariant where it actually lives — the engine's own guard cannot be
      // reached by staging invalid state, because staging it is impossible.
      await expect(
        database.run(
          `UPDATE recurring_invoices SET amount_config = ? WHERE id = ?`,
          JSON.stringify({ schema_version: 2, type: 'fixed_lines', line_items: [] }),
          definition.id,
        ),
      ).rejects.toThrow(/recurring invoice amount config is invalid/)
    })

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
    })

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
        engine.generate(definition.id, '2026-08-31', { type: 'user', userId: 1, profile: 'member' }),
      ).rejects.toThrow(RecurringEngineError)
    })

    it('[unit] rejects generation for nonexistent definition', async () => {
      database = await factory()
      await seedDatabase(database)
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T10:00:00.000Z',
      })

      await expect(
        engine.generate(99999, '2026-08-31', principal),
      ).rejects.toThrow(RecurringEngineError)
    })

    it('[unit] rejects generation with invalid attachment policy version', async () => {
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31' }),
      )
      // As above: the policy version is rejected by the schema, so an invalid
      // one never reaches generation.
      await expect(
        database.run(
          `UPDATE recurring_invoices SET attachment_policy = ? WHERE id = ?`,
          JSON.stringify({ schema_version: 2, type: 'static', attachment_ids: [1] }),
          definition.id,
        ),
      ).rejects.toThrow(/recurring attachment policy is invalid/)
    })

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
    })

    it('[unit] the scheduled sweep issues what is due and leaves the rest alone', async () => {
      // The gap this closes: nothing on any cron ever looked at these, so a
      // definition whose date had passed sat there until a person opened the
      // Recurring screen and pressed Generate.
      database = await factory()
      await seedDatabase(database)
      const due = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31', dayOfMonth: 31 }),
      )
      const later = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ clientId: 2, nextIssueOn: '2026-09-30', dayOfMonth: 30 }),
      )

      const sweep = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T03:00:00.000Z',
      }).generateDue('2026-08-31', systemPrincipal)

      expect(sweep.failed).toEqual([])
      expect(sweep.generated.map((result) => result.definitionId)).toEqual([due.id])
      const issued = await database.rows<{ recurring_invoice_id: number }>(
        `SELECT recurring_invoice_id FROM invoices ORDER BY id`,
      )
      expect(issued.map((invoice) => invoice.recurring_invoice_id)).toEqual([due.id])
      // The one that is not due keeps its date rather than being nudged by a
      // pass that walked past it.
      const untouched = await database.rows<{ next_issue_on: string }>(
        `SELECT next_issue_on FROM recurring_invoices WHERE id = ?`,
        later.id,
      )
      expect(untouched[0]!.next_issue_on).toBe('2026-09-30')
    })

    it('[unit] attributes a scheduled issue to the system and a pressed one to the user', async () => {
      // Both branches in one test, because the fact being asserted is that they
      // differ. Either alone passes against an engine that writes one constant.
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31', dayOfMonth: 31 }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T03:00:00.000Z',
      })

      const sweep = await engine.generateDue('2026-08-31', systemPrincipal)
      expect(sweep.failed).toEqual([])
      const scheduled = sweep.generated[0]!

      expect(
        await database.rows<{ actor_type: string; actor_id: number | null }>(
          `SELECT actor_type, actor_id FROM invoice_command_ledger WHERE invoice_id = ?`,
          scheduled.invoiceId,
        ),
      ).toEqual([{ actor_type: 'system', actor_id: null }])
      // Nobody's name on the invoice either -- the column is nullable precisely
      // so that an issue with no person behind it can say so.
      expect(
        (
          await database.rows<{ created_by_user_id: number | null }>(
            `SELECT created_by_user_id FROM invoices WHERE id = ?`,
            scheduled.invoiceId,
          )
        )[0]!.created_by_user_id,
      ).toBeNull()
      const events = await database.rows<{ payload_json: string }>(
        `SELECT payload_json FROM event_outbox
         WHERE aggregate_type = 'invoice' AND aggregate_id = ?`,
        scheduled.invoiceId,
      )
      expect(
        (JSON.parse(events[0]!.payload_json) as { actor: unknown }).actor,
      ).toEqual({ type: 'system', id: null })

      const pressed = await engine.generate(definition.id, '2026-09-30', principal)
      expect(
        await database.rows<{ actor_type: string; actor_id: number | null }>(
          `SELECT actor_type, actor_id FROM invoice_command_ledger WHERE invoice_id = ?`,
          pressed.invoiceId,
        ),
      ).toEqual([{ actor_type: 'user', actor_id: principal.userId }])
    })

    it('[unit] a second sweep over the same day does not issue a second invoice', async () => {
      // What makes the sweep safe to run without a lock of its own: two crons
      // that overlap, a retry after a half-finished run, or a catch-up after
      // days of downtime all key on the same ledger command.
      database = await factory()
      await seedDatabase(database)
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-08-31', dayOfMonth: 31 }),
      )
      const engine = createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T03:00:00.000Z',
      })

      const first = await engine.generateDue('2026-08-31', systemPrincipal)
      // Tomorrow's cron, or this one re-run by hand: the date moved on, so the
      // definition is not even selected.
      const second = await engine.generateDue('2026-08-31', systemPrincipal)
      expect(second.generated).toEqual([])

      // And the case the ledger is actually there for -- a pass that sees the
      // definition still due, because it overlapped one already running or
      // because the run before it died between writing the invoice and moving
      // the date. It returns the invoice that exists rather than a second one.
      await database.run(
        `UPDATE recurring_invoices SET next_issue_on = '2026-08-31' WHERE id = ?`,
        definition.id,
      )
      const overlapping = await engine.generateDue('2026-08-31', systemPrincipal)
      expect(overlapping.failed).toEqual([])
      expect(overlapping.generated[0]!.invoiceId).toBe(first.generated[0]!.invoiceId)

      const invoices = await database.rows<{ count: number }>(
        `SELECT count(*) AS count FROM invoices WHERE recurring_invoice_id = ?`,
        definition.id,
      )
      expect(invoices[0]!.count).toBe(1)
    })

    it('[unit] one definition that throws does not stop the ones behind it', async () => {
      // A definition can be broken in ways that belong to it alone. If that
      // aborted the pass, one bad definition would silently stop every client
      // behind it in the id order from being invoiced at all -- and the failure
      // would show up as an invoice nobody sent rather than as an error.
      database = await factory()
      await seedDatabase(database)
      const broken = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-08-31',
          dayOfMonth: 31,
          amountConfig: {
            ...fixedAmountConfig,
            line_items: [decayingLine('2026-01-31')],
          },
        }),
      )
      const behind = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ clientId: 2, nextIssueOn: '2026-08-31', dayOfMonth: 31 }),
      )
      expect(broken.id).toBeLessThan(behind.id)

      const sweep = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-08-31T03:00:00.000Z',
      }).generateDue('2026-08-31', systemPrincipal)

      expect(sweep.failed).toEqual([
        {
          definitionId: broken.id,
          code: 'invalid_definition',
          message: 'every line on this definition has passed its through date',
        },
      ])
      expect(sweep.generated.map((result) => result.definitionId)).toEqual([behind.id])
      const issued = await database.rows<{ recurring_invoice_id: number }>(
        `SELECT recurring_invoice_id FROM invoices ORDER BY id`,
      )
      expect(issued.map((invoice) => invoice.recurring_invoice_id)).toEqual([behind.id])
    })

  describe('a banded engagement, where the flat rate consumes the work', () => {
    // Issue 484. A team at a flat monthly rate: the month's tracked time is worth
    // far more at billable rates than the band charges, and neither shape the
    // model offered fitted -- "bill the time" overcharges, "bill a fixed line"
    // leaves the hours reading as uninvoiced and billable twice.
    const claimable = async (
      database: TestDatabase,
      entries: readonly { seconds: number; rateCents: number; spentDate: string }[],
      projectId = 1,
    ) => {
      await database.run(
        `INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
         VALUES (1, 'Advisory', 1, 1, 1, ?, ?)`,
        timestamp, timestamp,
      )
      await database.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
        projectId, projectId, timestamp, timestamp,
      )
      await database.run(
        `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
         VALUES (?, ?, 1, 1, ?, ?)`,
        projectId, projectId, timestamp, timestamp,
      )
      for (const [index, entry] of entries.entries()) {
        await database.run(
          `INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                     task_assignment_id, spent_date, seconds, seconds_without_timer,
                                     rounded_seconds, billable, billable_rate_cents,
                                     created_at, updated_at)
           VALUES (?, 1, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          index + 1, projectId, projectId, projectId, entry.spentDate,
          entry.seconds, entry.seconds, entry.seconds, entry.rateCents, timestamp, timestamp,
        )
      }
    }

    it('[money] claims the work and still bills the band', async () => {
      // The failure in the issue, in miniature: 100 hours at $250 is $25,000 of
      // billable value against a $12,500 band. The client is billed the band, and
      // the hours stop reading as uninvoiced so they cannot be billed again.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [
        { seconds: 180_000, rateCents: 25_000, spentDate: '2026-08-10' },
        { seconds: 180_000, rateCents: 25_000, spentDate: '2026-08-20' },
      ])
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({
          nextIssueOn: '2026-09-10',
          dayOfMonth: 10,
          amountConfig: {
            ...fixedAmountConfig,
            line_items: [{ ...fixedAmountConfig.line_items[0]!, unit_price_cents: 1_250_000 }],
          },
        }),
      )
      await database.run(
        `UPDATE recurring_invoices SET claims_project_ids = '[1]' WHERE id = ?`,
        definition.id,
      )

      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)

      const [invoice] = await database.rows<{
        amount_cents: number
        foregone_billable_cents: number
        written_off_cents: number
      }>(
        `SELECT amount_cents, foregone_billable_cents, written_off_cents
         FROM invoices WHERE id = ?`,
        result.invoiceId,
      )
      // Billed the band, not the time.
      expect(invoice!.amount_cents).toBe(1_250_000)
      // 100 hours at $250 is $25,000; the band charged $12,500.
      expect(invoice!.foregone_billable_cents).toBe(1_250_000)
      // And not as a write-off: the client owes and pays the whole band.
      expect(invoice!.written_off_cents).toBe(0)

      const claimed = await database.rows<{ n: number }>(
        `SELECT count(*) AS n FROM time_entries WHERE invoice_id = ?`,
        result.invoiceId,
      )
      expect(claimed[0]!.n).toBe(2)
      const loose = await database.rows<{ n: number }>(
        `SELECT count(*) AS n FROM time_entries WHERE invoice_id IS NULL`,
      )
      expect(loose[0]!.n).toBe(0)
    })

    it('[money] a ceiling claims the oldest hours and leaves the rest billable', async () => {
      // The deal #707 describes: the band covers work up to a point and the
      // rest is ordinary time and materials on the same project. 50 hours of
      // ceiling against 75 tracked -- the first two entries fit, the third does
      // not and stays billable rather than being absorbed.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-05' },
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-12' },
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-19' },
      ])
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      await database.run(
        `UPDATE recurring_invoices SET claims_project_ids = '[1]',
           claim_mode = 'ceiling', claim_ceiling_seconds = 180000 WHERE id = ?`,
        definition.id,
      )

      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)

      const claimed = await database.rows<{ spent_date: string }>(
        `SELECT spent_date FROM time_entries WHERE invoice_id = ? ORDER BY spent_date`,
        result.invoiceId,
      )
      expect(claimed.map((row) => row.spent_date)).toEqual(['2026-08-05', '2026-08-12'])
      // The overflow is still billable work, not something the band swallowed.
      const loose = await database.rows<{ spent_date: string }>(
        `SELECT spent_date FROM time_entries WHERE invoice_id IS NULL`,
      )
      expect(loose.map((row) => row.spent_date)).toEqual(['2026-08-19'])
    })

    it('[money] leaves an entry that would straddle the ceiling out whole', async () => {
      // Half a time entry has one rate, one person and one approval state.
      // Splitting one would invent a row nobody tracked, so an entry that does
      // not fit is left out entirely -- the band claims less than its ceiling.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-05' },
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-12' },
      ])
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      // 30 hours of ceiling against two 25-hour entries: the second overshoots.
      await database.run(
        `UPDATE recurring_invoices SET claims_project_ids = '[1]',
           claim_mode = 'ceiling', claim_ceiling_seconds = 108000 WHERE id = ?`,
        definition.id,
      )

      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)

      const claimed = await database.rows<{ n: number }>(
        `SELECT count(*) AS n FROM time_entries WHERE invoice_id = ?`,
        result.invoiceId,
      )
      expect(claimed[0]!.n).toBe(1)
    })

    it('[money] claims the same entries on a re-run, not a different subset', async () => {
      // Oldest-first by spent date and id is the ordering that survives a
      // retry. A band whose claimed hours move between attempts is one nobody
      // can reconcile, so this pins the ordering rather than the count.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-19' },
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-05' },
        { seconds: 90_000, rateCents: 25_000, spentDate: '2026-08-12' },
      ])
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      await database.run(
        `UPDATE recurring_invoices SET claims_project_ids = '[1]',
           claim_mode = 'ceiling', claim_ceiling_seconds = 180000 WHERE id = ?`,
        definition.id,
      )

      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)

      // Seeded out of date order on purpose: the two earliest dates are taken,
      // not the two lowest ids.
      const claimed = await database.rows<{ spent_date: string }>(
        `SELECT spent_date FROM time_entries WHERE invoice_id = ? ORDER BY spent_date`,
        result.invoiceId,
      )
      expect(claimed.map((row) => row.spent_date)).toEqual(['2026-08-05', '2026-08-12'])
    })

    it('[money] a definition that claims nothing behaves exactly as before', async () => {
      // The whole feature is inert until somebody names a project. Every existing
      // definition is this one.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [{ seconds: 3_600, rateCents: 25_000, spentDate: '2026-08-10' }])
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)

      const [invoice] = await database.rows<{ foregone_billable_cents: number }>(
        `SELECT foregone_billable_cents FROM invoices WHERE id = ?`,
        result.invoiceId,
      )
      expect(invoice!.foregone_billable_cents).toBe(0)
      const loose = await database.rows<{ n: number }>(
        `SELECT count(*) AS n FROM time_entries WHERE invoice_id IS NULL`,
      )
      expect(loose[0]!.n).toBe(1)
    })

    it('[money] never claims time already billed elsewhere', async () => {
      // An entry on an earlier ad-hoc invoice stays there. The band covers what
      // has not been covered, and cannot quietly move work off another invoice.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [
        { seconds: 3_600, rateCents: 25_000, spentDate: '2026-08-10' },
        { seconds: 3_600, rateCents: 25_000, spentDate: '2026-08-11' },
      ])
      await database.run(
        `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                               created_at, updated_at)
         VALUES (900, 1, '900', 'USD', '2026-08-15', '2026-09-15', 'draft', ?, ?)`,
        timestamp, timestamp,
      )
      await database.run(`UPDATE time_entries SET invoice_id = 900 WHERE id = 1`)

      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      await database.run(
        `UPDATE recurring_invoices SET claims_project_ids = '[1]' WHERE id = ?`,
        definition.id,
      )
      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)

      expect(
        (await database.rows<{ n: number }>(
          `SELECT count(*) AS n FROM time_entries WHERE invoice_id = 900`,
        ))[0]!.n,
      ).toBe(1)
      expect(
        (await database.rows<{ n: number }>(
          `SELECT count(*) AS n FROM time_entries WHERE invoice_id = ?`,
          result.invoiceId,
        ))[0]!.n,
      ).toBe(1)
    })

    it('[money] records nothing foregone when the band covers more than the work', async () => {
      // A profitable month is not a negative forgone amount.
      database = await factory()
      await seedDatabase(database)
      await claimable(database, [{ seconds: 3_600, rateCents: 10_000, spentDate: '2026-08-10' }])
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      await database.run(
        `UPDATE recurring_invoices SET claims_project_ids = '[1]' WHERE id = ?`,
        definition.id,
      )
      const result = await createRecurringInvoiceEngine(database.orm, {
        clock: () => '2026-09-10T10:00:00.000Z',
      }).generate(definition.id, '2026-09-10', principal)
      expect(
        (await database.rows<{ foregone_billable_cents: number }>(
          `SELECT foregone_billable_cents FROM invoices WHERE id = ?`,
          result.invoiceId,
        ))[0]!.foregone_billable_cents,
      ).toBe(0)
    })

    it('[security] refuses a definition claiming another client project', async () => {
      // One client's work inside another client's invoice.
      database = await factory()
      await seedDatabase(database)
      await database.run(
        `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
         VALUES (2, 2, 'Other Client Project', 'SAN-2', ?, ?)`,
        timestamp, timestamp,
      )
      const definition = await createRecurringInvoiceDefinition(
        database.orm as unknown as RecurringInvoiceDatabase,
        createInput({ nextIssueOn: '2026-09-10', dayOfMonth: 10 }),
      )
      await expect(
        database.run(
          `UPDATE recurring_invoices SET claims_project_ids = '[2]' WHERE id = ?`,
          definition.id,
        ),
      ).rejects.toThrow(/must belong to the definition client/u)
    })
  })
  })
}
