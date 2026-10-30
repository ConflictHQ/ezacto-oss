import * as core from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduledJobConfig } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createScheduledJobsService, proposeDueScheduledJobs } from '../src/scheduled-jobs.js'
import { createScheduledActionStore } from '../src/scheduled-actions.js'
import { seedMonthEndJobFixture } from './support/month-end-job-fixture.js'
const now = '2026-10-01T09:00:00.000Z'
for (const runtime of ['SQLite', 'D1'])
  describe(`scheduled job lifecycle (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => {
      vi.restoreAllMocks()
      await close?.()
    })
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
      return {
        database,
        service: createScheduledJobsService(database),
        store: createScheduledActionStore(database),
      }
    }
    const config = () => scheduledJobConfig({ name: 'Monthly A', scope: { client_ids: [1] } })
    it('[workflow #63] creates, reads and pauses settings with optimistic concurrency and live administrator checks', async () => {
      const { database, service } = await setup()
      await expect(service.create(2, config(), now)).rejects.toMatchObject({
        code: 'profile_forbidden',
      })
      const job = await service.create(3, config(), now)
      expect(job).toMatchObject({
        id: 1,
        version: 0,
        created_by: 3,
        is_active: true,
        scope: { client_ids: [1] },
      })
      expect(
        await service.list({ throughId: await service.snapshot(), afterId: null, take: 10 }),
      ).toEqual([job])
      const paused = await service.update(3, job.id, 0, { is_active: false }, now)
      expect(paused).toMatchObject({ version: 1, is_active: false })
      await expect(
        service.update(3, job.id, 0, { name: 'Stale settings' }, now),
      ).rejects.toMatchObject({ code: 'state_conflict' })
      await database.run(sql`UPDATE users SET is_active=0 WHERE id=3`)
      await expect(service.update(3, job.id, 1, { is_active: true }, now)).rejects.toMatchObject({
        code: 'profile_forbidden',
      })
      expect((await service.read(job.id))?.is_active).toBe(false)
    })
    it('[concurrency #63] overlapping ticks propose one scoped manifest, preserve its deadline and never confirm or execute', async () => {
      const { database, service, store } = await setup()
      const job = await service.create(1, config(), now)
      const sweeps = await Promise.all([
        proposeDueScheduledJobs(database, now),
        proposeDueScheduledJobs(database, now),
      ])
      expect(sweeps.flatMap((result) => result.proposed)).toHaveLength(1)
      const rows = await database.all<{
        id: number
        state: string
        expires_at: string
        job_version: number
      }>(sql`SELECT id,state,expires_at,job_version FROM proposed_runs`)
      expect(rows).toEqual([
        { id: 1, state: 'proposed', expires_at: '2026-10-02T09:00:00.000Z', job_version: 0 },
      ])
      expect(await store.manifest(1)).toMatchObject([
        {
          subjectId: 1,
          clientName: 'Month End A',
          amountCents: 10000,
          target: 'a@example.test',
          state: 'pending',
          attemptCount: 0,
        },
      ])
      expect(await proposeDueScheduledJobs(database, '2026-10-01T10:00:00.000Z')).toMatchObject({
        proposed: [],
      })
      await service.update(
        1,
        job.id,
        0,
        { confirm_within_minutes: 60, scope: { client_ids: [2] } },
        now,
      )
      expect((await store.read(1))?.expiresAt).toBe('2026-10-02T09:00:00.000Z')
      expect(await store.manifest(1)).toMatchObject([{ subjectId: 1, target: 'a@example.test' }])
      expect((await service.read(job.id))?.last_run_id).toBe(1)
    })
    it('[workflow #63] evaluates the company clock, skips paused jobs and exposes empty/malformed jobs without blocking others', async () => {
      const { database, service } = await setup()
      const valid = await service.create(1, config(), now)
      const paused = await service.create(
        1,
        scheduledJobConfig({ name: 'Paused', is_active: false }),
        now,
      )
      const empty = await service.create(
        1,
        scheduledJobConfig({ name: 'Empty', scope: { client_ids: [999] } }),
        now,
      )
      const malformed = await service.create(
        1,
        scheduledJobConfig({ name: 'Legacy malformed' }),
        now,
      )
      await database.run(
        sql`UPDATE scheduled_jobs SET scope_json='{"unexpected_filter":true}' WHERE id=${malformed.id}`,
      )
      await database.run(sql`UPDATE organizations SET timezone='America/Costa_Rica' WHERE id=1`)
      const before = await proposeDueScheduledJobs(database, '2026-10-01T14:59:00.000Z')
      expect(before.proposed).toEqual([])
      const due = await proposeDueScheduledJobs(database, '2026-10-01T15:00:00.000Z')
      expect(due.proposed).toEqual([{ jobId: valid.id, runId: 1 }])
      expect(due.failed.map((row) => row.jobId)).toEqual(
        expect.arrayContaining([empty.id, malformed.id]),
      )
      expect((await service.read(empty.id))?.last_error).toContain('No eligible invoices')
      expect((await service.read(malformed.id))?.last_error).toContain('client_ids')
      expect((await service.read(paused.id))?.last_checked_at).toBeNull()
    })
    it('[invariant #63] records a renderer failure without a proposal and continues to the next job', async () => {
      const { database, service } = await setup()
      const first = await service.create(1, config(), now)
      const second = await service.create(
        1,
        scheduledJobConfig({ name: 'Monthly B', scope: { client_ids: [2] } }),
        now,
      )
      vi.spyOn(core, 'renderDetailedReportDocument').mockImplementationOnce(() => {
        throw new Error('Report renderer unavailable')
      })
      const result = await proposeDueScheduledJobs(database, now)
      expect(result.failed).toEqual([{ jobId: first.id, message: 'Report renderer unavailable' }])
      expect(result.proposed).toEqual([{ jobId: second.id, runId: 1 }])
      expect(await database.all(sql`SELECT job_id FROM proposed_runs`)).toEqual([
        { job_id: second.id },
      ])
      expect((await service.read(first.id))?.last_error).toBe('Report renderer unavailable')
    })
    it('[invariant #63] refuses a stale configuration at the atomic proposal boundary', async () => {
      const { database, service, store } = await setup()
      const job = await service.create(1, config(), now)
      await service.update(1, job.id, 0, { scope: { client_ids: [2] } }, now)
      expect(
        await store.propose({
          jobId: job.id,
          expectedJobVersion: 0,
          occurrenceKey: '2026-09',
          proposedAt: now,
          expiresAt: '2026-10-02T09:00:00.000Z',
          items: [
            {
              subjectType: 'invoice',
              subjectId: 1,
              description: 'Stale A',
              target: 'a@example.test',
            },
          ],
        }),
      ).toEqual({ outcome: 'job_unavailable' })
      expect(await database.all(sql`SELECT id FROM proposed_runs`)).toEqual([])
    })
  })
