import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database, migrateContainer, migrateD1 } from '@ezacto/db'
import {
  LOAD_RESOURCES,
  assertLoadComplete,
  loadNextChunk,
  readLoadProgress,
  runLoad,
  type LoadChunkResult,
} from '../src/load.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

type Row = Record<string, unknown>
type Rows = <T extends Row>(sql: string) => Promise<T[]>

interface LoadOutcome {
  counts: Record<string, number>
  harvestIdentities: Record<string, string[]>
  relationships: Record<string, Row[]>
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`

const HARVEST_ID_TABLES = [
  'clients',
  'contacts',
  'estimate_item_categories',
  'estimate_line_items',
  'estimate_messages',
  'estimates',
  'expense_categories',
  'expenses',
  'invoice_item_categories',
  'invoice_line_items',
  'invoice_messages',
  'invoice_payments',
  'invoices',
  'projects',
  'recurring_invoices',
  'retainers',
  'roles',
  'task_assignments',
  'tasks',
  'time_entries',
  'user_assignments',
  'user_billable_rates',
  'user_cost_rates',
  'users',
] as const

const loadOutcome = async (rows: Rows): Promise<LoadOutcome> => {
  const counts: Record<string, number> = {}
  const harvestIdentities: Record<string, string[]> = {}
  const applicationTables = await rows<{ name: string }>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND substr(name, 1, 1) <> '_' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  )
  for (const { name } of applicationTables) {
    const table = quoteIdentifier(name)
    const [{ count }] = await rows<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
    counts[name] = count!
  }
  for (const name of HARVEST_ID_TABLES) {
    const table = quoteIdentifier(name)
    harvestIdentities[name] = (
      await rows<{ harvestId: string }>(
        `SELECT CAST(harvest_id AS TEXT) AS harvestId FROM ${table}
         WHERE harvest_id IS NOT NULL ORDER BY CAST(harvest_id AS TEXT)`,
      )
    ).map((row) => row.harvestId)
  }

  return {
    counts,
    harvestIdentities,
    relationships: {
      roles: await rows(
        `SELECT role.harvest_id AS role_harvest_id, user.harvest_id AS user_harvest_id
         FROM user_roles assignment
         JOIN roles role ON role.id = assignment.role_id
         JOIN users user ON user.id = assignment.user_id
         ORDER BY role.harvest_id, user.harvest_id`,
      ),
      teammates: await rows(
        `SELECT manager.harvest_id AS manager_harvest_id, teammate.harvest_id AS teammate_harvest_id
         FROM teammate_assignments assignment
         JOIN users manager ON manager.id = assignment.manager_id
         JOIN users teammate ON teammate.id = assignment.user_id
         ORDER BY manager.harvest_id, teammate.harvest_id`,
      ),
      taskAssignments: await rows(
        `SELECT assignment.harvest_id, project.harvest_id AS project_harvest_id,
           task.harvest_id AS task_harvest_id
         FROM task_assignments assignment
         JOIN projects project ON project.id = assignment.project_id
         JOIN tasks task ON task.id = assignment.task_id
         ORDER BY assignment.harvest_id`,
      ),
      userAssignments: await rows(
        `SELECT assignment.harvest_id, project.harvest_id AS project_harvest_id,
           user.harvest_id AS user_harvest_id
         FROM user_assignments assignment
         JOIN projects project ON project.id = assignment.project_id
         JOIN users user ON user.id = assignment.user_id
         ORDER BY assignment.harvest_id`,
      ),
      estimateLines: await rows(
        `SELECT estimate.harvest_id AS estimate_harvest_id, line.harvest_id
         FROM estimate_line_items line JOIN estimates estimate ON estimate.id = line.estimate_id
         ORDER BY estimate.harvest_id, line.harvest_id`,
      ),
      estimateMessages: await rows(
        `SELECT estimate.harvest_id AS estimate_harvest_id, message.harvest_id
         FROM estimate_messages message JOIN estimates estimate ON estimate.id = message.estimate_id
         ORDER BY estimate.harvest_id, message.harvest_id`,
      ),
      invoiceLines: await rows(
        `SELECT invoice.harvest_id AS invoice_harvest_id, line.harvest_id
         FROM invoice_line_items line JOIN invoices invoice ON invoice.id = line.invoice_id
         ORDER BY invoice.harvest_id, line.harvest_id`,
      ),
      invoiceMessages: await rows(
        `SELECT invoice.harvest_id AS invoice_harvest_id, message.harvest_id
         FROM invoice_messages message JOIN invoices invoice ON invoice.id = message.invoice_id
         ORDER BY invoice.harvest_id, message.harvest_id`,
      ),
      invoicePayments: await rows(
        `SELECT invoice.harvest_id AS invoice_harvest_id, payment.harvest_id,
           recorder.harvest_id AS recorder_harvest_id
         FROM invoice_payments payment
         JOIN invoices invoice ON invoice.id = payment.invoice_id
         LEFT JOIN users recorder ON recorder.id = payment.recorded_by_user_id
         ORDER BY invoice.harvest_id, payment.harvest_id`,
      ),
      timeEntries: await rows(
        `SELECT entry.harvest_id, user.harvest_id AS user_harvest_id,
           project.harvest_id AS project_harvest_id, task.harvest_id AS task_harvest_id,
           invoice.harvest_id AS invoice_harvest_id
         FROM time_entries entry
         JOIN users user ON user.id = entry.user_id
         JOIN projects project ON project.id = entry.project_id
         JOIN tasks task ON task.id = entry.task_id
         LEFT JOIN invoices invoice ON invoice.id = entry.invoice_id
         ORDER BY CAST(entry.harvest_id AS TEXT)`,
      ),
      expenses: await rows(
        `SELECT expense.harvest_id, user.harvest_id AS user_harvest_id,
           project.harvest_id AS project_harvest_id,
           category.harvest_id AS category_harvest_id,
           invoice.harvest_id AS invoice_harvest_id
         FROM expenses expense
         JOIN users user ON user.id = expense.user_id
         JOIN projects project ON project.id = expense.project_id
         JOIN expense_categories category ON category.id = expense.expense_category_id
         LEFT JOIN invoices invoice ON invoice.id = expense.invoice_id
         ORDER BY expense.harvest_id`,
      ),
      expenseReceipts: await rows(
        `SELECT receipt.source_expense_id, file.content_hash,
           attachment.id AS attachment_id, file.id AS file_id
         FROM harvest_expense_receipts receipt
         JOIN attachments attachment ON attachment.id = receipt.attachment_id
         JOIN file_objects file ON file.id = attachment.file_object_id
         ORDER BY receipt.source_expense_id`,
      ),
    },
  }
}

const protectedIdentities = async (rows: Rows): Promise<Record<string, Row[]>> => {
  const importedRows = await Promise.all(
    HARVEST_ID_TABLES.map(async (name) => {
      const table = quoteIdentifier(name)
      return [
        name,
        await rows(
          `SELECT * FROM ${table} WHERE harvest_id IS NOT NULL
           ORDER BY CAST(harvest_id AS TEXT), id`,
        ),
      ] as const
    }),
  )
  return {
    ...Object.fromEntries(importedRows),
    receipts: await rows(
      `SELECT * FROM harvest_expense_receipts ORDER BY source_expense_id`,
    ),
    receiptAttachments: await rows(
      `SELECT attachment.id AS attachment_id, attachment.file_object_id,
         attachment.name, attachment.uploaded_by_user_id,
         attachment.created_at AS attachment_created_at,
         attachment.updated_at AS attachment_updated_at,
         file.id AS file_id, file.content_hash, file.file_key, file.byte_size,
         file.content_type, file.created_at AS file_created_at,
         file.updated_at AS file_updated_at
       FROM harvest_expense_receipts receipt
       JOIN attachments attachment ON attachment.id = receipt.attachment_id
       JOIN file_objects file ON file.id = attachment.file_object_id
       ORDER BY receipt.source_expense_id`,
    ),
  }
}

const expectNoPendingLoadWork = async (rows: Rows): Promise<void> => {
  expect(
    await rows(
      `SELECT
        (SELECT count(*) FROM _ezacto_load_subprogress) AS subprogress,
        (SELECT count(*) FROM _ezacto_load_rate_progress) AS rate_progress,
        (SELECT count(*) FROM _ezacto_load_billable_rates) AS staged_billable_rates,
        (SELECT count(*) FROM _ezacto_load_cost_rates) AS staged_cost_rates,
        (SELECT count(*) FROM invoice_import_operations WHERE completed = 0) AS invoice_operations,
        (SELECT count(*) FROM invoice_import_reconciliations WHERE completed = 0)
          AS invoice_reconciliations`,
    ),
  ).toEqual([
    {
      subprogress: 0,
      rate_progress: 0,
      staged_billable_rates: 0,
      staged_cost_rates: 0,
      invoice_operations: 0,
      invoice_reconciliations: 0,
    },
  ])
}

const containerRows =
  (database: BetterSqlite3.Database): Rows =>
  async <T extends Row>(sql: string) =>
    database.prepare(sql).all() as T[]

const d1Rows =
  (database: D1Database): Rows =>
  async <T extends Row>(sql: string) =>
    (await database.prepare(sql).all<T>()).results

const checksum = async (snapshotDir: string): Promise<string> => {
  const value = JSON.parse(await readFile(join(snapshotDir, 'checksums.json'), 'utf8')) as {
    snapshot_sha256: string
  }
  return value.snapshot_sha256
}

const LOAD_CHECKPOINT_TABLES = [
  '_ezacto_load_progress',
  '_ezacto_load_lineage_progress',
  '_ezacto_load_subprogress',
  '_ezacto_load_rate_progress',
  '_ezacto_load_currency_progress',
  '_ezacto_load_billable_rates',
  '_ezacto_load_cost_rates',
] as const

const clearD1LoadCheckpoints = async (database: D1Database): Promise<void> => {
  for (const table of LOAD_CHECKPOINT_TABLES) {
    await database.prepare(`DELETE FROM ${table}`).run()
  }
}

const miniflareOptions = (persistencePath: string) => ({
  modules: true as const,
  script: 'export default { fetch() { return new Response("ok") } }',
  d1Databases: ['CLEAN', 'RESUMED'],
  d1Persist: persistencePath,
})

const loadD1ToCompletion = async (
  database: D1Database,
  snapshotDir: string,
  digest: string,
): Promise<LoadChunkResult> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await loadNextChunk({
      database: createD1Database(database),
      snapshotDir,
      immutableSnapshotSha256: digest,
      maxRows: 100,
      maxStatements: 700,
    })
    if (result.complete) return result
  }
  throw new Error('D1 load did not complete')
}

describe('idempotent load and resume', () => {
  let dir: string
  let snapshotDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-load-resume-'))
    snapshotDir = join(dir, 'snapshot')
    await buildSanitizedLoadSnapshot(snapshotDir)
  })

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  it('[unit] resumes a killed container load with the same rows and source relationships as a clean run', async () => {
    const cleanPath = join(dir, 'clean.sqlite')
    const resumedPath = join(dir, 'resumed.sqlite')
    await runLoad({ snapshotDir, databasePath: cleanPath, maxRows: 1, maxStatements: 20 })
    const clean = new BetterSqlite3(cleanPath, { readonly: true })
    const expected = await loadOutcome(containerRows(clean))
    clean.close()

    const interrupted = new BetterSqlite3(resumedPath)
    migrateContainer(interrupted)
    const interruptedDatabase = createContainerDatabase(interrupted)
    let checkpoint: LoadChunkResult | null = null
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await loadNextChunk({
        database: interruptedDatabase,
        snapshotDir,
        maxRows: 1,
        maxStatements: 20,
      })
      if (result.resource === 'projects' && result.loadedRows === 1) {
        checkpoint = result
        break
      }
    }
    expect(checkpoint).not.toBeNull()
    expect(
      interrupted
        .prepare(
          `SELECT rows_loaded AS rowsLoaded, total_rows AS totalRows, completed
           FROM _ezacto_load_progress WHERE resource = 'projects'`,
        )
        .get(),
    ).toEqual({ rowsLoaded: 1, totalRows: 2, completed: 0 })
    interrupted.close()

    // This is the on-disk lock shape left when the process disappears after its
    // database checkpoint but before runLoad's finally block can release it.
    const lockPath = join(snapshotDir, '.sync.lock')
    await mkdir(lockPath)
    await writeFile(
      join(lockPath, 'owner.json'),
      `${JSON.stringify({
        pid: 2_147_483_647,
        host: hostname(),
        command: 'load',
        started_at: '2026-08-30T00:00:00.000Z',
        token: 'test',
      })}\n`,
    )

    const resumed = await runLoad({
      snapshotDir,
      databasePath: resumedPath,
      maxRows: 1,
      maxStatements: 20,
    })
    const actualDatabase = new BetterSqlite3(resumedPath)
    try {
      const rows = containerRows(actualDatabase)
      expect(await loadOutcome(rows)).toEqual(expected)
      const report = await assertLoadComplete(
        createContainerDatabase(actualDatabase),
        resumed.snapshotSha256,
      )
      expect(report.resources).toHaveLength(LOAD_RESOURCES.length)
      expect(
        report.resources.filter((resource) => !resource.completed).map((r) => r.resource),
      ).toEqual([])
      expect(
        report.resources
          .filter((resource) => resource.rowsLoaded !== resource.totalRows)
          .map((r) => ({ resource: r.resource, loaded: r.rowsLoaded, total: r.totalRows })),
      ).toEqual([])
      await expectNoPendingLoadWork(rows)
    } finally {
      actualDatabase.close()
    }
  }, 60_000)

  it('[unit] a same-snapshot replay is a no-op even when every load checkpoint is lost', async () => {
    const databasePath = join(dir, 'replay.sqlite')
    const first = await runLoad({ snapshotDir, databasePath, maxRows: 1, maxStatements: 20 })
    const database = new BetterSqlite3(databasePath)
    const rows = containerRows(database)
    const beforeOutcome = await loadOutcome(rows)
    const beforeIdentities = await protectedIdentities(rows)
    database.close()

    const beforeRetry = createHash('sha256')
      .update(await readFile(databasePath))
      .digest('hex')
    const directRetry = await runLoad({ snapshotDir, databasePath, maxRows: 1, maxStatements: 20 })
    expect(directRetry.loadedRows).toBe(0)
    expect(directRetry.snapshotSha256).toBe(first.snapshotSha256)
    expect(
      createHash('sha256')
        .update(await readFile(databasePath))
        .digest('hex'),
    ).toBe(beforeRetry)

    const checkpointless = new BetterSqlite3(databasePath)
    try {
      checkpointless.transaction(() => {
        for (const table of LOAD_CHECKPOINT_TABLES)
          checkpointless.prepare(`DELETE FROM ${table}`).run()
      })()
    } finally {
      checkpointless.close()
    }
    await runLoad({ snapshotDir, databasePath, maxRows: 1, maxStatements: 20 })

    const replayed = new BetterSqlite3(databasePath)
    try {
      const replayedRows = containerRows(replayed)
      expect(await loadOutcome(replayedRows)).toEqual(beforeOutcome)
      expect(await protectedIdentities(replayedRows)).toEqual(beforeIdentities)
      expect(
        replayed.prepare('SELECT count(*) AS count FROM _ezacto_load_anomalies').get(),
      ).toEqual({ count: 1 })
      await expectNoPendingLoadWork(replayedRows)
    } finally {
      replayed.close()
    }
  }, 60_000)

  it('[unit] D1 resumes after an adapter restart and converges duplicate deliveries and replay', async () => {
    const persistencePath = join(dir, 'miniflare')
    const digest = await checksum(snapshotDir)
    let miniflare = new Miniflare(miniflareOptions(persistencePath))
    let clean = await miniflare.getD1Database('CLEAN')
    let resumed = await miniflare.getD1Database('RESUMED')
    await Promise.all([migrateD1(clean), migrateD1(resumed)])
    await loadD1ToCompletion(clean, snapshotDir, digest)

    let checkpoint: LoadChunkResult | null = null
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await loadNextChunk({
        database: createD1Database(resumed),
        snapshotDir,
        immutableSnapshotSha256: digest,
        maxRows: 1,
        maxStatements: 20,
      })
      if (result.resource === 'projects' && result.loadedRows === 1) {
        checkpoint = result
        break
      }
    }
    expect(checkpoint).not.toBeNull()
    await miniflare.dispose()

    // A fresh Miniflare instance removes every process-local admission/cache
    // witness while retaining only the D1 database and immutable snapshot.
    miniflare = new Miniflare(miniflareOptions(persistencePath))
    clean = await miniflare.getD1Database('CLEAN')
    resumed = await miniflare.getD1Database('RESUMED')
    try {
      const duplicate = await Promise.all([
        loadNextChunk({
          database: createD1Database(resumed),
          snapshotDir,
          immutableSnapshotSha256: digest,
          maxRows: 1,
          maxStatements: 20,
        }),
        loadNextChunk({
          database: createD1Database(resumed),
          snapshotDir,
          immutableSnapshotSha256: digest,
          maxRows: 1,
          maxStatements: 20,
        }),
      ])
      expect(duplicate.map((result) => result.snapshotSha256)).toEqual([digest, digest])
      await loadD1ToCompletion(resumed, snapshotDir, digest)
      expect(await loadOutcome(d1Rows(resumed))).toEqual(await loadOutcome(d1Rows(clean)))

      const beforeOutcome = await loadOutcome(d1Rows(resumed))
      const beforeIdentities = await protectedIdentities(d1Rows(resumed))
      const completeRetry = await loadNextChunk({
        database: createD1Database(resumed),
        snapshotDir,
        immutableSnapshotSha256: digest,
        maxRows: 1,
        maxStatements: 20,
      })
      expect(completeRetry).toMatchObject({ complete: true, loadedRows: 0 })

      await clearD1LoadCheckpoints(resumed)
      await loadD1ToCompletion(resumed, snapshotDir, digest)
      expect(await loadOutcome(d1Rows(resumed))).toEqual(beforeOutcome)
      expect(await protectedIdentities(d1Rows(resumed))).toEqual(beforeIdentities)
      expect(
        await resumed.prepare('SELECT count(*) AS count FROM _ezacto_load_anomalies').first(),
      ).toEqual({ count: 1 })
      const progress = await readLoadProgress(createD1Database(resumed))
      expect(progress).toHaveLength(LOAD_RESOURCES.length)
      // Named rather than counted (issue 620). These were `.every(...)` and
      // failed as a bare `false == true`, which says a resource did not
      // converge without saying which -- so every flake cost a re-run to learn
      // anything at all. The diff now carries the resource and its counts.
      expect(progress.filter((resource) => !resource.completed).map((r) => r.resource)).toEqual([])
      expect(
        progress
          .filter((resource) => resource.rowsLoaded !== resource.totalRows)
          .map((r) => ({ resource: r.resource, loaded: r.rowsLoaded, total: r.totalRows })),
      ).toEqual([])
      await expectNoPendingLoadWork(d1Rows(resumed))
    } finally {
      await miniflare.dispose()
    }
  }, 180_000)
})
