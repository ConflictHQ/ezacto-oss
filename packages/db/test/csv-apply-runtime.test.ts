import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'
import { createContainerDatabase } from '../src/adapters.js'
import { createContainerSessionStore } from '../src/sessions.js'
import { createCsvBrowserDatasetLedger } from '../src/csv-browser-import.js'
import { createCsvApplyRunStore } from '../src/csv-apply-runtime.js'
import { DrizzleTrackedResourceRepository } from '../src/tracked-resource-repository.js'
import { canonicalCsvApplyCommand, type CsvApplyAuthorization } from '@ezacto/core'

const owned = async () => {
  const db = new BetterSqlite3(':memory:')
  migrateContainer(db)
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Owned','{}',?,?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Admin','administrator','[]',?,?)`,
  ).run(now, now)
  const session = await createContainerSessionStore(db).issue(2)
  const target = db.prepare('SELECT nonce FROM csv_staging_instance').get() as { nonce: string }
  const orm = createContainerDatabase(db)
  const ledger = createCsvBrowserDatasetLedger(orm, {
    now: () => new Date(),
    tracked: new DrizzleTrackedResourceRepository(orm, { isLocked: async () => false }),
    destinationFence: () => ({ sql: '1', params: [] }),
    setupFacts: () => ({ sql: '?', params: ['a'.repeat(64)] }),
  })
  const actor = { kind: 'administrator' as const, userId: '2' }
  const source = await ledger.registerDataset(actor, { workspaceIdentity: 'owned-apply-runtime' })
  const seal = await ledger.seal(
    actor,
    {
      datasetId: source,
      fileSha256: 'a'.repeat(64),
      mappingSha256: 'b'.repeat(64),
      adapterId: 'owned',
      identityVersion: 2,
      dateFormat: 'iso',
      exporterZone: 'UTC',
      excludedLines: [],
      destinationVersion: 'owned',
      fileRows: 1,
      selectedRows: 1,
    },
    true,
  )
  if (seal.outcome === 'blocked') throw new Error('Owned setup refused')
  const command = {
    preview_id: 'preview_' + 'c'.repeat(64),
    command_id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    expected_selected_rows: 1,
    expected_source_seconds: 3600,
    expected_destination_seconds: 3600,
    acknowledge_exclusions: false,
    acknowledge_destination_difference: false,
    acknowledge_new_people: false,
  }
  const input: CsvApplyAuthorization = {
    runId: seal.run.runId,
    stageId: 'owned-stage',
    stageVersion: 2,
    previewId: command.preview_id,
    targetNonce: target.nonce,
    authority: { userId: 2, sessionRowId: session.session.id },
    inputExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    commandId: command.command_id,
    confirmationCommandId: command.command_id,
    requestJson: canonicalCsvApplyCommand(command).json,
    planId: seal.run.planId,
    sourceSecondsTotal: 3600,
    acknowledgedDestinationDelta: 0,
  }
  return { db, ledger, actor, input, command, store: createCsvApplyRunStore(db) }
}

describe('durable native CSV apply intent', () => {
  it('holds an accepted command inactive until its staging binding is acknowledged', async () => {
    const h = await owned()
    try {
      const accepted = h.store.authorize(h.input).run
      expect(accepted.ready).toBe(false)
      expect(h.store.listReady()).toEqual([])
      const fence = h.store.executionFence(accepted, 2)
      expect(h.db.prepare(`SELECT (${fence.sql}) AS ok`).get(...fence.params)).toEqual({ ok: 0 })
      const active = h.store.activate(accepted)
      expect(active.ready).toBe(true)
      expect(h.store.listReady()).toHaveLength(1)
      expect(h.store.authorize(h.input).run.ready).toBe(true)
    } finally {
      h.db.close()
    }
  })

  it('queues once and replays the same command without resetting retry custody', async () => {
    const h = await owned()
    try {
      const first = h.store.authorize(h.input)
      expect(first.outcome).toBe('queued')
      const paused = h.store.settle(first.run, null, 'partial', 'storage_unavailable', {
        attempts: 2,
        failureChunk: 0,
        nextAttemptAt: new Date(Date.now() + 60000).toISOString(),
      })!
      expect(h.store.authorize(h.input).outcome).toBe('replayed')
      expect(h.store.read(h.input.runId)?.attempts).toBe(2)
      expect(h.store.read(h.input.runId)?.nextAttemptAt).toBe(paused.nextAttemptAt)
      expect(h.db.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
      const changed = { ...h.command, acknowledge_new_people: true }
      expect(() =>
        h.store.authorize({ ...h.input, requestJson: canonicalCsvApplyCommand(changed).json }),
      ).toThrow('command_conflict')
    } finally {
      h.db.close()
    }
  })
  it('requires a current real native session before accepting or replaying commands', async () => {
    const h = await owned()
    try {
      h.store.authorize(h.input)
      h.db
        .prepare("UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked' WHERE id=?")
        .run(new Date().toISOString(), h.input.authority.sessionRowId)
      expect(() => h.store.authorize(h.input)).toThrow('authority_required')
      expect(h.store.inspect(h.store.read(h.input.runId)!)).toBe('authority_revoked')
      const fence = h.store.executionFence(h.store.read(h.input.runId)!, 2)
      expect(h.db.prepare(`SELECT (${fence.sql}) AS ok`).get(...fence.params)).toEqual({ ok: 0 })
    } finally {
      h.db.close()
    }
  })
  it('cancels immediately across a live lease even after input expiry and fences the old writer', async () => {
    const h = await owned()
    try {
      const queued = h.store.activate(h.store.authorize(h.input).run)
      const lease = await h.ledger.claimLease(h.actor, {
        runId: h.input.runId,
        holder: 'owned-live-holder',
        ttlMs: 60000,
      })
      if (lease.outcome !== 'claimed') throw new Error('Owned lease refused')
      h.store.markRunning(queued, {
        runId: h.input.runId,
        holder: 'owned-live-holder',
        generation: lease.lease.generation,
      })
      h.db
        .prepare(
          "UPDATE csv_import_runs SET apply_input_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
        )
        .run(Number(h.input.runId))
      const cancelled = h.store.cancel(h.input.authority, {
        runId: h.input.runId,
        stageId: h.input.stageId,
        targetNonce: h.input.targetNonce,
        previewId: h.input.previewId,
        executionCommandId: h.input.commandId,
        commandId: '22222222-2222-4222-8222-222222222222',
      })
      expect(cancelled.state).toBe('cancelled')
      const fence = h.store.executionFence(queued, 2)
      expect(h.db.prepare(`SELECT (${fence.sql}) AS ok`).get(...fence.params)).toEqual({ ok: 0 })
      expect(
        h.store.settle(
          queued,
          { runId: h.input.runId, holder: 'owned-live-holder', generation: lease.lease.generation },
          'partial',
          'storage_unavailable',
        ),
      ).toBeNull()
      expect(h.db.prepare('SELECT count(*) AS n FROM csv_import_chunks').get()).toEqual({ n: 0 })
    } finally {
      h.db.close()
    }
  })
  it('requires immutable totals and incarnation before accepting execution intent', async () => {
    const h = await owned()
    try {
      expect(() => h.store.authorize({ ...h.input, sourceSecondsTotal: 7200 })).toThrow(
        'binding_mismatch',
      )
      h.db.prepare('UPDATE csv_staging_instance SET nonce=?').run('d'.repeat(64))
      expect(() => h.store.authorize(h.input)).toThrow('authority_required')
      expect(h.store.read(h.input.runId)).toBeNull()
    } finally {
      h.db.close()
    }
  })
})
