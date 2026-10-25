import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createContainerSessionStore, createCsvApplyRunStore } from '@ezacto/db'
import { canonicalCsvApplyCommand } from '@ezacto/core'
import { createSqliteCsvBrowserService } from '../src/csv-browser-sqlite.js'
import { emptyMapping } from '../src/csv-mapping.js'
import { createSqliteCsvApplyDriver } from '../src/csv-apply-driver.js'
import type { CsvStagingApplyPort } from '../src/csv-staging-private.js'
import {
  createOwnedPlannerDestination,
  plannerAdministrator,
} from './support/csv-planner-acceptance.js'

/** Native driver component coverage. The staging bytes are owned fixtures;
 * full disk/HTTP admission, ownership and expiry acceptance is separate. */
const setup = async () => {
  const destination = await createOwnedPlannerDestination()
  const sqlite = destination.writer
  const session = await createContainerSessionStore(sqlite).issue(2)
  const authority = { userId: 2, sessionRowId: session.session.id }
  const nonce = (
    sqlite.prepare('SELECT nonce FROM csv_staging_instance').get() as { nonce: string }
  ).nonce
  const one = readFileSync(
    new URL('./fixtures/csv-browser-planner/preview.csv', import.meta.url),
    'utf8',
  )
    .trimEnd()
    .split('\n')
  const bytes = new TextEncoder().encode(one[0] + '\n' + one[1] + '\n' + one[1] + '\n')
  const service = createSqliteCsvBrowserService(sqlite)
  const source = await service.ledger.registerDataset(plannerAdministrator, {
    workspaceIdentity: 'owned-driver',
  })
  const initial = service.preview(plannerAdministrator, source, bytes, { exporterZone: 'UTC' })
  const sealed = await service.confirm(plannerAdministrator, initial.plan)
  if (sealed.outcome === 'blocked') throw new Error('Owned seal refused')
  const command = {
    preview_id: 'preview_' + 'a'.repeat(64),
    command_id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    expected_selected_rows: 2,
    expected_source_seconds: initial.plan.sourceSeconds,
    expected_destination_seconds: initial.plan.destinationSeconds,
    acknowledge_exclusions: false,
    acknowledge_destination_difference: true,
    acknowledge_new_people: false,
  }
  const inputExpiresAt = new Date(Date.now() + 3600000).toISOString()
  const input = {
    runId: sealed.run.runId,
    stageId: 'owned',
    stageVersion: 2,
    previewId: command.preview_id,
    targetNonce: nonce,
    authority,
    inputExpiresAt,
    commandId: command.command_id,
    confirmationCommandId: command.command_id,
    requestJson: canonicalCsvApplyCommand(command).json,
    planId: sealed.run.planId,
    sourceSecondsTotal: initial.plan.sourceSeconds,
    acknowledgedDestinationDelta: initial.plan.destinationDeltaSeconds,
  }
  const store = createCsvApplyRunStore(sqlite)
  store.activate(store.authorize(input).run)
  let afterLoad = () => {}
  const staging: CsvStagingApplyPort = {
    async readOwnedConfirmation() {
      return null
    },
    async readOwnedApplyBinding() {
      return null
    },
    async requestOwnedCancellation() {
      throw new Error('Not exercised by native driver')
    },
    async claimConfirmation() {
      throw new Error('Not exercised by native driver')
    },
    async bindConfirmedRun(_authority, binding) {
      return binding
    },
    async markSystemProgress(binding) {
      return binding
    },
    async loadOwnedPreview() {
      const current = service.preview(plannerAdministrator, source, bytes, { exporterZone: 'UTC' })
      afterLoad()
      return {
        stageId: 'owned',
        stageVersion: 2,
        targetNonce: nonce,
        creatorUserId: 2,
        authority,
        previewId: command.preview_id,
        sourceId: source,
        fileSha256: 'a'.repeat(64),
        fileBytes: bytes.length,
        mappingSha256: 'b'.repeat(64),
        stagingExpiresAt: inputExpiresAt,
        inputExpiresAt,
        retentionDeadline: null,
        stale: false,
        choices: {
          workspaceIdentity: 'owned-driver',
          exporterZone: 'UTC',
          mapping: emptyMapping(),
          excludedLines: [],
        },
        plan: current.plan,
        snapshot: current.snapshot,
        bytes,
      }
    },
  }
  const driver = (options: Partial<Parameters<typeof createSqliteCsvApplyDriver>[2]> = {}) =>
    createSqliteCsvApplyDriver(sqlite, staging, {
      holder: () => crypto.randomUUID(),
      maxRows: 1,
      maxTickMs: 10000,
      ...options,
    })
  return {
    destination,
    sqlite,
    authority,
    input,
    store,
    driver,
    setAfterLoad: (callback: () => void) => {
      afterLoad = callback
    },
  }
}
describe('native durable CSV chunk driver', () => {
  it('preserves the original failure while isolating a rejected diagnostic callback', async () => {
    const h = await setup()
    try {
      const original = new Error('Owned private diagnostic fixture')
      const captured: unknown[] = []
      h.setAfterLoad(() => {
        throw original
      })
      const result = await h
        .driver({
          reportError: async (cause) => {
            captured.push(cause)
            throw new Error('Owned reporter rejection')
          },
        })
        .tick()
      expect(result).toMatchObject({ state: 'partial' })
      expect(captured).toEqual([original])
      expect(h.store.read(h.input.runId)).toMatchObject({
        state: 'partial',
        code: 'storage_unavailable',
        committedRows: 0,
        attempts: 1,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await h.destination.close()
    }
  })
  it('stops automatic retries after three failed attempts and exact command replay cannot reset that custody', async () => {
    const h = await setup()
    try {
      h.sqlite.exec(
        `CREATE TRIGGER owned_repeat_csv_failure BEFORE INSERT ON time_entries BEGIN SELECT RAISE(ABORT,'owned repeat storage failure'); END`,
      )
      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await h.driver().tick()).toMatchObject({ state: 'partial' })
        expect(h.store.read(h.input.runId)).toMatchObject({ attempts: attempt, committedRows: 0 })
        h.sqlite
          .prepare('UPDATE csv_import_runs SET apply_next_attempt_at=? WHERE id=?')
          .run(new Date(Date.now() - 1000).toISOString(), Number(h.input.runId))
      }
      expect(await h.driver().tick()).toBeNull()
      expect(h.store.authorize(h.input).outcome).toBe('replayed')
      expect(h.store.read(h.input.runId)?.attempts).toBe(3)
      expect(await h.driver().tick()).toBeNull()
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
    } finally {
      await h.destination.close()
    }
  })

  it('retries a genuine rolled-back storage failure at the same cursor without resetting the bounded attempt budget', async () => {
    const h = await setup()
    try {
      h.sqlite.exec(
        `CREATE TRIGGER owned_transient_csv_failure BEFORE INSERT ON time_entries BEGIN SELECT RAISE(ABORT,'owned transient write failure'); END`,
      )
      expect(await h.driver().tick()).toMatchObject({ state: 'partial' })
      expect(h.store.read(h.input.runId)).toMatchObject({
        attempts: 1,
        committedRows: 0,
        code: 'storage_unavailable',
      })
      expect(await h.driver().tick()).toBeNull()
      h.sqlite.exec('DROP TRIGGER owned_transient_csv_failure')
      h.sqlite
        .prepare('UPDATE csv_import_runs SET apply_next_attempt_at=? WHERE id=?')
        .run(new Date(Date.now() - 1000).toISOString(), Number(h.input.runId))
      expect(await h.driver().tick()).toMatchObject({ state: 'queued' })
      expect(h.store.read(h.input.runId)).toMatchObject({ committedRows: 1, attempts: 0 })
      expect(await h.driver().tick()).toMatchObject({ state: 'complete' })
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 2 })
    } finally {
      await h.destination.close()
    }
  })

  it('recreates its driver after one committed row, completes only the remainder and replays without new time', async () => {
    const h = await setup()
    try {
      expect(await h.driver().tick()).toMatchObject({ state: 'queued' })
      expect(h.store.read(h.input.runId)?.committedRows).toBe(1)
      expect(await h.driver().tick()).toMatchObject({ state: 'complete' })
      expect(h.store.read(h.input.runId)?.committedRows).toBe(2)
      expect(await h.driver().tick()).toBeNull()
      expect(h.store.authorize(h.input).outcome).toBe('replayed')
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 2 })
      expect(h.store.summary(h.input.runId)).toMatchObject({
        insertedRows: 2,
        alreadyImportedRows: 0,
        sourceSecondsCommitted: 7202,
        destinationSeconds: 7200,
        destinationDeltaSeconds: -2,
      })
    } finally {
      await h.destination.close()
    }
  })
  it('revokes a real session after asynchronous input loading and commits no time or chunk', async () => {
    const h = await setup()
    try {
      h.setAfterLoad(() => {
        h.sqlite
          .prepare("UPDATE sessions SET revoked_at=?,revocation_reason='user_revoked' WHERE id=?")
          .run(new Date().toISOString(), h.authority.sessionRowId)
      })
      expect(await h.driver().tick()).toMatchObject({ state: 'paused' })
      expect(h.store.read(h.input.runId)).toMatchObject({
        state: 'paused',
        code: 'authority_revoked',
        committedRows: 0,
      })
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM time_entries').get()).toEqual({ n: 0 })
      expect(h.sqlite.prepare('SELECT count(*) AS n FROM csv_import_chunks').get()).toEqual({
        n: 0,
      })
    } finally {
      await h.destination.close()
    }
  })
})
