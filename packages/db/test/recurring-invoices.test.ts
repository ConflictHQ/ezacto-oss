import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import * as publicDatabase from '../src/index.js'
import { ensureHarvestRecurringInvoiceStub } from '../src/internal/recurring-invoice-import.js'
import { completeHarvestRecurringInvoice } from '../src/internal/worksheet-import.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { rateResolverMigration } from '../src/migrations/0003_rate_resolver.js'
import { invoiceFoundationMigration } from '../src/migrations/0004_invoice_foundation.js'
import { invoicePaymentsTotalsMigration } from '../src/migrations/0005_invoice_payments_totals.js'
import { recurringInvoicesMigration } from '../src/migrations/0010_recurring_invoices.js'
import {
  createRecurringInvoiceDefinition,
  type CreateRecurringInvoiceDefinitionInput,
  type RecurringInvoiceDatabase,
} from '../src/recurring-invoices.js'

type PrivilegedCreateKey = Extract<
  keyof CreateRecurringInvoiceDefinitionInput,
  'id' | 'harvestId' | 'definitionStatus' | 'autoSend' | 'recurringInvoiceId'
>
type AssertNever<T extends never> = T

const nativeCreateHasNoPrivilegedKeys: AssertNever<PrivilegedCreateKey> | null = null

interface TestDatabase {
  orm: RecurringInvoiceDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

interface DanglingRecurringInvoice {
  id: number
  number: string
  client: { id: number; name: string }
  recurring_invoice_id: number
}

const timestamp = '2026-08-28T12:00:00.000Z'
const migrationsThrough0005 = [
  ['0000_org_people', orgPeopleMigration],
  ['0001_clients', clientsMigration],
  ['0002_projects_time', projectsTimeMigration],
  ['0003_rate_resolver', rateResolverMigration],
  ['0004_invoice_foundation', invoiceFoundationMigration],
  ['0005_invoice_payments_totals', invoicePaymentsTotalsMigration],
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

const seedClients = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES (1, 41001, 'Sanitized Client', 'USD', ?, ?),
            (2, 41002, 'Other Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
}

const insertInvoice = async (
  database: TestDatabase,
  id: number,
  clientId = 1,
  harvestId: number | null = null,
  number = `SAN-${id}`,
): Promise<void> => {
  await database.run(
    `INSERT INTO invoices (
      id, harvest_id, client_id, number, currency, issue_date, due_date,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'USD', '2026-08-28', '2026-09-28', ?, ?)`,
    id,
    harvestId,
    clientId,
    number,
    timestamp,
    timestamp,
  )
}

const insertMoneyRetainer = async (
  database: TestDatabase,
  id: number,
  clientId: number | null,
): Promise<void> => {
  await database.run(
    `INSERT INTO retainers (
      id, client_id, denomination, amount_cents, seconds, created_at, updated_at
    ) VALUES (?, ?, 'money', 100000, NULL, ?, ?)`,
    id,
    clientId,
    timestamp,
    timestamp,
  )
}

const insertProject = async (
  database: TestDatabase,
  id: number,
  clientId: number,
): Promise<void> => {
  await database.run(
    `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    clientId,
    `Sanitized Project ${id}`,
    `SAN-${id}`,
    timestamp,
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

for (const [runtime, factory] of factories) {
  describe(`recurring invoice schema (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] upgrades fresh and populated prerequisite databases with real foreign keys', async () => {
      database = await factory()
      expect(
        await database.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`,
        ),
      ).toEqual([{ id: '0037_recurring_generate_command' }])
      const recurringForeignKeys = await database.rows<{
        from: string
        table: string
        to: string
        on_delete: string
      }>(`PRAGMA foreign_key_list(recurring_invoices)`)
      expect(
        recurringForeignKeys.map(({ from, table, to, on_delete }) => ({
          from,
          table,
          to,
          on_delete,
        })),
      ).toEqual(
        expect.arrayContaining([
          { from: 'client_id', table: 'clients', to: 'id', on_delete: 'RESTRICT' },
          {
            from: 'can_draw_from_retainer_id',
            table: 'retainers',
            to: 'id',
            on_delete: 'RESTRICT',
          },
        ]),
      )
      const invoiceForeignKeys = await database.rows<{
        from: string
        table: string
        to: string
        on_delete: string
      }>(`PRAGMA foreign_key_list(invoices)`)
      expect(
        invoiceForeignKeys.map(({ from, table, to, on_delete }) => ({
          from,
          table,
          to,
          on_delete,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            from: 'recurring_invoice_id',
            table: 'recurring_invoices',
            to: 'id',
            on_delete: 'RESTRICT',
          },
        ]),
      )
      await database.close()

      database = await factory(false)
      await installThrough0005(database)
      await seedClients(database)
      await insertInvoice(database, 1, 1, 71001)
      await database.migrateAgain()
      expect(
        await database.rows<{ id: number; recurring_invoice_id: number | null }>(
          `SELECT id, recurring_invoice_id FROM invoices`,
        ),
      ).toEqual([{ id: 1, recurring_invoice_id: null }])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
      await database.migrateAgain()
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    }, 20_000)

    it('[unit] stores complete calendar anchors with exactly one physical amount model', async () => {
      database = await factory()
      await seedClients(database)
      await insertMoneyRetainer(database, 1, 1)
      await insertProject(database, 1001, 1)
      await insertProject(database, 1002, 1)
      const fixedProjectConfig = {
        ...fixedAmountConfig,
        line_items: fixedAmountConfig.line_items.map((line) => ({
          ...line,
          project_id: 1001,
        })),
      }
      const fixed = await createRecurringInvoiceDefinition(
        database.orm,
        createInput({ amountConfig: fixedProjectConfig, canDrawFromRetainerId: 1 }),
      )
      expect(fixed).toMatchObject({
        definitionStatus: 'complete',
        everyNMonths: 1,
        dayOfMonth: 31,
        canDrawFromRetainerId: 1,
        amountConfig: fixedProjectConfig,
      })
      const imported = await createRecurringInvoiceDefinition(
        database.orm,
        createInput({
          subjectTemplate: 'Tracked work for %invoice_issue_month_name%',
          dayOfMonth: 1,
          nextIssueOn: '2026-09-01',
          amountConfig: {
            schema_version: 1,
            type: 'line_items_import',
            project_ids: [1001, 1002],
            time: { summary_type: 'task' },
            expenses: { summary_type: 'category' },
          },
        }),
      )
      expect(imported.amountConfig).toEqual({
        schema_version: 1,
        type: 'line_items_import',
        project_ids: [1001, 1002],
        time: { summary_type: 'task' },
        expenses: { summary_type: 'category' },
      })

      for (const input of [
        createInput({ everyNMonths: 0 }),
        createInput({ dayOfMonth: 0 }),
        createInput({ dayOfMonth: 32 }),
        createInput({ nextIssueOn: '2026-02-29' }),
        createInput({ subjectTemplate: ' \t\r\n' }),
        createInput({
          amountConfig: {
            ...fixedAmountConfig,
            line_items: fixedAmountConfig.line_items.map((line) => ({
              ...line,
              kind: ' \t\r\n',
            })),
          },
        }),
      ]) {
        await expect(createRecurringInvoiceDefinition(database.orm, input)).rejects.toThrow()
      }
      await expect(
        database.run(
          `INSERT INTO recurring_invoices (
            id, client_id, subject_template, notes_template, every_n_months,
            day_of_month, next_issue_on, amount_config, created_at, updated_at
          ) VALUES (99, 1, 'Subject', '', 1, 29, '2026-02-29', ?, ?, ?)`,
          JSON.stringify(fixedAmountConfig),
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      for (const [id, subjectTemplate, amountConfig] of [
        [100, ' \t\r\n', fixedAmountConfig],
        [
          101,
          'Subject',
          {
            ...fixedAmountConfig,
            line_items: fixedAmountConfig.line_items.map((line) => ({
              ...line,
              kind: ' \t\r\n',
            })),
          },
        ],
      ] as const) {
        await expect(
          database.run(
            `INSERT INTO recurring_invoices (
              id, client_id, subject_template, notes_template, every_n_months,
              day_of_month, next_issue_on, amount_config, created_at, updated_at
            ) VALUES (?, 1, ?, '', 1, 1, '2026-09-01', ?, ?, ?)`,
            id,
            subjectTemplate,
            JSON.stringify(amountConfig),
            timestamp,
            timestamp,
          ),
        ).rejects.toThrow()
      }
    })

    it('[unit] rejects malformed, mixed, open, and unknown-version JSON contracts', async () => {
      database = await factory()
      await seedClients(database)
      await insertProject(database, 1, 1)
      const insert = (id: number, config: string) =>
        database!.run(
          `INSERT INTO recurring_invoices (
            id, client_id, definition_status, subject_template, notes_template,
            every_n_months, day_of_month, next_issue_on, amount_config,
            created_at, updated_at
          ) VALUES (?, 1, 'complete', 'Subject', '', 1, 1, '2026-09-01', ?, ?, ?)`,
          id,
          config,
          timestamp,
          timestamp,
        )
      const invalidConfigs = [
        '{',
        JSON.stringify({ ...fixedAmountConfig, schema_version: 2 }),
        JSON.stringify(fixedAmountConfig).replace('"schema_version":1', '"schema_version":1.0'),
        JSON.stringify({ ...fixedAmountConfig, project_ids: [1] }),
        JSON.stringify({ ...fixedAmountConfig, line_items: [] }),
        `{"schema_version":1,"type":"fixed_lines","line_items":[{"kind":"Service","kind":"Duplicate","description":null,"quantity":1,"unit_price_cents":100,"taxed2":false,"project_id":null}]}`,
        JSON.stringify({
          ...fixedAmountConfig,
          line_items: [{ ...fixedAmountConfig.line_items[0], attachment_id: 1 }],
        }),
        JSON.stringify({
          schema_version: 1,
          type: 'line_items_import',
          project_ids: [1, 1],
          time: { summary_type: 'task' },
        }),
        JSON.stringify({
          schema_version: 1,
          type: 'line_items_import',
          project_ids: [1],
        }),
        JSON.stringify({
          schema_version: 1,
          type: 'line_items_import',
          project_ids: [1],
          time: { summary_type: 'task', from: '2026-08-01' },
        }),
        JSON.stringify({
          schema_version: 1,
          type: 'line_items_import',
          project_ids: [1],
          expenses: { summary_type: 'category', attach_receipts: true },
        }),
      ]
      for (const [index, config] of invalidConfigs.entries()) {
        await expect(insert(100 + index, config)).rejects.toThrow()
      }
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM recurring_invoices`),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] rejects divergent duplicate names at every physical JSON object layer', async () => {
      database = await factory()
      await seedClients(database)
      await insertProject(database, 1, 1)
      const duplicateConfigs = [
        `{"schema_version":1,"type":"line_items_import","project_ids":[1],"time":{"summary_type":"task"},"schema_version":2}`,
        `{"schema_version":1,"type":"fixed_lines","line_items":[{"kind":"Service","kind":"Expense","description":null,"quantity":1,"unit_price_cents":100,"taxed":false,"taxed2":false,"project_id":null}]}`,
        `{"schema_version":1,"type":"line_items_import","project_ids":[1],"time":{"summary_type":"task","summary_type":"detailed"}}`,
        `{"schema_version":1,"type":"line_items_import","project_ids":[1],"expenses":{"summary_type":"category","summary_type":"people"}}`,
      ]
      expect(JSON.parse(duplicateConfigs[0]!) as { schema_version: number }).toMatchObject({
        schema_version: 2,
      })
      expect(
        JSON.parse(duplicateConfigs[1]!) as { line_items: Array<{ kind: string }> },
      ).toMatchObject({ line_items: [{ kind: 'Expense' }] })
      expect(JSON.parse(duplicateConfigs[2]!) as { time: { summary_type: string } }).toMatchObject({
        time: { summary_type: 'detailed' },
      })
      expect(
        JSON.parse(duplicateConfigs[3]!) as { expenses: { summary_type: string } },
      ).toMatchObject({ expenses: { summary_type: 'people' } })

      for (const [index, config] of duplicateConfigs.entries()) {
        await expect(
          database.run(
            `INSERT INTO recurring_invoices (
              id, client_id, subject_template, notes_template, every_n_months,
              day_of_month, next_issue_on, amount_config, created_at, updated_at
            ) VALUES (?, 1, 'Subject', '', 1, 1, '2026-09-01', ?, ?, ?)`,
            300 + index,
            config,
            timestamp,
            timestamp,
          ),
        ).rejects.toThrow()
      }
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM recurring_invoices`),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] keeps dangling Harvest stubs incomplete, internal, deduplicated, and attributable', async () => {
      database = await factory()
      expect(nativeCreateHasNoPrivilegedKeys).toBeNull()
      expect('ensureHarvestRecurringInvoiceStub' in publicDatabase).toBe(false)
      await seedClients(database)
      await expect(
        createRecurringInvoiceDefinition(database.orm, {
          clientId: 1,
          subjectTemplate: null,
          notesTemplate: null,
          everyNMonths: null,
          dayOfMonth: null,
          nextIssueOn: null,
          amountConfig: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        } as unknown as CreateRecurringInvoiceDefinitionInput),
      ).rejects.toThrow()
      const fixtures = JSON.parse(
        await readFile(
          new URL('fixtures/harvest-invoices-dangling-recurring.json', import.meta.url),
          'utf8',
        ),
      ) as DanglingRecurringInvoice[]
      const localInvoiceId = (fixture: DanglingRecurringInvoice) => fixture.id + 100_000
      for (const fixture of fixtures) {
        expect(localInvoiceId(fixture)).not.toBe(fixture.id)
        await insertInvoice(database, localInvoiceId(fixture), 1, fixture.id, fixture.number)
      }
      const stubs = await Promise.all(
        fixtures.map((fixture) =>
          ensureHarvestRecurringInvoiceStub(database!.orm, {
            invoiceId: localInvoiceId(fixture),
            harvestInvoiceId: fixture.id,
            harvestRecurringInvoiceId: fixture.recurring_invoice_id,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ),
      )
      expect(new Set(stubs.map(({ id }) => id)).size).toBe(1)
      expect(stubs[0]).toMatchObject({
        harvestId: fixtures[0]!.recurring_invoice_id,
        clientId: 1,
        definitionStatus: 'incomplete',
        subjectTemplate: null,
        notesTemplate: null,
        everyNMonths: null,
        dayOfMonth: null,
        nextIssueOn: null,
        amountConfig: null,
        canDrawFromRetainerId: null,
      })
      expect(
        await database.rows<{
          recurring_harvest_id: number
          invoice_id: number
          invoice_harvest_id: number
          number: string
          client_id: number
        }>(
          `SELECT recurring.harvest_id AS recurring_harvest_id,
              invoice.id AS invoice_id, invoice.harvest_id AS invoice_harvest_id,
              invoice.number, invoice.client_id
           FROM recurring_invoices recurring
           JOIN invoices invoice ON invoice.recurring_invoice_id = recurring.id
           ORDER BY invoice.id`,
        ),
      ).toEqual(
        fixtures.map((fixture) => ({
          recurring_harvest_id: fixture.recurring_invoice_id,
          invoice_id: localInvoiceId(fixture),
          invoice_harvest_id: fixture.id,
          number: fixture.number,
          client_id: 1,
        })),
      )
      await expect(
        database.run(
          `INSERT INTO recurring_invoices (
            harvest_id, client_id, created_at, updated_at
          ) VALUES (95001, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow()
      await expect(
        database.run(
          `INSERT OR REPLACE INTO recurring_invoices (
            id, harvest_id, client_id, definition_status, created_at, updated_at
          ) VALUES (?, ?, 1, 'incomplete', ?, ?)`,
          stubs[0]!.id,
          fixtures[0]!.recurring_invoice_id,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/identity already exists/)
    }, 20_000)

    it('[unit] links an incremental source invoice to its already-completed definition', async () => {
      database = await factory()
      await seedClients(database)
      const sourceRecurringId = 94_500
      await insertInvoice(database, 175_001, 1, 75_001)
      const stub = await ensureHarvestRecurringInvoiceStub(database.orm, {
        invoiceId: 175_001,
        harvestInvoiceId: 75_001,
        harvestRecurringInvoiceId: sourceRecurringId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      await completeHarvestRecurringInvoice(database.orm, {
        harvestRecurringInvoiceId: sourceRecurringId,
        snapshotSha256: 'a'.repeat(64),
        contextSha256: 'b'.repeat(64),
        subjectTemplate: 'Completed definition',
        notesTemplate: '',
        everyNMonths: 1,
        dayOfMonth: 1,
        nextIssueOn: '2026-09-01',
        sourceAmountConfig: {
          schema_version: 1,
          type: 'fixed_lines',
          line_items: [
            {
              kind: 'Service',
              description: 'Sanitized monthly service',
              quantity: 1,
              unit_price_cents: 125_000,
              taxed: true,
              taxed2: false,
              harvest_project_id: null,
            },
          ],
        },
        resolvedAmountConfig: fixedAmountConfig,
        sourceCanDrawFromHarvestRetainerId: null,
        resolvedCanDrawFromRetainerId: null,
        completedAt: timestamp,
      })
      await insertInvoice(database, 175_002, 1, 75_002)

      const completed = await ensureHarvestRecurringInvoiceStub(database.orm, {
        invoiceId: 175_002,
        harvestInvoiceId: 75_002,
        harvestRecurringInvoiceId: sourceRecurringId,
        createdAt: timestamp,
        updatedAt: timestamp,
      })

      expect(completed).toMatchObject({
        id: stub.id,
        harvestId: sourceRecurringId,
        definitionStatus: 'complete',
        subjectTemplate: 'Completed definition',
        amountConfig: fixedAmountConfig,
      })
      expect(
        await database.rows<{ id: number; recurring_invoice_id: number | null }>(
          `SELECT id, recurring_invoice_id FROM invoices WHERE id IN (175001, 175002) ORDER BY id`,
        ),
      ).toEqual([
        { id: 175_001, recurring_invoice_id: stub.id },
        { id: 175_002, recurring_invoice_id: stub.id },
      ])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM recurring_invoices WHERE harvest_id = ?`,
          sourceRecurringId,
        ),
      ).toEqual([{ count: 1 }])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] rejects invalid or cross-client client, retainer, and recurring references', async () => {
      database = await factory()
      await seedClients(database)
      await insertMoneyRetainer(database, 1, 1)
      await insertMoneyRetainer(database, 2, 2)
      await insertProject(database, 10, 1)
      await insertProject(database, 20, 2)
      await expect(
        createRecurringInvoiceDefinition(database.orm, createInput({ clientId: 999 })),
      ).rejects.toThrow()
      await expect(
        createRecurringInvoiceDefinition(database.orm, createInput({ canDrawFromRetainerId: 2 })),
      ).rejects.toThrow()
      await expect(
        createRecurringInvoiceDefinition(
          database.orm,
          createInput({
            amountConfig: {
              ...fixedAmountConfig,
              line_items: fixedAmountConfig.line_items.map((line) => ({
                ...line,
                project_id: 20,
              })),
            },
          }),
        ),
      ).rejects.toThrow()
      await expect(
        createRecurringInvoiceDefinition(
          database.orm,
          createInput({
            amountConfig: {
              schema_version: 1,
              type: 'line_items_import',
              project_ids: [999],
              time: { summary_type: 'task' },
            },
          }),
        ),
      ).rejects.toThrow()
      await expect(
        createRecurringInvoiceDefinition(
          database.orm,
          createInput({
            amountConfig: {
              schema_version: 1,
              type: 'line_items_import',
              project_ids: [20],
              expenses: { summary_type: 'category' },
            },
          }),
        ),
      ).rejects.toThrow()
      const recurring = await createRecurringInvoiceDefinition(
        database.orm,
        createInput({
          canDrawFromRetainerId: 1,
          amountConfig: {
            ...fixedAmountConfig,
            line_items: fixedAmountConfig.line_items.map((line) => ({
              ...line,
              project_id: 10,
            })),
          },
        }),
      )
      await expect(
        database.run(
          `UPDATE recurring_invoices SET amount_config = ? WHERE id = ?`,
          JSON.stringify({
            ...fixedAmountConfig,
            line_items: fixedAmountConfig.line_items.map((line) => ({
              ...line,
              project_id: 20,
            })),
          }),
          recurring.id,
        ),
      ).rejects.toThrow()
      await insertInvoice(database, 1, 2)
      await expect(
        database.run(`UPDATE invoices SET recurring_invoice_id = ? WHERE id = 1`, recurring.id),
      ).rejects.toThrow(/must belong to invoice client/)
      await expect(
        database.run(`UPDATE invoices SET recurring_invoice_id = 999 WHERE id = 1`),
      ).rejects.toThrow()
      await expect(database.run(`UPDATE retainers SET client_id = 2 WHERE id = 1`)).rejects.toThrow(
        /match every recurring invoice/,
      )
      await expect(database.run(`UPDATE projects SET client_id = 2 WHERE id = 10`)).rejects.toThrow(
        /match every recurring invoice definition/,
      )
      await expect(database.run(`DELETE FROM projects WHERE id = 10`)).rejects.toThrow(
        /referenced by a recurring invoice definition/,
      )
      await expect(database.run(`UPDATE projects SET id = 11 WHERE id = 10`)).rejects.toThrow(
        /match every recurring invoice definition/,
      )
      await expect(
        database.run(
          `INSERT OR REPLACE INTO projects (
            id, harvest_id, client_id, name, code, created_at, updated_at
          ) VALUES (10, 51010, 2, 'Replacement', 'REPLACE', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/preserve recurring invoice references/)
      await insertProject(database, 30, 2)
      await database.run(`UPDATE projects SET harvest_id = 51010 WHERE id = 10`)
      await expect(
        database.run(
          `INSERT OR REPLACE INTO projects (
            id, harvest_id, client_id, name, code, created_at, updated_at
          ) VALUES (30, 51010, 2, 'Harvest replacement', 'REPLACE', ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/preserve recurring invoice references/)
      expect(
        await database.rows<{ id: number; client_id: number }>(
          `SELECT id, client_id FROM projects WHERE id IN (10, 30) ORDER BY id`,
        ),
      ).toEqual([
        { id: 10, client_id: 1 },
        { id: 30, client_id: 2 },
      ])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] rejects UPDATE OR REPLACE collisions with referenced project identities', async () => {
      database = await factory()
      await seedClients(database)
      await insertProject(database, 10, 1)
      await insertProject(database, 11, 1)
      await insertProject(database, 30, 2)
      await insertProject(database, 31, 1)
      await createRecurringInvoiceDefinition(
        database.orm,
        createInput({
          amountConfig: {
            ...fixedAmountConfig,
            line_items: fixedAmountConfig.line_items.map((line) => ({
              ...line,
              project_id: 10,
            })),
          },
        }),
      )
      await createRecurringInvoiceDefinition(
        database.orm,
        createInput({
          amountConfig: {
            schema_version: 1,
            type: 'line_items_import',
            project_ids: [11],
            time: { summary_type: 'task' },
          },
        }),
      )

      await expect(
        database.run(`UPDATE OR REPLACE projects SET id = 10 WHERE id = 30`),
      ).rejects.toThrow(/preserve recurring invoice references/)

      await database.run(`UPDATE projects SET harvest_id = 51011 WHERE id = 11`)
      await expect(
        database.run(`UPDATE OR REPLACE projects SET harvest_id = 51011 WHERE id = 31`),
      ).rejects.toThrow(/preserve recurring invoice references/)

      expect(
        await database.rows<{ id: number; harvest_id: number | null; client_id: number }>(
          `SELECT id, harvest_id, client_id FROM projects WHERE id IN (10, 11, 30, 31) ORDER BY id`,
        ),
      ).toEqual([
        { id: 10, harvest_id: null, client_id: 1 },
        { id: 11, harvest_id: 51_011, client_id: 1 },
        { id: 30, harvest_id: null, client_id: 2 },
        { id: 31, harvest_id: null, client_id: 1 },
      ])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] refuses stub linking outside exact virgin Harvest invoice authority', async () => {
      database = await factory()
      await seedClients(database)
      await insertInvoice(database, 1)
      await expect(
        ensureHarvestRecurringInvoiceStub(database.orm, {
          invoiceId: 1,
          harvestInvoiceId: 1,
          harvestRecurringInvoiceId: 94001,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow(/could not link/)
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM recurring_invoices`),
      ).toEqual([{ count: 0 }])

      await insertInvoice(database, 2, 1, 72002)
      await expect(
        ensureHarvestRecurringInvoiceStub(database.orm, {
          invoiceId: 2,
          harvestInvoiceId: 99999,
          harvestRecurringInvoiceId: 94002,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow(/could not link/)
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })

    it('[unit] rolls back a conflicting source link without leaving a partial stub', async () => {
      database = await factory()
      await seedClients(database)
      const nativeInvoiceId = 173_001
      const harvestInvoiceId = 73_001
      await insertInvoice(database, nativeInvoiceId, 1, harvestInvoiceId)
      const original = await ensureHarvestRecurringInvoiceStub(database.orm, {
        invoiceId: nativeInvoiceId,
        harvestInvoiceId,
        harvestRecurringInvoiceId: 94_001,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      await expect(
        ensureHarvestRecurringInvoiceStub(database.orm, {
          invoiceId: nativeInvoiceId,
          harvestInvoiceId,
          harvestRecurringInvoiceId: 94_002,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ).rejects.toThrow()
      expect(
        await database.rows<{ recurring_invoice_id: number }>(
          `SELECT recurring_invoice_id FROM invoices WHERE id = ? AND harvest_id = ?`,
          nativeInvoiceId,
          harvestInvoiceId,
        ),
      ).toEqual([{ recurring_invoice_id: original.id }])
      expect(
        await database.rows<{ harvest_id: number }>(
          `SELECT harvest_id FROM recurring_invoices ORDER BY harvest_id`,
        ),
      ).toEqual([{ harvest_id: 94_001 }])
      expect(await database.rows(`PRAGMA foreign_key_check`)).toEqual([])
    })
  })
}

describe('recurring invoice migration scope', () => {
  it('[unit] stores definitions only, without engine, sending, or attachment policy', () => {
    const sql = recurringInvoicesMigration.join('\n').toLowerCase()
    for (const forbidden of [
      'scheduler',
      'scheduled_job',
      'generated_invoice',
      'auto_send',
      'attachment_id',
      'attachment_policy',
      'owner_type',
      'owner_id',
    ]) {
      expect(sql).not.toContain(forbidden)
    }
  })
})
