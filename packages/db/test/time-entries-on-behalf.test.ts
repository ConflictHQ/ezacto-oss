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
import {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TimeEntryActor,
  type TrackedPolicyResolver,
} from '../src/tracked-resource-repository.js'

/**
 * Issue 917: an administrator corrects a teammate's time, and nobody else can.
 *
 * Every case runs on both runtimes because the audit is a follow-up statement
 * inside the write's own transaction (better-sqlite3) or batch (D1), and the
 * two runtimes are what decide whether it really commits with the write.
 */

type TrackedDatabase = ConstructorParameters<typeof DrizzleTrackedResourceRepository>[0]

interface TestDatabase {
  orm: TrackedDatabase
  outbox(): OutboxService
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-08-31T12:00:00.000Z'
const drainAt = '2026-08-31T13:00:00.000Z'
/** `t0` for each of a statement's `?` placeholders. */
const stamps = (count: number): string[] => Array.from({ length: count }, () => t0)

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    outbox: () => createContainerOutboxService(sqlite, { now: () => drainAt }),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
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
    outbox: () => createD1OutboxService(d1, { now: () => drainAt }),
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<Row>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const ada: TimeEntryActor = { userId: 10, profile: 'administrator' }
const maya: TimeEntryActor = { userId: 1, profile: 'member' }
const milo: TimeEntryActor = { userId: 6, profile: 'member' }
const evan: TimeEntryActor = { userId: 3, profile: 'executive_manager' }
const priya: TimeEntryActor = { userId: 2, profile: 'project_manager' }

const at = (instant: string, date = instant.slice(0, 10), time = instant.slice(11, 16)) => ({
  instant,
  date,
  time,
})

const policyKey = (subject: Readonly<PolicySubject>): string =>
  subject.entityType === 'running_time_entry_replacement'
    ? `running:${subject.userId}`
    : subject.entityType === 'tracked_date'
      ? `tracked_date:${subject.spentDate}`
      : `${subject.entityType}:${subject.entityId}`

/**
 * Locks by key, with an optional hook that runs while the repository is between
 * reading the entry and writing it -- which is where a concurrent change lands.
 */
const policy = (
  locked: ReadonlySet<string> = new Set(),
  between?: (subject: Readonly<PolicySubject>) => Promise<void>,
): TrackedPolicyResolver => ({
  isLocked: async (subject) => {
    await between?.(subject)
    return locked.has(policyKey(subject))
  },
})

/**
 * Maya (1) owns the time. Entry 1 is a stopped hour in the week of 24 August;
 * entry 2 is her timer, running since 11:00 on the 31st.
 */
const installFixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Fictional Studio', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES
      (10, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
      (1, 'Maya', 'Member', 'member', '[]', ?, ?),
      (2, 'Priya', 'Manager', 'project_manager', '[]', ?, ?),
      (3, 'Evan', 'Executive', 'executive_manager', '[]', ?, ?),
      (6, 'Milo', 'Member', 'member', '[]', ?, ?)`,
    ...stamps(10),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Fictional Client', 'USD', ?, ?)`,
    ...stamps(2),
  )
  // Billed by person, so an entry's rate says whose entry it is.
  await db.run(
    `INSERT INTO projects (id, client_id, name, bill_by, created_at, updated_at)
     VALUES (1, 1, 'Fictional Project', 'people', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Fictional Task', ?, ?)`,
    ...stamps(2),
  )
  // Ada is assigned too, so her own time can be told apart from Maya's.
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?), (2, 1, 10, ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO user_billable_rates (id, user_id, amount_cents, start_date, created_at, updated_at)
     VALUES (1, 1, 9000, NULL, ?, ?), (2, 10, 15000, NULL, ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
      billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, 1, 1, '2026-08-25', 3600, 3600, 3600, 'Initial work', 1, ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, timer_started_at,
      notes, billable, created_at, updated_at
    ) VALUES (2, 1, 1, 1, 1, 1, '2026-08-31', 0, 0, 0, '2026-08-31T11:00:00.000Z',
      'Running', 1, ?, ?)`,
    ...stamps(2),
  )
}

interface OnBehalfPayload {
  readonly time_entry: {
    readonly user_id: number
    readonly before: Readonly<Record<string, unknown>> | null
    readonly after: Readonly<Record<string, unknown>> | null
  }
  readonly [key: string]: unknown
}

interface EventRow {
  id: string
  aggregate_id: number
  aggregate_sequence: number
  event_type: string
  payload_json: string
  occurred_at: string
  available_at: string
}

const onBehalfEvents = (db: TestDatabase) =>
  db.rows<EventRow>(
    `SELECT id, aggregate_id, aggregate_sequence, event_type, payload_json, occurred_at,
       available_at
     FROM event_outbox WHERE aggregate_type = 'time_entry'
     ORDER BY occurred_at, aggregate_id, aggregate_sequence`,
  )

const entryRows = (db: TestDatabase) =>
  db.rows<{
    id: number
    user_id: number
    seconds: number
    notes: string | null
    timer_started_at: string | null
    updated_at: string
  }>(
    `SELECT id, user_id, seconds, notes, timer_started_at, updated_at
     FROM time_entries ORDER BY id`,
  )

for (const [runtime, factory] of factories) {
  describe(`time entries on somebody else's behalf (${runtime})`, () => {
    let database: TestDatabase | null = null

    afterEach(async () => {
      await database?.close()
      database = null
    })

    const setup = async (resolver: TrackedPolicyResolver = policy()) => {
      database = await factory()
      await installFixture(database)
      return {
        db: database,
        tracked: new DrizzleTrackedResourceRepository(database.orm, resolver),
      }
    }

    it('[security #917] keeps a member, an executive manager and a project manager to their own time', async () => {
      const { db, tracked } = await setup()
      const before = await entryRows(db)
      for (const actor of [milo, evan, priya]) {
        const source = tracked.timeEntries(actor, { userId: maya.userId })
        expect(await source.highWatermark()).toBeNull()
        expect(await source.list({ afterId: null, throughId: 99, take: 10 })).toEqual([])
        await expect(tracked.getTimeEntry(actor, 1)).rejects.toMatchObject({
          code: 'tracked_resource_not_found',
        })
        await expect(
          tracked.createTimeEntry(
            actor,
            { userId: maya.userId, projectId: 1, taskId: 1, spentDate: '2026-08-26', seconds: 900 },
            at('2026-08-31T12:01:00.000Z'),
          ),
        ).rejects.toMatchObject({ field: 'user_id', reasonCode: 'forbidden' })
        await expect(
          tracked.updateTimeEntry(actor, 1, { notes: 'Not yours' }, at('2026-08-31T12:02:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_resource_not_found' })
        await expect(
          tracked.stopTimeEntry(actor, 2, at('2026-08-31T12:03:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_resource_not_found' })
        await expect(
          tracked.restartTimeEntry(actor, 1, at('2026-08-31T12:04:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_resource_not_found' })
        await expect(
          tracked.deleteTimeEntry(actor, 1, at('2026-08-31T12:05:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_resource_not_found' })
      }
      // Asking for your own entries by name still works: the filter narrows,
      // it is only somebody else's name that finds nothing.
      expect(
        (
          await tracked.timeEntries(maya, { userId: maya.userId }).list({
            afterId: null,
            throughId: 99,
            take: 10,
          })
        ).map(({ id }) => id),
      ).toEqual([1, 2])
      expect(await entryRows(db)).toEqual(before)
      expect(await onBehalfEvents(db)).toEqual([])
    }, 60_000)

    it("[security #917] lets an administrator log, correct, stop and delete a teammate's time, recorded as the actor", async () => {
      const { db, tracked } = await setup()
      expect(
        (
          await tracked.timeEntries(ada, { userId: maya.userId }).list({
            afterId: null,
            throughId: 99,
            take: 10,
          })
        ).map(({ id, userId }) => ({ id, userId })),
      ).toEqual([
        { id: 1, userId: 1 },
        { id: 2, userId: 1 },
      ])
      // Without a name an administrator still sees their own week, which is
      // what every existing client asks for.
      expect(
        await tracked.timeEntries(ada, {}).list({ afterId: null, throughId: 99, take: 10 }),
      ).toEqual([])
      expect((await tracked.getTimeEntry(ada, 1)).userId).toBe(1)

      const created = await tracked.createTimeEntry(
        ada,
        {
          userId: maya.userId,
          projectId: 1,
          taskId: 1,
          spentDate: '2026-08-26',
          seconds: 1800,
          notes: 'Logged by the administrator',
        },
        at('2026-08-31T12:01:00.000Z'),
      )
      // Maya's entry on Maya's assignment at Maya's rate, not Ada's.
      expect(created).toMatchObject({
        userId: 1,
        userAssignmentId: 1,
        billableRateCents: 9000,
        notes: 'Logged by the administrator',
      })
      const corrected = await tracked.updateTimeEntry(
        ada,
        1,
        { seconds: 5400, notes: 'Corrected' },
        at('2026-08-31T12:02:00.000Z'),
      )
      expect(corrected).toMatchObject({ userId: 1, seconds: 5400, notes: 'Corrected' })
      const stopped = await tracked.stopTimeEntry(ada, 2, at('2026-08-31T12:03:00.000Z'))
      expect(stopped).toMatchObject({ userId: 1, timerStartedAt: null, seconds: 3780 })
      const deleted = await tracked.deleteTimeEntry(ada, 1, at('2026-08-31T12:04:00.000Z'))
      expect(deleted.id).toBe(1)
      expect((await entryRows(db)).map(({ id, user_id }) => ({ id, user_id }))).toEqual([
        { id: 2, user_id: 1 },
        { id: created.id, user_id: 1 },
      ])

      const events = await onBehalfEvents(db)
      expect(
        events.map(
          ({ aggregate_id, aggregate_sequence, event_type, occurred_at, available_at }) => ({
            aggregate_id,
            aggregate_sequence,
            event_type,
            occurred_at,
            available_at,
          }),
        ),
      ).toEqual([
        {
          aggregate_id: created.id,
          aggregate_sequence: 1,
          event_type: 'time_entry.created_on_behalf',
          occurred_at: '2026-08-31T12:01:00.000Z',
          available_at: '2026-08-31T12:01:00.000Z',
        },
        {
          aggregate_id: 1,
          aggregate_sequence: 1,
          event_type: 'time_entry.updated_on_behalf',
          occurred_at: '2026-08-31T12:02:00.000Z',
          available_at: '2026-08-31T12:02:00.000Z',
        },
        {
          aggregate_id: 2,
          aggregate_sequence: 1,
          event_type: 'time_entry.stopped_on_behalf',
          occurred_at: '2026-08-31T12:03:00.000Z',
          available_at: '2026-08-31T12:03:00.000Z',
        },
        {
          aggregate_id: 1,
          aggregate_sequence: 2,
          event_type: 'time_entry.deleted_on_behalf',
          occurred_at: '2026-08-31T12:04:00.000Z',
          available_at: '2026-08-31T12:04:00.000Z',
        },
      ])
      const payloads = events.map((event) => JSON.parse(event.payload_json) as OnBehalfPayload)
      for (const [index, payload] of payloads.entries()) {
        // The actor is the administrator; the time stays Maya's.
        expect(payload).toMatchObject({
          schema_version: 1,
          event_id: events[index]!.id,
          event_type: events[index]!.event_type,
          occurred_at: events[index]!.occurred_at,
          aggregate: {
            type: 'time_entry',
            id: events[index]!.aggregate_id,
            sequence: events[index]!.aggregate_sequence,
          },
          actor: { type: 'user', id: 10 },
          time_entry: { user_id: 1 },
        })
        // No rates: reports readers see this log, and a cost rate is not theirs.
        expect(payload.time_entry.before ?? {}).not.toHaveProperty('billable_rate_cents')
        expect(payload.time_entry.after ?? {}).not.toHaveProperty('cost_rate_cents')
      }
      const [createdEvent, updatedEvent, stoppedEvent, deletedEvent] = payloads
      expect(createdEvent!.time_entry).toEqual({
        user_id: 1,
        before: null,
        after: {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-26',
          seconds: 1800,
          started_time: null,
          ended_time: null,
          timer_started_at: null,
          notes: 'Logged by the administrator',
          billable: true,
          budgeted: false,
          approval_status: 'unsubmitted',
          updated_at: '2026-08-31T12:01:00.000Z',
        },
      })
      expect(updatedEvent!.time_entry).toMatchObject({
        before: { seconds: 3600, notes: 'Initial work', updated_at: t0, billable: true },
        after: { seconds: 5400, notes: 'Corrected', updated_at: '2026-08-31T12:02:00.000Z' },
      })
      // Both halves have the same shape, so a reader can diff them field by field.
      expect(Object.keys(updatedEvent!.time_entry.after!)).toEqual(
        Object.keys(updatedEvent!.time_entry.before!),
      )
      expect(stoppedEvent!.time_entry).toMatchObject({
        before: { timer_started_at: '2026-08-31T11:00:00.000Z', seconds: 0 },
        after: { timer_started_at: null, seconds: 3780 },
      })
      expect(deletedEvent!.time_entry).toMatchObject({
        before: { seconds: 5400, notes: 'Corrected' },
        after: null,
      })

      // The activity log records them like any other event, under Ada's name.
      const outbox = db.outbox()
      await outbox.drain()
      expect(
        (await outbox.listActivity({ actorId: ada.userId }))
          .map(({ eventType }) => eventType)
          .sort(),
      ).toEqual([
        'time_entry.created_on_behalf',
        'time_entry.deleted_on_behalf',
        'time_entry.stopped_on_behalf',
        'time_entry.updated_on_behalf',
      ])
    }, 60_000)

    it("[db #917] does not record an administrator's changes to their own time", async () => {
      const { db, tracked } = await setup()
      const own = await tracked.createTimeEntry(
        ada,
        { projectId: 1, taskId: 1, spentDate: '2026-08-26', seconds: 900 },
        at('2026-08-31T12:01:00.000Z'),
      )
      // Naming yourself is the same as not naming anybody.
      const named = await tracked.createTimeEntry(
        ada,
        { userId: ada.userId, projectId: 1, taskId: 1, spentDate: '2026-08-27', seconds: 900 },
        at('2026-08-31T12:02:00.000Z'),
      )
      expect([own.userId, own.billableRateCents, named.userId]).toEqual([10, 15000, 10])
      await tracked.updateTimeEntry(ada, own.id, { notes: 'Mine' }, at('2026-08-31T12:03:00.000Z'))
      await tracked.deleteTimeEntry(ada, own.id, at('2026-08-31T12:04:00.000Z'))
      expect(await onBehalfEvents(db)).toEqual([])
    }, 60_000)

    it('[db #917] refuses to start or restart a timer for somebody else', async () => {
      const { db, tracked } = await setup()
      // The organization's mode cannot change under a running timer.
      await db.run(
        `UPDATE time_entries SET seconds = 600, seconds_without_timer = 600,
           rounded_seconds = 600, timer_started_at = NULL WHERE id = 2`,
      )
      const before = await entryRows(db)
      await expect(
        tracked.createTimeEntry(
          ada,
          { userId: maya.userId, projectId: 1, taskId: 1 },
          at('2026-08-31T12:01:00.000Z'),
        ),
      ).rejects.toMatchObject({ field: 'user_id', reasonCode: 'timer_owned' })
      await expect(
        tracked.restartTimeEntry(ada, 1, at('2026-08-31T12:02:00.000Z')),
      ).rejects.toMatchObject({ field: 'time_entry', reasonCode: 'timer_owned' })
      await db.run(`UPDATE organizations SET time_entry_mode = 'start_end' WHERE id = 1`)
      await expect(
        tracked.createTimeEntry(
          ada,
          { userId: maya.userId, projectId: 1, taskId: 1, startedTime: '12:03' },
          at('2026-08-31T12:03:00.000Z'),
        ),
      ).rejects.toMatchObject({ field: 'user_id', reasonCode: 'timer_owned' })
      // Stopped start/end time is still Ada's to log for Maya.
      const logged = await tracked.createTimeEntry(
        ada,
        {
          userId: maya.userId,
          projectId: 1,
          taskId: 1,
          spentDate: '2026-08-27',
          startedTime: '09:00',
          endedTime: '10:30',
        },
        at('2026-08-31T12:04:00.000Z'),
      )
      expect(logged).toMatchObject({ userId: 1, seconds: 5400, endedTime: '10:30' })
      expect((await entryRows(db)).filter(({ id }) => id !== logged.id)).toEqual(before)
      expect((await onBehalfEvents(db)).map(({ event_type }) => event_type)).toEqual([
        'time_entry.created_on_behalf',
      ])
    }, 60_000)

    it('[security #917] holds a timesheet lock and an invoice claim against an administrator as against the owner', async () => {
      const locked = new Set(['time_entry:1', 'tracked_date:2026-08-27'])
      const { db, tracked } = await setup(policy(locked))
      for (const actor of [ada, maya]) {
        await expect(
          tracked.updateTimeEntry(actor, 1, { notes: 'Locked' }, at('2026-08-31T12:01:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'policy_locked' })
        await expect(
          tracked.deleteTimeEntry(actor, 1, at('2026-08-31T12:02:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'policy_locked' })
        await expect(
          tracked.createTimeEntry(
            actor,
            { userId: maya.userId, projectId: 1, taskId: 1, spentDate: '2026-08-27', seconds: 600 },
            at('2026-08-31T12:03:00.000Z'),
          ),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'policy_locked' })
      }

      locked.clear()
      await db.run(
        `INSERT INTO invoices (
          id, client_id, number, currency, issue_date, due_date, created_at, updated_at
        ) VALUES (1, 1, 'FICT-1', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
        ...stamps(2),
      )
      await db.run(`UPDATE time_entries SET invoice_id = 1 WHERE id IN (1, 2)`)
      for (const actor of [ada, maya]) {
        await expect(
          tracked.updateTimeEntry(actor, 1, { notes: 'Claimed' }, at('2026-08-31T12:04:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'invoiced' })
        await expect(
          tracked.deleteTimeEntry(actor, 1, at('2026-08-31T12:05:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'invoiced' })
        await expect(
          tracked.stopTimeEntry(actor, 2, at('2026-08-31T12:06:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'invoiced' })
      }
      expect(
        (await entryRows(db)).map(({ id, notes, timer_started_at }) => ({
          id,
          notes,
          timer_started_at,
        })),
      ).toEqual([
        { id: 1, notes: 'Initial work', timer_started_at: null },
        { id: 2, notes: 'Running', timer_started_at: '2026-08-31T11:00:00.000Z' },
      ])
      expect(await onBehalfEvents(db)).toEqual([])
    }, 60_000)

    it('[security #917] holds approved and submitted weeks against an administrator as against the owner', async () => {
      const { db, tracked } = await setup()
      const approvals = createTimesheetApprovalRepository(db.orm)
      const submitted = await approvals.submit(
        1,
        '2026-08-24',
        '2026-08-30',
        '2026-08-31T12:01:00.000Z',
      )

      // A submitted week takes new time into the submission, for Ada as for Maya.
      const added = await tracked.createTimeEntry(
        ada,
        { userId: maya.userId, projectId: 1, taskId: 1, spentDate: '2026-08-26', seconds: 600 },
        at('2026-08-31T12:02:00.000Z'),
      )
      expect(added).toMatchObject({
        userId: 1,
        approvalStatus: 'submitted',
        timesheetSubmissionId: submitted.id,
      })

      await approvals.approve(
        { userId: ada.userId, profile: 'administrator' },
        submitted.id,
        '2026-08-31T12:03:00.000Z',
      )
      for (const actor of [ada, maya]) {
        await expect(
          tracked.updateTimeEntry(actor, 1, { notes: 'Approved' }, at('2026-08-31T12:04:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'approved' })
        await expect(
          tracked.deleteTimeEntry(actor, added.id, at('2026-08-31T12:05:00.000Z')),
        ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'approved' })
        await expect(
          tracked.createTimeEntry(
            actor,
            { userId: maya.userId, projectId: 1, taskId: 1, spentDate: '2026-08-27', seconds: 600 },
            at('2026-08-31T12:06:00.000Z'),
          ),
        ).rejects.toMatchObject({ field: 'spent_date', reasonCode: 'approved_period' })
      }
      // Only the one write that went through was recorded.
      expect(
        (await onBehalfEvents(db)).map(({ event_type, aggregate_id }) => ({
          event_type,
          aggregate_id,
        })),
      ).toEqual([{ event_type: 'time_entry.created_on_behalf', aggregate_id: added.id }])
    }, 60_000)

    it('[concurrency #917] records nothing when the write is refused after the entry was read', async () => {
      // Two races, each landing between the repository's read and its write:
      // an invoice claiming the entry, and somebody else saving it first.
      // Without the `changes() = 1` guard the audit statement would still run
      // in the same unit and record a correction that never happened.
      let race: string | null = null
      const resolver = policy(new Set(), async (subject) => {
        if (race === null || subject.entityType !== 'time_entry') return
        const statement = race
        race = null
        await database!.run(statement)
      })
      const { db, tracked } = await setup(resolver)
      await db.run(
        `INSERT INTO invoices (
          id, client_id, number, currency, issue_date, due_date, created_at, updated_at
        ) VALUES (1, 1, 'FICT-1', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
        ...stamps(2),
      )
      race = `UPDATE time_entries SET invoice_id = 1 WHERE id = 1`
      await expect(
        tracked.updateTimeEntry(ada, 1, { notes: 'Too late' }, at('2026-08-31T12:01:00.000Z')),
      ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'invoiced' })
      await db.run(`UPDATE time_entries SET invoice_id = NULL WHERE id = 1`)

      race = `UPDATE time_entries SET notes = 'Saved first', updated_at = '2026-08-31T12:01:30.000Z' WHERE id = 1`
      await expect(
        tracked.updateTimeEntry(ada, 1, { notes: 'Too late' }, at('2026-08-31T12:02:00.000Z')),
      ).rejects.toMatchObject({ code: 'version_conflict' })
      race = `UPDATE time_entries SET notes = 'Saved again', updated_at = '2026-08-31T12:02:30.000Z' WHERE id = 1`
      await expect(
        tracked.deleteTimeEntry(ada, 1, at('2026-08-31T12:03:00.000Z')),
      ).rejects.toMatchObject({ code: 'version_conflict' })

      expect((await entryRows(db))[0]).toMatchObject({ id: 1, notes: 'Saved again' })
      expect(await onBehalfEvents(db)).toEqual([])
    }, 60_000)
  })
}
