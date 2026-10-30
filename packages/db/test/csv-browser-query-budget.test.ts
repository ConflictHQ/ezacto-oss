import { Miniflare } from 'miniflare'
import { afterEach, expect, it } from 'vitest'
import { createD1Database } from '../src/adapters.js'
import { migrateD1 } from '../src/migrate.js'
import { createCsvBrowserDatasetLedger } from '../src/csv-browser-import.js'
import type { AdministratorActor, CsvPlanInput } from '@ezacto/core'

const fixtures: Miniflare[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.dispose()))
})
const fixture = async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
  })
  fixtures.push(mf)
  const native = await mf.getD1Database('DB')
  await migrateD1(native)
  const now = new Date().toISOString()
  await native
    .prepare(
      "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Budget','Administrator','administrator','[]',?,?)",
    )
    .bind(now, now)
    .run()
  await native
    .prepare(
      "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Retained','Administrator','administrator','[]',?,?)",
    )
    .bind(now, now)
    .run()
  let calls = 0
  let beforeWrite: (() => Promise<void>) | null = null
  const observed = new Proxy(native, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          calls++
          if (beforeWrite && calls === 2) {
            const run = beforeWrite
            beforeWrite = null
            await run()
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as unknown as D1Database
  const ledger = createCsvBrowserDatasetLedger(createD1Database(observed), {
    now: () => new Date(),
    tracked: {
      createTimeEntry: async () => {
        throw new Error('not used')
      },
    },
    destinationFence: () => ({ sql: '1', params: [] }),
    setupFacts: () => ({ sql: '?', params: ['a'.repeat(64)] }),
  })
  const actor: AdministratorActor = { kind: 'administrator', userId: '2' }
  const datasetId = await ledger.registerDataset(actor, { workspaceIdentity: 'budget-fixture' })
  const plan: CsvPlanInput = {
    datasetId,
    fileSha256: 'a'.repeat(64),
    mappingSha256: 'a'.repeat(64),
    adapterId: 'owned',
    identityVersion: 1,
    dateFormat: 'iso',
    exporterZone: 'UTC',
    excludedLines: [],
    destinationVersion: 'owned-v1',
    fileRows: 1,
    selectedRows: 1,
  }
  const sealed = await ledger.seal(actor, plan, true)
  if (sealed.outcome === 'blocked') throw new Error('fixture seal refused')
  calls = 0
  return {
    native,
    ledger,
    actor,
    runId: sealed.run.runId,
    calls: () => calls,
    reset: () => {
      calls = 0
    },
    revokeBeforeWrite: () => {
      beforeWrite = async () => {
        await native.prepare('UPDATE users SET is_active=0 WHERE id=2').run()
      }
    },
  }
}
it('batches independent run reads and successful lease reads without weakening held-lease behavior', async () => {
  const f = await fixture()
  expect(await f.ledger.getRun(f.actor, f.runId)).toMatchObject({
    runId: f.runId,
    written: 0,
    alreadyImported: 0,
  })
  expect(f.calls()).toBe(1)
  f.reset()
  const first = await f.ledger.claimLease(f.actor, {
    runId: f.runId,
    holder: 'first',
    ttlMs: 60000,
  })
  expect(first.outcome).toBe('claimed')
  expect(f.calls()).toBe(2)
  f.reset()
  expect(
    await f.ledger.claimLease(f.actor, { runId: f.runId, holder: 'second', ttlMs: 60000 }),
  ).toMatchObject({ outcome: 'held' })
  expect(f.calls()).toBe(3)
  expect(
    await f.native
      .prepare('SELECT lease_holder FROM csv_import_runs WHERE id=?')
      .bind(Number(f.runId))
      .first(),
  ).toEqual({ lease_holder: 'first' })
}, 60000)
it('rechecks authority in the write after the batched initial read and reveals no run to a revoked actor', async () => {
  const f = await fixture()
  f.revokeBeforeWrite()
  await expect(
    f.ledger.claimLease(f.actor, { runId: f.runId, holder: 'revoked', ttlMs: 60000 }),
  ).rejects.toMatchObject({ code: 'actor_required' })
  expect(
    await f.native
      .prepare('SELECT lease_holder FROM csv_import_runs WHERE id=?')
      .bind(Number(f.runId))
      .first(),
  ).toEqual({ lease_holder: null })
  await expect(f.ledger.getRun(f.actor, f.runId)).rejects.toMatchObject({ code: 'actor_required' })
}, 60000)
