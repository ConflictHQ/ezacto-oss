import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { describe, it, expect } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createContainerSessionStore, createD1SessionStore } from '../src/sessions.js'
import { DrizzleTrackedResourceRepository } from '../src/tracked-resource-repository.js'
import { createCsvBrowserDatasetLedger } from '../src/csv-browser-import.js'
import { csvStagingSessionFence } from '../src/csv-staging-authority.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import type { AdministratorActor, CsvPlanInput } from '@ezacto/core'
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

for (const [runtime, factory] of [
  ['SQLite', container],
  ['D1', d1],
] as const)
  describe(`CSV private authority (${runtime})`, () => {
    it('repeats a real session proof inside native writes, preserves rollback, and refuses a revoked session', async () => {
      const h = await factory()
      try {
        const client = h.orm.$client
        const sessions =
          'batch' in client ? createD1SessionStore(client) : createContainerSessionStore(client)
        const issued = await sessions.issue(2)
        const [target] = await h.rows<{ nonce: string }>(
          'SELECT nonce FROM csv_staging_instance WHERE singleton=1',
        )
        if (!target) throw new Error('Missing owned target')
        const actor: AdministratorActor = { kind: 'administrator', userId: '2' }
        const authority = { userId: 2, sessionRowId: issued.session.id }
        const tracked = new DrizzleTrackedResourceRepository(h.orm, { isLocked: async () => false })
        const ledger = createCsvBrowserDatasetLedger(h.orm, {
          tracked,
          now: () => new Date(),
          destinationFence: () => ({ sql: '1', params: [] }),
          setupFacts: () => ({ sql: '?', params: [sha] }),
          authorityFence: (current) =>
            csvStagingSessionFence(authority, target.nonce, Number(current.userId)),
        })
        const sourceId = await ledger.registerDataset(actor, {
          workspaceIdentity: 'owned-session-proof',
        })
        const plan: CsvPlanInput = {
          datasetId: sourceId,
          fileSha256: sha,
          mappingSha256: sha,
          adapterId: 'owned',
          identityVersion: 2,
          dateFormat: 'iso',
          exporterZone: 'UTC',
          excludedLines: [],
          destinationVersion: 'owned-policy',
          fileRows: 1,
          selectedRows: 1,
        }
        const sealed = await ledger.seal(actor, plan, true)
        if (sealed.outcome === 'blocked') throw new Error('Owned seal failed')
        const claim = await ledger.claimLease(actor, {
          runId: sealed.run.runId,
          holder: 'owned',
          ttlMs: 60000,
        })
        if (claim.outcome !== 'claimed') throw new Error('Owned lease failed')
        const input = {
          runId: sealed.run.runId,
          planId: sealed.run.planId,
          holder: 'owned',
          leaseGeneration: claim.lease.generation,
          chunkIndex: 0,
          sourceKey: 'owned-key#0',
          line: 2,
          sourceSeconds: 60,
          entry: { userId: 1, projectId: 1, taskId: 1, spentDate: '2026-09-01', seconds: 60 },
        }
        await h.run(
          `CREATE TRIGGER owned_revoke_csv_session AFTER INSERT ON time_entries BEGIN UPDATE sessions SET revoked_at='2026-10-25T00:00:00.000Z',revocation_reason='user_revoked' WHERE id=${issued.session.id}; END`,
        )
        await expect(ledger.commitEntry(actor, input)).rejects.toThrow()
        expect(await h.rows('SELECT id FROM time_entries')).toHaveLength(0)
        expect(await h.rows('SELECT id FROM csv_import_entries')).toHaveLength(0)
        expect(
          await h.rows('SELECT revoked_at FROM sessions WHERE id=?', issued.session.id),
        ).toEqual([{ revoked_at: null }])
        await h.run('DROP TRIGGER owned_revoke_csv_session')
        expect(await ledger.commitEntry(actor, input)).toEqual({ outcome: 'written' })
        await sessions.revoke(2, issued.session.id)
        await expect(
          ledger.registerDataset(actor, { workspaceIdentity: 'owned-session-proof' }),
        ).rejects.toMatchObject({ code: 'actor_required' })
        await expect(ledger.getRun(actor, input.runId)).rejects.toMatchObject({
          code: 'actor_required',
        })
        await expect(ledger.seal(actor, plan, true)).rejects.toMatchObject({
          code: 'actor_required',
        })
        await expect(
          ledger.claimLease(actor, { runId: input.runId, holder: 'revoked', ttlMs: 1000 }),
        ).rejects.toMatchObject({ code: 'actor_required' })
        await expect(
          ledger.setup(actor, {
            ...input,
            setupKey: 'forbidden',
            kind: 'clients',
            input: { name: 'Must not exist' },
          }),
        ).rejects.toMatchObject({ code: 'actor_required' })
        await expect(ledger.commitEntry(actor, input)).rejects.toMatchObject({
          code: 'actor_required',
        })
        await expect(ledger.acknowledgeExisting(actor, input)).rejects.toMatchObject({
          code: 'actor_required',
        })
        await expect(ledger.finish(actor, { ...input, status: 'cancelled' })).rejects.toMatchObject(
          { code: 'actor_required' },
        )
        expect(csvStagingSessionFence(authority, target.nonce, 1)).toEqual({ sql: '0', params: [] })
      } finally {
        await h.close()
      }
    }, 60000)
    it('changes target identity on physical identity replacement so reused ids cannot inherit private files', async () => {
      const h = await factory()
      try {
        await h.run(
          `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(3,'Owned','Replacement','administrator','[]',?,?)`,
          t0,
          t0,
        )
        const [before] = await h.rows<{ nonce: string }>(
          'SELECT nonce FROM csv_staging_instance WHERE singleton=1',
        )
        await h.run('DELETE FROM users WHERE id=3')
        await h.run(
          `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(3,'New','Identity','administrator','[]',?,?)`,
          t0,
          t0,
        )
        const [after] = await h.rows<{ nonce: string }>(
          'SELECT nonce FROM csv_staging_instance WHERE singleton=1',
        )
        expect(after?.nonce).not.toBe(before?.nonce)
        expect(after?.nonce).toMatch(/^[a-f0-9]{64}$/)
      } finally {
        await h.close()
      }
    }, 60000)
  })
