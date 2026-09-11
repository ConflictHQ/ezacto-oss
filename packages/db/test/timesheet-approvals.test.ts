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
const t4 = '2026-08-31T12:04:00.000Z'
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
    `INSERT INTO expense_categories (id, name, created_at, updated_at)
     VALUES (1, 'Travel', ?, ?)`,
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

const insertNativeExpense = async (
  db: TestDatabase,
  id: number,
  spentDate: string,
  totalCostCents: number,
  notes = 'Approval expense',
): Promise<void> => {
  await db.run(
    `INSERT INTO expenses (
      id, user_id, project_id, expense_category_id, spent_date, notes,
      total_cost_cents, billable, created_at, updated_at
    ) VALUES (?, 1, 1, 1, ?, ?, ?, 1, ?, ?)`,
    id,
    spentDate,
    notes,
    totalCostCents,
    t0,
    t0,
  )
}

/** Gives a further week something to submit, so a batch has more than one row. */
const insertWeekEntry = async (
  db: TestDatabase,
  id: number,
  userId: number,
  spentDate: string,
  userAssignmentId = 1,
): Promise<void> => {
  await db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
      billable, created_at, updated_at
    ) VALUES (?, ?, 1, 1, ?, 1, ?, 1800, 1800, 1800, 'Bulk work', 1, ?, ?)`,
    id,
    userId,
    userAssignmentId,
    spentDate,
    t0,
    t0,
  )
}

const insertSourceExpense = async (
  db: TestDatabase,
  id: number,
  harvestId: number,
  spentDate: string,
  sourceStatus: 'unsubmitted' | 'submitted' | 'approved',
): Promise<void> => {
  await db.run(
    `INSERT INTO expenses (
      id, harvest_id, user_id, project_id, expense_category_id, spent_date, notes,
      total_cost_cents, billable, approval_status, source_approval_status,
      created_at, updated_at
    ) VALUES (?, ?, 1, 1, 1, ?, 'Imported expense', 1000, 1,
      'unsubmitted', ?, ?, ?)`,
    id,
    harvestId,
    spentDate,
    sourceStatus,
    t0,
    t1,
  )
}

const insertSourceTimeEntry = async (
  db: TestDatabase,
  id: number,
  harvestId: string,
  spentDate: string,
  sourceStatus: 'unsubmitted' | 'submitted' | 'approved',
): Promise<void> => {
  await db.run(
    `INSERT INTO time_entries (
      id, harvest_id, user_id, project_id, task_id, user_assignment_id,
      task_assignment_id, spent_date, seconds, seconds_without_timer,
      rounded_seconds, notes, billable, approval_status, source_approval_status,
      created_at, updated_at
    ) VALUES (?, ?, 1, 1, 1, 1, 1, ?, 600, 600, 600, 'Imported time', 1,
      'unsubmitted', ?, ?, ?)`,
    id,
    harvestId,
    spentDate,
    sourceStatus,
    t0,
    t1,
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

    it('[db] tells a withdrawal from a rejection by the row, not by the reason', async () => {
      // The point of migration 0047. Both are unsubmitted weeks; before it,
      // both also carried a reviewer and a reason, and the only thing telling
      // them apart was whether the reason matched a fixed sentence. A reviewer
      // who typed that sentence was misread as a withdrawal, and an
      // administrator rejecting their own week was too, because the reviewer
      // was also the owner.
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)

      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const rejected = await approvals.reject(
        actor(2, 'administrator'),
        submitted.id,
        'Clarify the delivery detail.',
        t2,
      )
      expect(rejected).toMatchObject({
        status: 'unsubmitted',
        reviewedByUserId: 2,
        rejectionReason: 'Clarify the delivery detail.',
      })

      const resubmitted = await approvals.submit(1, periodStart, periodEnd, t3)
      const withdrawn = await approvals.unsubmit(actor(1, 'member'), resubmitted.id, t4)

      // Same status, opposite shape. No string is read to tell them apart.
      expect(withdrawn.status).toBe(rejected.status)
      expect(withdrawn.reviewedByUserId).toBeNull()
      expect(rejected.reviewedByUserId).not.toBeNull()
    })

    it('[db] lets a person take back their own week and edit it again', async () => {
      // Submitting used to be one-way until a reviewer acted. Someone who spotted
      // their own mistake had to ask for a rejection -- a reviewer's judgement --
      // to correct a typo they made themselves.
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)

      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      expect(submitted.status).toBe('submitted')

      const taken = await approvals.unsubmit(actor(1, 'member'), submitted.id, t2)
      expect(taken).toMatchObject({
        status: 'unsubmitted',
        userId: 1,
        // Nobody reviewed it, and the row now says so rather than naming the
        // owner as their own reviewer with a sentence standing in for a reason.
        // That is what separates a withdrawal from a rejection, and no free
        // text can collide with it.
        reviewedByUserId: null,
        reviewedAt: null,
        rejectionReason: null,
      })
      expect((await tracked.getTimeEntry(1, 1)).state).toMatchObject({
        approvalStatus: 'unsubmitted',
        isLocked: false,
      })
    })

    it('[security] refuses to unsubmit a week that is not yours', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)

      // Not found rather than forbidden: a 403 would confirm the submission
      // exists and tell the caller whose week it is.
      await expect(
        approvals.unsubmit(actor(2, 'member'), submitted.id, t2),
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(
        (await approvals.get(actor(10, 'administrator'), submitted.id))?.status,
      ).toBe('submitted')
    })

    it('[security] leaves an approved week to the administrator path', async () => {
      // An approved week has been acted on by someone else. Taking it back is
      // undoing their decision, which stays `withdraw` and stays privileged.
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      await approvals.approve(actor(10, 'administrator'), submitted.id, t2)

      await expect(
        approvals.unsubmit(actor(1, 'member'), submitted.id, t2),
      ).rejects.toMatchObject({ code: 'state_conflict' })
      expect(
        (await approvals.get(actor(10, 'administrator'), submitted.id))?.status,
      ).toBe('approved')
    })

    it('[db] submits, accepts editable pending work, approves atomically, and audits', async () => {
      database = await factory()
      await installFixture(database)
      await insertNativeExpense(database, 1, '2026-08-25', 1_250, 'Train fare')
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)

      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      expect(submitted).toMatchObject({
        userId: 1,
        status: 'submitted',
        entryCount: 1,
        expenseCount: 1,
        totalSeconds: 3600,
        rejectionReason: null,
      })
      expect((await tracked.getTimeEntry(1, 1)).state).toMatchObject({
        approvalStatus: 'submitted',
        isLocked: false,
      })
      expect(await tracked.getExpense({ userId: 1, profile: 'member', managerGrants: [] }, 1)).toMatchObject({
        notes: 'Train fare',
        reimbursementStatus: 'none',
        state: { approvalStatus: 'submitted', isLocked: false, invoiceId: null },
      })

      const addedExpense = await tracked.createExpense(
        1,
        {
          projectId: 1,
          expenseCategoryId: 1,
          spentDate: '2026-08-26',
          totalCostCents: 2_500,
          notes: 'Hotel while pending',
          reimbursable: true,
        },
        { instant: t2, date: '2026-08-26', time: '12:02' },
      )
      expect(addedExpense).toMatchObject({
        approvalStatus: 'submitted',
        timesheetSubmissionId: submitted.id,
        reimbursementStatus: 'none',
      })
      await tracked.updateExpense(
        1,
        addedExpense.id,
        { notes: 'Hotel receipt reviewed' },
        { instant: t3, date: '2026-08-26', time: '12:03' },
      )

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
      expect(approved).toMatchObject({
        status: 'approved',
        entryCount: 2,
        expenseCount: 2,
        totalSeconds: 6300,
      })
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
      expect(await tracked.getExpense({ userId: 1, profile: 'member', managerGrants: [] }, addedExpense.id)).toMatchObject({
        notes: 'Hotel receipt reviewed',
        reimbursable: true,
        reimbursementStatus: 'none',
        state: {
          approvalStatus: 'approved',
          isLocked: true,
          lockedReasonCode: 'approved',
          invoiceId: null,
        },
      })
      await expect(
        tracked.updateExpense(
          1,
          addedExpense.id,
          { spentDate: '2026-09-01' },
          { instant: t3, date: '2026-09-01', time: '12:03' },
        ),
      ).rejects.toMatchObject({ reasonCode: 'approved' })
      await expect(tracked.deleteExpense(1, addedExpense.id)).rejects.toMatchObject({
        reasonCode: 'approved',
      })
      await expect(
        tracked.createExpense(
          1,
          { projectId: 1, expenseCategoryId: 1, spentDate: '2026-08-27', totalCostCents: 0 },
          { instant: t3, date: '2026-08-27', time: '12:03' },
        ),
      ).rejects.toMatchObject({ reasonCode: 'approved_period' })
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
      await insertNativeExpense(database, 1, '2026-08-25', 3_300, 'Client lunch')
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
      expect((await tracked.getExpense({ userId: 1, profile: 'member', managerGrants: [] }, 1)).state).toMatchObject({
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
        expenseCount: 1,
      })
      expect((await tracked.getExpense({ userId: 1, profile: 'member', managerGrants: [] }, 1)).state.approvalStatus).toBe('submitted')
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

    it('[db] classifies an empty rejected period before resubmit without mutation', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const rejected = await approvals.reject(
        actor(10, 'administrator'),
        submitted.id,
        'Restore the missing work.',
        t2,
      )
      await tracked.deleteTimeEntry(1, 1)

      await expect(
        approvals.submit(1, periodStart, periodEnd, t3),
      ).rejects.toMatchObject({ code: 'empty_period' })
      expect(
        await database.rows<{
          status: string
          version: number
          rejection_reason: string | null
          events: number
        }>(
          `SELECT submission.status, submission.version, submission.rejection_reason,
            (SELECT count(*) FROM event_outbox event
             WHERE event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id) AS events
           FROM timesheet_submissions submission WHERE submission.id = ?`,
          submitted.id,
        ),
      ).toEqual([{
        status: 'unsubmitted',
        version: rejected.version,
        rejection_reason: 'Restore the missing work.',
        events: 2,
      }])
    })

    it('[db] classifies a running rejected period before resubmit without mutation', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const rejected = await approvals.reject(
        actor(10, 'administrator'),
        submitted.id,
        'Stop the timer first.',
        t2,
      )
      await tracked.restartTimeEntry(1, 1, {
        instant: t3,
        date: '2026-08-25',
        time: '12:03',
      })

      await expect(
        approvals.submit(1, periodStart, periodEnd, '2026-08-31T12:04:00.000Z'),
      ).rejects.toMatchObject({ code: 'running_entry' })
      expect(
        await database.rows<{
          status: string
          version: number
          rejection_reason: string | null
          events: number
          timer_started_at: string | null
        }>(
          `SELECT submission.status, submission.version, submission.rejection_reason,
            (SELECT count(*) FROM event_outbox event
             WHERE event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id) AS events,
            entry.timer_started_at
           FROM timesheet_submissions submission
           JOIN time_entries entry ON entry.user_id = submission.user_id
             AND entry.spent_date BETWEEN submission.period_start AND submission.period_end
           WHERE submission.id = ?`,
          submitted.id,
        ),
      ).toEqual([{
        status: 'unsubmitted',
        version: rejected.version,
        rejection_reason: 'Stop the timer first.',
        events: 2,
        timer_started_at: t3,
      }])
    })

    it('[db] submits and approves an expense-only period with exact reviewer detail', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(`DELETE FROM time_entries WHERE id = 1`)
      await insertNativeExpense(database, 1, '2026-08-25', 0, 'Zero-cost adjustment')
      const approvals = createTimesheetApprovalRepository(database.orm)

      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      expect(submitted).toMatchObject({
        status: 'submitted',
        entryCount: 0,
        expenseCount: 1,
        totalSeconds: 0,
      })
      await expect(approvals.get(actor(10, 'administrator'), submitted.id)).resolves.toMatchObject({
        entries: [],
        expenses: [{
          id: 1,
          spentDate: '2026-08-25',
          projectId: 1,
          projectName: 'Approval project',
          expenseCategoryId: 1,
          expenseCategoryName: 'Travel',
          totalCostCents: 0,
          currency: 'USD',
          notes: 'Zero-cost adjustment',
        }],
      })
      await expect(
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
      ).resolves.toMatchObject({ status: 'approved', expenseCount: 1 })
      expect(
        await database.rows<{
          approval_status: string
          timesheet_submission_id: number | null
        }>(`SELECT approval_status, timesheet_submission_id FROM expenses WHERE id = 1`),
      ).toEqual([{ approval_status: 'approved', timesheet_submission_id: submitted.id }])
    })

    it('[db] keeps submitted expense create, move, and delete edits in the current aggregate', async () => {
      database = await factory()
      await installFixture(database)
      await insertNativeExpense(database, 1, '2026-08-25', 1_000, 'Move me')
      await insertNativeExpense(database, 2, '2026-08-26', 2_000, 'Delete me')
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)

      const movedOut = await tracked.updateExpense(
        1,
        1,
        { spentDate: '2026-08-31' },
        { instant: t2, date: '2026-08-31', time: '12:02' },
      )
      expect(movedOut).toMatchObject({
        approvalStatus: 'unsubmitted',
        timesheetSubmissionId: null,
      })
      await expect(tracked.deleteExpense(1, 2)).resolves.toMatchObject({ id: 2 })

      const movedBack = await tracked.updateExpense(
        1,
        1,
        { spentDate: '2026-08-27', notes: 'Back in review' },
        { instant: t3, date: '2026-08-27', time: '12:03' },
      )
      expect(movedBack).toMatchObject({
        approvalStatus: 'submitted',
        timesheetSubmissionId: submitted.id,
      })
      await expect(approvals.get(actor(10, 'administrator'), submitted.id)).resolves.toMatchObject({
        expenseCount: 1,
        expenses: [{ id: 1, spentDate: '2026-08-27', notes: 'Back in review' }],
      })
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

    it('[migration] reconciles disabled same-source imports across both resources on enable', async () => {
      database = await factory()
      await installFixture(database, false)
      await insertSourceTimeEntry(database, 2, 'disabled-time-approved', '2026-08-18', 'approved')
      await insertSourceExpense(database, 1, 101, '2026-08-19', 'approved')
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('true')) WHERE id = 1`,
      )

      await insertSourceExpense(database, 2, 102, '2026-08-20', 'approved')
      const submissions = await database.rows<{
        id: number
        status: string
        origin: string
        event_count: number
      }>(
        `SELECT submission.id, submission.status, submission.origin,
          (SELECT count(*) FROM event_outbox event
           WHERE event.aggregate_type = 'timesheet_submission'
             AND event.aggregate_id = submission.id) AS event_count
         FROM timesheet_submissions submission`,
      )
      expect(submissions).toEqual([{
        id: expect.any(Number),
        status: 'approved',
        origin: 'harvest_import',
        event_count: 1,
      }])
      const submissionId = submissions[0]!.id
      expect(
        await database.rows<{ approval_status: string; timesheet_submission_id: number }>(
          `SELECT approval_status, timesheet_submission_id FROM time_entries WHERE id = 2
           UNION ALL
           SELECT approval_status, timesheet_submission_id FROM expenses WHERE id IN (1, 2)
           ORDER BY timesheet_submission_id`,
        ),
      ).toEqual([
        { approval_status: 'approved', timesheet_submission_id: submissionId },
        { approval_status: 'approved', timesheet_submission_id: submissionId },
        { approval_status: 'approved', timesheet_submission_id: submissionId },
      ])
    })

    it('[migration] preserves a withdrawn imported approval across later time and expense imports', async () => {
      database = await factory()
      await installFixture(database)
      await insertSourceTimeEntry(
        database,
        2,
        'withdrawn-source-time-initial',
        '2026-08-18',
        'approved',
      )
      const [imported] = await database.rows<{ id: number }>(
        `SELECT id FROM timesheet_submissions WHERE period_start = '2026-08-17'`,
      )
      const approvals = createTimesheetApprovalRepository(database.orm)
      await approvals.withdraw(
        actor(10, 'administrator'),
        imported!.id,
        'Source approval needs local correction.',
        t2,
      )

      await database.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
          billable, created_at, updated_at
        ) VALUES (20, 1, 1, 1, 1, 1, '2026-08-19', 60, 60, 60,
          'Local correction', 1, ?, ?)`,
        t2,
        t2,
      )
      await database.run(
        `INSERT INTO expenses (
          id, user_id, project_id, expense_category_id, spent_date, notes,
          total_cost_cents, billable, created_at, updated_at
        ) VALUES (20, 1, 1, 1, '2026-08-20', 'Local correction', 100, 1, ?, ?)`,
        t2,
        t2,
      )

      await expect(
        insertSourceExpense(database, 1, 101, '2026-08-19', 'approved'),
      ).resolves.toBeUndefined()
      await expect(
        insertSourceTimeEntry(
          database,
          5,
          'withdrawn-source-time-after-correction',
          '2026-08-20',
          'approved',
        ),
      ).resolves.toBeUndefined()
      expect(
        await database.rows<{ kind: string; approval_status: string }>(
          `SELECT 'time' AS kind, approval_status FROM time_entries WHERE id = 20
           UNION ALL SELECT 'expense', approval_status FROM expenses WHERE id = 20
           ORDER BY kind`,
        ),
      ).toEqual([
        { kind: 'expense', approval_status: 'unsubmitted' },
        { kind: 'time', approval_status: 'unsubmitted' },
      ])
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('false'))
         WHERE id = 1`,
      )
      await expect(
        insertSourceTimeEntry(
          database,
          3,
          'withdrawn-source-time-disabled',
          '2026-08-20',
          'approved',
        ),
      ).resolves.toBeUndefined()
      await expect(
        insertSourceExpense(database, 2, 102, '2026-08-21', 'approved'),
      ).resolves.toBeUndefined()
      expect(
        await database.rows<{ kind: string; timesheet_submission_id: number | null }>(
          `SELECT 'time' AS kind, timesheet_submission_id FROM time_entries WHERE id = 3
           UNION ALL SELECT 'expense', timesheet_submission_id FROM expenses WHERE id = 2
           ORDER BY kind`,
        ),
      ).toEqual([
        { kind: 'expense', timesheet_submission_id: null },
        { kind: 'time', timesheet_submission_id: null },
      ])

      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('true'))
         WHERE id = 1`,
      )
      await insertSourceTimeEntry(
        database,
        4,
        'withdrawn-source-time-enabled',
        '2026-08-22',
        'approved',
      )
      await insertSourceExpense(database, 3, 103, '2026-08-23', 'approved')

      expect(
        await database.rows<{
          status: string
          source_status: string
          rejection_reason: string
          events: number
        }>(
          `SELECT submission.status, submission.source_status, submission.rejection_reason,
            (SELECT count(*) FROM event_outbox event
             WHERE event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id) AS events
           FROM timesheet_submissions submission WHERE submission.id = ?`,
          imported!.id,
        ),
      ).toEqual([{
        status: 'unsubmitted',
        source_status: 'approved',
        rejection_reason: 'Source approval needs local correction.',
        events: 2,
      }])
      expect(
        await database.rows<{
          kind: string
          approval_status: string
          timesheet_submission_id: number
        }>(
          `SELECT 'time' AS kind, approval_status, timesheet_submission_id
           FROM time_entries WHERE id BETWEEN 2 AND 4
           UNION ALL
           SELECT 'expense', approval_status, timesheet_submission_id
           FROM expenses WHERE id BETWEEN 1 AND 3
           ORDER BY kind, timesheet_submission_id`,
        ),
      ).toEqual([
        ...Array.from({ length: 3 }, () => ({
          kind: 'expense',
          approval_status: 'unsubmitted',
          timesheet_submission_id: imported!.id,
        })),
        ...Array.from({ length: 3 }, () => ({
          kind: 'time',
          approval_status: 'unsubmitted',
          timesheet_submission_id: imported!.id,
        })),
      ])
    })

    it('[migration] rejects a disabled mixed-source week on the first enabled import atomically', async () => {
      database = await factory()
      await installFixture(database, false)
      await insertSourceTimeEntry(database, 2, 'disabled-time-approved', '2026-08-18', 'approved')
      await insertSourceExpense(database, 1, 101, '2026-08-19', 'submitted')
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('true')) WHERE id = 1`,
      )

      await expect(
        insertSourceExpense(database, 2, 102, '2026-08-20', 'unsubmitted'),
      ).rejects.toThrow(/source state is inconsistent/)
      expect(await database.rows(`SELECT id FROM expenses WHERE id = 2`)).toEqual([])
      expect(await database.rows(`SELECT id FROM timesheet_submissions`)).toEqual([])
      expect(
        await database.rows<{ approval_status: string; timesheet_submission_id: number | null }>(
          `SELECT approval_status, timesheet_submission_id FROM time_entries WHERE id = 2
           UNION ALL
           SELECT approval_status, timesheet_submission_id FROM expenses WHERE id = 1`,
        ),
      ).toEqual([
        { approval_status: 'unsubmitted', timesheet_submission_id: null },
        { approval_status: 'unsubmitted', timesheet_submission_id: null },
      ])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox
           WHERE aggregate_type = 'timesheet_submission'`,
        ),
      ).toEqual([{ count: 0 }])
    })

    it('[migration] rejects normalization of a disabled imported running peer atomically', async () => {
      database = await factory()
      await installFixture(database, false)
      await insertSourceTimeEntry(database, 2, 'disabled-running-approved', '2026-08-18', 'approved')
      await database.run(
        `UPDATE time_entries SET timer_started_at = ? WHERE id = 2`,
        t1,
      )
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('true')) WHERE id = 1`,
      )

      await expect(
        insertSourceExpense(database, 1, 101, '2026-08-19', 'approved'),
      ).rejects.toThrow(/running time entries cannot be submitted/)
      expect(await database.rows(`SELECT id FROM expenses WHERE id = 1`)).toEqual([])
      expect(await database.rows(`SELECT id FROM timesheet_submissions`)).toEqual([])
      expect(
        await database.rows<{
          approval_status: string
          timesheet_submission_id: number | null
          timer_started_at: string | null
        }>(
          `SELECT approval_status, timesheet_submission_id, timer_started_at
           FROM time_entries WHERE id = 2`,
        ),
      ).toEqual([{
        approval_status: 'unsubmitted',
        timesheet_submission_id: null,
        timer_started_at: t1,
      }])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox
           WHERE aggregate_type = 'timesheet_submission'`,
        ),
      ).toEqual([{ count: 0 }])
    })

    for (const sourceStatus of ['submitted', 'approved'] as const) {
      it(`[migration] preserves an imported ${sourceStatus} period lock while approval is hidden`, async () => {
        database = await factory()
        await installFixture(database)
        await insertSourceTimeEntry(
          database,
          2,
          `locked-source-time-${sourceStatus}`,
          '2026-08-18',
          sourceStatus,
        )
        const before = await database.rows<{
          id: number
          status: string
          events: number
        }>(
          `SELECT submission.id, submission.status,
            (SELECT count(*) FROM event_outbox event
             WHERE event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id) AS events
           FROM timesheet_submissions submission
           WHERE submission.period_start = '2026-08-17'`,
        )
        expect(before).toEqual([{ id: expect.any(Number), status: sourceStatus, events: 1 }])

        await database.run(
          `UPDATE organizations SET modules = json_set(modules, '$.approval', json('false')) WHERE id = 1`,
        )
        await expect(
          insertSourceExpense(database, 1, 101, '2026-08-19', sourceStatus),
        ).rejects.toThrow(/approved or pending timesheet period/)

        expect(await database.rows(`SELECT id FROM expenses WHERE id = 1`)).toEqual([])
        expect(
          await database.rows<{
            approval_status: string
            timesheet_submission_id: number
          }>(
            `SELECT approval_status, timesheet_submission_id
             FROM time_entries WHERE id = 2`,
          ),
        ).toEqual([{ approval_status: sourceStatus, timesheet_submission_id: before[0]!.id }])
        expect(
          await database.rows<{ id: number; status: string; events: number }>(
            `SELECT submission.id, submission.status,
              (SELECT count(*) FROM event_outbox event
               WHERE event.aggregate_type = 'timesheet_submission'
                 AND event.aggregate_id = submission.id) AS events
             FROM timesheet_submissions submission
             WHERE submission.period_start = '2026-08-17'`,
          ),
        ).toEqual(before)
      })
    }

    it('[migration] permits native and Harvest unsubmitted peers without inventing an aggregate', async () => {
      database = await factory()
      await installFixture(database)
      await expect(
        insertSourceExpense(database, 1, 101, '2026-08-26', 'unsubmitted'),
      ).resolves.toBeUndefined()
      expect(await database.rows(`SELECT id FROM timesheet_submissions`)).toEqual([])
      expect(
        await database.rows<{ approval_status: string; source_approval_status: string }>(
          `SELECT approval_status, source_approval_status FROM expenses WHERE id = 1`,
        ),
      ).toEqual([{ approval_status: 'unsubmitted', source_approval_status: 'unsubmitted' }])
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

    it('[concurrency] translates a stopped time create whose target is rejected after membership read', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const reached = deferred()
      const release = deferred()
      interface ReturningBuilder {
        returning(...fields: unknown[]): Promise<unknown[]>
      }
      interface InsertBuilder {
        select(selection: unknown): ReturningBuilder
      }
      const mutableOrm = database.orm as unknown as {
        insert(...args: unknown[]): InsertBuilder
      }
      const originalInsert = mutableOrm.insert
      mutableOrm.insert = function (...args: unknown[]): InsertBuilder {
        const builder = originalInsert.apply(this, args)
        const originalSelect = builder.select
        builder.select = function (selection: unknown): ReturningBuilder {
          const selected = originalSelect.call(this, selection)
          const originalReturning = selected.returning
          selected.returning = function (...fields: unknown[]): Promise<unknown[]> {
            const query = originalReturning.apply(this, fields)
            return (async () => {
              reached.resolve()
              await release.promise
              return query
            })()
          }
          return selected
        }
        return builder
      }
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const createOutcome = tracked.createTimeEntry(
        1,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-08-26',
          seconds: 300,
          notes: 'Target rejection race',
        },
        { instant: t2, date: '2026-08-26', time: '12:02' },
      ).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )

      try {
        await reached.promise
        await approvals.reject(actor(10, 'administrator'), submitted.id, 'Return first', t2)
        release.resolve()
        await expect(createOutcome).resolves.toMatchObject({
          status: 'rejected',
          reason: { name: 'TrackedResourceConflictError', code: 'version_conflict' },
        })
      } finally {
        release.resolve()
        mutableOrm.insert = originalInsert
      }
      expect(
        await database.rows(`SELECT id FROM time_entries WHERE notes = 'Target rejection race'`),
      ).toEqual([])
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

    it('[concurrency] serializes expense create and edit against approval', async () => {
      database = await factory()
      await installFixture(database)
      await insertNativeExpense(database, 1, '2026-08-25', 1_000, 'Before approval')
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const editOutcomes = await Promise.allSettled([
        tracked.updateExpense(
          1,
          1,
          { notes: 'Concurrent expense edit' },
          { instant: t2, date: '2026-08-25', time: '12:02' },
        ),
        tracked.createExpense(
          1,
          {
            projectId: 1,
            expenseCategoryId: 1,
            spentDate: '2026-08-26',
            totalCostCents: 2_000,
            notes: 'Concurrent expense create',
          },
          { instant: t2, date: '2026-08-26', time: '12:02' },
        ),
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
      ])
      expect(editOutcomes[2]).toMatchObject({ status: 'fulfilled' })
      const rows = await database.rows<{
        approval_status: string
        timesheet_submission_id: number | null
        notes: string | null
      }>(
        `SELECT approval_status, timesheet_submission_id, notes FROM expenses ORDER BY id`,
      )
      expect(rows.every((row) => row.approval_status === 'approved')).toBe(true)
      expect(rows.every((row) => row.timesheet_submission_id === submitted.id)).toBe(true)
      expect(['Before approval', 'Concurrent expense edit']).toContain(rows[0]?.notes)
      for (const outcome of editOutcomes.slice(0, 2)) {
        if (outcome?.status === 'rejected') {
          expect(outcome.reason).toMatchObject({ reasonCode: expect.stringMatching(/approved/) })
        }
      }
    })

    it('[concurrency] translates time and expense moves racing target rejection', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
          billable, created_at, updated_at
        ) VALUES (2, 1, 1, 1, 1, 1, '2026-09-01', 600, 600, 600,
          'Move time into review', 1, ?, ?)`,
        t0,
        t0,
      )
      await insertNativeExpense(database, 1, '2026-09-01', 500, 'Move expense into review')
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const reached = deferred()
      const release = deferred()
      let calls = 0
      const racingPolicy: TrackedPolicyResolver = {
        isLocked: async ({ entityType }) => {
          if (entityType === 'time_entry' || entityType === 'expense') {
            calls += 1
            if (calls === 2) reached.resolve()
            await release.promise
          }
          return false
        },
      }
      const tracked = new DrizzleTrackedResourceRepository(database.orm, racingPolicy)
      const moves = [
        tracked.updateTimeEntry(
          1,
          2,
          { spentDate: '2026-08-26' },
          { instant: t2, date: '2026-08-26', time: '12:02' },
        ),
        tracked.updateExpense(
          1,
          1,
          { spentDate: '2026-08-26' },
          { instant: t2, date: '2026-08-26', time: '12:02' },
        ),
      ].map((operation) => operation.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ))

      await reached.promise
      await approvals.reject(actor(10, 'administrator'), submitted.id, 'Return for edits', t2)
      release.resolve()
      const outcomes = await Promise.all(moves)
      expect(outcomes).toMatchObject([
        { status: 'rejected', reason: { name: 'TrackedResourceConflictError', code: 'version_conflict' } },
        { status: 'rejected', reason: { name: 'TrackedResourceConflictError', code: 'version_conflict' } },
      ])
      expect(
        await database.rows<{
          kind: string
          spent_date: string
          approval_status: string
          timesheet_submission_id: number | null
        }>(
          `SELECT 'time' AS kind, spent_date, approval_status, timesheet_submission_id
           FROM time_entries WHERE id = 2
           UNION ALL
           SELECT 'expense', spent_date, approval_status, timesheet_submission_id
           FROM expenses WHERE id = 1`,
        ),
      ).toEqual([
        { kind: 'time', spent_date: '2026-09-01', approval_status: 'unsubmitted', timesheet_submission_id: null },
        { kind: 'expense', spent_date: '2026-09-01', approval_status: 'unsubmitted', timesheet_submission_id: null },
      ])
    })

    it('[concurrency] translates time and expense moves racing target approval', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
          billable, created_at, updated_at
        ) VALUES (2, 1, 1, 1, 1, 1, '2026-09-01', 600, 600, 600,
          'Move time into review', 1, ?, ?)`,
        t0,
        t0,
      )
      await insertNativeExpense(database, 1, '2026-09-01', 500, 'Move expense into review')
      const approvals = createTimesheetApprovalRepository(database.orm)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const reached = deferred()
      const release = deferred()
      let calls = 0
      const racingPolicy: TrackedPolicyResolver = {
        isLocked: async ({ entityType }) => {
          if (entityType === 'time_entry' || entityType === 'expense') {
            calls += 1
            if (calls === 2) reached.resolve()
            await release.promise
          }
          return false
        },
      }
      const tracked = new DrizzleTrackedResourceRepository(database.orm, racingPolicy)
      const moves = [
        tracked.updateTimeEntry(
          1,
          2,
          { spentDate: '2026-08-26' },
          { instant: t2, date: '2026-08-26', time: '12:02' },
        ),
        tracked.updateExpense(
          1,
          1,
          { spentDate: '2026-08-26' },
          { instant: t2, date: '2026-08-26', time: '12:02' },
        ),
      ].map((operation) => operation.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ))

      await reached.promise
      await approvals.approve(actor(10, 'administrator'), submitted.id, t2)
      release.resolve()
      const outcomes = await Promise.all(moves)
      expect(outcomes).toMatchObject([
        { status: 'rejected', reason: { name: 'TrackedResourceInputError', reasonCode: 'approved_period' } },
        { status: 'rejected', reason: { name: 'TrackedResourceInputError', reasonCode: 'approved_period' } },
      ])
    })

    it('[db] preserves signed imported costs across non-price edits and then locks them', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO expenses (
          id, harvest_id, user_id, project_id, expense_category_id, spent_date, notes,
          total_cost_cents, billable, approval_status, source_approval_status,
          created_at, updated_at
        ) VALUES (1, 9001, 1, 1, 1, '2026-08-25', 'Imported adjustment',
          -125, 1, 'unsubmitted', 'unsubmitted', ?, ?)`,
        t0,
        t0,
      )
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      await expect(
        tracked.updateExpense(
          1,
          1,
          { notes: 'Imported adjustment clarified', billable: false },
          { instant: t2, date: '2026-08-25', time: '12:02' },
        ),
      ).resolves.toMatchObject({
        totalCostCents: -125,
        notes: 'Imported adjustment clarified',
        billable: false,
        approvalStatus: 'submitted',
      })
      await approvals.approve(actor(10, 'administrator'), submitted.id, t3)
      await expect(
        tracked.updateExpense(
          1,
          1,
          { notes: 'Too late' },
          { instant: '2026-08-31T12:04:00.000Z', date: '2026-08-25', time: '12:04' },
        ),
      ).rejects.toMatchObject({ reasonCode: 'approved' })
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

    it('[concurrency] never approves an expense-only period racing its final deletion', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(`DELETE FROM time_entries WHERE id = 1`)
      await insertNativeExpense(database, 1, '2026-08-25', 500, 'Final expense')
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)
      const outcomes = await Promise.allSettled([
        tracked.deleteExpense(1, 1),
        approvals.approve(actor(10, 'administrator'), submitted.id, t2),
      ])
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      const final = (
        await database.rows<{ status: string; expense_count: number }>(
          `SELECT submission.status,
            (SELECT count(*) FROM expenses expense
             WHERE expense.timesheet_submission_id = submission.id) AS expense_count
           FROM timesheet_submissions submission`,
        )
      )[0]
      expect(final).toEqual(
        outcomes[1]?.status === 'fulfilled'
          ? { status: 'approved', expense_count: 1 }
          : { status: 'submitted', expense_count: 0 },
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
      await insertNativeExpense(database, 1, '2026-08-25', -125, 'Private adjustment')
      await database.run(
        `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
         VALUES (2, 1, ?, ?)`,
        t0,
        t0,
      )
      const approvals = createTimesheetApprovalRepository(database.orm)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, unlocked)
      const submitted = await approvals.submit(1, periodStart, periodEnd, t1)

      await database.run(`UPDATE projects SET billing_currency = 'eur' WHERE id = 1`)

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
      expect(detail).toMatchObject({
        expenseCount: 1,
        expenses: [{ totalCostCents: -125, currency: 'EUR', notes: 'Private adjustment' }],
      })
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
        expect(managerRace[0].value.expenses[0]?.notes).toBe('Private adjustment')
      } else {
        expect(managerRace[0]?.reason).toMatchObject({ code: 'forbidden' })
      }
      await expect(approvals.get(actor(2, 'project_manager'), submitted.id)).rejects.toMatchObject({
        code: 'forbidden',
      })

      await database.run(`UPDATE projects SET billing_currency = 'invalid' WHERE id = 1`)
      await expect(approvals.get(actor(10, 'administrator'), submitted.id)).rejects.toThrow(
        'Timesheet submission expense currency is invalid.',
      )
    })

    it('[api] filters pending submissions by user_id', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
         VALUES (2, 1, 2, ?, ?)`,
        t0, t0,
      )
      await database.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
          billable, created_at, updated_at
        ) VALUES (2, 2, 1, 1, 2, 1, '2026-08-25', 1800, 1800, 1800,
          'Manager work', 1, ?, ?)`,
        t0, t0,
      )
      await database.run(
        `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
         VALUES (2, 1, ?, ?)`,
        t0, t0,
      )
      const approvals = createTimesheetApprovalRepository(database.orm)
      await approvals.submit(1, periodStart, periodEnd, t1)
      await approvals.submit(2, periodStart, periodEnd, t1)

      const all = approvals.pendingSubmissions(actor(10, 'administrator'), {})
      const allResults = await all.list({ afterId: null, throughId: (await all.highWatermark())!, take: 50 })
      expect(allResults).toHaveLength(2)

      const filtered = approvals.pendingSubmissions(actor(10, 'administrator'), { userId: 1 })
      const hwm = await filtered.highWatermark()
      const filteredResults = await filtered.list({ afterId: null, throughId: hwm!, take: 50 })
      expect(filteredResults).toHaveLength(1)
      expect(filteredResults[0]!.userId).toBe(1)
    })

    it('[api] filters pending submissions by client_id via time entry project', async () => {
      database = await factory()
      await installFixture(database)
      await database.run(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (2, 'Other client', 'EUR', ?, ?)`,
        t0, t0,
      )
      await database.run(
        `INSERT INTO projects (id, client_id, name, created_at, updated_at)
         VALUES (2, 2, 'Other project', ?, ?)`,
        t0, t0,
      )
      await database.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
         VALUES (3, 2, 1, ?, ?)`,
        t0, t0,
      )
      await database.run(
        `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
         VALUES (3, 2, 1, 1, ?, ?)`,
        t0, t0,
      )
      const approvals = createTimesheetApprovalRepository(database.orm)
      await approvals.submit(1, periodStart, periodEnd, t1)

      const matchClient1 = approvals.pendingSubmissions(actor(10, 'administrator'), { clientId: 1 })
      const hwm1 = await matchClient1.highWatermark()
      expect(hwm1).not.toBeNull()
      const results1 = await matchClient1.list({ afterId: null, throughId: hwm1!, take: 50 })
      expect(results1).toHaveLength(1)

      const matchClient2 = approvals.pendingSubmissions(actor(10, 'administrator'), { clientId: 2 })
      const hwm2 = await matchClient2.highWatermark()
      expect(hwm2).toBeNull()
    })

    it('[e2e] bounded hydration keeps query count stable with all filters', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      await approvals.submit(1, periodStart, periodEnd, t1)

      const source = approvals.pendingSubmissions(actor(10, 'administrator'), {
        userId: 1,
        clientId: 1,
        projectId: 1,
      })
      const hwm = await source.highWatermark()
      expect(hwm).not.toBeNull()
      const results = await source.list({ afterId: null, throughId: hwm!, take: 50 })
      expect(results).toHaveLength(1)
    })

    it('[unit] approves an explicit selection under one command identity', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const first = await approvals.submit(1, periodStart, periodEnd, t1)
      await insertWeekEntry(database, 21, 1, '2026-08-18')
      const second = await approvals.submit(1, '2026-08-17', '2026-08-23', t1)
      await insertWeekEntry(database, 22, 1, '2026-08-11')
      const third = await approvals.submit(1, '2026-08-10', '2026-08-16', t1)
      const identifiers = [first, second, third]
        .map((submission) => submission.id)
        .sort((left, right) => left - right)

      const approved = await approvals.bulkApprove(
        actor(10, 'administrator'),
        'bulk-approve-1',
        [first, second, third].map((submission) => ({
          submissionId: submission.id,
          expectedVersion: submission.version,
        })),
        t2,
      )
      expect(approved.map((submission) => submission.id)).toEqual(identifiers)
      expect(
        approved.map((submission) => ({
          status: submission.status,
          version: submission.version,
          reviewedByUserId: submission.reviewedByUserId,
          reviewedAt: submission.reviewedAt,
        })),
      ).toEqual(
        identifiers.map(() => ({
          status: 'approved',
          version: 1,
          reviewedByUserId: 10,
          reviewedAt: t2,
        })),
      )

      expect(
        await database.rows<{
          aggregate_id: number
          command_id: string
          event_index: number
          payload_command: string
          payload_actor: number
        }>(
          `SELECT aggregate_id, command_id, event_index,
             json_extract(payload_json, '$.command.id') AS payload_command,
             json_extract(payload_json, '$.actor.id') AS payload_actor
           FROM event_outbox WHERE event_type = 'timesheet.approved'
           ORDER BY aggregate_id`,
        ),
      ).toEqual(
        identifiers.map((id) => ({
          aggregate_id: id,
          command_id: 'bulk-approve-1',
          event_index: 0,
          payload_command: 'bulk-approve-1',
          payload_actor: 10,
        })),
      )
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM timesheet_bulk_approval_command_items
           WHERE command_id = 'bulk-approve-1'`,
        ),
      ).toEqual([{ count: 3 }])
      expect(
        await database.rows<{ approval_status: string }>(
          `SELECT DISTINCT approval_status FROM time_entries`,
        ),
      ).toEqual([{ approval_status: 'approved' }])

      const [event] = await database.rows<{ id: string }>(
        `SELECT id FROM event_outbox WHERE event_type = 'timesheet.approved' LIMIT 1`,
      )
      await expect(
        database.run(`UPDATE event_outbox SET payload_json = '{}' WHERE id = ?`, event!.id),
      ).rejects.toThrow(/immutable/)
    })

    it('[security] leaves every selection unchanged when one row is stale', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const first = await approvals.submit(1, periodStart, periodEnd, t1)
      await insertWeekEntry(database, 21, 1, '2026-08-18')
      const second = await approvals.submit(1, '2026-08-17', '2026-08-23', t1)
      await insertWeekEntry(database, 22, 1, '2026-08-11')
      const third = await approvals.submit(1, '2026-08-10', '2026-08-16', t1)

      await expect(
        approvals.bulkApprove(
          actor(10, 'administrator'),
          'bulk-approve-stale',
          [
            { submissionId: first.id, expectedVersion: first.version },
            { submissionId: second.id, expectedVersion: second.version + 1 },
            { submissionId: third.id, expectedVersion: third.version },
          ],
          t2,
        ),
      ).rejects.toMatchObject({ code: 'state_conflict', submissionIds: [second.id] })

      expect(
        await database.rows<{ id: number; status: string; version: number }>(
          `SELECT id, status, version FROM timesheet_submissions ORDER BY id`,
        ),
      ).toEqual(
        [first, second, third]
          .map((submission) => ({ id: submission.id, status: 'submitted', version: 0 }))
          .sort((left, right) => left.id - right.id),
      )
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE event_type = 'timesheet.approved'`,
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM timesheet_bulk_approval_commands`,
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await database.rows<{ approval_status: string }>(
          `SELECT DISTINCT approval_status FROM time_entries`,
        ),
      ).toEqual([{ approval_status: 'submitted' }])
    })

    it('[security] leaves every selection unchanged when one row is unreviewable', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      await database.run(
        `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
         VALUES (2, 1, ?, ?)`,
        t0,
        t0,
      )
      await database.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
         VALUES (2, 1, 4, ?, ?)`,
        t0,
        t0,
      )
      const mine = await approvals.submit(1, periodStart, periodEnd, t1)
      await insertWeekEntry(database, 23, 4, '2026-08-25', 2)
      const theirs = await approvals.submit(4, periodStart, periodEnd, t1)

      await expect(
        approvals.bulkApprove(
          actor(2, 'project_manager'),
          'bulk-approve-forbidden',
          [
            { submissionId: mine.id, expectedVersion: mine.version },
            { submissionId: theirs.id, expectedVersion: theirs.version },
          ],
          t2,
        ),
      ).rejects.toMatchObject({ code: 'forbidden', submissionIds: [theirs.id] })

      expect(
        await database.rows<{ id: number; status: string; version: number }>(
          `SELECT id, status, version FROM timesheet_submissions ORDER BY id`,
        ),
      ).toEqual(
        [mine, theirs]
          .map((submission) => ({ id: submission.id, status: 'submitted', version: 0 }))
          .sort((left, right) => left.id - right.id),
      )
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE event_type = 'timesheet.approved'`,
        ),
      ).toEqual([{ count: 0 }])
    })

    it('[concurrency] rolls the whole batch back when one period lost its work', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const first = await approvals.submit(1, periodStart, periodEnd, t1)
      await insertWeekEntry(database, 21, 1, '2026-08-18')
      const second = await approvals.submit(1, '2026-08-17', '2026-08-23', t1)
      // The item moved out from under the approver. The submission is still
      // submitted at the version they saw, so nothing but the approve guard
      // catches it, and that guard fires from inside the batch.
      await database.run(
        `UPDATE time_entries SET approval_status = 'unsubmitted', timesheet_submission_id = NULL
         WHERE id = 21`,
      )

      await expect(
        approvals.bulkApprove(
          actor(10, 'administrator'),
          'bulk-approve-moved',
          [
            { submissionId: first.id, expectedVersion: first.version },
            { submissionId: second.id, expectedVersion: second.version },
          ],
          t2,
        ),
      ).rejects.toMatchObject({ code: 'state_conflict' })

      expect(
        await database.rows<{ id: number; status: string; version: number }>(
          `SELECT id, status, version FROM timesheet_submissions ORDER BY id`,
        ),
      ).toEqual(
        [first, second]
          .map((submission) => ({ id: submission.id, status: 'submitted', version: 0 }))
          .sort((left, right) => left.id - right.id),
      )
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM event_outbox WHERE event_type = 'timesheet.approved'`,
        ),
      ).toEqual([{ count: 0 }])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM timesheet_bulk_approval_command_items`,
        ),
      ).toEqual([{ count: 0 }])
    })

    it('[api] refuses a command identity that has already approved work', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const first = await approvals.submit(1, periodStart, periodEnd, t1)
      await insertWeekEntry(database, 21, 1, '2026-08-18')
      const second = await approvals.submit(1, '2026-08-17', '2026-08-23', t1)

      await approvals.bulkApprove(
        actor(10, 'administrator'),
        'bulk-approve-replay',
        [{ submissionId: first.id, expectedVersion: first.version }],
        t2,
      )
      await expect(
        approvals.bulkApprove(
          actor(10, 'administrator'),
          'bulk-approve-replay',
          [{ submissionId: second.id, expectedVersion: second.version }],
          t3,
        ),
      ).rejects.toMatchObject({ code: 'state_conflict', submissionIds: [second.id] })
      expect(
        await database.rows<{ status: string; version: number }>(
          `SELECT status, version FROM timesheet_submissions WHERE id = ?`,
          second.id,
        ),
      ).toEqual([{ status: 'submitted', version: 0 }])
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
      await database.run(
        `INSERT INTO expenses (
          id, harvest_id, user_id, project_id, expense_category_id, spent_date,
          notes, total_cost_cents, billable, approval_status, created_at, updated_at
        ) VALUES
          (1, 501, 1, 1, 1, '2026-08-18', 'Historic approved expense', -250,
            1, 'approved', ?, ?),
          (2, 502, 1, 1, 1, '2026-08-04', 'Expense-only submission', 500,
            1, 'submitted', ?, ?)`,
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
             ((SELECT count(*) FROM time_entries entry
               WHERE entry.timesheet_submission_id = submission.id)
              + (SELECT count(*) FROM expenses expense
                 WHERE expense.timesheet_submission_id = submission.id)) AS linked,
             event.event_type
           FROM timesheet_submissions submission
           JOIN event_outbox event ON event.aggregate_type = 'timesheet_submission'
             AND event.aggregate_id = submission.id
           ORDER BY submission.period_start`,
        ),
      ).toEqual([
        {
          id: expect.any(Number),
          period_start: '2026-08-03',
          period_end: '2026-08-09',
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
          linked: 2,
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
      await database.run(
        `INSERT INTO expenses (
          id, harvest_id, user_id, project_id, expense_category_id, spent_date,
          notes, total_cost_cents, billable, approval_status, created_at, updated_at
        ) VALUES (1, 701, 1, 1, 1, '2026-08-25', 'Disabled expense source',
          100, 1, 'approved', ?, ?)`,
        t0,
        t1,
      )
      await database.migrateFinal()
      expect(
        await database.rows<{
          approval_status: string
          source_approval_status: string
          timesheet_submission_id: number | null
        }>(
          `SELECT approval_status, source_approval_status, timesheet_submission_id
           FROM time_entries WHERE id = 1
           UNION ALL
           SELECT approval_status, source_approval_status, timesheet_submission_id
           FROM expenses WHERE id = 1`,
        ),
      ).toEqual(Array.from({ length: 2 }, () => ({
        approval_status: 'unsubmitted',
        source_approval_status: 'approved',
        timesheet_submission_id: null,
      })))
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
        `INSERT INTO expenses (
          id, harvest_id, user_id, project_id, expense_category_id, spent_date,
          notes, total_cost_cents, billable, approval_status, created_at, updated_at
        ) VALUES (1, 601, 1, 1, 1, '2026-08-26',
          'Contradictory source', 600, 1, 'approved', ?, ?)`,
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
