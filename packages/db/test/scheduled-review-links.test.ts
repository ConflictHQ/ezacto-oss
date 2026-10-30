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
const now = '2026-10-01T09:00:00.000Z',
  key = new Uint8Array(32).fill(0x43)
for (const runtime of ['SQLite', 'D1'])
  describe(`single-use review links (${runtime})`, () => {
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
      await database.run(sql`INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at)
      VALUES(1,'owner@example.test',1,${now},${now},${now}),(3,'admin@example.test',1,${now},${now},${now})`)
      await createScheduledJobsService(database).create(
        1,
        scheduledJobConfig({ name: 'Review fixture', scope: { client_ids: [1] } }),
        now,
      )
      const objects = new Map<string, ArrayBuffer>()
      await proposeDueScheduledJobs(database, now, {
        put: async (key, bytes) => {
          objects.set(key, bytes)
        },
      })
      const prepare = (at = now) =>
        prepareScheduledRunNotifications(database, {
          now: at,
          appUrl: 'https://ezacto.test',
          reviewLinkSigningKey: key,
          from: { email: 'notify@example.test' },
        })
      const runs = createScheduledRunsService(database, { reviewLinkSigningKey: key })
      const tokenFrom = (text: string) =>
        new URLSearchParams(
          new URL(/https:\/\/\S+\/scheduled-runs\/\d+#review=\S+/u.exec(text)![0]).hash.slice(1),
        ).get('review')!
      return { database, prepare, runs, tokenFrom }
    }
    it('[single-use #61] concurrent openings consume once, bind to the intended administrator, and never confirm or execute', async () => {
      const f = await setup(),
        messages = await f.prepare(),
        token = f.tokenFrom(
          messages.find((message) => message.to.email === 'owner@example.test')!.text,
        )
      expect(await f.runs.consumeReviewLink!(1, 3, token, '2026-10-01T09:01:00.000Z')).toBe(
        'invalid',
      )
      const outcomes = await Promise.all([
        f.runs.consumeReviewLink!(1, 1, token, '2026-10-01T09:01:00.000Z'),
        f.runs.consumeReviewLink!(1, 1, token, '2026-10-01T09:01:00.000Z'),
      ])
      expect(outcomes.sort()).toEqual(['accepted', 'used'])
      expect(
        (await f.prepare('2026-10-01T09:02:00.000Z')).map((message) => message.to.email),
      ).toEqual(['admin@example.test'])
      expect((await f.runs.read(1))?.state).toBe('proposed')
      expect((await f.runs.read(1))?.items[0]?.attempt_count).toBe(0)
      expect(await f.database.all(sql`SELECT * FROM scheduled_run_deliveries`)).toEqual([])
      const receipts = await f.database.all(sql`SELECT * FROM scheduled_run_review_links`)
      expect(JSON.stringify(receipts)).not.toContain(token)
      await expect(async () => {
        await f.database.run(
          sql`UPDATE scheduled_run_review_links SET consumed_at=NULL,consumed_by_user_id=NULL WHERE user_id=1`,
        )
      }).rejects.toThrow()
    })
    it('[expiry #61] refuses the exact deadline, tampering, a different instance key and revoked authority', async () => {
      const f = await setup(),
        messages = await f.prepare()
      const owner = f.tokenFrom(
          messages.find((message) => message.to.email === 'owner@example.test')!.text,
        ),
        admin = f.tokenFrom(
          messages.find((message) => message.to.email === 'admin@example.test')!.text,
        )
      expect(await f.runs.consumeReviewLink!(1, 1, owner, '2026-10-02T09:00:00.000Z')).toBe(
        'expired',
      )
      expect(
        await f.runs.consumeReviewLink!(
          1,
          1,
          (owner[0] === 'A' ? 'B' : 'A') + owner.slice(1),
          '2026-10-01T09:01:00.000Z',
        ),
      ).toBe('invalid')
      expect(
        await createScheduledRunsService(f.database, {
          reviewLinkSigningKey: new Uint8Array(32).fill(0x44),
        }).consumeReviewLink!(1, 1, owner, '2026-10-01T09:01:00.000Z'),
      ).toBe('invalid')
      await f.database.run(sql`UPDATE users SET profile='member' WHERE id=3`)
      expect(await f.runs.consumeReviewLink!(1, 3, admin, '2026-10-01T09:01:00.000Z')).toBe(
        'invalid',
      )
      expect(await f.database.all(sql`SELECT consumed_at FROM scheduled_run_review_links`)).toEqual(
        [{ consumed_at: null }, { consumed_at: null }],
      )
    })
    it('[durability #61] the nonce and email/notification rows commit together; a retry uses the recorded original link', async () => {
      const f = await setup()
      await f.database.run(
        sql`CREATE TRIGGER fixture_review_link_failure BEFORE INSERT ON scheduled_run_review_links BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`,
      )
      await expect(f.prepare()).rejects.toThrow()
      expect(await f.database.all(sql`SELECT id FROM email_log`)).toEqual([])
      expect(await f.database.all(sql`SELECT id FROM notification_deliveries`)).toEqual([])
      expect(await f.database.all(sql`SELECT token_hash FROM scheduled_run_review_links`)).toEqual(
        [],
      )
      await f.database.run(sql`DROP TRIGGER fixture_review_link_failure`)
      const messages = await f.prepare()
      expect(messages).toHaveLength(2)
      const resumed = await f.prepare('2026-10-01T09:02:00.000Z')
      expect(resumed.map((message) => ({ id: message.deliveryId, text: message.text }))).toEqual(
        messages.map((message) => ({ id: message.deliveryId, text: message.text })),
      )
      expect(
        await f.database.all(sql`SELECT token_hash FROM scheduled_run_review_links`),
      ).toHaveLength(2)
    })
  })
