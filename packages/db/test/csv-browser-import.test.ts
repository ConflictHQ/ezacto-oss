import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createCsvImportStore } from '../src/csv-imports.js'
import { createCsvBrowserDatasetLedger } from '../src/csv-browser-import.js'
import { DrizzleTrackedResourceRepository } from '../src/tracked-resource-repository.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { csvNameKey, type CsvImportDestinationScope } from '@ezacto/core'
import {
  csvImportDestinationFacts,
  csvImportDestinationFence,
  csvImportSetupFacts,
  registerCsvImportSqliteFunctions,
} from '../src/csv-import-destination.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import type { AdministratorActor, CsvPlanInput, CsvBrowserCommit } from '@ezacto/core'
interface Harness {
  sqlite?: BetterSqlite3.Database
  orm: InvoiceStateDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-09-02T12:00:00.000Z'
const sha = 'a'.repeat(64)

const seed = async (harness: Omit<Harness, 'orm'>): Promise<void> => {
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
    `INSERT INTO users (id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES (2,'Ada','Admin','administrator','[]',?,?)`,
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
  return { ...harness, sqlite, orm: createContainerDatabase(sqlite) }
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
  return { ...harness, orm: createD1Database(database) }
}

const admin: AdministratorActor = { kind: 'administrator', userId: '2' }
const setup = async (h: Harness, confirm = true) => {
  await h.run(
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(3,'Owned','Member','member','[]',?,?)`,
    t0,
    t0,
  )
  let clock = new Date(t0)
  let destination = true
  const tracked = new DrizzleTrackedResourceRepository(h.orm, { isLocked: async () => false })
  const ledger = createCsvBrowserDatasetLedger(h.orm, {
    tracked,
    now: () => clock,
    setupFacts: () => ({ sql: '?', params: [sha] }),
    clockSql: () => ({ sql: '?', params: [clock.getTime()] }),
    destinationFence: () => ({
      sql: "?=1 AND (SELECT name FROM organizations WHERE id=1)='Fictional'",
      params: [destination ? 1 : 0],
    }),
  })
  const datasetId = await ledger.registerDataset(admin, { workspaceIdentity: 'owned-workspace' })
  const plan: CsvPlanInput = {
    datasetId,
    fileSha256: sha,
    mappingSha256: sha,
    adapterId: 'owned-csv',
    identityVersion: 1,
    dateFormat: 'iso',
    exporterZone: 'UTC',
    excludedLines: [5],
    destinationVersion: 'owned-destination-v1',
    fileRows: 4,
    selectedRows: 3,
  }
  const sealed = await ledger.seal(admin, plan, confirm)
  if (sealed.outcome === 'blocked') throw new Error('Fixture seal refused')
  const run = sealed.run
  const lease = confirm
    ? await ledger.claimLease(admin, {
        runId: run.runId,
        holder: 'owned-worker',
        ttlMs: 10000,
      })
    : {
        outcome: 'claimed' as const,
        lease: { holder: 'owned-worker', generation: 0, expiresAt: 0 },
      }
  if (lease.outcome !== 'claimed') throw new Error('Fixture lease refused')
  const command: CsvBrowserCommit = {
    runId: run.runId,
    planId: run.planId,
    holder: lease.lease.holder,
    leaseGeneration: lease.lease.generation,
    chunkIndex: 0,
    sourceKey: 'owned-row#0',
    line: 2,
    sourceSeconds: 4442,
    entry: {
      userId: 1,
      projectId: 1,
      taskId: 1,
      spentDate: '2026-09-01',
      seconds: 4442,
      notes: 'Owned synthetic entry',
    },
  }
  return {
    ledger,
    plan,
    command,
    tracked,
    setClock: (value: Date) => {
      clock = value
    },
    staleDestination: () => {
      destination = false
    },
  }
}
for (const [runtime, factory] of [
  ['SQLite', container],
  ['D1', d1],
] as const) {
  describe(`native browser CSV ledger (${runtime})`, () => {
    it('[unit] registers once, permits draft replacement and permanently seals the selected file/mapping/adapter/exclusions', async () => {
      const h = await factory()
      try {
        const { ledger, plan } = await setup(h)
        expect(await ledger.registerDataset(admin, { workspaceIdentity: 'owned-workspace' })).toBe(
          plan.datasetId,
        )
        expect(await ledger.seal(admin, plan, true)).toMatchObject({ outcome: 'reopened' })
        await expect(
          ledger.seal(admin, { ...plan, exporterZone: undefined } as unknown as CsvPlanInput, true),
        ).rejects.toThrow('Invalid CSV plan')
        await expect(
          ledger.seal(admin, { ...plan, fileRows: undefined } as unknown as CsvPlanInput, true),
        ).rejects.toThrow('Invalid CSV plan')
        await expect(ledger.seal(admin, { ...plan, selectedRows: 5 }, true)).rejects.toThrow(
          'Invalid CSV plan',
        )
        for (const [change, reason] of [
          [{ fileSha256: 'b'.repeat(64) }, 'different_file'],
          [{ mappingSha256: 'b'.repeat(64) }, 'different_mapping'],
          [{ adapterId: 'other' }, 'different_adapter'],
          [{ excludedLines: [] }, 'different_selection'],
          [{ destinationVersion: 'other' }, 'different_destination'],
        ] as const)
          expect(await ledger.seal(admin, { ...plan, ...change }, true)).toMatchObject({
            outcome: 'blocked',
            reason,
          })
        await expect(
          ledger.registerDataset(admin, { workspaceIdentity: 'other-owned-workspace' }),
        ).rejects.toMatchObject({ code: 'dataset_conflict' })
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] replaces draft file/mapping/exclusions until explicit confirmation only', async () => {
      const h = await factory()
      try {
        const { ledger, plan, command } = await setup(h, false)
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          status: 'draft',
          actor: null,
        })
        await expect(
          ledger.claimLease(admin, { runId: command.runId, holder: 'owned', ttlMs: 10000 }),
        ).rejects.toMatchObject({ code: 'not_confirmed' })
        const replaced = {
          ...plan,
          fileSha256: 'b'.repeat(64),
          mappingSha256: 'c'.repeat(64),
          excludedLines: [2],
        }
        expect(await ledger.seal(admin, replaced, false)).toMatchObject({
          run: { status: 'draft', plan: replaced },
        })
        expect(await ledger.seal(admin, replaced, true)).toMatchObject({
          run: { status: 'partial', actor: admin },
        })
        expect(await ledger.seal(admin, plan, true)).toMatchObject({
          outcome: 'blocked',
          reason: 'different_file',
        })
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] refuses to confirm a stale preview without changing its draft or creating a new run', async () => {
      const h = await factory()
      try {
        const { ledger, plan, command, staleDestination } = await setup(h, false)
        const before = await h.rows('SELECT * FROM csv_import_runs')
        staleDestination()
        expect(await ledger.seal(admin, plan, true)).toMatchObject({
          outcome: 'blocked',
          reason: 'stale_plan',
        })
        expect(await h.rows('SELECT * FROM csv_import_runs')).toEqual(before)
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          status: 'draft',
          actor: null,
        })
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] records truthful file counts and refuses completion until every selected position committed', async () => {
      const h = await factory()
      try {
        const { ledger, command } = await setup(h)
        expect(await h.rows('SELECT total_rows FROM csv_import_runs')).toEqual([{ total_rows: 4 }])
        await expect(
          ledger.finish(admin, { ...command, status: 'complete' }),
        ).rejects.toMatchObject({ code: 'incomplete_run' })
        await ledger.commitEntry(admin, command)
        await expect(
          ledger.finish(admin, { ...command, status: 'complete' }),
        ).rejects.toMatchObject({ code: 'incomplete_run' })
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          status: 'partial',
          written: 1,
        })
        for (const [index, seconds] of [
          [1, 3600],
          [2, 1],
        ] as const)
          await ledger.commitEntry(admin, {
            ...command,
            chunkIndex: index,
            line: index + 2,
            sourceKey: `owned-complete#${index}`,
            sourceSeconds: seconds,
            entry: { ...command.entry, seconds },
          })
        await ledger.finish(admin, { ...command, status: 'complete' })
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          status: 'complete',
          written: 3,
          plan: { fileRows: 4, selectedRows: 3 },
        })
        expect(
          await h.rows('SELECT status,total_rows,committed_chunks FROM csv_import_runs'),
        ).toEqual([{ status: 'complete', total_rows: 4, committed_chunks: 3 }])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] commits through the real tracked writer with one key/progress/audit, exact replay and durable tombstone dedup', async () => {
      const h = await factory()
      try {
        const { ledger, command } = await setup(h)
        expect(await ledger.commitEntry(admin, command)).toEqual({ outcome: 'written' })
        expect(await ledger.commitEntry(admin, command)).toEqual({ outcome: 'written' })
        expect(
          await ledger.commitEntry(admin, {
            ...command,
            entry: {
              notes: 'Owned synthetic entry',
              seconds: 4442,
              spentDate: '2026-09-01',
              taskId: 1,
              projectId: 1,
              userId: 1,
            },
          }),
        ).toEqual({ outcome: 'written' })
        expect(await h.rows('SELECT seconds,seconds_without_timer FROM time_entries')).toEqual([
          { seconds: 4442, seconds_without_timer: 4442 },
        ])
        expect(await h.rows('SELECT source_line,source_seconds FROM csv_import_entries')).toEqual([
          { source_line: 2, source_seconds: 4442 },
        ])
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          written: 1,
          alreadyImported: 0,
        })
        await h.run('DELETE FROM time_entries')
        await expect(
          ledger.commitEntry(admin, { ...command, chunkIndex: 1 }),
        ).rejects.toMatchObject({ code: 'chunk_conflict' })
        expect(await ledger.commitEntry(admin, command)).toEqual({ outcome: 'written' })
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          written: 1,
          alreadyImported: 0,
        })
        await expect(
          ledger.commitEntry(admin, { ...command, sourceSeconds: 1 }),
        ).rejects.toMatchObject({ code: 'chunk_conflict' })
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] attaches the canonical on-behalf audit to the new time id after ledger inserts change last_insert_rowid', async () => {
      const h = await factory()
      try {
        const { ledger, command, tracked } = await setup(h)
        for (const seconds of [1, 2])
          await tracked.createTimeEntry(
            { userId: 1, profile: 'administrator' },
            { userId: 1, projectId: 1, taskId: 1, spentDate: '2026-09-01', seconds },
            { instant: t0, date: '2026-09-02', time: '12:00' },
          )
        await ledger.commitEntry(admin, command)
        const [entry] = await h.rows<{ id: number }>(
          'SELECT id FROM time_entries WHERE seconds=4442',
        )
        expect(entry).toBeDefined()
        expect(
          await h.rows(
            `SELECT aggregate_id,CAST(json_extract(payload_json,'$.aggregate.id') AS INTEGER) AS payload_id,CAST(json_extract(payload_json,'$.time_entry.after.seconds') AS INTEGER) AS seconds,CAST(json_extract(payload_json,'$.actor.id') AS INTEGER) AS actor_id FROM event_outbox WHERE event_type='time_entry.created_on_behalf'`,
          ),
        ).toEqual([{ aggregate_id: entry!.id, payload_id: entry!.id, seconds: 4442, actor_id: 2 }])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] serializes real concurrent chunk and setup replay without duplicate time, keys, lineage or progress', async () => {
      const h = await factory()
      try {
        const { ledger, command, tracked } = await setup(h)
        const originalCreate = tracked.createTimeEntry.bind(tracked)
        let arrivals = 0
        let release!: () => void
        const bothMissedTheKey = new Promise<void>((resolve) => {
          release = resolve
        })
        tracked.createTimeEntry = async (...args) => {
          arrivals += 1
          if (arrivals === 2) release()
          await bothMissedTheKey
          return originalCreate(...args)
        }
        const outcomes = await Promise.all([
          ledger.commitEntry(admin, command),
          ledger.commitEntry(admin, command),
        ])
        expect(arrivals).toBe(2)
        expect(outcomes).toEqual([{ outcome: 'written' }, { outcome: 'written' }])
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(1)
        expect(await h.rows('SELECT id FROM csv_import_entries')).toHaveLength(1)
        expect(
          await h.rows(
            "SELECT id FROM event_outbox WHERE event_type='time_entry.created_on_behalf'",
          ),
        ).toHaveLength(1)
        expect(await h.rows('SELECT run_id FROM csv_import_chunks')).toHaveLength(1)
        expect(await h.rows('SELECT committed_chunks FROM csv_import_runs')).toEqual([
          { committed_chunks: 1 },
        ])
        const request = {
          ...command,
          setupKey: 'concurrent-client',
          kind: 'clients' as const,
          input: { name: 'Owned concurrent client' },
        }
        const [first, second] = await Promise.all([
          ledger.setup(admin, request),
          ledger.setup(admin, request),
        ])
        expect(first).toEqual(second)
        expect(
          await h.rows('SELECT id FROM clients WHERE name=?', 'Owned concurrent client'),
        ).toEqual([{ id: first!.id }])
        expect(await h.rows('SELECT entity_id FROM csv_import_setup')).toEqual([
          { entity_id: first!.id },
        ])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] acknowledges a real closed-target tombstone without reconstructing or resurrecting its old entry', async () => {
      const h = await factory()
      try {
        const { ledger, command, staleDestination, tracked, plan } = await setup(h)
        await h.run(
          `INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,3,?,?)`,
          t0,
          t0,
        )
        const original = { ...command, entry: { ...command.entry, userId: 3 } }
        expect(await ledger.commitEntry(admin, original)).toEqual({ outcome: 'written' })
        // A different already-imported key with original source evidence can
        // occupy its own selected position. It is not the first row counted twice.
        await tracked.createTimeEntry(
          { userId: 2, profile: 'administrator' },
          { ...original.entry, seconds: 3600 },
          { instant: t0, date: '2026-09-02', time: '12:00' },
          [
            createCsvImportStore(h.orm).recordEntry({
              runId: Number(command.runId),
              sourceId: plan.datasetId,
              sourceKey: 'preexisting-row#1',
              sourceLine: 3,
              sourceSeconds: 3600,
              now: t0,
            }),
          ],
        )
        await createAccountRetentionRepository(h.orm).publish({
          actorUserId: 1,
          expectedVersion: 0,
          now: t0,
          policy: {
            frameworks: [],
            retained_records: ['audit_and_security', 'time_and_worker_attribution'].map(
              (category) => ({
                category,
                reason: 'Owned fixture: retain reviewed import and worker evidence.',
                period: 'Review after thirty days.',
                review_after_days: 30,
              }),
            ),
            response_target_days: 14,
            operator_contact: 'owned@example.invalid',
            user_notice: 'Owned fixture closure notice.',
            backup_handling: 'Reapply closure evidence on restore.',
            acknowledged: true,
          },
        })
        await createAccountDeletionRequestRepository(h.orm).request({
          userId: 3,
          id: 'owned-close-target',
          now: t0,
          expectedPolicyVersion: 1,
        })
        const closures = createAccountClosureRepository(h.orm)
        const review = await closures.preview(1, 'owned-close-target')
        expect(review.uncovered_categories).toEqual([])
        await closures.close({
          actorUserId: 1,
          id: 'owned-close-target',
          expectedVersion: review.request_version,
          reviewToken: review.review_token,
          expectedPolicyVersion: 1,
          now: t0,
          acknowledged: true,
        })
        await expect(
          ledger.commitEntry(admin, {
            ...original,
            chunkIndex: 1,
            sourceKey: 'must-not-resurrect',
          }),
        ).rejects.toMatchObject({ code: 'stale_plan' })
        await expect(
          ledger.setup(admin, {
            ...command,
            setupKey: 'must-not-reassign',
            kind: 'user-assignments',
            input: { userId: 3, projectId: 1 },
          }),
        ).rejects.toMatchObject({ code: 'stale_plan' })
        await h.run('DELETE FROM time_entries WHERE user_id=3')
        const existing = {
          runId: original.runId,
          planId: original.planId,
          holder: original.holder,
          leaseGeneration: original.leaseGeneration,
          chunkIndex: original.chunkIndex,
          sourceKey: original.sourceKey,
          line: original.line,
          sourceSeconds: original.sourceSeconds,
        }
        staleDestination()
        expect(await ledger.acknowledgeExisting(admin, existing)).toEqual({ outcome: 'written' })
        await expect(
          ledger.acknowledgeExisting(admin, { ...existing, chunkIndex: 1 }),
        ).rejects.toMatchObject({ code: 'chunk_conflict' })
        expect(
          await Promise.all([
            ledger.acknowledgeExisting(admin, {
              ...existing,
              chunkIndex: 1,
              sourceKey: 'preexisting-row#1',
              line: 3,
              sourceSeconds: 3600,
            }),
            ledger.acknowledgeExisting(admin, {
              ...existing,
              chunkIndex: 1,
              sourceKey: 'preexisting-row#1',
              line: 3,
              sourceSeconds: 3600,
            }),
          ]),
        ).toEqual([{ outcome: 'duplicate' }, { outcome: 'duplicate' }])
        await expect(
          ledger.acknowledgeExisting(admin, {
            ...existing,
            chunkIndex: 2,
            sourceKey: 'absent-key',
          }),
        ).rejects.toMatchObject({ code: 'source_key_required' })
        await expect(
          ledger.acknowledgeExisting(admin, { ...existing, sourceSeconds: 1 }),
        ).rejects.toMatchObject({ code: 'chunk_conflict' })
        await expect(
          ledger.acknowledgeExisting(admin, { ...existing, chunkIndex: 9 }),
        ).rejects.toMatchObject({ code: 'chunk_conflict' })
        await expect(
          ledger.acknowledgeExisting(admin, { ...existing, chunkIndex: 2, line: 5 }),
        ).rejects.toMatchObject({ code: 'excluded_line' })
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
        expect(await h.rows('SELECT time_entry_id FROM csv_import_entries')).toEqual([
          { time_entry_id: null },
          { time_entry_id: null },
        ])
        expect(await ledger.getRun(admin, command.runId)).toMatchObject({
          written: 1,
          alreadyImported: 1,
        })
        expect(await h.rows('SELECT committed_chunks FROM csv_import_runs')).toEqual([
          { committed_chunks: 2 },
        ])
        // The unchanged legacy CLI recording path has no source-line/seconds
        // evidence. Do not invent that evidence from today's catalog.
        const legacy = createCsvImportStore(h.orm)
        await tracked.createTimeEntry(
          { userId: 1, profile: 'administrator' },
          { userId: 1, projectId: 1, taskId: 1, spentDate: '2026-09-01', seconds: 1 },
          { instant: t0, date: '2026-09-02', time: '12:00' },
          [
            legacy.recordEntry({
              runId: Number(command.runId),
              sourceId: plan.datasetId,
              sourceKey: 'legacy-key#0',
              now: t0,
            }),
          ],
        )
        await expect(
          ledger.acknowledgeExisting(admin, {
            ...existing,
            chunkIndex: 2,
            sourceKey: 'legacy-key#0',
            line: 3,
            sourceSeconds: 1,
          }),
        ).rejects.toMatchObject({ code: 'source_identity_unavailable' })
        expect(await h.rows('SELECT id FROM time_entries WHERE user_id=3')).toHaveLength(0)
        expect(
          await h.rows(
            'SELECT source_line,source_seconds FROM csv_import_entries WHERE source_key=?',
            'legacy-key#0',
          ),
        ).toEqual([{ source_line: null, source_seconds: null }])
        expect(await h.rows('SELECT committed_chunks FROM csv_import_runs')).toEqual([
          { committed_chunks: 2 },
        ])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] fences stale actors, exclusions, live leases, expired generations and changed destination before any time', async () => {
      const h = await factory()
      try {
        const { ledger, command, setClock, staleDestination } = await setup(h)
        await expect(
          ledger.getRun({ kind: 'administrator', userId: '3' }, command.runId),
        ).rejects.toMatchObject({ code: 'actor_required' })
        await expect(ledger.commitEntry(admin, { ...command, line: 5 })).rejects.toMatchObject({
          code: 'excluded_line',
        })
        expect(
          await ledger.claimLease(admin, {
            runId: command.runId,
            holder: command.holder,
            ttlMs: 10000,
          }),
        ).toMatchObject({ outcome: 'held' })
        setClock(new Date(Date.parse(t0) + 11000))
        const renewed = await ledger.claimLease(admin, {
          runId: command.runId,
          holder: 'new-worker',
          ttlMs: 10000,
        })
        expect(renewed).toMatchObject({ outcome: 'claimed', lease: { generation: 2 } })
        await expect(ledger.commitEntry(admin, command)).rejects.toMatchObject({
          code: 'stale_lease',
        })
        staleDestination()
        await expect(
          ledger.commitEntry(admin, { ...command, holder: 'new-worker', leaseGeneration: 2 }),
        ).rejects.toMatchObject({ code: 'stale_plan' })
        await h.run("UPDATE users SET profile='member' WHERE id=2")
        await expect(ledger.getRun(admin, command.runId)).rejects.toMatchObject({
          code: 'actor_required',
        })
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] binds a lease to its actual admin and permits explicit takeover after the old actor loses authority', async () => {
      const h = await factory()
      try {
        const { ledger, command, setClock } = await setup(h)
        await h.run(
          `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(4,'Owned','Replacement admin','administrator','[]',?,?)`,
          t0,
          t0,
        )
        const replacement: AdministratorActor = { kind: 'administrator', userId: '4' }
        await expect(ledger.commitEntry(replacement, command)).rejects.toMatchObject({
          code: 'stale_lease',
        })
        await h.run("UPDATE users SET profile='member' WHERE id=2")
        await expect(ledger.commitEntry(admin, command)).rejects.toMatchObject({
          code: 'actor_required',
        })
        setClock(new Date(Date.parse(t0) + 11000))
        const claimed = await ledger.claimLease(replacement, {
          runId: command.runId,
          holder: 'new-admin',
          ttlMs: 10000,
        })
        expect(claimed).toMatchObject({ outcome: 'claimed', lease: { generation: 2 } })
        expect(
          await ledger.commitEntry(replacement, {
            ...command,
            holder: 'new-admin',
            leaseGeneration: 2,
          }),
        ).toEqual({ outcome: 'written' })
        expect(await ledger.getRun(replacement, command.runId)).toMatchObject({
          actor: admin,
          written: 1,
        })
        const client = await ledger.setup(replacement, {
          ...command,
          holder: 'new-admin',
          leaseGeneration: 2,
          setupKey: 'handover-client',
          kind: 'clients',
          input: { name: 'Owned handover client' },
        })
        expect(client.name).toBe('Owned handover client')
        expect(await h.rows('SELECT actor_user_id FROM csv_import_chunks')).toEqual([
          { actor_user_id: 4 },
        ])
        expect(await h.rows('SELECT actor_user_id FROM csv_import_setup')).toEqual([
          { actor_user_id: 4 },
        ])
        await h.run("UPDATE users SET profile='administrator' WHERE id=2")
        await expect(ledger.commitEntry(admin, command)).rejects.toMatchObject({
          code: 'stale_lease',
        })
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(1)
        await createAccountRetentionRepository(h.orm).publish({
          actorUserId: 1,
          expectedVersion: 0,
          now: t0,
          policy: {
            frameworks: [],
            retained_records: [
              {
                category: 'audit_and_security',
                reason: 'Owned fixture: retain minimal import confirmation evidence.',
                period: 'Review after thirty days.',
                review_after_days: 30,
              },
            ],
            response_target_days: 14,
            operator_contact: 'owned@example.invalid',
            user_notice: 'Owned fixture closure notice.',
            backup_handling: 'Reapply closure evidence on restore.',
            acknowledged: true,
          },
        })
        await createAccountDeletionRequestRepository(h.orm).request({
          userId: 2,
          id: 'owned-close-confirmer',
          now: t0,
          expectedPolicyVersion: 1,
        })
        const closures = createAccountClosureRepository(h.orm)
        const review = await closures.preview(1, 'owned-close-confirmer')
        expect(review.uncovered_categories).toEqual([])
        expect(review.inventory).toContainEqual({
          location: 'csv_import_runs.confirmed_by_user_id',
          count: 1,
          category: 'audit_and_security',
        })
        await closures.close({
          actorUserId: 1,
          id: 'owned-close-confirmer',
          expectedVersion: review.request_version,
          reviewToken: review.review_token,
          expectedPolicyVersion: 1,
          now: t0,
          acknowledged: true,
        })
        await expect(ledger.commitEntry(admin, command)).rejects.toMatchObject({
          code: 'actor_required',
        })
        await expect(ledger.getRun(admin, command.runId)).rejects.toMatchObject({
          code: 'actor_required',
        })
        await createAccountDeletionRequestRepository(h.orm).request({
          userId: 4,
          id: 'owned-review-replacement',
          now: t0,
          expectedPolicyVersion: 1,
        })
        const replacementReview = await closures.preview(1, 'owned-review-replacement')
        expect(replacementReview.uncovered_categories).toEqual([])
        for (const location of [
          'csv_import_runs.lease_actor_user_id',
          'csv_import_setup.actor_user_id',
          'csv_import_chunks.actor_user_id',
        ])
          expect(replacementReview.inventory).toContainEqual({
            location,
            count: 1,
            category: 'audit_and_security',
          })
        expect(
          await h.rows('SELECT lease_actor_user_id,confirmed_by_user_id FROM csv_import_runs'),
        ).toEqual([{ lease_actor_user_id: 4, confirmed_by_user_id: 2 }])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] creates canonical setup with atomic lineage and exact replay despite default relation inserts', async () => {
      const h = await factory()
      try {
        const { ledger, command } = await setup(h)
        await h.run('UPDATE tasks SET is_default=1 WHERE id=1')
        await h.run('UPDATE users SET has_access_to_all_future_projects=1 WHERE id=1')
        const request = {
          ...command,
          setupKey: 'new-project',
          kind: 'projects' as const,
          input: { clientId: 1, name: 'Owned new project' },
        }
        const project = await ledger.setup(admin, request)
        expect(await ledger.setup(admin, request)).toEqual(project)
        expect(await h.rows('SELECT entity_id FROM csv_import_setup')).toEqual([
          { entity_id: project.id },
        ])
        expect(
          await h.rows('SELECT project_id FROM task_assignments WHERE project_id=?', project.id),
        ).toEqual([{ project_id: project.id }])
        await expect(
          ledger.setup(admin, { ...request, input: { clientId: 1, name: 'Changed' } }),
        ).rejects.toMatchObject({ code: 'chunk_conflict' })
        const user = await ledger.setup(admin, {
          ...command,
          setupKey: 'new-user',
          kind: 'users',
          input: {
            firstName: 'Owned',
            lastName: 'Person',
            email: 'owned@example.invalid',
            profile: 'member',
          },
        })
        expect(
          await h.rows('SELECT user_id FROM user_emails WHERE address=?', 'owned@example.invalid'),
        ).toEqual([{ user_id: user.id }])
        await ledger.finish(admin, { ...command, status: 'cancelled' })
        expect(await h.rows('SELECT id FROM projects WHERE id=?', project.id)).toHaveLength(1)
        expect(await h.rows('SELECT id FROM users WHERE id=?', user.id)).toHaveLength(1)
        await expect(
          ledger.setup(admin, { ...request, setupKey: 'after-cancel' }),
        ).rejects.toMatchObject({ code: 'cancelled' })
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] rolls back setup and its default relations if authority changes in the atomic creation', async () => {
      const h = await factory()
      try {
        const { ledger, command } = await setup(h)
        await h.run(
          `CREATE TRIGGER owned_demote_setup AFTER INSERT ON projects BEGIN UPDATE users SET profile='member' WHERE id=2; END`,
        )
        await expect(
          ledger.setup(admin, {
            ...command,
            setupKey: 'refused',
            kind: 'projects',
            input: { clientId: 1, name: 'Must roll back' },
          }),
        ).rejects.toThrow()
        expect(await h.rows('SELECT id FROM projects')).toEqual([{ id: 1 }])
        expect(await h.rows('SELECT * FROM csv_import_setup')).toHaveLength(0)
        expect(await h.rows('SELECT profile FROM users WHERE id=2')).toEqual([
          { profile: 'administrator' },
        ])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] aborts the time/key/progress batch on a policy or lease change after normal-writer reads', async () => {
      const h = await factory()
      try {
        const { ledger, command } = await setup(h)
        await h.run(
          `CREATE TRIGGER owned_policy_race AFTER INSERT ON time_entries BEGIN UPDATE organizations SET name='Changed' WHERE id=1; END`,
        )
        await expect(ledger.commitEntry(admin, command)).rejects.toThrow()
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
        expect(await h.rows('SELECT name FROM organizations WHERE id=1')).toEqual([
          { name: 'Fictional' },
        ])
        await h.run('DROP TRIGGER owned_policy_race')
        await h.run(
          `CREATE TRIGGER owned_lease_race AFTER INSERT ON time_entries BEGIN UPDATE csv_import_runs SET lease_generation=lease_generation+1; END`,
        )
        await expect(ledger.commitEntry(admin, command)).rejects.toThrow()
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
        expect(await h.rows('SELECT id FROM csv_import_entries')).toHaveLength(0)
        expect(await h.rows('SELECT * FROM csv_import_chunks')).toHaveLength(0)
        expect(await h.rows('SELECT lease_generation FROM csv_import_runs')).toEqual([
          { lease_generation: 1 },
        ])
      } finally {
        await h.close()
      }
    }, 60_000)
    it('[unit] rolls back the canonical time insert if current admin changes after writer pre-reads', async () => {
      const h = await factory()
      try {
        const { ledger, command } = await setup(h)
        await h.run(
          `CREATE TRIGGER owned_demote_after_time AFTER INSERT ON time_entries BEGIN UPDATE users SET profile='member' WHERE id=2; END`,
        )
        await expect(ledger.commitEntry(admin, command)).rejects.toThrow()
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
        expect(await h.rows('SELECT id FROM csv_import_entries')).toHaveLength(0)
        expect(await h.rows('SELECT * FROM csv_import_chunks')).toHaveLength(0)
        expect(await h.rows('SELECT profile FROM users WHERE id=2')).toEqual([
          { profile: 'administrator' },
        ])
      } finally {
        await h.close()
      }
    }, 60_000)
  })
}

/** The actual container freshness expression, not the injectable fault predicate
 * used to isolate native guard mechanics above. Browser D1 activation is #1184. */
it('[unit] uses canonical native facts for own setup and refuses edited implicit or explicit lineage', async () => {
  const h = await container()
  try {
    if (!h.sqlite) throw new Error('Owned SQLite fixture missing')
    registerCsvImportSqliteFunctions(h.sqlite)
    const hash = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)))
    const nameHash = (value: string) => hash(csvNameKey(value))
    await h.run('UPDATE tasks SET is_default=1 WHERE id=1')
    await h.run('UPDATE users SET has_access_to_all_future_projects=1 WHERE id=1')
    const tracked = new DrizzleTrackedResourceRepository(h.orm, { isLocked: async () => false })
    const ledger = createCsvBrowserDatasetLedger(h.orm, {
      tracked,
      now: () => new Date(t0),
      clockSql: () => ({ sql: '?', params: [Date.parse(t0)] }),
      destinationFence: csvImportDestinationFence,
      setupFacts: csvImportSetupFacts,
    })
    const datasetId = await ledger.registerDataset(admin, { workspaceIdentity: 'owned-real-facts' })
    const scope: CsvImportDestinationScope = {
      emailHashes: [],
      clientHashes: [nameHash('C')],
      projectPairs: [{ client: nameHash('C'), project: nameHash('Owned project') }],
      taskHashes: [nameHash('T')],
      dates: ['2026-09-01'],
      includeProjectDefaults: true,
    }
    const facts = csvImportDestinationFacts(scope, datasetId)
    const [initial] = await h.rows<{ facts: string }>(
      `SELECT ${facts.sql} AS facts`,
      ...facts.params,
    )
    if (!initial) throw new Error('Owned destination facts missing')
    const plan: CsvPlanInput = {
      datasetId,
      fileSha256: sha,
      mappingSha256: sha,
      adapterId: 'owned',
      identityVersion: 1,
      dateFormat: 'iso',
      exporterZone: 'UTC',
      excludedLines: [],
      destinationFacts: JSON.stringify(scope),
      destinationVersion: hash(initial.facts),
      fileRows: 1,
      selectedRows: 1,
    }
    const sealed = await ledger.seal(admin, plan, true)
    if (sealed.outcome === 'blocked') throw new Error('Owned real-facts seal refused')
    const lease = await ledger.claimLease(admin, {
      runId: sealed.run.runId,
      holder: 'owned',
      ttlMs: 10000,
    })
    if (lease.outcome !== 'claimed') throw new Error('Owned real-facts lease refused')
    const base = {
      runId: sealed.run.runId,
      planId: sealed.run.planId,
      holder: 'owned',
      leaseGeneration: lease.lease.generation,
    }
    const project = await ledger.setup(admin, {
      ...base,
      setupKey: 'project',
      kind: 'projects',
      input: { clientId: 1, name: 'Owned project' },
    })
    expect(
      await ledger.setup(admin, {
        ...base,
        setupKey: 'project',
        kind: 'projects',
        input: { clientId: 1, name: 'Owned project' },
      }),
    ).toEqual(project)
    expect(await h.rows('SELECT policy_facts_sha256 FROM csv_import_setup')).toEqual([
      { policy_facts_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ])
    await h.run('UPDATE task_assignments SET billable=0 WHERE project_id=?', project.id)
    await expect(
      ledger.setup(admin, {
        ...base,
        setupKey: 'project',
        kind: 'projects',
        input: { clientId: 1, name: 'Owned project' },
      }),
    ).rejects.toMatchObject({ code: 'stale_plan' })
    await ledger.finish(admin, { ...base, status: 'cancelled' })
    expect(await ledger.getRun(admin, base.runId)).toMatchObject({ status: 'cancelled' })
  } finally {
    await h.close()
  }
}, 60_000)
