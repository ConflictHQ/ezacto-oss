import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { scheduledJobConfig } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createScheduledJobsService, proposeDueScheduledJobs } from '../src/scheduled-jobs.js'
import { createScheduledRunsService } from '../src/scheduled-runs.js'
import { prepareScheduledRunNotifications } from '../src/scheduled-run-notifications.js'
import { seedMonthEndJobFixture } from './support/month-end-job-fixture.js'
const now = '2026-10-01T09:00:00.000Z'
for (const runtime of ['SQLite', 'D1'])
  describe(`manifest notices (${runtime})`, () => {
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
      await database.run(sql`INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES
      (1,'owner@example.test',1,${now},${now},${now}),(2,'member@example.test',1,${now},${now},${now}),(3,'admin@example.test',1,${now},${now},${now})`)
      await createScheduledJobsService(database).create(
        1,
        scheduledJobConfig({ name: 'Monthly A', scope: { client_ids: [1] } }),
        now,
      )
      await proposeDueScheduledJobs(database, now)
      const prepare = (at = now) =>
        prepareScheduledRunNotifications(database, {
          now: at,
          from: { email: 'notice@example.test' },
          appUrl: 'https://ezacto.test/',
        })
      return { database, prepare, runs: createScheduledRunsService(database) }
    }
    it('[notification #61] overlapping sweeps record one concrete email per active verified administrator; recovery preserves the delivery', async () => {
      const { database, prepare } = await setup()
      const messages = (await Promise.all([prepare(), prepare()])).flat()
      expect(messages).toHaveLength(2)
      expect(messages.map((message) => message.to.email).sort()).toEqual([
        'admin@example.test',
        'owner@example.test',
      ])
      for (const message of messages) {
        expect(message.text).toContain('Month End A')
        expect(message.text).toContain('USD 100.00')
        expect(message.text).toContain('Target: a@example.test')
        expect(message.text).toContain('https://ezacto.test/scheduled-runs/1')
        expect(message.text).not.toContain('Month End B')
      }
      expect(await prepare()).toEqual([])
      const recovered = await prepare('2026-10-01T09:02:00.000Z')
      expect(recovered.map((message) => message.deliveryId).sort()).toEqual(
        messages.map((message) => message.deliveryId).sort(),
      )
      expect(await database.all(sql`SELECT state,confirmed_by_user_id FROM proposed_runs`)).toEqual(
        [{ state: 'proposed', confirmed_by_user_id: null }],
      )
    })
    it('[notification #61] does not recover a notice after expiry, decision, or loss of administrator authority', async () => {
      const { database, prepare, runs } = await setup()
      await prepare()
      await database.run(sql`UPDATE users SET profile='member' WHERE id=3`)
      expect(
        (await prepare('2026-10-01T09:02:00.000Z')).map((message) => message.to.email),
      ).toEqual(['owner@example.test'])
      expect((await runs.confirm(1, 3, '2026-10-01T09:03:00.000Z')).outcome).toBe('not_proposed')
      expect((await runs.cancel(1, 3, '2026-10-01T09:03:00.000Z')).outcome).toBe('not_proposed')
      expect((await runs.read(1))?.state).toBe('proposed')
      await runs.confirm(1, 1, '2026-10-01T09:04:00.000Z')
      expect(await prepare('2026-10-01T09:05:00.000Z')).toEqual([])
      expect(await prepare('2026-10-02T09:00:00.000Z')).toEqual([])
    })
    it('[expiry #61] a late cancel expires the proposal without recording a fresh answer', async () => {
      const { runs, prepare } = await setup()
      expect(await prepare('2026-10-02T09:00:00.000Z')).toEqual([])
      expect(await runs.cancel(1, 1, '2026-10-02T09:00:00.000Z')).toMatchObject({
        outcome: 'expired',
        run: { state: 'expired', confirmed_by: null },
      })
    })
  })
