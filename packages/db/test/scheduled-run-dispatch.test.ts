import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { scheduledJobConfig } from '@ezacto/core'
import {
  createQueuedMailer,
  createSenderBoundQueuedMailer,
  processQueuedEmail,
  type QueuedEmailJob,
} from '@ezacto/mailer'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createContainerEmailConfigurationStore,
  createD1EmailConfigurationStore,
  type EmailConfigurationStore,
} from '../src/email-configuration.js'
import { createContainerEmailLogStore, createD1EmailLogStore } from '../src/email-log.js'
import { createScheduledJobsService, proposeDueScheduledJobs } from '../src/scheduled-jobs.js'
import { createScheduledRunsService } from '../src/scheduled-runs.js'
import { createScheduledActionStore } from '../src/scheduled-actions.js'
import { createScheduledRunDispatchService } from '../src/scheduled-run-dispatch.js'
import { seedMonthEndJobFixture } from './support/month-end-job-fixture.js'
const now = '2026-10-01T09:00:00.000Z'
for (const runtime of ['SQLite', 'D1'])
  describe(`durable month-end dispatch (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async () => {
      let database: Parameters<typeof seedMonthEndJobFixture>[0],
        configuration: EmailConfigurationStore,
        log: ReturnType<typeof createD1EmailLogStore>
      if (runtime === 'SQLite') {
        const sqlite = new BetterSqlite3(':memory:')
        migrateContainer(sqlite)
        database = createContainerDatabase(sqlite)
        configuration = createContainerEmailConfigurationStore(sqlite)
        log = createContainerEmailLogStore(sqlite)
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
        configuration = createD1EmailConfigurationStore(d1)
        log = createD1EmailLogStore(d1)
        close = async () => mf.dispose()
      }
      await seedMonthEndJobFixture(database)
      await database.run(
        sql`INSERT INTO report_brands(id,name,created_at,updated_at) VALUES(1,'Brand A',${now},${now}),(2,'Brand B',${now},${now})`,
      )
      await database.run(sql`UPDATE clients SET report_brand_id=id WHERE id IN(1,2)`)
      await configuration.createSenderIdentity({
        id: 10,
        email: 'billing@example.test',
        displayName: 'Billing',
        provider: 'ses',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'scheduled-sender',
        occurredAt: now,
      })
      await configuration.recordSenderEvidence({
        id: 10,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'domain',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          mailFromDomain: 'bounce.example.test',
          mailFromStatus: 'verified',
          observedAt: now,
        },
        actorUserId: 1,
        commandId: 'scheduled-evidence',
        occurredAt: now,
      })
      await configuration.setDefaultSenderIdentity({
        id: 10,
        expectedVersion: 0,
        actorUserId: 1,
        commandId: 'scheduled-default',
        occurredAt: now,
      })
      const objects = new Map<string, Uint8Array>()
      const writes = {
        put: async (key: string, bytes: ArrayBuffer) => {
          objects.set(key, new Uint8Array(bytes))
        },
      }
      await createScheduledJobsService(database).create(
        1,
        scheduledJobConfig({ name: 'All clients' }),
        now,
      )
      expect((await proposeDueScheduledJobs(database, now, writes)).proposed).toHaveLength(1)
      const jobs: QueuedEmailJob[] = []
      let clock = '2026-10-01T09:02:00.000Z',
        pauseHandoff = false
      let releaseHandoff!: () => void, enteredHandoff!: () => void
      const paused = new Promise<void>((resolve) => {
        enteredHandoff = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseHandoff = resolve
      })
      let ambiguousItem: number | null = null,
        alwaysFailItem: number | null = null
      const queued = createQueuedMailer(log, {
        send: async (job) => {
          jobs.push(job)
          if (alwaysFailItem !== null && job.deliveryId === alwaysFailItem)
            throw new Error('Queue temporarily unavailable')
          if (ambiguousItem !== null && job.deliveryId === ambiguousItem) {
            ambiguousItem = null
            throw new Error('Queue handoff response lost')
          }
        },
      })
      const mailer = createSenderBoundQueuedMailer(configuration, queued, 'ses')
      const dispatch = createScheduledRunDispatchService(database, {
        sender: async () => {
          await mailer.assertAvailable()
          const sender = (await configuration.resolveSenderIdentity())!
          return {
            senderIdentityId: sender.id,
            senderIdentityVersion: sender.version,
            senderEvidenceVersion: sender.evidence!.version,
            from: { email: sender.email, name: sender.displayName },
          }
        },
        enqueue: async (...args) => {
          if (ambiguousItem === -1 && args[2].to[0]?.email === 'b@example.test')
            ambiguousItem = args[0]
          if (alwaysFailItem === -1 && args[2].to[0]?.email === 'b@example.test')
            alwaysFailItem = args[0]
          await mailer.enqueuePersisted!(...args)
          if (pauseHandoff && args[2].to[0]?.email === 'a@example.test') {
            pauseHandoff = false
            enteredHandoff()
            await released
          }
        },
        readBytes: async (key) => objects.get(key) ?? null,
        now: () => clock,
      })
      return {
        pause: () => {
          pauseHandoff = true
        },
        paused: () => paused,
        release: () => releaseHandoff(),
        advance: (now: string) => {
          clock = now
        },
        database,
        objects,
        jobs,
        dispatch,
        runs: createScheduledRunsService(database),
        store: createScheduledActionStore(database),
        log,
        ambiguous: () => {
          ambiguousItem = -1
        },
        unavailable: () => {
          alwaysFailItem = -1
        },
        available: () => {
          alwaysFailItem = null
        },
      }
    }
    it('[workflow #62 #1204] retries an ambiguous checkpoint for the same ten candidates, then advances fairly', async () => {
      const f = await setup()
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      for (let month = 1; month <= 11; month += 1) {
        const proposal = await f.store.propose({
          jobId: 1,
          occurrenceKey: `2025-${String(month).padStart(2, '0')}`,
          proposedAt: now,
          expiresAt: '2026-10-02T09:00:00.000Z',
          items: [
            {
              subjectType: 'invoice',
              subjectId: 1,
              description: 'Legacy work detail',
              amountCents: 10000,
              currency: 'USD',
              target: 'a@example.test',
            },
          ],
        })
        if (proposal.outcome !== 'proposed') throw new Error(proposal.outcome)
        await f.runs.confirm(proposal.run.id, 1, '2026-10-01T09:01:00.000Z')
      }
      const originalAll = f.database.all.bind(f.database)
      const dialect = new SQLiteSyncDialect()
      let checkpoints = 0
      const checkpointIds: unknown[][] = []
      vi.spyOn(f.database, 'all').mockImplementation((async (query: Parameters<typeof originalAll>[0]) => {
        const statement = typeof query === 'string' ? { sql: query, params: [] } : dialect.sqlToQuery(query.getSQL())
        const result = await originalAll(query)
        if (statement.sql.startsWith('UPDATE proposed_runs SET workflow_checked_at=')) {
          checkpoints++
          checkpointIds.push(statement.params)
          if (checkpoints === 1) throw new Error('Failed query', { cause: new Error('D1_ERROR: Network connection lost') })
        }
        return result
      }) as never)
      expect(
        (await f.dispatch.workflowCandidates()).map((row) => row.id).sort((a, b) => a - b),
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(checkpoints).toBe(2)
      expect(checkpointIds[0]).toEqual(checkpointIds[1])
      f.advance('2026-10-01T09:03:00.000Z')
      const next = await f.dispatch.workflowCandidates()
      expect(next).toHaveLength(10)
      expect(next.map((row) => row.id)).toEqual(expect.arrayContaining([11, 12]))
    })
    it('[workflow #1204] rechecks cancellation and active leases between candidate read and checkpoint', async () => {
      const f = await setup()
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      const originalAll = f.database.all.bind(f.database)
      const dialect = new SQLiteSyncDialect()
      let race: 'lease' | 'checkpoint' | 'cancel' = 'lease'
      vi.spyOn(f.database, 'all').mockImplementation((async (query: Parameters<typeof originalAll>[0]) => {
        if ((typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql).startsWith('UPDATE proposed_runs SET workflow_checked_at=')) {
          if (race === 'lease') await f.database.run(sql`UPDATE run_items SET state='running',attempted_at='2026-10-01T09:00:00Z',lease_expires_at='2027-01-01T00:00:00Z' WHERE run_id=1`)
          else if (race === 'checkpoint') await f.database.run(sql`UPDATE proposed_runs SET workflow_checked_at='2026-10-01T09:30:00Z' WHERE id=1`)
          else await f.database.run(sql`UPDATE proposed_runs SET state='cancelled' WHERE id=1`)
        }
        return await originalAll(query)
      }) as never)
      expect(await f.dispatch.workflowCandidates()).toEqual([])
      await f.database.run(sql`UPDATE run_items SET state='pending',lease_expires_at=NULL WHERE run_id=1`)
      race = 'checkpoint'
      expect(await f.dispatch.workflowCandidates()).toEqual([])
      expect(await f.database.get(sql`SELECT workflow_checked_at FROM proposed_runs WHERE id=1`)).toMatchObject({ workflow_checked_at: '2026-10-01T09:30:00Z' })
      race = 'cancel'
      expect(await f.dispatch.workflowCandidates()).toEqual([])
      expect(await f.database.get(sql`SELECT state FROM proposed_runs WHERE id=1`)).toMatchObject({ state: 'cancelled' })
    })
    it('[workflow #62] scopes a pass to its immutable proposal and excludes finished runs', async () => {
      const f = await setup()
      expect(await f.dispatch.workflowCandidates()).toEqual([])
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      const candidates = await f.dispatch.workflowCandidates()
      expect(candidates).toEqual([{ id: 1, proposed_at: now, generation: 6 }])
      expect(await f.dispatch.processRun(1, '2026-09-01T09:00:00.000Z')).toMatchObject({
        completed: 0,
        pending: false,
      })
      expect(f.jobs).toHaveLength(0)
      expect(await f.dispatch.processRun(1, now)).toMatchObject({ completed: 2, pending: false })
      expect(await f.dispatch.workflowCandidates()).toEqual([])
    })
    it('[e2e #58 #62] captures branded PDFs once, attaches to the right invoices and reuses durable queue IDs after an ambiguous handoff', async () => {
      const f = await setup()
      const items = await f.store.manifest(1)
      expect(items).toHaveLength(2)
      for (const [index, item] of items.entries()) {
        expect(item.report).not.toBeNull()
        expect(new TextDecoder().decode(f.objects.get(item.report!.key))).toContain(
          index === 0 ? 'Brand A' : 'Brand B',
        )
      }
      await f.database.run(sql`UPDATE report_brands SET name='Changed after proposal' WHERE id=1`)
      expect(await f.dispatch.processDue()).toMatchObject({ completed: 0, failed: [] })
      expect(f.jobs).toHaveLength(0)
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      f.ambiguous()
      const first = await f.dispatch.processDue()
      expect(first, JSON.stringify(first)).toMatchObject({ completed: 1 })
      expect(first.failed).toHaveLength(1)
      expect((await f.dispatch.processDue()).completed).toBe(1)
      expect(f.jobs).toHaveLength(3)
      expect(f.jobs[1]!.deliveryId).toBe(f.jobs[2]!.deliveryId)
      expect(
        await f.database.all(
          sql`SELECT invoice_id,count(*) AS count FROM invoice_attachments GROUP BY invoice_id ORDER BY invoice_id`,
        ),
      ).toEqual([
        { invoice_id: 1, count: 1 },
        { invoice_id: 2, count: 1 },
      ])
      const delivered: string[] = []
      for (const job of f.jobs)
        await processQueuedEmail(
          job,
          1,
          f.log,
          {
            name: 'ses',
            send: async (message) => {
              delivered.push(message.to[0]!.email)
              return { messageId: `scheduled-${delivered.length}` }
            },
          },
          { resolveAttachment: async (ref) => f.objects.get(ref.key) ?? null },
        )
      expect(delivered).toEqual(['a@example.test', 'b@example.test'])
      const confirmed = await f.runs.read(1)
      expect(confirmed?.state).toBe('completed')
      expect(confirmed?.items.map((item) => item.delivery_status)).toEqual(['sent', 'sent'])
      await f.runs.confirm(1, 1, '2026-10-01T09:03:00.000Z')
      await f.dispatch.processDue()
      expect(f.jobs).toHaveLength(3)
      const trail = await f.database.all<{ event_type: string; payload_json: string }>(
        sql`SELECT event_type,payload_json FROM event_outbox WHERE aggregate_type='scheduled_run' ORDER BY aggregate_sequence`,
      )
      expect(trail.map((event) => event.event_type)).toEqual([
        'scheduled_run.proposed',
        'scheduled_run.confirmed',
        'scheduled_run.item_started',
        'scheduled_run.item_completed',
        'scheduled_run.item_started',
        'scheduled_run.item_failed',
        'scheduled_run.item_started',
        'scheduled_run.item_completed',
        'scheduled_run.completed',
      ])
      expect(JSON.parse(trail[1]!.payload_json).actor).toEqual({ type: 'user', id: 1 })
    })
    it('[crash #62] a stopped process resumes after lease recovery without replacing receipts or repeating completed items', async () => {
      const f = await setup()
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      f.pause()
      const stopped = f.dispatch.processDue()
      await f.paused()
      f.advance('2026-10-01T09:18:00.000Z')
      const resumed = await f.dispatch.processDue()
      f.release()
      expect(resumed.completed).toBe(2)
      expect((await stopped).completed).toBe(0)
      expect(f.jobs).toHaveLength(3)
      expect(f.jobs[0]!.deliveryId).toBe(f.jobs[1]!.deliveryId)
      expect(
        await f.database.all(sql`SELECT count(*) AS count FROM scheduled_run_deliveries`),
      ).toEqual([{ count: 2 }])
      expect(await f.database.all(sql`SELECT count(*) AS count FROM invoice_attachments`)).toEqual([
        { count: 2 },
      ])
      expect((await f.runs.read(1))?.items.map((item) => item.attempt_count)).toEqual([2, 1])
    })
    it('[privacy #62] refuses missing/tampered report bytes and a changed recipient without silently redirecting', async () => {
      const f = await setup(),
        items = await f.store.manifest(1)
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      await expect(async () => {
        await f.database.run(
          sql`UPDATE run_items SET report_name='unreviewed.pdf' WHERE id=${items[0]!.id}`,
        )
      }).rejects.toThrow()
      await expect(async () => {
        await f.database.run(
          sql`UPDATE run_items SET report_people_json='[{"id":1,"name":"Unreviewed person","seconds":1}]' WHERE id=${items[0]!.id}`,
        )
      }).rejects.toThrow()
      f.objects.set(items[0]!.report!.key, new Uint8Array([1, 2, 3]))
      await f.database.run(sql`UPDATE contacts SET email='unreviewed@example.test' WHERE id=2`)
      const result = await f.dispatch.processDue()
      expect(result.completed).toBe(0)
      expect(result.failed).toHaveLength(2)
      expect(f.jobs).toHaveLength(0)
      expect(await f.database.all(sql`SELECT * FROM scheduled_run_deliveries`)).toEqual([])
    })
    it('[retry #62] stops at the retry budget and an administrator can authorize only another failed-item window', async () => {
      const f = await setup()
      await f.runs.confirm(1, 1, '2026-10-01T09:01:00.000Z')
      f.unavailable()
      for (let pass = 0; pass < 3; pass++) await f.dispatch.processDue()
      expect((await f.runs.read(1))?.items.map((item) => item.attempt_count)).toEqual([1, 3])
      expect((await f.dispatch.processDue()).failed).toEqual([])
      await f.runs.retry!(1, 2, '2026-10-01T09:03:00.000Z')
      expect((await f.runs.read(1))?.items[1]?.attempt_limit).toBe(3)
      await f.runs.retry!(1, 1, '2026-10-01T09:03:00.000Z')
      f.available()
      expect((await f.dispatch.processDue()).completed).toBe(1)
      expect((await f.runs.read(1))?.items.map((item) => item.attempt_count)).toEqual([1, 4])
      expect(f.jobs.filter((job) => job.message.to[0]?.email === 'a@example.test')).toHaveLength(1)
    })
    it('[review #924] warnings are part of the immutable report and need a recorded acknowledgement', async () => {
      const f = await setup(),
        item = (await f.store.manifest(1))[0]!
      const job = await createScheduledJobsService(f.database).create(
        1,
        scheduledJobConfig({ name: 'Warning review' }),
        now,
      )
      const proposed = await f.store.propose({
        jobId: job.id,
        occurrenceKey: '2026-09',
        proposedAt: now,
        expiresAt: '2026-10-02T09:00:00.000Z',
        items: [
          {
            ...item,
            reportWarnings: [
              { entryId: 55, kind: 'url', match: 'https://internal.example.test/55' },
            ],
          },
        ],
      })
      if (proposed.outcome !== 'proposed') throw new Error('Warning fixture not proposed')
      expect((await f.runs.confirm(proposed.run.id, 1, '2026-10-01T09:01:00.000Z')).outcome).toBe(
        'report_warnings_unacknowledged',
      )
      await expect(async () => {
        await f.database.run(
          sql`UPDATE proposed_runs SET state='confirmed',confirmed_by_user_id=1,confirmed_at='2026-10-01T09:01:00.000Z' WHERE id=${proposed.run.id}`,
        )
      }).rejects.toThrow()
      expect(
        (await f.runs.confirm(proposed.run.id, 1, '2026-10-01T09:01:00.000Z', true)).outcome,
      ).toBe('ok')
      expect(
        await f.database.all(
          sql`SELECT report_warnings_acknowledged FROM proposed_runs WHERE id=${proposed.run.id}`,
        ),
      ).toEqual([{ report_warnings_acknowledged: 1 }])
    })
  })
