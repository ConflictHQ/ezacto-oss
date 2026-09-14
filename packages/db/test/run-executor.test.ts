import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { executeRun } from '../src/run-executor.js'
import {
  createScheduledActionStore,
  type RunItemRecord,
  type ScheduledActionStore,
} from '../src/scheduled-actions.js'

/**
 * Issue 62's loop. The store holds the rule that an item which completed is
 * never done again; this is the thing that relies on it, and the tests below
 * are mostly about killing it and starting it again.
 */

const t = (hour: number): string =>
  `2026-09-13T${String(hour).padStart(2, '0')}:00:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const items = [1315, 1316, 1317].map((id) => ({
  subjectType: 'invoice',
  subjectId: id,
  description: `Invoice ${String(id)} — August work detail`,
  amountCents: 100_000 + id,
  currency: 'USD',
  target: `ap-${String(id)}@example.test`,
}))

const fixture = async (): Promise<{ store: ScheduledActionStore; runId: number }> => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO scheduled_jobs
      (id, action, name, scope_json, cadence, created_by_user_id, created_at, updated_at)
      VALUES (1, 'month_end_pack', 'Month end', '{}', '0 9 1 * *', 1, '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  const store = createScheduledActionStore(createContainerDatabase(database))
  const proposed = await store.propose({
    jobId: 1,
    occurrenceKey: '2026-08',
    items,
    proposedAt: t(9),
    expiresAt: t(21),
  })
  if (proposed.outcome !== 'proposed') throw new Error(proposed.outcome)
  const confirmed = await store.confirm(proposed.run.id, 1, t(10))
  if (confirmed.outcome !== 'confirmed') throw new Error(confirmed.outcome)
  return { store, runId: proposed.run.id }
}

const clock = () => t(11)

describe('driving a run to completion (#62)', () => {
  it('[money] does every item once and finishes the run', async () => {
    const { store, runId } = await fixture()
    const handled: number[] = []
    const report = await executeRun(runId, {
      store,
      handler: async (item) => {
        handled.push(item.subjectId)
      },
      now: clock,
    })
    expect(handled).toEqual([1315, 1316, 1317])
    expect(report).toMatchObject({ completed: 3, failed: [], runCompleted: true })
  })

  it('[money] a second pass does nothing, because everything is already done', async () => {
    // The property that makes a resume safe to run as often as it likes.
    const { store, runId } = await fixture()
    const handler = vi.fn(async () => undefined)
    await executeRun(runId, { store, handler, now: clock })
    handler.mockClear()
    const second = await executeRun(runId, { store, handler, now: clock })
    expect(handler).not.toHaveBeenCalled()
    expect(second.completed).toBe(0)
  })

  it('[money] resuming after a kill does not repeat what finished', async () => {
    // The kill: the handler throws a signal after the first item, which is what
    // a process dying mid-run looks like from in here.
    const { store, runId } = await fixture()
    const done: number[] = []
    await expect(
      executeRun(runId, {
        store,
        handler: async (item: RunItemRecord) => {
          if (done.length === 1) throw Object.assign(new Error('killed'), { fatal: true })
          done.push(item.subjectId)
        },
        now: clock,
      }),
    ).resolves.toMatchObject({ completed: 1 })

    const resumed: number[] = []
    const report = await executeRun(runId, {
      store,
      handler: async (item) => {
        resumed.push(item.subjectId)
      },
      now: clock,
    })
    // The first invoice is not sent a second time.
    expect(resumed).not.toContain(1315)
    expect(resumed).toEqual([1316, 1317])
    expect(report.runCompleted).toBe(true)
  })

  it('[money] a re-run after partial failure touches only what failed', async () => {
    const { store, runId } = await fixture()
    await executeRun(runId, {
      store,
      handler: async (item) => {
        if (item.subjectId === 1316) throw new Error('the client has no invoice address')
      },
      now: clock,
    })

    const retried: number[] = []
    const report = await executeRun(runId, {
      store,
      handler: async (item) => {
        retried.push(item.subjectId)
      },
      now: clock,
    })
    expect(retried).toEqual([1316])
    expect(report.runCompleted).toBe(true)
  })

  it('[money] names what failed and why, rather than a count', async () => {
    const { store, runId } = await fixture()
    const report = await executeRun(runId, {
      store,
      handler: async (item) => {
        if (item.subjectId !== 1315) throw new Error('the client has no invoice address')
      },
      now: clock,
    })
    expect(report.completed).toBe(1)
    // Two items, each named. "2 failed" is not something anybody can act on.
    expect(report.failed).toEqual([
      { itemId: expect.any(Number), reason: 'the client has no invoice address' },
      { itemId: expect.any(Number), reason: 'the client has no invoice address' },
    ])
    expect(report.runCompleted).toBe(false)
  })

  it('[money] does not report a run finished while anything is outstanding', async () => {
    const { store, runId } = await fixture()
    const report = await executeRun(runId, {
      store,
      handler: async (item) => {
        if (item.subjectId === 1317) throw new Error('nope')
      },
      now: clock,
    })
    expect(report.runCompleted).toBe(false)
    expect((await store.outstanding(runId)).map((row) => row.subjectId)).toEqual([1317])
  })

  it('[unit] a handler that fails without a message still records a reason', async () => {
    // A failed item with no reason is one nobody can decide about.
    const { store, runId } = await fixture()
    const report = await executeRun(runId, {
      store,
      handler: async () => {
        throw new Error('   ')
      },
      now: clock,
    })
    expect(report.failed[0]?.reason).toBe('the handler failed without saying why')
  })

  it('[money] stops at its deadline rather than being killed mid-item', async () => {
    // A pass that ignores its budget is killed mid-item, which is survivable by
    // design but leaves an item to be re-attempted for no reason.
    const { store, runId } = await fixture()
    const controller = new AbortController()
    const handled: number[] = []
    const report = await executeRun(runId, {
      store,
      handler: async (item) => {
        handled.push(item.subjectId)
        controller.abort()
      },
      now: clock,
      signal: controller.signal,
    })
    expect(handled).toEqual([1315])
    expect(report.runCompleted).toBe(false)
    // And the rest are still waiting, untouched.
    expect((await store.outstanding(runId)).map((row) => row.subjectId)).toEqual([1316, 1317])
  })
})
