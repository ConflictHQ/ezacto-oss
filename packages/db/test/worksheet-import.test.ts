import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  completeHarvestRecurringInvoice,
  completeHarvestRetainerBalance,
  type ImportDatabase,
} from '../src/importer.js'
import * as publicDatabase from '../src/index.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'

interface TestDatabase {
  orm: ImportDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const timestamp = '2026-08-30T12:00:00Z'
const retryTimestamp = '2026-08-30T12:00:01Z'
const snapshotSha256 = 'a'.repeat(64)
const contextSha256 = 'b'.repeat(64)

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
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

const seed = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', '{"invoices":true}', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
     VALUES (1, 41001, 'Sanitized Client', 'USD', ?, ?),
            (2, 41002, 'Other Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects (id, harvest_id, client_id, name, code, created_at, updated_at)
     VALUES (10, 51001, 1, 'Sanitized Project', 'SAN', ?, ?),
            (20, 51002, 2, 'Other Project', 'OTHER', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO retainers (
       id, harvest_id, client_id, denomination, amount_cents, seconds, created_at, updated_at
     ) VALUES (100, 91001, 1, 'money', 0, NULL, ?, ?),
              (101, 91002, 1, 'money', 0, NULL, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO recurring_invoices (
       id, harvest_id, client_id, definition_status, created_at, updated_at
     ) VALUES (200, 92001, 1, 'incomplete', ?, ?),
              (201, 92002, 1, 'incomplete', ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices (
       id, harvest_id, client_id, number, currency, issue_date, due_date,
       retainer_id, recurring_invoice_id, created_at, updated_at
     ) VALUES (300, 93001, 1, 'SAN-300', 'USD', '2026-08-30', '2026-09-30',
       100, 200, ?, ?)`,
    timestamp,
    timestamp,
  )
}

const fixedAmountConfig = (projectId: number | null = 10) => ({
  schema_version: 1 as const,
  type: 'fixed_lines' as const,
  line_items: [
    {
      kind: 'Service',
      description: 'Sanitized monthly service',
      quantity: 1,
      unit_price_cents: 125_000,
      taxed: false,
      taxed2: false,
      project_id: projectId,
    },
  ],
})

const sourceFixedAmountConfig = (harvestProjectId: number | null = 51_001) => ({
  schema_version: 1 as const,
  type: 'fixed_lines' as const,
  line_items: [
    {
      kind: 'Service',
      description: 'Sanitized monthly service',
      quantity: 1,
      unit_price_cents: 125_000,
      taxed: false,
      taxed2: false,
      harvest_project_id: harvestProjectId,
    },
  ],
})

const importAmountConfig = (projectId = 10) => ({
  schema_version: 1 as const,
  type: 'line_items_import' as const,
  project_ids: [projectId],
  time: { summary_type: 'detailed' as const },
  expenses: { summary_type: 'category' as const },
})

const sourceImportAmountConfig = (harvestProjectId = 51_001) => ({
  schema_version: 1 as const,
  type: 'line_items_import' as const,
  harvest_project_ids: [harvestProjectId],
  time: { summary_type: 'detailed' as const },
  expenses: { summary_type: 'category' as const },
})

const recurringInput = (harvestRecurringInvoiceId = 92_001) => ({
  harvestRecurringInvoiceId,
  snapshotSha256,
  contextSha256,
  subjectTemplate: 'Services for %invoice_issue_month_name%',
  notesTemplate: '',
  everyNMonths: 1,
  dayOfMonth: 1,
  nextIssueOn: '2026-09-01',
  sourceAmountConfig: sourceFixedAmountConfig(),
  resolvedAmountConfig: fixedAmountConfig(),
  sourceCanDrawFromHarvestRetainerId: 91_002,
  resolvedCanDrawFromRetainerId: 101,
  completedAt: timestamp,
})

const rawRecurringInputJson = (): string =>
  JSON.stringify({
    version: 1,
    kind: 'recurring_invoice_definition',
    harvest_recurring_invoice_id: 92_001,
    snapshot_sha256: snapshotSha256,
    context_sha256: contextSha256,
    subject_template: 'Services for %invoice_issue_month_name%',
    notes_template: '',
    every_n_months: 1,
    day_of_month: 1,
    next_issue_on: '2026-09-01',
    source_amount_config: sourceFixedAmountConfig(),
    amount_config: fixedAmountConfig(),
    source_can_draw_from_harvest_retainer_id: 91_002,
    can_draw_from_retainer_id: 101,
  })

for (const [runtime, factory] of factories) {
  describe(`migration worksheet importer (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] records positive and zero opening balances exactly once', async () => {
      database = await factory()
      await seed(database)
      expect('completeHarvestRetainerBalance' in publicDatabase).toBe(false)

      const positive = await completeHarvestRetainerBalance(database.orm, {
        harvestRetainerId: 91_001,
        snapshotSha256,
        contextSha256,
        balanceCents: 125_000,
        occurredOn: '2026-08-30',
        notes: 'Opening balance copied from Harvest UI',
        completedAt: timestamp,
      })
      expect(positive).toMatchObject({
        harvestId: 91_001,
        resourceId: 100,
        balanceCents: 125_000,
        ledgerEntryId: 'harvest-retainer:91001:opening',
        replayed: false,
      })
      const replay = await completeHarvestRetainerBalance(database.orm, {
        harvestRetainerId: 91_001,
        snapshotSha256,
        contextSha256,
        balanceCents: 125_000,
        occurredOn: '2026-08-30',
        notes: 'Opening balance copied from Harvest UI',
        completedAt: retryTimestamp,
      })
      expect(replay).toMatchObject({ replayed: true, completedAt: timestamp })

      const zero = await completeHarvestRetainerBalance(database.orm, {
        harvestRetainerId: 91_002,
        snapshotSha256,
        contextSha256,
        balanceCents: 0,
        occurredOn: '2026-08-30',
        notes: 'Zero balance confirmed in Harvest UI',
        completedAt: timestamp,
      })
      expect(zero).toMatchObject({ balanceCents: 0, ledgerEntryId: null })
      expect(
        await database.rows<{ id: string; amount: number }>(
          `SELECT id, amount FROM retainer_ledger ORDER BY id`,
        ),
      ).toEqual([{ id: 'harvest-retainer:91001:opening', amount: 125_000 }])
      expect(
        await database.rows<{ harvest_id: number; balance: number }>(
          `SELECT retainer.harvest_id, balance.balance
           FROM retainers retainer JOIN retainer_balances balance ON balance.retainer_id = retainer.id
           ORDER BY retainer.harvest_id`,
        ),
      ).toEqual([
        { harvest_id: 91_001, balance: 125_000 },
        { harvest_id: 91_002, balance: 0 },
      ])
      expect(
        await database.rows<{ harvest_id: number }>(
          `SELECT harvest_id FROM _ezacto_worksheet_completions ORDER BY harvest_id`,
        ),
      ).toEqual([{ harvest_id: 91_001 }, { harvest_id: 91_002 }])
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])

      await expect(
        completeHarvestRetainerBalance(database.orm, {
          harvestRetainerId: 91_001,
          snapshotSha256,
          contextSha256,
          balanceCents: 125_001,
          occurredOn: '2026-08-30',
          notes: 'Opening balance copied from Harvest UI',
          completedAt: retryTimestamp,
        }),
      ).rejects.toThrow(/different input/)
      await expect(
        database.run(
          `UPDATE _ezacto_worksheet_completions SET completed_at = ?
           WHERE kind = 'retainer_balance' AND harvest_id = 91001`,
          retryTimestamp,
        ),
      ).rejects.toThrow(/immutable/)
    })

    it('[unit] completes a recurring stub in place and closes raw-SQL bypasses', async () => {
      database = await factory()
      await seed(database)
      expect('completeHarvestRecurringInvoice' in publicDatabase).toBe(false)

      await expect(
        database.run(
          `UPDATE recurring_invoices SET definition_status = 'complete',
             subject_template = 'Forged', notes_template = '', every_n_months = 1,
             day_of_month = 1, next_issue_on = '2026-09-01', amount_config = ?, updated_at = ?
           WHERE id = 200`,
          JSON.stringify(fixedAmountConfig()),
          timestamp,
        ),
      ).rejects.toThrow(/authority/)
      const before = await database.rows<{ id: number; definition_status: string }>(
        `SELECT id, definition_status FROM recurring_invoices WHERE harvest_id = 92001`,
      )

      const completed = await completeHarvestRecurringInvoice(database.orm, recurringInput())
      expect(completed).toMatchObject({
        harvestId: 92_001,
        resourceId: 200,
        replayed: false,
      })
      expect(
        await database.rows<{
          id: number
          harvest_id: number
          definition_status: string
          subject_template: string
          can_draw_from_retainer_id: number
        }>(
          `SELECT id, harvest_id, definition_status, subject_template,
             can_draw_from_retainer_id FROM recurring_invoices WHERE harvest_id = 92001`,
        ),
      ).toEqual([
        {
          id: 200,
          harvest_id: 92_001,
          definition_status: 'complete',
          subject_template: 'Services for %invoice_issue_month_name%',
          can_draw_from_retainer_id: 101,
        },
      ])
      expect(
        await database.rows<{
          source_project_id: number
          resolved_project_id: number
          source_retainer_id: number
          resolved_retainer_id: number
        }>(
          `SELECT
             json_extract(input_json, '$.source_amount_config.line_items[0].harvest_project_id')
               AS source_project_id,
             json_extract(input_json, '$.amount_config.line_items[0].project_id')
               AS resolved_project_id,
             json_extract(input_json, '$.source_can_draw_from_harvest_retainer_id')
               AS source_retainer_id,
             json_extract(input_json, '$.can_draw_from_retainer_id') AS resolved_retainer_id
           FROM _ezacto_worksheet_completions
           WHERE kind = 'recurring_invoice_definition' AND harvest_id = 92001`,
        ),
      ).toEqual([
        {
          source_project_id: 51_001,
          resolved_project_id: 10,
          source_retainer_id: 91_002,
          resolved_retainer_id: 101,
        },
      ])
      expect(
        await database.rows<{ recurring_invoice_id: number }>(
          `SELECT recurring_invoice_id FROM invoices WHERE id = 300`,
        ),
      ).toEqual([{ recurring_invoice_id: 200 }])
      expect(before).toEqual([{ id: 200, definition_status: 'incomplete' }])
      expect(
        await completeHarvestRecurringInvoice(database.orm, {
          ...recurringInput(),
          completedAt: retryTimestamp,
        }),
      ).toMatchObject({ replayed: true, completedAt: timestamp })
      await expect(
        completeHarvestRecurringInvoice(database.orm, {
          ...recurringInput(),
          subjectTemplate: 'Changed replay',
          completedAt: retryTimestamp,
        }),
      ).rejects.toThrow(/different input/)
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])

      await expect(
        completeHarvestRecurringInvoice(database.orm, {
          ...recurringInput(92_002),
          sourceAmountConfig: sourceFixedAmountConfig(51_002),
          resolvedAmountConfig: fixedAmountConfig(20),
        }),
      ).rejects.toThrow(/mapping|client/)
      expect(
        await database.rows<{ definition_status: string }>(
          `SELECT definition_status FROM recurring_invoices WHERE harvest_id = 92002`,
        ),
      ).toEqual([{ definition_status: 'incomplete' }])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM _ezacto_worksheet_completions
           WHERE kind = 'recurring_invoice_definition' AND harvest_id = 92002`,
        ),
      ).toEqual([{ count: 0 }])
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])
    })

    it('[unit] validates and retains line-items-import source mappings', async () => {
      database = await factory()
      await seed(database)

      await expect(
        completeHarvestRecurringInvoice(database.orm, {
          ...recurringInput(92_001),
          sourceAmountConfig: sourceImportAmountConfig(),
          resolvedAmountConfig: importAmountConfig(),
        }),
      ).resolves.toMatchObject({ resourceId: 200, replayed: false })
      expect(
        await database.rows<{
          source_project_id: number
          resolved_project_id: number
          source_time: string
          resolved_time: string
        }>(
          `SELECT
             json_extract(input_json, '$.source_amount_config.harvest_project_ids[0]')
               AS source_project_id,
             json_extract(input_json, '$.amount_config.project_ids[0]') AS resolved_project_id,
             json_extract(input_json, '$.source_amount_config.time.summary_type') AS source_time,
             json_extract(input_json, '$.amount_config.time.summary_type') AS resolved_time
           FROM _ezacto_worksheet_completions
           WHERE kind = 'recurring_invoice_definition' AND harvest_id = 92001`,
        ),
      ).toEqual([
        {
          source_project_id: 51_001,
          resolved_project_id: 10,
          source_time: 'detailed',
          resolved_time: 'detailed',
        },
      ])

      await expect(
        completeHarvestRecurringInvoice(database.orm, {
          ...recurringInput(92_002),
          sourceAmountConfig: sourceImportAmountConfig(51_001),
          resolvedAmountConfig: importAmountConfig(20),
        }),
      ).rejects.toThrow(/mapping/)
      expect(
        await database.rows<{ status: string }>(
          `SELECT definition_status AS status FROM recurring_invoices WHERE harvest_id = 92002`,
        ),
      ).toEqual([{ status: 'incomplete' }])
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])
    })

    it('[unit] rejects completion receipts that bypass exact pending authority', async () => {
      database = await factory()
      await seed(database)
      const forgedRetainer = JSON.stringify({
        version: 1,
        kind: 'retainer_balance',
        harvest_retainer_id: 91_001,
        snapshot_sha256: snapshotSha256,
        context_sha256: contextSha256,
        balance_cents: 0,
        occurred_on: '2026-08-30',
        notes: 'Forged receipt',
      })
      await expect(
        database.run(
          `INSERT INTO _ezacto_worksheet_completions (
             kind, harvest_id, resource_id, snapshot_sha256, context_sha256,
             input_sha256, input_json, completed_at
           ) VALUES ('retainer_balance', 91001, 100, ?, ?, ?, ?, ?)`,
          snapshotSha256,
          contextSha256,
          'c'.repeat(64),
          forgedRetainer,
          timestamp,
        ),
      ).rejects.toThrow(/opening ledger/)
      await expect(
        database.run(
          `INSERT INTO _ezacto_worksheet_import_authority (
             kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
           ) VALUES ('retainer_balance', 91001, 100, ?, '{}', ?)`,
          'c'.repeat(64),
          timestamp,
        ),
      ).rejects.toThrow(/authority|mapping/)
      const duplicateRetainerKey = `{
        "version":1,
        "kind":"retainer_balance",
        "harvest_retainer_id":91001,
        "snapshot_sha256":"${snapshotSha256}",
        "context_sha256":"${contextSha256}",
        "balance_cents":0,
        "notes":"first duplicate",
        "notes":"second duplicate"
      }`
      await expect(
        database.run(
          `INSERT INTO _ezacto_worksheet_import_authority (
             kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
           ) VALUES ('retainer_balance', 91001, 100, ?, ?, ?)`,
          'c'.repeat(64),
          duplicateRetainerKey,
          timestamp,
        ),
      ).rejects.toThrow(/authority/)
      const duplicateRecurringKey = `{
        "version":1,
        "kind":"recurring_invoice_definition",
        "harvest_recurring_invoice_id":92001,
        "snapshot_sha256":"${snapshotSha256}",
        "context_sha256":"${contextSha256}",
        "subject_template":"Forged",
        "notes_template":"",
        "notes_template":"duplicate",
        "every_n_months":1,
        "day_of_month":1,
        "next_issue_on":"2026-09-01",
        "source_amount_config":${JSON.stringify(sourceFixedAmountConfig())},
        "amount_config":${JSON.stringify(fixedAmountConfig())},
        "source_can_draw_from_harvest_retainer_id":91002
      }`
      await expect(
        database.run(
          `INSERT INTO _ezacto_worksheet_import_authority (
             kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
           ) VALUES ('recurring_invoice_definition', 92001, 200, ?, ?, ?)`,
          'c'.repeat(64),
          duplicateRecurringKey,
          timestamp,
        ),
      ).rejects.toThrow(/authority|mapping/)
      const malformedNestedConfig = `{
        "version":1,
        "kind":"recurring_invoice_definition",
        "harvest_recurring_invoice_id":92001,
        "snapshot_sha256":"${snapshotSha256}",
        "context_sha256":"${contextSha256}",
        "subject_template":"Forged",
        "notes_template":"",
        "every_n_months":1,
        "day_of_month":1,
        "next_issue_on":"2026-09-01",
        "source_amount_config":{
          "schema_version":1,
          "type":"line_items_import",
          "harvest_project_ids":[51001],
          "time":{"summary_type":"detailed","summary_type":"project"}
        },
        "amount_config":${JSON.stringify({
          schema_version: 1,
          type: 'line_items_import',
          project_ids: [10],
          time: { summary_type: 'detailed' },
        })},
        "source_can_draw_from_harvest_retainer_id":91002,
        "can_draw_from_retainer_id":101
      }`
      await expect(
        database.run(
          `INSERT INTO _ezacto_worksheet_import_authority (
             kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
           ) VALUES ('recurring_invoice_definition', 92001, 200, ?, ?, ?)`,
          'c'.repeat(64),
          malformedNestedConfig,
          timestamp,
        ),
      ).rejects.toThrow(/mapping|shape/)
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_completions`)).toEqual([])
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])
    })

    it('[unit] prevents a pending authority source mapping from becoming stale', async () => {
      database = await factory()
      await seed(database)
      await database.run(
        `INSERT INTO _ezacto_worksheet_import_authority (
           kind, harvest_id, resource_id, input_sha256, input_json, target_updated_at
         ) VALUES ('recurring_invoice_definition', 92001, 200, ?, ?, ?)`,
        'c'.repeat(64),
        rawRecurringInputJson(),
        timestamp,
      )

      await expect(
        database.run(`UPDATE projects SET harvest_id = 51999 WHERE id = 10`),
      ).rejects.toThrow(/source mapping is locked/)
      expect(
        await database.rows<{ harvest_id: number }>(
          `SELECT harvest_id FROM projects WHERE id = 10`,
        ),
      ).toEqual([{ harvest_id: 51_001 }])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM _ezacto_worksheet_import_authority`,
        ),
      ).toEqual([{ count: 1 }])
    })
  })
}

describe('D1 worksheet completion concurrency', () => {
  it('[unit] converges duplicate same-input delivery to one ledger and one receipt', async () => {
    const database = await d1Database()
    try {
      await seed(database)
      const input = {
        harvestRetainerId: 91_001,
        snapshotSha256,
        contextSha256,
        balanceCents: 12_500,
        occurredOn: '2026-08-30',
        notes: 'Opening balance copied from Harvest UI',
        completedAt: timestamp,
      }

      const results = await Promise.all([
        completeHarvestRetainerBalance(database.orm, input),
        completeHarvestRetainerBalance(database.orm, { ...input, completedAt: retryTimestamp }),
      ])

      expect(results.map((result) => result.replayed).sort()).toEqual([false, true])
      expect(
        await database.rows<{ receipts: number; ledger: number }>(
          `SELECT
             (SELECT count(*) FROM _ezacto_worksheet_completions) AS receipts,
             (SELECT count(*) FROM retainer_ledger) AS ledger`,
        ),
      ).toEqual([{ receipts: 1, ledger: 1 }])
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])
    } finally {
      await database.close()
    }
  })

  it('[unit] lets one conflicting delivery win and rejects the other without residue', async () => {
    const database = await d1Database()
    try {
      await seed(database)
      const input = {
        harvestRetainerId: 91_001,
        snapshotSha256,
        contextSha256,
        balanceCents: 12_500,
        occurredOn: '2026-08-30',
        notes: 'Opening balance copied from Harvest UI',
        completedAt: timestamp,
      }

      const results = await Promise.allSettled([
        completeHarvestRetainerBalance(database.orm, input),
        completeHarvestRetainerBalance(database.orm, {
          ...input,
          balanceCents: 12_501,
          completedAt: retryTimestamp,
        }),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected')
      expect(String(rejected?.reason)).toMatch(/different input|worksheet/)
      const state = await database.rows<{ receipt_balance: number; ledger_balance: number }>(
        `SELECT
           json_extract(completion.input_json, '$.balance_cents') AS receipt_balance,
           entry.amount AS ledger_balance
         FROM _ezacto_worksheet_completions completion
         JOIN retainer_ledger entry ON entry.retainer_id = completion.resource_id
         WHERE completion.kind = 'retainer_balance' AND completion.harvest_id = 91001`,
      )
      expect(state).toHaveLength(1)
      expect(state[0]!.receipt_balance).toBe(state[0]!.ledger_balance)
      expect(await database.rows(`SELECT * FROM _ezacto_worksheet_import_authority`)).toEqual([])
    } finally {
      await database.close()
    }
  })
})

describe('worksheet completion migration boundary', () => {
  it('[unit] upgrades a populated 0023 database without changing source identities', () => {
    const sqlite = new BetterSqlite3(':memory:')
    try {
      migrateContainerThrough(sqlite, '0023_migration_import_authority')
      sqlite
        .prepare(
          `INSERT INTO organizations (name, modules, created_at, updated_at)
         VALUES ('Sanitized Organization', '{}', ?, ?)`,
        )
        .run(timestamp, timestamp)
      migrateContainer(sqlite)
      expect(
        sqlite
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE '_ezacto_worksheet_%' ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: '_ezacto_worksheet_completions' },
        { name: '_ezacto_worksheet_import_authority' },
      ])
      expect(sqlite.prepare(`SELECT name FROM organizations`).all()).toEqual([
        { name: 'Sanitized Organization' },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('[unit] upgrades a populated D1 0023 database without changing source identities', async () => {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const d1 = await miniflare.getD1Database('DB')
      await migrateD1Through(d1, '0023_migration_import_authority')
      const database: TestDatabase = {
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
        close: async () => undefined,
      }
      await seed(database)
      const identitySql = `SELECT
        (SELECT id FROM retainers WHERE harvest_id = 91001) AS retainer_id,
        (SELECT id FROM recurring_invoices WHERE harvest_id = 92001) AS recurring_id,
        (SELECT id FROM projects WHERE harvest_id = 51001) AS project_id,
        (SELECT id FROM invoices WHERE harvest_id = 93001) AS invoice_id`
      const before = await database.rows(identitySql)

      await migrateD1(d1)

      expect(await database.rows(identitySql)).toEqual(before)
      expect(
        await database.rows<{ id: string }>(
          `SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`,
        ),
      ).toEqual([{ id: '0036_client_budgets' }])
    } finally {
      await miniflare.dispose()
    }
  })
})
