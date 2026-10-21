import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'
import { createScheduledActionStore } from '../src/scheduled-actions.js'

const now = '2026-10-01T09:00:00.000Z'
for (const runtime of ['SQLite', 'D1'])
  describe(`atomic proposed manifests (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async (legacy = false) => {
      let upgrade: () => Promise<void>
      let database: Parameters<typeof createScheduledActionStore>[0]
      let exec: (query: string) => Promise<unknown>
      let rows: (query: string) => Promise<Record<string, unknown>[]>
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        if (legacy) migrateContainerThrough(sqlite, '0140_email_suppressions')
        else migrateContainer(sqlite)
        upgrade = async () => {
          migrateContainer(sqlite)
        }
        database = createContainerDatabase(sqlite)
        exec = async (query) => sqlite.exec(query)
        rows = async (query) => sqlite.prepare(query).all() as Record<string, unknown>[]
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
        if (legacy) await migrateD1Through(d1, '0140_email_suppressions')
        else await migrateD1(d1)
        upgrade = async () => migrateD1(d1)
        database = createD1Database(d1)
        exec = (query) => d1.prepare(query).run()
        rows = async (query) => (await d1.prepare(query).all<Record<string, unknown>>()).results
        close = async () => mf.dispose()
      }
      await exec(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
      VALUES(1,'Admin','Reviewer','administrator','[]','${now}','${now}')`)
      await exec(`INSERT INTO scheduled_jobs(id,action,name,scope_json,cadence,created_by_user_id,created_at,updated_at)
      VALUES(1,'month_end_pack','Month end','{}','0 9 1 * *',1,'${now}','${now}')`)
      return { store: createScheduledActionStore(database), rows, exec, upgrade }
    }
    const input = () => ({
      jobId: 1,
      occurrenceKey: '2026-09',
      proposedAt: now,
      expiresAt: '2026-10-02T09:00:00.000Z',
      items: [
        {
          subjectType: 'invoice',
          subjectId: 1,
          description: 'Client A',
          amountCents: 10000,
          currency: 'USD',
          target: 'client@example.test',
        },
        {
          subjectType: 'invoice',
          subjectId: 2,
          description: 'Client B',
          amountCents: 20000,
          currency: 'USD',
          target: 'other@example.test',
        },
      ],
    })

    it('[upgrade #63] preserves legacy proposal/item rows and materializes later proposals once', async () => {
      const { store, rows, exec, upgrade } = await setup(true)
      await exec(`INSERT INTO proposed_runs(id,job_id,occurrence_key,proposed_at,expires_at,created_at,updated_at)
      VALUES(1,1,'2026-08','${now}','2026-10-02T09:00:00.000Z','${now}','${now}')`)
      await exec(`INSERT INTO run_items(id,run_id,subject_type,subject_id,description,created_at)
      VALUES(1,1,'invoice',99,'Legacy concrete item','${now}')`)
      const before = await store.manifest(1)
      await upgrade()
      expect(await store.manifest(1)).toEqual(before)
      expect(await store.propose(input())).toMatchObject({ outcome: 'proposed' })
      expect(await rows('SELECT count(*) AS count FROM proposed_runs')).toEqual([{ count: 2 }])
      expect(await rows('SELECT count(*) AS count FROM run_items')).toEqual([{ count: 3 }])
    })
    it('[workflow #63] a paused job cannot create a new proposal', async () => {
      const { store, rows, exec } = await setup()
      await exec('UPDATE scheduled_jobs SET is_active=0 WHERE id=1')
      expect(await store.propose(input())).toEqual({ outcome: 'job_unavailable' })
      expect(await rows('SELECT id FROM proposed_runs')).toEqual([])
      await exec('UPDATE scheduled_jobs SET is_active=1 WHERE id=1')
      expect(await store.propose(input())).toMatchObject({ outcome: 'proposed' })
    })
    it('[invariant #63] a failed item leaves neither a run nor a partial manifest', async () => {
      const { store, rows } = await setup()
      const proposed = input()
      proposed.items[1]!.currency = 'not-a-currency'
      await expect(store.propose(proposed)).rejects.toThrow()
      expect(await rows('SELECT id FROM proposed_runs')).toEqual([])
      expect(await rows('SELECT id FROM run_items')).toEqual([])
    })
    it('[concurrency #63] racing proposals materialize one complete occurrence', async () => {
      const { store, rows } = await setup()
      const results = await Promise.all([store.propose(input()), store.propose(input())])
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'already_proposed',
        'proposed',
      ])
      expect(await rows('SELECT count(*) AS count FROM proposed_runs')).toEqual([{ count: 1 }])
      expect(await rows('SELECT subject_id FROM run_items ORDER BY id')).toEqual([
        { subject_id: 1 },
        { subject_id: 2 },
      ])
    })
  })
