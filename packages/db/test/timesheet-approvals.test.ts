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
import { createStoppedTimeEntry, startTimeEntry } from '../src/time-entries.js'
import {
  createTimesheetApprovalRepository,
  TimesheetApprovalError,
  type TimesheetApprovalActor,
} from '../src/timesheet-approvals.js'
import {
  DrizzleTrackedResourceRepository,
  type TrackedPolicyResolver,
} from '../src/tracked-resource-repository.js'

type ApprovalDatabase = ConstructorParameters<typeof DrizzleTrackedResourceRepository>[0]

interface TestDatabase {
  orm: ApprovalDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

interface UpgradeTestDatabase extends TestDatabase {
  migrateFinal(): Promise<void>
}

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
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
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<Row>()).results,
    close: async () => miniflare.dispose(),
  }
}

const upgradeContainerDatabase = async (): Promise<UpgradeTestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainerThrough(sqlite, '0026_invoice_generation')
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
    migrateFinal: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const upgradeD1Database = async (): Promise<UpgradeTestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1Through(d1, '0026_invoice_generation')
  return {
    orm: createD1Database(d1),
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<Row>()).results,
    migrateFinal: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const upgradeFactories = [
  ['container', upgradeContainerDatabase],
  ['D1', upgradeD1Database],
] as const

const t0 = '2026-08-31T12:00:00.000Z'
const t1 = '2026-08-31T12:01:00.000Z'
const t2 = '2026-08-31T12:02:00.000Z'
const t3 = '2026-08-31T12:03:00.000Z'
const periodStart = '2026-08-24'
const periodEnd = '2026-08-30'

const unlocked: TrackedPolicyResolver = { isLocked: async () => false }

const deferred = (): { promise: Promise<void>; resolve(): void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const installFixture = async (db: TestDatabase, approval = true): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Approval org', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval }),
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
      (4, 'Pia', 'People', 'people_admin', '[]', ?, ?),
      (5, 'Alex', 'Accounting', 'accounting', '[]', ?, ?)`,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Approval client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at)
     VALUES (1, 1, 'Approval project', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Approval task', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO user_assignments
      (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO task_assignments
      (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
      billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, 1, 1, '2026-08-25', 3600, 3600, 3600,
      'Initial work', 1, ?, ?)`,
    t0,
    t0,
  )
}

const actor = (
  userId: number,
  profile: TimesheetApprovalActor['profile'],
): TimesheetApprovalActor => ({ userId, profile })

for (const [runtime, factory] of factories) {
  describe(`timesheet approvals (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[db] submits, accepts editable pending work, approves atomically, and audits', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)

      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      expect(submitted).toMatchObject({
        userId: 1,
        status: 'submitted',
        entryCount: 1,
        totalSeconds: 3600,
        rejectionReason: null,
      })
      expect((await tracked.getTimeEntry(1, 1)).state).toMatchObject({
        approvalStatus: 'submitted',
        isLocked: false,
      })

      const added = await tracked.createTimeEntry(
        1,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-08-26',
          seconds: 1800,
          notes: 'Added while pending',
        },
        { instant: t2, date: '2026-08-26', time: '12:02' },
      )
      expect(added.state.approvalStatus).toBe('submitted')
      expect(added.timesheetSubmissionId).toBe(submitted.id)
      const edited = await tracked.updateTimeEntry(
        1,
        added.id,
        { seconds: 2700, notes: 'Editable while pending' },
        { instant: t3, date: '2026-08-26', time: '12:03' },
      )
      expect(edited.state).toMatchObject({ approvalStatus: 'submitted', isLocked: false })

      const approved = await approvals.approve(actor(10, 'administrator'), submitted.id, t3)
      expect(approved).toMatchObject({ status: 'approved', entryCount: 2, totalSeconds: 6300 })
      await expect(tracked.updateTimeEntry(1, 1, { notes: 'too late' }, {
        instant: '2026-08-31T12:04:00.000Z',
        date: '2026-08-25',
        time: '12:04',
      })).rejects.toMatchObject({ reasonCode: 'approved' })
      expect((await tracked.getTimeEntry(1, 1)).state).toMatchObject({
        approvalStatus: 'approved',
        isLocked: true,
        lockedReasonCode: 'approved',
        lockedReason: 'Approved',
      })
      await expect(
        tracked.createTimeEntry(
          1,
          { projectId: 1, taskId: 1, spentDate: '2026-08-27', seconds: 60 },
          { instant: '2026-08-31T12:04:00.000Z', date: '2026-08-27', time: '12:04' },
        ),
      ).rejects.toMatchObject({ reasonCode: 'approved_period' })

      expect(
        await database.rows<{ event_type: string; aggregate_sequence: number }>(
          `SELECT event_type, aggregate_sequence FROM event_outbox
           WHERE aggregate_type = 'timesheet_submission' ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { event_type: 'timesheet.submitted', aggregate_sequence: 1 },
        { event_type: 'timesheet.approved', aggregate_sequence: 2 },
      ])
    })

    it('[db] rejects with a durable visible reason, then clears it on resubmit', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)

      const rejected = await approvals.reject(
        actor(3, 'executive_manager'),
        submitted.id,
        'Please describe the client outcome.',
        t2,
      )
      expect(rejected).toMatchObject({
        status: 'unsubmitted',
        rejectionReason: 'Please describe the client outcome.',
        reviewedByUserId: 3,
      })
      expect((await tracked.getTimeEntry(1, 1)).state).toMatchObject({
        approvalStatus: 'unsubmitted',
        isLocked: false,
      })
      await tracked.updateTimeEntry(1, 1, { notes: 'Client outcome added.' }, {
        instant: t3,
        date: '2026-08-25',
        time: '12:03',
      })
      const resubmitted = await approvals.submit(1, periodStart, periodEnd, t3)
      expect(resubmitted).toMatchObject({
        id: submitted.id,
        status: 'submitted',
        rejectionReason: null,
        reviewedByUserId: null,
        version: 2,
      })
      expect(
        await database.rows<{ event_type: string; reason: string | null }>(
          `SELECT event_type,
            json_extract(payload_json, '$.timesheet_submission.rejection_reason') AS reason
           FROM event_outbox WHERE aggregate_type = 'timesheet_submission'
           ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { event_type: 'timesheet.submitted', reason: null },
        { event_type: 'timesheet.rejected', reason: 'Please describe the client outcome.' },
        { event_type: 'timesheet.submitted', reason: null },
      ])
    })

    it('[security] limits project managers to explicit teammates and denies other profiles', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)

      await expect(approvals.get(actor(1, 'member'), submitted.id)).resolves.toMatchObject({
        id: submitted.id,
        entries: [
          {
            id: 1,
            spentDate: '2026-08-25',
            projectId: 1,
            projectName: 'Approval project',
            taskId: 1,
            taskName: 'Approval task',
            seconds: 3600,
            notes: 'Initial work',
          },
        ],
      })
      await expect(
        approvals.get(actor(10, 'administrator'), submitted.id),
      ).resolves.toMatchObject({ id: submitted.id })

      await expect(
        approvals.approve(actor(2, 'project_manager'), submitted.id, t2),
      ).rejects.toMatchObject({ code: 'forbidden' })
      await expect(
        approvals.get(actor(2, 'project_manager'), submitted.id),
      ).rejects.toMatchObject({ code: 'forbidden' })
      for (const denied of [
        actor(1, 'member'),
        actor(4, 'people_admin'),
        actor(5, 'accounting'),
      ]) {
        await expect(approvals.approve(denied, submitted.id, t2)).rejects.toMatchObject({
          code: 'forbidden',
        })
      }
      await database.run(
        `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
         VALUES (2, 1, ?, ?)`,
        t0,
        t0,
      )
      const queue = approvals.pendingSubmissions(actor(2, 'project_manager'), {})
      expect(await queue.highWatermark()).toBe(submitted.id)
      expect(await queue.list({ afterId: null, throughId: submitted.id, take: 2 })).toHaveLength(1)
      await expect(
        approvals.get(actor(2, 'project_manager'), submitted.id),
      ).resolves.toMatchObject({ id: submitted.id, entries: [{ id: 1 }] })
      await expect(approvals.approve(actor(2, 'project_manager'), submitted.id, t2)).resolves.toMatchObject({
        status: 'approved',
      })
    })

    it('[db] fails closed when the module is disabled and leaves the axis untouched', async () => {
      database = await factory()
      await installFixture(database, false)
      const approvals = createTimesheetApprovalRepository(database.orm)
      await expect(approvals.assertEnabled()).rejects.toEqual(
        new TimesheetApprovalError('module_disabled', 'Timesheet approvals are not enabled.'),
      )
      await expect(approvals.submit(1, periodStart, periodEnd, t1)).rejects.toMatchObject({
        code: 'module_disabled',
      })
      expect(
        await database.rows<{ approval_status: string; timesheet_submission_id: number | null }>(
          `SELECT approval_status, timesheet_submission_id FROM time_entries WHERE id = 1`,
        ),
      ).toEqual([{ approval_status: 'unsubmitted', timesheet_submission_id: null }])
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM timesheet_submissions`),
      ).toEqual([{ count: 0 }])
    })

    it('[concurrency] permits exactly one approve/reject winner', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const outcomes = await Promise.allSettled([
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
        approvals.reject(actor(3, 'executive_manager'), submitted.id, 'Needs correction.', t2),
      ])
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      const rows = await database.rows<{ count: number }>(
        `SELECT count(*) AS count FROM event_outbox
         WHERE aggregate_type = 'timesheet_submission'`,
      )
      expect(rows).toEqual([{ count: 2 }])
    })

    it('[concurrency] permits exactly one first submit winner', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const outcomes = await Promise.allSettled([
        approvals.submit(1, periodStart, periodEnd, t1),
        approvals.submit(1, periodStart, periodEnd, t1),
      ])
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(
        await database.rows<{ status: string; events: number }>(
          `SELECT submission.status,
            (SELECT count(*) FROM event_outbox event
             WHERE event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id) AS events
           FROM timesheet_submissions submission`,
        ),
      ).toEqual([{ status: 'submitted', events: 1 }])
    })

    it('[concurrency] serializes an editable pending entry against approval', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const outcomes = await Promise.allSettled([
        tracked.updateTimeEntry(
          1,
          1,
          { notes: 'A concurrent pending edit.' },
          { instant: t2, date: '2026-08-25', time: '12:02' },
        ),
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
      ])
      expect(outcomes[1]).toMatchObject({ status: 'fulfilled' })
      const entry = await tracked.getTimeEntry(1, 1)
      expect(entry.state).toMatchObject({ approvalStatus: 'approved', isLocked: true })
      expect(['Initial work', 'A concurrent pending edit.']).toContain(entry.notes)
      if (outcomes[0]?.status === 'rejected') {
        expect(outcomes[0].reason).toMatchObject({ reasonCode: 'approved' })
      }
    })

    it('[concurrency] either includes or rejects a new entry racing approval', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const outcomes = await Promise.allSettled([
        tracked.createTimeEntry(
          1,
          {
            projectId: 1,
            taskId: 1,
            spentDate: '2026-08-26',
            seconds: 300,
            notes: 'Racing approval.',
          },
          { instant: t2, date: '2026-08-26', time: '12:02' },
        ),
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
      ])
      expect(outcomes[1]).toMatchObject({ status: 'fulfilled' })
      expect(
        await database.rows<{ approval_status: string; timesheet_submission_id: number }>(
          `SELECT approval_status, timesheet_submission_id FROM time_entries ORDER BY id`,
        ),
      ).toEqual(
        outcomes[0]?.status === 'fulfilled'
          ? [
              { approval_status: 'approved', timesheet_submission_id: submitted.id },
              { approval_status: 'approved', timesheet_submission_id: submitted.id },
            ]
          : [{ approval_status: 'approved', timesheet_submission_id: submitted.id }],
      )
    })

    it('[concurrency] never approves an empty period racing its final deletion', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const outcomes = await Promise.allSettled([
        tracked.deleteTimeEntry(1, 1),
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
      ])
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      const final = (
        await database.rows<{ status: string; entry_count: number }>(
          `SELECT submission.status,
            (SELECT count(*) FROM time_entries entry
             WHERE entry.timesheet_submission_id = submission.id) AS entry_count
           FROM timesheet_submissions submission`,
        )
      )[0]
      expect(final).toEqual(
        outcomes[1]?.status === 'fulfilled'
          ? { status: 'approved', entry_count: 1 }
          : { status: 'submitted', entry_count: 0 },
      )
    })

    it('[concurrency] translates a submit that wins after restart preflight', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const policyReached = deferred()
      const releasePolicy = deferred()
      const racingPolicy: TrackedPolicyResolver = {
        isLocked: async () => {
          policyReached.resolve()
          await releasePolicy.promise
          return false
        },
      }
      const tracked = new DrizzleTrackedResourceRepository(database.orm, racingPolicy)
      const restartOutcome = tracked
        .restartTimeEntry(1, 1, {
          instant: t2,
          date: '2026-08-25',
          time: '12:02',
        })
        .then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        )

      await policyReached.promise
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      releasePolicy.resolve()
      const restart = await restartOutcome

      expect(submitted.status).toBe('submitted')
      expect(restart).toMatchObject({
        status: 'rejected',
        reason: {
          name: 'TrackedResourceInputError',
          reasonCode: 'submitted_period_running',
        },
      })
      expect(
        await database.rows<{
          submission_status: string
          approval_status: string
          timesheet_submission_id: number | null
          timer_started_at: string | null
          started_time: string | null
          ended_time: string | null
        }>(
          `SELECT submission.status AS submission_status, entry.approval_status,
             entry.timesheet_submission_id, entry.timer_started_at,
             entry.started_time, entry.ended_time
           FROM timesheet_submissions submission
           JOIN time_entries entry ON entry.timesheet_submission_id = submission.id
           WHERE submission.id = ?`,
          submitted.id,
        ),
      ).toEqual([
        {
          submission_status: 'submitted',
          approval_status: 'submitted',
          timesheet_submission_id: submitted.id,
          timer_started_at: null,
          started_time: null,
          ended_time: null,
        },
      ])
    })

    it('[db] normalizes fresh Harvest helper writes and preserves positional insert shape', async () => {
      database = await factory()
      await installFixture(database)
      const stopped = await createStoppedTimeEntry(database.orm, {
        harvestId: 'harvest-approved',
        userId: 1,
        projectId: 1,
        taskId: 1,
        userAssignmentId: 1,
        taskAssignmentId: 1,
        spentDate: '2026-08-18',
        seconds: 900,
        notes: 'Imported approved detail',
        approvalStatus: 'approved',
        createdAt: t0,
        updatedAt: t1,
      })
      expect(stopped).toMatchObject({
        approvalStatus: 'approved',
        sourceApprovalStatus: 'approved',
      })
      expect(stopped.timesheetSubmissionId).not.toBeNull()

      const running = await startTimeEntry(
        database.orm,
        {
          harvestId: 'harvest-running',
          userId: 1,
          projectId: 1,
          taskId: 1,
          userAssignmentId: 1,
          taskAssignmentId: 1,
          notes: 'Imported current timer',
        },
        { instant: t2, date: '2026-08-31', time: '12:02' },
        false,
      )
      expect(running).toMatchObject({
        approvalStatus: 'unsubmitted',
        sourceApprovalStatus: 'unsubmitted',
        timesheetSubmissionId: null,
      })
      expect(
        await database.rows<{ origin: string; source_status: string; event_type: string }>(
          `SELECT submission.origin, submission.source_status, event.event_type
           FROM timesheet_submissions submission
           JOIN event_outbox event ON event.aggregate_type = 'timesheet_submission'
             AND event.aggregate_id = submission.id
           WHERE submission.id = ?`,
          stopped.timesheetSubmissionId,
        ),
      ).toEqual([
        {
          origin: 'harvest_import',
          source_status: 'approved',
          event_type: 'timesheet.status_imported',
        },
      ])
    })

    it('[concurrency] returns one authorized detail snapshot and discloses nothing after revocation', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
         VALUES (2, 1, ?, ?)`,
        t0,
        t0,
      )
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)

      const [detail, edit] = await Promise.all([
        approvals.get(actor(10, 'administrator'), submitted.id),
        tracked.updateTimeEntry(
          1,
          1,
          { seconds: 5400, notes: 'Concurrent complete detail' },
          { instant: t2, date: '2026-08-25', time: '12:02' },
        ),
      ])
      expect(detail.totalSeconds).toBe(detail.entries.reduce((sum, entry) => sum + entry.seconds, 0))
      expect(['Initial work', 'Concurrent complete detail']).toContain(detail.entries[0]?.notes)
      expect(edit.notes).toBe('Concurrent complete detail')

      const reviewRace = await Promise.allSettled([
        approvals.get(actor(10, 'administrator'), submitted.id),
        approvals.approve(actor(10, 'administrator'), submitted.id, t3),
      ])
      expect(reviewRace.every((result) => result.status === 'fulfilled')).toBe(true)
      if (reviewRace[0]?.status === 'fulfilled') {
        expect(['submitted', 'approved']).toContain(reviewRace[0].value.status)
        expect(reviewRace[0].value.totalSeconds).toBe(
          reviewRace[0].value.entries.reduce((sum, entry) => sum + entry.seconds, 0),
        )
      }

      const managerRace = await Promise.allSettled([
        approvals.get(actor(2, 'project_manager'), submitted.id),
        database.run(`DELETE FROM teammate_assignments WHERE manager_id = 2 AND user_id = 1`),
      ])
      if (managerRace[0]?.status === 'fulfilled') {
        expect(managerRace[0].value.entries[0]?.notes).toBe('Concurrent complete detail')
      } else {
        expect(managerRace[0]?.reason).toMatchObject({ code: 'forbidden' })
      }
      await expect(approvals.get(actor(2, 'project_manager'), submitted.id)).rejects.toMatchObject({
        code: 'forbidden',
      })
    })
  })
}

for (const [runtime, factory] of upgradeFactories) {
  describe(`timesheet approval legacy upgrade (${runtime})`, () => {
    let database: UpgradeTestDatabase | undefined

    afterEach(async () => database?.close())

    it('[migration] backfills truthful Harvest weeks and supports native review transitions', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `UPDATE time_entries SET harvest_id = 'source-submitted-a', approval_status = 'submitted'
         WHERE id = 1`,
      )
      await database.run(
        `INSERT INTO time_entries (
          id, harvest_id, user_id, project_id, task_id, user_assignment_id,
          task_assignment_id, spent_date, seconds, seconds_without_timer,
          rounded_seconds, notes, billable, approval_status, created_at, updated_at
        ) VALUES
          (2, 'source-approved', 1, 1, 1, 1, 1, '2026-08-18',
            1800, 1800, 1800, 'Historic approval', 1, 'approved', ?, ?),
          (3, 'source-submitted-b', 1, 1, 1, 1, 1, '2026-08-11',
            1200, 1200, 1200, 'Historic submission', 1, 'submitted', ?, ?)`,
        t0,
        t1,
        t0,
        t1,
      )

      await database.migrateFinal()
      expect(
        await database.rows<{
          id: number
          period_start: string
          period_end: string
          status: string
          origin: string
          source_status: string
          source_observed_at: string
          submitted_by_user_id: number | null
          submitted_at: string | null
          reviewed_by_user_id: number | null
          reviewed_at: string | null
          linked: number
          event_type: string
        }>(
          `SELECT submission.id, submission.period_start, submission.period_end,
             submission.status, submission.origin, submission.source_status,
             submission.source_observed_at, submission.submitted_by_user_id,
             submission.submitted_at, submission.reviewed_by_user_id,
             submission.reviewed_at,
             (SELECT count(*) FROM time_entries entry
              WHERE entry.timesheet_submission_id = submission.id) AS linked,
             event.event_type
           FROM timesheet_submissions submission
           JOIN event_outbox event ON event.aggregate_type = 'timesheet_submission'
             AND event.aggregate_id = submission.id
           ORDER BY submission.period_start`,
        ),
      ).toEqual([
        {
          id: expect.any(Number),
          period_start: '2026-08-10',
          period_end: '2026-08-16',
          status: 'submitted',
          origin: 'legacy_backfill',
          source_status: 'submitted',
          source_observed_at: t1,
          submitted_by_user_id: null,
          submitted_at: null,
          reviewed_by_user_id: null,
          reviewed_at: null,
          linked: 1,
          event_type: 'timesheet.status_imported',
        },
        {
          id: expect.any(Number),
          period_start: '2026-08-17',
          period_end: '2026-08-23',
          status: 'approved',
          origin: 'legacy_backfill',
          source_status: 'approved',
          source_observed_at: t1,
          submitted_by_user_id: null,
          submitted_at: null,
          reviewed_by_user_id: null,
          reviewed_at: null,
          linked: 1,
          event_type: 'timesheet.status_imported',
        },
        {
          id: expect.any(Number),
          period_start: '2026-08-24',
          period_end: '2026-08-30',
          status: 'submitted',
          origin: 'legacy_backfill',
          source_status: 'submitted',
          source_observed_at: t0,
          submitted_by_user_id: null,
          submitted_at: null,
          reviewed_by_user_id: null,
          reviewed_at: null,
          linked: 1,
          event_type: 'timesheet.status_imported',
        },
      ])

      const approvals = createTimesheetApprovalRepository(database.orm)
      const rows = await database.rows<{ id: number; period_start: string }>(
        `SELECT id, period_start FROM timesheet_submissions`,
      )
      const byStart = new Map(rows.map((row) => [row.period_start, row.id]))
      const directApproval = await approvals.approve(
        actor(10, 'administrator'),
        byStart.get('2026-08-24')!,
        t2,
      )
      expect(directApproval).toMatchObject({
        status: 'approved',
        submittedByUserId: null,
        submittedAt: null,
        reviewedByUserId: 10,
      })

      const retryId = byStart.get('2026-08-10')!
      await approvals.reject(actor(10, 'administrator'), retryId, 'Add context', t2)
      const resubmitted = await approvals.submit(1, '2026-08-10', '2026-08-16', t3)
      expect(resubmitted).toMatchObject({
        status: 'submitted',
        submittedByUserId: 1,
        submittedAt: t3,
        origin: 'legacy_backfill',
        sourceStatus: 'submitted',
      })
      await expect(
        approvals.approve(
          actor(10, 'administrator'),
          retryId,
          '2026-08-31T12:04:00.000Z',
        ),
      ).resolves.toMatchObject({ status: 'approved', reviewedByUserId: 10 })
    })

    it('[migration] keeps approval disabled and fails atomically on mixed enabled weeks', async () => {
      database = await factory()
      await installFixture(database, false)
      await database.run(
        `UPDATE time_entries SET harvest_id = 'disabled-source', approval_status = 'approved'
         WHERE id = 1`,
      )
      await database.migrateFinal()
      expect(
        await database.rows<{
          approval_status: string
          source_approval_status: string
          timesheet_submission_id: number | null
        }>(
          `SELECT approval_status, source_approval_status, timesheet_submission_id
           FROM time_entries WHERE id = 1`,
        ),
      ).toEqual([
        {
          approval_status: 'unsubmitted',
          source_approval_status: 'approved',
          timesheet_submission_id: null,
        },
      ])
      expect(await database.rows(`SELECT * FROM timesheet_submissions`)).toEqual([])
    })

    it('[migration] rejects a mixed enabled Harvest week before any 0027 DDL lands', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `UPDATE time_entries SET harvest_id = 'mixed-submitted', approval_status = 'submitted'
         WHERE id = 1`,
      )
      await database.run(
        `INSERT INTO time_entries (
          id, harvest_id, user_id, project_id, task_id, user_assignment_id,
          task_assignment_id, spent_date, seconds, seconds_without_timer,
          rounded_seconds, notes, billable, approval_status, created_at, updated_at
        ) VALUES (2, 'mixed-approved', 1, 1, 1, 1, 1, '2026-08-26',
          600, 600, 600, 'Contradictory source', 1, 'approved', ?, ?)`,
        t0,
        t1,
      )

      await expect(database.migrateFinal()).rejects.toThrow(
        'timesheet approval migration preflight failed: code=mixed_source_week',
      )
      expect(
        await database.rows(`SELECT id FROM _ezacto_migrations
          WHERE id = '0027_timesheet_approvals'`),
      ).toEqual([])
      expect(
        await database.rows(`SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'timesheet_submissions'`),
      ).toEqual([])
    })
  })
}
