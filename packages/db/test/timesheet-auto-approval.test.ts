import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  readTimesheetAutoApproval,
  runTimesheetAutoApproval,
  updateTimesheetAutoApproval,
} from '../src/timesheet-auto-approval.js'
import { createTimesheetApprovalRepository } from '../src/timesheet-approvals.js'

type Orm = ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>

interface TestDatabase {
  orm: Orm
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
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

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const t0 = '2026-08-01T00:00:00.000Z'
/** Three consecutive weeks Maya can submit, and the day she submits each. */
const weeks = [
  { start: '2026-08-03', end: '2026-08-09', entryDate: '2026-08-04' },
  { start: '2026-08-10', end: '2026-08-16', entryDate: '2026-08-11' },
  { start: '2026-08-17', end: '2026-08-23', entryDate: '2026-08-18' },
] as const
const admin = { userId: 10, profile: 'administrator' } as const
const submittedAt = '2026-08-24T09:00:00.000Z'
const addMs = (instant: string, ms: number): string =>
  new Date(Date.parse(instant) + ms).toISOString()
const day = 86_400_000

const install = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Auto approval org', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (10, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
            (11, 'Zed', 'Admin', 'administrator', '[]', ?, ?),
            (1, 'Maya', 'Member', 'member', '[]', ?, ?)`,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Project', ?, ?)`,
    t0,
    t0,
  )
  await db.run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Task', ?, ?)`, t0, t0)
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  for (const [index, week] of weeks.entries()) {
    await db.run(
      `INSERT INTO time_entries (
        id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
        spent_date, seconds, seconds_without_timer, rounded_seconds, notes,
        billable, created_at, updated_at
      ) VALUES (?, 1, 1, 1, 1, 1, ?, 3600, 3600, 3600, 'Work', 1, ?, ?)`,
      index + 1,
      week.entryDate,
      t0,
      t0,
    )
  }
}

const submit = (db: TestDatabase, weekIndex: number, at: string) =>
  createTimesheetApprovalRepository(db.orm).submit(
    1,
    weeks[weekIndex]!.start,
    weeks[weekIndex]!.end,
    at,
  )

const status = async (db: TestDatabase, id: number) =>
  (
    await db.rows<{ status: string; reviewed_by_user_id: number | null }>(
      `SELECT status, reviewed_by_user_id FROM timesheet_submissions WHERE id = ?`,
      id,
    )
  )[0]!

/** Turns the policy on at `at` with the given window, as the administrator. */
const enable = (db: TestDatabase, windowDays: number, at: string) =>
  updateTimesheetAutoApproval(db.orm, 10, { enabled: true, windowDays }, at)

for (const [runtime, factory] of factories) {
  describe(`timesheet auto approval (${runtime})`, () => {
    let database: TestDatabase | undefined
    afterEach(async () => database?.close())

    it('[db #1009] is off by default and approves nothing until an administrator enables it', async () => {
      database = await factory()
      await install(database)
      expect(await readTimesheetAutoApproval(database.orm)).toEqual({
        enabled: false,
        windowDays: null,
        effectiveFrom: null,
        actorUserId: null,
        approvalModuleEnabled: true,
      })
      await submit(database, 0, submittedAt)
      const run = await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 400 * day))
      expect(run).toEqual({ approved: [], skipped: 0, failed: [] })
      expect((await status(database, 1)).status).toBe('submitted')
    })

    it('[db #1009] needs a window to be enabled, and the database refuses an incomplete policy', async () => {
      database = await factory()
      await install(database)
      await expect(
        updateTimesheetAutoApproval(database.orm, 10, { enabled: true }, submittedAt),
      ).rejects.toThrow('choose a window')
      await expect(
        updateTimesheetAutoApproval(database.orm, 10, { windowDays: 0 }, submittedAt),
      ).rejects.toThrow('window_days')
      await expect(
        database.run(`UPDATE organizations SET auto_approval_enabled = 1 WHERE id = 1`),
      ).rejects.toThrow('automatic approval needs a window')
    })

    it('[db #1009] stamps effective_from on enabling, keeps it while running, and restamps after being off', async () => {
      database = await factory()
      await install(database)
      const on = await enable(database, 3, submittedAt)
      expect(on).toMatchObject({ enabled: true, windowDays: 3, effectiveFrom: submittedAt, actorUserId: 10 })
      const later = addMs(submittedAt, day)
      expect(
        await updateTimesheetAutoApproval(database.orm, 10, { windowDays: 5 }, later),
      ).toMatchObject({ enabled: true, windowDays: 5, effectiveFrom: submittedAt })
      const off = await updateTimesheetAutoApproval(database.orm, 10, { enabled: false }, later)
      expect(off).toMatchObject({ enabled: false, windowDays: 5, effectiveFrom: null, actorUserId: null })
      const again = addMs(submittedAt, 2 * day)
      expect(
        await updateTimesheetAutoApproval(database.orm, 10, { enabled: true }, again),
      ).toMatchObject({ enabled: true, windowDays: 5, effectiveFrom: again })
    })

    it('[db #1009] approves exactly at the deadline, not a millisecond before, through the approval path', async () => {
      database = await factory()
      await install(database)
      await enable(database, 3, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      const deadline = addMs(submittedAt, 3 * day)

      expect(await runTimesheetAutoApproval(database.orm, addMs(deadline, -1))).toEqual({
        approved: [],
        skipped: 0,
        failed: [],
      })
      const run = await runTimesheetAutoApproval(database.orm, deadline)
      expect(run).toEqual({ approved: [1], skipped: 0, failed: [] })

      // The existing approval path locks the week and entries. Its internal FK
      // retains the policy authority; the immutable receipt and event identify
      // the system as actor, and the public reviewer is not that administrator.
      expect(await status(database, 1)).toEqual({ status: 'approved', reviewed_by_user_id: 10 })
      expect(
        (await database.rows<{ approval_status: string }>(`SELECT approval_status FROM time_entries WHERE id = 1`))[0]
          ?.approval_status,
      ).toBe('approved')
      const events = await database.rows<{ payload_json: string }>(
        `SELECT payload_json FROM event_outbox WHERE event_type = 'timesheet.approved'`,
      )
      expect(events).toHaveLength(1)
      expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
        actor: { type: 'system' },
        aggregate: { type: 'timesheet_submission', id: 1 },
        timesheet_submission: { automatic_approval: {actor:'system',window_days:3,authorized_by_user_id:10,submitted_at:submittedAt} },
      })

      const reviewed = await createTimesheetApprovalRepository(database.orm).get(admin,1)
      expect(reviewed.reviewedByUserId).toBeNull()
      expect(reviewed.automaticApproval).toMatchObject({actor:'system',authorized_by_user_id:10,window_days:3,submitted_at:submittedAt,approved_at:deadline})
      await expect(database.run('UPDATE timesheet_automatic_approval_receipts SET window_days=4')).rejects.toThrow(/immutable/u)

      // Nothing left to do, and nothing is approved twice.
      expect(await runTimesheetAutoApproval(database.orm, addMs(deadline, day))).toEqual({
        approved: [],
        skipped: 0,
        failed: [],
      })
    })

    it('[db #1009] rejects a policy disabled after the final read inside the atomic command', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      const original = database.orm.all.bind(database.orm)
      const instrumented = Object.create(database.orm) as Orm
      let reads = 0
      instrumented.all = (async (...args: Parameters<typeof original>) => {
        const rows = await original(...args)
        if (++reads === 3) await database!.run('UPDATE organizations SET auto_approval_enabled=0 WHERE id=1')
        return rows
      }) as typeof database.orm.all
      expect(await runTimesheetAutoApproval(instrumented, addMs(submittedAt, 2 * day))).toMatchObject({approved:[],skipped:1,failed:[]})
      expect((await status(database,1)).status).toBe('submitted')
      expect(await database.rows('SELECT command_id FROM timesheet_automatic_approval_receipts')).toEqual([])
      expect(await database.rows('SELECT command_id FROM timesheet_bulk_approval_commands')).toEqual([])
    })

    it('[db #1009] never sweeps a week submitted before the policy took effect', async () => {
      database = await factory()
      await install(database)
      await submit(database, 0, submittedAt)
      await enable(database, 1, addMs(submittedAt, 1))
      await submit(database, 1, addMs(submittedAt, 2))
      const run = await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 30 * day))
      expect(run.approved).toEqual([2])
      expect((await status(database, 1)).status).toBe('submitted')
    })

    it('[db #1009] restarts the clock when a rejected week is submitted again', async () => {
      database = await factory()
      await install(database)
      await enable(database, 3, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      const approvals = createTimesheetApprovalRepository(database.orm)
      await approvals.reject(admin, 1, 'Wrong project', addMs(submittedAt, day))
      const resubmitted = addMs(submittedAt, 2 * day)
      await submit(database, 0, resubmitted)

      // Three days after the first submission is not three days after this one.
      expect((await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 3 * day))).approved).toEqual([])
      expect((await runTimesheetAutoApproval(database.orm, addMs(resubmitted, 3 * day))).approved).toEqual([1])
    })

    it('[db #1009] leaves a rejected or withdrawn week alone', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      await createTimesheetApprovalRepository(database.orm).reject(admin, 1, 'No', addMs(submittedAt, 1))
      const run = await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 30 * day))
      expect(run.approved).toEqual([])
      expect((await status(database, 1)).status).toBe('unsubmitted')
    })

    it('[db #1009] skips an archived submitter and an approver who is no longer an administrator', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      const due = addMs(submittedAt, 2 * day)

      await database.run(`UPDATE users SET is_active = 0 WHERE id = 1`)
      expect((await runTimesheetAutoApproval(database.orm, due)).approved).toEqual([])
      await database.run(`UPDATE users SET is_active = 1 WHERE id = 1`)

      // The organization keeps its owner as administrator, so the approver who
      // loses the role is a second administrator.
      await updateTimesheetAutoApproval(database.orm, 11, { windowDays: 1 }, due)
      await database.run(`UPDATE users SET profile = 'member' WHERE id = 11`)
      expect(await runTimesheetAutoApproval(database.orm, due)).toMatchObject({
        approved: [],
        stopped: 'approver_unavailable',
      })
      expect((await status(database, 1)).status).toBe('submitted')
    })

    it('[db #1009] does nothing while the approval module is off', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      await database.run(`UPDATE organizations SET modules = '{"approval":false}' WHERE id = 1`)
      expect(await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 2 * day))).toMatchObject({
        approved: [],
        stopped: 'module_disabled',
      })
    })

    it('[db #1009] approves in bounded batches, oldest first', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      await submit(database, 1, addMs(submittedAt, 1000))
      await submit(database, 2, addMs(submittedAt, 2000))
      const due = addMs(submittedAt, 5 * day)
      expect((await runTimesheetAutoApproval(database.orm, due, { batchSize: 2 })).approved).toEqual([1, 2])
      expect((await runTimesheetAutoApproval(database.orm, due, { batchSize: 2 })).approved).toEqual([3])
    })

    it('[db #1009] approves once when two runs overlap', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      await submit(database, 1, addMs(submittedAt, 1000))
      const due = addMs(submittedAt, 5 * day)
      const runs = await Promise.all([
        runTimesheetAutoApproval(database.orm, due),
        runTimesheetAutoApproval(database.orm, due),
      ])
      const approved = runs.flatMap((run) => run.approved).sort()
      expect(approved).toEqual([1, 2])
      expect(runs.flatMap((run) => run.failed)).toEqual([])
      const receipts = await database.rows<{ n: number }>(
        `SELECT count(*) AS n FROM event_outbox WHERE event_type = 'timesheet.approved'`,
      )
      expect(receipts[0]!.n).toBe(2)
    })

    it('[db #1009] stops part way when the policy is switched off during a run', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      await submit(database, 1, addMs(submittedAt, 1000))
      // An administrator disables the policy the moment the first week is approved.
      await database.run(
        `CREATE TRIGGER test_disable_after_first AFTER UPDATE ON timesheet_submissions
         WHEN NEW.status = 'approved'
         BEGIN
           UPDATE organizations SET auto_approval_enabled = 0, auto_approval_effective_from = NULL,
             auto_approval_actor_user_id = NULL WHERE id = 1;
         END`,
      )
      const run = await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 5 * day))
      expect(run).toMatchObject({ approved: [1], stopped: 'disabled' })
      expect((await status(database, 2)).status).toBe('submitted')
    })

    it('[db #1009] a manual decision that lands mid-run makes the sweep a no-op for that week', async () => {
      database = await factory()
      await install(database)
      await enable(database, 1, addMs(submittedAt, -day))
      await submit(database, 0, submittedAt)
      await submit(database, 1, addMs(submittedAt, 1000))
      // A reviewer rejects week two after the sweep has listed it as due but
      // before the sweep reaches it: the version moves, so the stale write finds
      // nothing to approve.
      await database.run(
        `CREATE TRIGGER test_reject_second AFTER UPDATE ON timesheet_submissions
         WHEN NEW.id = 1 AND NEW.status = 'approved'
         BEGIN
           UPDATE timesheet_submissions SET status = 'unsubmitted', reviewed_by_user_id = 10,
             reviewed_at = NEW.updated_at, rejection_reason = 'Late catch',
             version = version + 1, updated_at = NEW.updated_at
           WHERE id = 2;
         END`,
      )
      const run = await runTimesheetAutoApproval(database.orm, addMs(submittedAt, 5 * day))
      expect(run).toEqual({ approved: [1], skipped: 1, failed: [] })
      expect((await status(database, 2)).status).toBe('unsubmitted')
    })
  })
}
