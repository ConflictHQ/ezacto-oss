import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createContainerOutboxService,
  createD1OutboxService,
  type OutboxService,
} from '../src/outbox.js'
import { createTimesheetApprovalRepository } from '../src/timesheet-approvals.js'
import { createTimesheetLockPolicyRepository } from '../src/timesheet-lock-policy.js'

/**
 * Approvals and locks reach the activity log (issue 8). Their events are
 * written by triggers in the same statement as the state change, so there is
 * no capture code to test here: this proves the log reads them back, once each,
 * with the actor named and the time recorded, and that the filters narrow to
 * one submission or one lock.
 */

type Orm = Parameters<typeof createTimesheetApprovalRepository>[0]

interface TestDatabase {
  orm: Orm
  outbox: OutboxService
  run(sql: string, ...params: unknown[]): Promise<void>
  close(): Promise<void>
}

const drainAt = '2026-09-02T00:00:00.000Z'
const t0 = '2026-08-31T12:00:00.000Z'
const t1 = '2026-08-31T12:01:00.000Z'
const t2 = '2026-08-31T12:02:00.000Z'
const t3 = '2026-08-31T12:03:00.000Z'
const t4 = '2026-08-31T12:04:00.000Z'
const t5 = '2026-08-31T12:05:00.000Z'
const t6 = '2026-08-31T12:06:00.000Z'
const fingerprint = `sha256:${'0'.repeat(64)}`

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    outbox: createContainerOutboxService(sqlite, { now: () => drainAt }),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    orm: createD1Database(d1),
    outbox: createD1OutboxService(d1, { now: () => drainAt }),
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const installFixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Activity org', '{"expenses":true,"invoices":true,"approval":true}', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (10, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
            (1, 'Maya', 'Member', 'member', '[]', ?, ?),
            (3, 'Evan', 'Executive', 'executive_manager', '[]', ?, ?)`,
    t0, t0, t0, t0, t0, t0,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`,
    t0, t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Project', ?, ?)`,
    t0, t0,
  )
  await db.run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Task', ?, ?)`, t0, t0)
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 1, ?, ?)`,
    t0, t0,
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0, t0,
  )
  await db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
      billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, 1, 1, '2026-08-25', 3600, 3600, 3600, 'Work', 1, ?, ?)`,
    t0, t0,
  )
}

for (const [runtime, factory] of factories) {
  describe(`activity log approval and lock events (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[unit] records submit, reject, resubmit, approve and withdraw once each, with actor and time', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, '2026-08-24', '2026-08-30', t1)
      await approvals.reject(
        { userId: 3, profile: 'executive_manager' },
        submitted.id,
        'Add detail.',
        t2,
      )
      await approvals.submit(1, '2026-08-24', '2026-08-30', t3)
      await approvals.approve({ userId: 10, profile: 'administrator' }, submitted.id, t4)
      await approvals.withdraw(
        { userId: 10, profile: 'administrator' },
        submitted.id,
        'Reopened for a correction.',
        t5,
      )

      // Draining twice is the retried handler: the second pass must find
      // nothing to record rather than write each entry again.
      await database.outbox.drain()
      await database.outbox.drain()
      const log = await database.outbox.listActivity({
        aggregateType: 'timesheet_submission',
        aggregateId: submitted.id,
      })

      // One drain stamps every entry with the same recorded_at, so the log's own
      // order inside it is by event id; chronology is read from occurred_at.
      expect(
        [...log]
          .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
          .map((entry) => ({
            type: entry.eventType,
            at: entry.occurredAt,
            actor: entry.actor,
            sequence: entry.aggregateSequence,
          })),
      ).toEqual([
        { type: 'timesheet.submitted', at: t1, actor: { type: 'user', id: 1, name: 'Maya Member' }, sequence: 1 },
        { type: 'timesheet.rejected', at: t2, actor: { type: 'user', id: 3, name: 'Evan Executive' }, sequence: 2 },
        { type: 'timesheet.submitted', at: t3, actor: { type: 'user', id: 1, name: 'Maya Member' }, sequence: 3 },
        { type: 'timesheet.approved', at: t4, actor: { type: 'user', id: 10, name: 'Ada Admin' }, sequence: 4 },
        { type: 'timesheet.withdrawn', at: t5, actor: { type: 'user', id: 10, name: 'Ada Admin' }, sequence: 5 },
      ])
      // The payload names ids and states; the person is not copied into it.
      for (const entry of log) {
        expect(JSON.stringify(entry.payload)).not.toContain('Maya')
        expect(entry.recordedAt).toBe(drainAt)
      }
    })

    it('[unit] records a lock and its unlock, and a replayed lock command writes nothing more', async () => {
      database = await factory()
      await installFixture(database)
      const locks = createTimesheetLockPolicyRepository(database.orm, { clock: () => t1 })
      const admin = { userId: 10, profile: 'administrator' } as const
      const locked = await locks.createManualLock(admin, '2026-08-25', 'Month-end close', t1, 'lock-1', fingerprint)
      const replayed = await locks.createManualLock(admin, '2026-08-25', 'Month-end close', t1, 'lock-1', fingerprint)
      expect(replayed.id).toBe(locked.id)
      await locks.unlock({ userId: 3, profile: 'executive_manager' }, locked.id, 'Corrections authorized', t6)

      await database.outbox.drain()
      const log = await database.outbox.listActivity({
        aggregateType: 'timesheet_lock',
        aggregateId: locked.id,
      })
      expect(
        [...log]
          .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
          .map((entry) => [entry.eventType, entry.occurredAt, entry.actor?.name]),
      ).toEqual([
        ['timesheet.locked', t1, 'Ada Admin'],
        ['timesheet.unlocked', t6, 'Evan Executive'],
      ])
    })

    it('[container/D1] the aggregate filters return only matching rows and AND with the others', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const locks = createTimesheetLockPolicyRepository(database.orm, { clock: () => t1 })
      const submitted = await approvals.submit(1, '2026-08-24', '2026-08-30', t1)
      await approvals.approve({ userId: 10, profile: 'administrator' }, submitted.id, t2)
      const locked = await locks.createManualLock(
        { userId: 10, profile: 'administrator' },
        '2026-08-25',
        'Close',
        t3,
        'lock-2',
        fingerprint,
      )
      await database.outbox.drain()
      const types = async (filter: Parameters<OutboxService['listActivity']>[0]) =>
        (await database!.outbox.listActivity(filter)).map((entry) => entry.eventType).sort()

      expect(await types({})).toEqual(['timesheet.approved', 'timesheet.locked', 'timesheet.submitted'])
      expect(await types({ aggregateType: 'timesheet_lock' })).toEqual(['timesheet.locked'])
      expect(await types({ aggregateType: 'timesheet_lock', aggregateId: locked.id })).toEqual([
        'timesheet.locked',
      ])
      expect(await types({ aggregateType: 'timesheet_lock', aggregateId: locked.id + 1 })).toEqual([])
      expect(
        await types({ aggregateType: 'timesheet_submission', actorId: 10 }),
      ).toEqual(['timesheet.approved'])
      expect(
        await types({ aggregateType: 'timesheet_submission', eventType: 'timesheet.locked' }),
      ).toEqual([])

      await expect(database.outbox.listActivity({ aggregateId: 1 })).rejects.toThrow(RangeError)
      await expect(
        database.outbox.listActivity({ aggregateType: 'timesheet_lock', aggregateId: 0 }),
      ).rejects.toThrow(RangeError)
      await expect(database.outbox.listActivity({ aggregateType: "x'; --" })).rejects.toThrow(RangeError)
    })

    it('[container/D1] pages on (recorded_at, event_id) without repeating or skipping an entry', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, '2026-08-24', '2026-08-30', t1)
      await approvals.approve({ userId: 10, profile: 'administrator' }, submitted.id, t2)
      await approvals.withdraw({ userId: 10, profile: 'administrator' }, submitted.id, 'Reopen', t3)
      await database.outbox.drain()

      expect(await database.outbox.activitySnapshot()).toBe(drainAt)
      const everything = await database.outbox.listActivity()
      expect(everything).toHaveLength(3)

      const seen: string[] = []
      let after: { recordedAt: string; eventId: string } | null = null
      for (;;) {
        const page = await database.outbox.listActivity({ limit: 2, after, recordedThrough: drainAt })
        seen.push(...page.map((entry) => entry.id))
        const last = page.at(-1)
        if (page.length < 2 || last === undefined) break
        after = { recordedAt: last.recordedAt, eventId: last.id }
      }
      expect(seen).toEqual(everything.map((entry) => entry.id))

      // Entries recorded after the snapshot are not part of the traversal.
      expect(
        await database.outbox.listActivity({ recordedThrough: '2026-09-01T23:59:59.999Z' }),
      ).toEqual([])
    })
  })
}
