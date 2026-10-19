import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createCsvImportStore, isDuplicateCsvImportKey } from '../src/csv-imports.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

/**
 * Issue 1012, slice 2: the source identity of the CSV time import. The store is
 * runtime-neutral, so each case runs on both runtimes; what differs is how a
 * duplicate key surfaces, which `isDuplicateCsvImportKey` has to recognize on
 * both.
 */

interface Harness {
  store: ReturnType<typeof createCsvImportStore>
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-09-02T12:00:00.000Z'
const sha = 'a'.repeat(64)

const seed = async (harness: Omit<Harness, 'store'>): Promise<void> => {
  await harness.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Fictional', '{}', ?, ?)`,
    t0,
    t0,
  )
  await harness.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Ann', 'Member', 'member', '[]', ?, ?)`,
    t0,
    t0,
  )
  await harness.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'C', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await harness.run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'P', ?, ?)`,
    t0,
    t0,
  )
  await harness.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'T', ?, ?)`,
    t0,
    t0,
  )
  await harness.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  await harness.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at) VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
}

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const harness = {
    run: async (sql: string, ...params: unknown[]) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
    close: async () => {
      sqlite.close()
    },
  }
  await seed(harness)
  return { ...harness, store: createCsvImportStore(createContainerDatabase(sqlite)) }
}

const d1 = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  const harness = {
    run: async (sql: string, ...params: unknown[]) => {
      await database
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (
        await database
          .prepare(sql)
          .bind(...params)
          .all<Row>()
      ).results,
    close: async () => miniflare.dispose(),
  }
  await seed(harness)
  return { ...harness, store: createCsvImportStore(createD1Database(database)) }
}

const entry = (harness: Harness, runId: number, key: string) => {
  const { sql, params } = harness.store.recordEntry({
    runId,
    sourceId: 'demo',
    sourceKey: key,
    now: t0,
  })
  return harness.run(sql, ...params)
}
const timeEntry = (harness: Harness, id: number) =>
  harness.run(
    `INSERT INTO time_entries
       (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id, spent_date,
        seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
     VALUES (?, 1, 1, 1, 1, 1, '2026-09-01', 3600, 3600, 3600, 1, ?, ?)`,
    id,
    t0,
    t0,
  )

for (const [runtime, factory] of [
  ['container', container],
  ['D1', d1],
] as const) {
  describe(`CSV import ledger (${runtime})`, () => {
    it('[unit] is one run per source and file, and finds it again', async () => {
      const harness = await factory()
      try {
        expect(await harness.store.available()).toBe(true)
        expect(await harness.store.findRun('demo', sha)).toBeNull()
        const run = await harness.store.startRun({
          sourceId: 'demo',
          fileSha256: sha,
          mappingJson: '{}',
          mappingSha256: sha,
          totalRows: 3,
          now: t0,
        })
        expect(run).toMatchObject({ status: 'partial', totalRows: 3 })
        expect(await harness.store.findRun('demo', sha)).toMatchObject({ id: run.id })
        expect(await harness.store.findRun('other', sha)).toBeNull()
        await expect(
          harness.store.startRun({
            sourceId: 'demo',
            fileSha256: sha,
            mappingJson: '{}',
            mappingSha256: sha,
            totalRows: 3,
            now: t0,
          }),
        ).rejects.toThrow()
        await harness.store.finishRun(run.id, {
          status: 'complete',
          rejectedRows: 1,
          lastError: null,
          now: t0,
        })
        expect(await harness.store.findRun('demo', sha)).toMatchObject({
          status: 'complete',
          rejectedRows: 1,
          finishedAt: t0,
        })
      } finally {
        await harness.close()
      }
    })

    it('[unit] refuses a source key twice, and says that is what happened', async () => {
      const harness = await factory()
      try {
        const run = await harness.store.startRun({
          sourceId: 'demo',
          fileSha256: sha,
          mappingJson: '{}',
          mappingSha256: sha,
          totalRows: 1,
          now: t0,
        })
        await timeEntry(harness, 1)
        await entry(harness, run.id, 'k#0')
        await timeEntry(harness, 2)
        let failure: unknown
        try {
          await entry(harness, run.id, 'k#0')
        } catch (error) {
          failure = error
        }
        expect(failure).toBeDefined()
        expect(isDuplicateCsvImportKey(failure)).toBe(true)
        expect(isDuplicateCsvImportKey(new Error('something else'))).toBe(false)
        expect(await harness.store.importedKeys('demo')).toEqual(new Set(['k#0']))
        expect(await harness.store.importedKeys('other')).toEqual(new Set())
      } finally {
        await harness.close()
      }
    })

    it('[unit] keeps the key as a tombstone when its time entry is deleted', async () => {
      const harness = await factory()
      try {
        const run = await harness.store.startRun({
          sourceId: 'demo',
          fileSha256: sha,
          mappingJson: '{}',
          mappingSha256: sha,
          totalRows: 1,
          now: t0,
        })
        await timeEntry(harness, 1)
        await entry(harness, run.id, 'k#0')
        expect(await harness.rows(`SELECT time_entry_id FROM csv_import_entries`)).toEqual([
          { time_entry_id: 1 },
        ])
        await harness.run(`DELETE FROM time_entries WHERE id = 1`)
        expect(await harness.rows(`SELECT time_entry_id FROM csv_import_entries`)).toEqual([
          { time_entry_id: null },
        ])
        expect(await harness.store.importedKeys('demo')).toEqual(new Set(['k#0']))
      } finally {
        await harness.close()
      }
    })

    it('[unit] checks the shape of a source id, a hash and a key', async () => {
      const harness = await factory()
      try {
        await expect(
          harness.store.startRun({
            sourceId: 'has space',
            fileSha256: sha,
            mappingJson: '{}',
            mappingSha256: sha,
            totalRows: 1,
            now: t0,
          }),
        ).rejects.toThrow()
        await expect(
          harness.store.startRun({
            sourceId: 'demo',
            fileSha256: 'NOT-HEX',
            mappingJson: '{}',
            mappingSha256: sha,
            totalRows: 1,
            now: t0,
          }),
        ).rejects.toThrow()
        await expect(
          harness.store.startRun({
            sourceId: 'demo',
            fileSha256: sha,
            mappingJson: 'not json',
            mappingSha256: sha,
            totalRows: 1,
            now: t0,
          }),
        ).rejects.toThrow()
      } finally {
        await harness.close()
      }
    })
  })
}
