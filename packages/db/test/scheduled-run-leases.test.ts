import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { scheduledJobConfig } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createScheduledJobsService, proposeDueScheduledJobs } from '../src/scheduled-jobs.js'
import { createScheduledActionStore } from '../src/scheduled-actions.js'
import { executeRun } from '../src/run-executor.js'
import { seedMonthEndJobFixture } from './support/month-end-job-fixture.js'
const now = '2026-10-01T09:00:00.000Z'
for (const runtime of ['SQLite', 'D1'])
  describe(`run execution leases (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async () => {
      let database: Parameters<typeof seedMonthEndJobFixture>[0]
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite)
        close = async () => {
          sqlite.close()
        }
      } else {
        const mf = new Miniflare({
          modules: true,
          script: 'export default {fetch(){return new Response("ok")}}',
          d1Databases: ['DB'],
        })
        const d1 = await mf.getD1Database('DB')
        await migrateD1(d1)
        database = createD1Database(d1)
        close = async () => mf.dispose()
      }
      await seedMonthEndJobFixture(database)
      await createScheduledJobsService(database).create(
        1,
        scheduledJobConfig({ name: 'Lease fixture', scope: { client_ids: [1] } }),
        now,
      )
      await proposeDueScheduledJobs(database, now)
      const store = createScheduledActionStore(database)
      await store.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      return { database, store, item: (await store.manifest(1))[0]! }
    }
    it('[concurrency #62] a second executor cannot run an item while the first handler owns it', async () => {
      const { store } = await setup()
      let release!: () => void, started!: () => void
      const gate = new Promise<void>((resolve) => {
          release = resolve
        }),
        entered = new Promise<void>((resolve) => {
          started = resolve
        })
      let handled = 0
      const first = executeRun(1, {
        store,
        now: () => '2026-10-01T09:02:00.000Z',
        handler: async () => {
          handled++
          started()
          await gate
        },
      })
      await entered
      const second = await executeRun(1, {
        store,
        now: () => '2026-10-01T09:03:00.000Z',
        handler: async () => {
          handled++
        },
      })
      release()
      await first
      expect(handled).toBe(1)
      expect(second.completed).toBe(0)
    })
    it('[crash #62] a killed process retains its lease until timeout; the resumed owner fences off stale completion', async () => {
      const { store, item } = await setup()
      expect(await store.claimItem(item.id, '2026-10-01T09:02:00.000Z', 'killed-owner')).toBe(true)
      expect(await store.claimItem(item.id, '2026-10-01T09:16:59.000Z', 'too-early')).toBe(false)
      expect(await store.claimItem(item.id, '2026-10-01T09:17:00.000Z', 'resumed-owner')).toBe(true)
      expect(await store.completeItem(item.id, '2026-10-01T09:17:01.000Z', 'killed-owner')).toBe(
        false,
      )
      expect(
        await store.failItem(item.id, '2026-10-01T09:17:01.000Z', 'stale failure', 'killed-owner'),
      ).toBe(false)
      expect(await store.completeItem(item.id, '2026-10-01T09:17:02.000Z', 'resumed-owner')).toBe(
        true,
      )
      expect((await store.manifest(1))[0]).toMatchObject({ state: 'done', attemptCount: 2 })
    })
    it('[crash #62] interruption on the last attempt becomes a visible failure after its lease expires', async () => {
      const { store, item } = await setup()
      for (const hour of [10, 11, 12])
        expect(
          await store.claimItem(item.id, `2026-10-01T${hour}:00:00.000Z`, `owner-${hour}`),
        ).toBe(true)
      expect(await store.claimItem(item.id, '2026-10-01T12:15:00.000Z', 'exhausted')).toBe(false)
      expect((await store.manifest(1))[0]).toMatchObject({
        state: 'failed',
        attemptCount: 3,
        failureReason: 'Automatic attempts exhausted after the executor was interrupted.',
      })
    })
    it('[retry #62] automatic attempts stop after three failures and retain the named failure', async () => {
      const { store, item, database } = await setup()
      for (const minute of [2, 3, 4]) {
        expect(await store.claimItem(item.id, `2026-10-01T09:0${minute}:00.000Z`, 'owner')).toBe(
          true,
        )
        await store.failItem(
          item.id,
          `2026-10-01T09:0${minute}:01.000Z`,
          'provider unavailable',
          'owner',
        )
      }
      expect(await store.claimItem(item.id, '2026-10-01T09:05:00.000Z', 'fourth')).toBe(false)
      expect(
        await database.all(
          sql`SELECT state,attempt_count,failure_reason FROM run_items WHERE id=${item.id}`,
        ),
      ).toEqual([{ state: 'failed', attempt_count: 3, failure_reason: 'provider unavailable' }])
    })
  })
