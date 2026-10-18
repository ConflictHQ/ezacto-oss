import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { readInvoiceJournal } from '../src/invoice-documents.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'
import { createReportRepository } from '../src/reports.js'
import { createTimesheetApprovalRepository } from '../src/timesheet-approvals.js'
import {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TimeEntryActor,
} from '../src/tracked-resource-repository.js'

/**
 * Issue 943: a duration organization holds start/end entries beside its
 * durations. The calendar records an interval in either mode; everything else
 * in a duration organization goes on writing durations, and its timer stays a
 * duration timer.
 *
 * Every case runs against a real migrated database on both runtimes, because
 * the rule that decides it is a trigger, and only a real schema enforces one.
 */

type Mode = 'duration' | 'start_end'
/** What the adapters hand back: every store below takes it, the journal reader included. */
type AdapterDatabase =
  ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>

interface TestDatabase {
  orm: AdapterDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  /** Applies every migration still pending. */
  migrate(): Promise<void>
  close(): Promise<void>
}

/** The migration before this one: a database as it stood when 0100 shipped. */
const before0100 = '0099_invoice_sending'

const containerDatabase = async (upToDate: boolean): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  if (upToDate) migrateContainer(sqlite)
  else migrateContainerThrough(sqlite, before0100)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
    migrate: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (upToDate: boolean): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (upToDate) await migrateD1(d1)
  else await migrateD1Through(d1, before0100)
  return {
    orm: createD1Database(d1),
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
    migrate: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const t0 = '2026-09-01T08:00:00.000Z'
const stamps = (count: number): string[] => Array.from({ length: count }, () => t0)

/** An organization on UTC, so a boundary's date and time are its instant's. */
const at = (instant: string) => ({
  instant,
  date: instant.slice(0, 10),
  time: instant.slice(11, 16),
})

const ada: TimeEntryActor = { userId: 1, profile: 'administrator' }
const maya: TimeEntryActor = { userId: 2, profile: 'member' }

const policyKey = (subject: Readonly<PolicySubject>): string =>
  subject.entityType === 'running_time_entry_replacement'
    ? `running:${subject.userId}`
    : subject.entityType === 'tracked_date'
      ? `tracked_date:${subject.spentDate}`
      : `${subject.entityType}:${subject.entityId}`

/**
 * Maya (2) logs time on one project with two tasks; Ada (1) administers.
 * Rounding is up to the quarter hour so a derived duration is visibly rounded.
 */
const installFixture = async (db: TestDatabase, mode: Mode): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, time_entry_mode, time_rounding_mode, time_rounding_minutes, modules, created_at, updated_at)
     VALUES ('Fictional Studio', ?, 'up', 15, ?, ?, ?)`,
    mode,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
            (2, 'Maya', 'Member', 'member', '[]', ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Fictional Client', 'USD', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
     VALUES (1, 1, 'Fictional Project', 'FP', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Design', ?, ?), (2, 'Review', ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 2, ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?), (2, 1, 2, 1, ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES (1, 1, 'FICTIONAL-1', 'USD', '2026-09-30', '2026-10-30', ?, ?)`,
    ...stamps(2),
  )
}

/** A time entry written straight to the table, past every repository rule. */
const insertRow = (
  db: TestDatabase,
  row: {
    id: number
    spentDate?: string
    taskId?: 1 | 2
    seconds: number
    timerStartedAt?: string | null
    startedTime?: string | null
    endedTime?: string | null
  },
): Promise<void> =>
  db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds,
      timer_started_at, started_time, ended_time, billable, created_at, updated_at
    ) VALUES (?, 2, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    row.id,
    row.taskId ?? 1,
    row.taskId ?? 1,
    row.spentDate ?? '2026-09-14',
    row.seconds,
    row.seconds,
    row.seconds,
    row.timerStartedAt ?? null,
    row.startedTime ?? null,
    row.endedTime ?? null,
    ...stamps(2),
  )

const shapeRefusal = /time entry shape does not match organization mode/

for (const [runtime, factory] of factories) {
  describe(`start/end entries in a duration organization (${runtime})`, () => {
    let database: TestDatabase | undefined
    const locks = new Set<string>()

    afterEach(async () => {
      await database?.close()
      database = undefined
      locks.clear()
    })

    const setup = async (mode: Mode, upToDate = true) => {
      database = await factory(upToDate)
      await installFixture(database, mode)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, {
        isLocked: async (subject) => locks.has(policyKey(subject)),
      })
      return { db: database, tracked }
    }

    it('[unit] 0100 upgrades a duration organization without touching a row', async () => {
      const { db } = await setup('duration', false)
      // What a duration organization already holds: an hour, a correction
      // offsetting half of it, and a timer that is running across the upgrade.
      await insertRow(db, { id: 1, seconds: 3_600 })
      await insertRow(db, { id: 2, seconds: -1_800 })
      await insertRow(db, {
        id: 3,
        spentDate: '2026-09-15',
        taskId: 2,
        seconds: 600,
        timerStartedAt: '2026-09-15T09:00:00.000Z',
      })
      await expect(
        insertRow(db, { id: 10, seconds: 1_800, startedTime: '09:00', endedTime: '09:30' }),
      ).rejects.toThrow(shapeRefusal)

      const triggers = async () =>
        Object.fromEntries(
          (
            await db.rows<{ name: string; sql: string }>(
              `SELECT name, sql FROM sqlite_master
               WHERE type = 'trigger'
                 AND name IN ('time_entries_mode_insert', 'time_entries_mode_update')`,
            )
          ).map(({ name, sql }) => [name, sql]),
        )
      const rowsBefore = await db.rows(`SELECT * FROM time_entries ORDER BY id`)
      const triggersBefore = await triggers()

      await db.migrate()

      expect(
        await db.rows(`SELECT id FROM _ezacto_migrations WHERE id = '0100_duration_timed_entries'`),
      ).toEqual([{ id: '0100_duration_timed_entries' }])
      // Not a row moved, the running timer included.
      expect(await db.rows(`SELECT * FROM time_entries ORDER BY id`)).toEqual(rowsBefore)
      const triggersAfter = await triggers()
      // The update rule is the one 0002 wrote, untouched.
      expect(triggersAfter['time_entries_mode_update']).toBe(
        triggersBefore['time_entries_mode_update'],
      )
      // The insert rule changed, and its start_end clause is 0002's to the
      // character: a start/end organization is held to exactly what it was.
      const startEndClause = (sql: string): string =>
        sql.slice(sql.indexOf(`= 'start_end'`), sql.indexOf('BEGIN'))
      expect(triggersAfter['time_entries_mode_insert']).not.toBe(
        triggersBefore['time_entries_mode_insert'],
      )
      expect(startEndClause(triggersAfter['time_entries_mode_insert']!)).toBe(
        startEndClause(triggersBefore['time_entries_mode_insert']!),
      )
      expect(startEndClause(triggersAfter['time_entries_mode_insert']!)).toContain(
        'NEW.timer_started_at IS NOT NULL OR NEW.started_time IS NULL',
      )

      // A stopped interval is admitted on the same day as the durations...
      await insertRow(db, { id: 10, seconds: 1_800, startedTime: '09:00', endedTime: '09:30' })
      // ...and a running one is not: a timer here is a duration timer.
      await expect(
        insertRow(db, { id: 11, spentDate: '2026-09-16', seconds: 0, startedTime: '09:00' }),
      ).rejects.toThrow()
      expect(
        await db.rows(
          `SELECT id, seconds, timer_started_at, started_time, ended_time
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, seconds: 3_600, timer_started_at: null, started_time: null, ended_time: null },
        { id: 2, seconds: -1_800, timer_started_at: null, started_time: null, ended_time: null },
        {
          id: 3,
          seconds: 600,
          timer_started_at: '2026-09-15T09:00:00.000Z',
          started_time: null,
          ended_time: null,
        },
        {
          id: 10,
          seconds: 1_800,
          timer_started_at: null,
          started_time: '09:00',
          ended_time: '09:30',
        },
      ])
      // Re-running the ledger is a no-op.
      await db.migrate()
      expect(await db.rows(`SELECT count(*) AS count FROM time_entries`)).toEqual([{ count: 4 }])
    }, 30_000)

    it('[unit] logs a stopped start/end entry in a duration organization, seconds derived and rounded', async () => {
      const { db, tracked } = await setup('duration')
      const seven = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-09-14',
          startedTime: '09:00',
          endedTime: '09:07',
        },
        at('2026-09-14T12:00:00.000Z'),
      )
      expect(seven).toMatchObject({
        userId: 2,
        spentDate: '2026-09-14',
        startedTime: '09:00',
        endedTime: '09:07',
        timerStartedAt: null,
        seconds: 420,
        secondsWithoutTimer: 420,
        // up_15, as every entry in this organization is rounded.
        roundedSeconds: 900,
        approvalStatus: 'unsubmitted',
      })
      // An end before the start is past midnight, as in a start/end organization.
      const overnight = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 2,
          spentDate: '2026-09-14',
          startedTime: '23:30',
          endedTime: '00:30',
        },
        at('2026-09-15T01:00:00.000Z'),
      )
      expect(overnight).toMatchObject({ seconds: 3_600, roundedSeconds: 3_600 })
      // An administrator may log one for a teammate, and the audit says so.
      const onBehalf = await tracked.createTimeEntry(
        ada,
        {
          userId: 2,
          projectId: 1,
          taskId: 1,
          spentDate: '2026-09-15',
          startedTime: '14:00',
          endedTime: '15:00',
        },
        at('2026-09-15T16:00:00.000Z'),
      )
      expect(onBehalf).toMatchObject({ userId: 2, startedTime: '14:00', seconds: 3_600 })
      expect(
        await db.rows(
          `SELECT event_type, aggregate_id FROM event_outbox
           WHERE aggregate_type = 'time_entry' ORDER BY rowid`,
        ),
      ).toEqual([{ event_type: 'time_entry.created_on_behalf', aggregate_id: onBehalf.id }])
      // The duration path is as it was.
      const duration = await tracked.createTimeEntry(
        maya,
        { projectId: 1, taskId: 1, spentDate: '2026-09-14', seconds: 1_000 },
        at('2026-09-14T12:00:00.000Z'),
      )
      expect(duration).toMatchObject({
        startedTime: null,
        endedTime: null,
        seconds: 1_000,
        roundedSeconds: 1_800,
      })
    }, 30_000)

    it('[unit] refuses the shapes a duration organization cannot hold and writes nothing', async () => {
      const { db, tracked } = await setup('duration')
      const create = (input: Record<string, unknown>) =>
        tracked.createTimeEntry(
          maya,
          { projectId: 1, taskId: 1, ...input },
          at('2026-09-14T12:00:00.000Z'),
        )
      // Seconds and times together: which is the entry? Neither is guessed.
      await expect(
        create({ spentDate: '2026-09-14', seconds: 600, startedTime: '09:00', endedTime: '09:10' }),
      ).rejects.toMatchObject({ field: 'seconds', reasonCode: 'mode_mismatch' })
      // A start with no end would be a running start/end timer.
      await expect(create({ startedTime: '12:00' })).rejects.toMatchObject({
        field: 'started_time',
        reasonCode: 'mode_mismatch',
      })
      await expect(create({ spentDate: '2026-09-14', startedTime: '12:00' })).rejects.toMatchObject(
        { field: 'started_time', reasonCode: 'mode_mismatch' },
      )
      // ...even for an administrator naming a teammate: the shape is refused
      // before anything is said about whose timer it would be.
      await expect(
        tracked.createTimeEntry(
          ada,
          { userId: 2, projectId: 1, taskId: 1, startedTime: '12:00' },
          at('2026-09-14T12:00:00.000Z'),
        ),
      ).rejects.toMatchObject({ field: 'started_time', reasonCode: 'mode_mismatch' })
      // An end needs a start and a day.
      await expect(create({ spentDate: '2026-09-14', endedTime: '10:00' })).rejects.toMatchObject({
        field: 'started_time',
        reasonCode: 'required',
      })
      await expect(create({ startedTime: '09:00', endedTime: '10:00' })).rejects.toMatchObject({
        field: 'started_time',
        reasonCode: 'required',
      })
      expect(await db.rows(`SELECT count(*) AS count FROM time_entries`)).toEqual([{ count: 0 }])
      expect(await db.rows(`SELECT count(*) AS count FROM event_outbox`)).toEqual([{ count: 0 }])
    }, 30_000)

    it('[money] accepts overlapping entries, and every total counts each one in full', async () => {
      const { db, tracked } = await setup('duration')
      // Two clients in the same hour is a real day: nothing refuses an overlap,
      // and nothing nets one entry against another. 09:00-11:00 and
      // 10:00-12:00 beside an hour logged as a duration is five hours of work
      // over a three-hour span, and five hours is what every total says.
      const boundary = at('2026-09-15T18:00:00.000Z')
      const duration = await tracked.createTimeEntry(
        maya,
        { projectId: 1, taskId: 1, spentDate: '2026-09-15', seconds: 3_600 },
        boundary,
      )
      const first = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-09-15',
          startedTime: '09:00',
          endedTime: '11:00',
        },
        boundary,
      )
      const second = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-09-15',
          startedTime: '10:00',
          endedTime: '12:00',
        },
        boundary,
      )
      const fiveHours = 18_000
      expect(
        await db.rows(
          `SELECT id, started_time, ended_time, seconds, rounded_seconds
           FROM time_entries WHERE user_id = 2 AND spent_date = '2026-09-15' ORDER BY id`,
        ),
      ).toEqual([
        {
          id: duration.id,
          started_time: null,
          ended_time: null,
          seconds: 3_600,
          rounded_seconds: 3_600,
        },
        {
          id: first.id,
          started_time: '09:00',
          ended_time: '11:00',
          seconds: 7_200,
          rounded_seconds: 7_200,
        },
        {
          id: second.id,
          started_time: '10:00',
          ended_time: '12:00',
          seconds: 7_200,
          rounded_seconds: 7_200,
        },
      ])

      const week = { from: '2026-09-14', to: '2026-09-20' }
      const reports = createReportRepository(db.orm)
      expect((await reports.timeReport(week)).totals).toMatchObject({
        seconds: fiveHours,
        roundedSeconds: fiveHours,
        timeEntryCount: 3,
      })
      const detailed = await reports.detailedTime({ ...week, grain: 'day' })
      expect(detailed.kind).toBe('report')
      if (detailed.kind !== 'report') return
      expect(detailed.report).toMatchObject({ seconds: fiveHours, timeEntryCount: 3 })
      // The day grain folds the three into one row for the day, summed.
      expect(detailed.report.rows).toEqual([
        expect.objectContaining({ spentDate: '2026-09-15', seconds: fiveHours, timeEntryCount: 3 }),
      ])
      expect(await reports.memberHours({ ...week, userId: 2 })).toMatchObject({
        seconds: fiveHours,
        roundedSeconds: fiveHours,
        timeEntryCount: 3,
      })

      // The work journal behind an invoice lists each entry at its own length.
      await db.run(`UPDATE time_entries SET invoice_id = 1 WHERE user_id = 2`)
      const journal = await readInvoiceJournal(db.orm, 1)
      expect(journal.map(({ seconds }) => seconds)).toEqual([3_600, 7_200, 7_200])
      await db.run(`UPDATE time_entries SET invoice_id = NULL WHERE user_id = 2`)

      // And so does the timesheet a manager approves.
      const submission = await createTimesheetApprovalRepository(db.orm).submit(
        2,
        week.from,
        week.to,
        '2026-09-18T12:00:00.000Z',
      )
      expect(submission).toMatchObject({ entryCount: 3, totalSeconds: fiveHours })
    }, 30_000)

    it('[unit] edits each entry by its own shape, whatever the organization mode', async () => {
      const { tracked } = await setup('duration')
      const boundary = at('2026-09-15T18:00:00.000Z')
      const timed = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 1,
          spentDate: '2026-09-15',
          startedTime: '09:00',
          endedTime: '10:00',
        },
        boundary,
      )
      const duration = await tracked.createTimeEntry(
        maya,
        { projectId: 1, taskId: 1, spentDate: '2026-09-15', seconds: 1_800 },
        boundary,
      )
      const later = at('2026-09-15T19:00:00.000Z')
      // A resize moves the end and the seconds follow it, rounded.
      const resized = await tracked.updateTimeEntry(maya, timed.id, { endedTime: '10:40' }, later)
      expect(resized).toMatchObject({
        startedTime: '09:00',
        endedTime: '10:40',
        seconds: 6_000,
        secondsWithoutTimer: 6_000,
        roundedSeconds: 6_300,
      })
      // Moving it to another day keeps its interval.
      const moved = await tracked.updateTimeEntry(
        maya,
        timed.id,
        { spentDate: '2026-09-16' },
        at('2026-09-15T19:01:00.000Z'),
      )
      expect(moved).toMatchObject({
        spentDate: '2026-09-16',
        startedTime: '09:00',
        endedTime: '10:40',
        seconds: 6_000,
      })
      await expect(
        tracked.updateTimeEntry(maya, timed.id, { seconds: 600 }, at('2026-09-15T19:02:00.000Z')),
      ).rejects.toMatchObject({ field: 'seconds', reasonCode: 'mode_mismatch' })
      // A duration entry stays one: it takes hours, never an invented clock time.
      await expect(
        tracked.updateTimeEntry(
          maya,
          duration.id,
          { startedTime: '13:00', endedTime: '14:00' },
          at('2026-09-15T19:03:00.000Z'),
        ),
      ).rejects.toMatchObject({ field: 'started_time', reasonCode: 'mode_mismatch' })
      expect(
        await tracked.updateTimeEntry(
          maya,
          duration.id,
          { seconds: 2_700 },
          at('2026-09-15T19:04:00.000Z'),
        ),
      ).toMatchObject({ startedTime: null, seconds: 2_700, roundedSeconds: 2_700 })
    }, 30_000)

    it('[unit] keeps the running timer a duration timer beside start/end entries', async () => {
      const { db, tracked } = await setup('duration')
      const timer = await tracked.createTimeEntry(
        maya,
        { projectId: 1, taskId: 1 },
        at('2026-09-16T08:00:00.000Z'),
      )
      expect(timer).toMatchObject({
        spentDate: '2026-09-16',
        timerStartedAt: '2026-09-16T08:00:00.000Z',
        startedTime: null,
      })
      // An interval logged across the running timer does not touch it.
      const interval = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 2,
          spentDate: '2026-09-16',
          startedTime: '08:30',
          endedTime: '09:15',
        },
        at('2026-09-16T09:20:00.000Z'),
      )
      expect(interval).toMatchObject({ seconds: 2_700, timerStartedAt: null })
      await expect(
        tracked.createTimeEntry(
          maya,
          { projectId: 1, taskId: 2, startedTime: '09:25' },
          at('2026-09-16T09:25:00.000Z'),
        ),
      ).rejects.toMatchObject({ reasonCode: 'mode_mismatch' })
      expect(await tracked.getTimeEntry(maya, timer.id)).toMatchObject({
        timerStartedAt: '2026-09-16T08:00:00.000Z',
        seconds: 0,
      })
      // Stop on an interval is refused: it never runs.
      await expect(
        tracked.stopTimeEntry(maya, interval.id, at('2026-09-16T09:30:00.000Z')),
      ).rejects.toMatchObject({ reasonCode: 'not_running' })

      // Restarting the interval starts a duration timer: its times are cleared,
      // its seconds carried, and the timer it displaces stops at that instant.
      const restarted = await tracked.restartTimeEntry(
        maya,
        interval.id,
        at('2026-09-16T10:00:00.000Z'),
      )
      expect(restarted).toMatchObject({
        spentDate: '2026-09-16',
        timerStartedAt: '2026-09-16T10:00:00.000Z',
        startedTime: null,
        endedTime: null,
        seconds: 2_700,
        secondsWithoutTimer: 2_700,
      })
      expect(await tracked.getTimeEntry(maya, timer.id)).toMatchObject({
        timerStartedAt: null,
        seconds: 7_200,
        roundedSeconds: 7_200,
      })
      const stopped = await tracked.stopTimeEntry(maya, interval.id, at('2026-09-16T10:07:00.000Z'))
      expect(stopped).toMatchObject({
        timerStartedAt: null,
        startedTime: null,
        endedTime: null,
        seconds: 3_120,
        secondsWithoutTimer: 3_120,
        roundedSeconds: 3_600,
      })
      expect(
        await db.rows(
          `SELECT count(*) AS count FROM time_entries
           WHERE timer_started_at IS NOT NULL OR (started_time IS NOT NULL AND ended_time IS NULL)`,
        ),
      ).toEqual([{ count: 0 }])
    }, 30_000)

    it('[security] holds policy locks, approvals and invoices on start/end entries', async () => {
      const { db, tracked } = await setup('duration')
      const interval = (spentDate: string, startedTime = '09:00', endedTime = '10:00') => ({
        projectId: 1,
        taskId: 1,
        spentDate,
        startedTime,
        endedTime,
      })
      const boundary = at('2026-09-18T12:00:00.000Z')

      locks.add('tracked_date:2026-09-17')
      await expect(
        tracked.createTimeEntry(maya, interval('2026-09-17'), boundary),
      ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'policy_locked' })
      locks.clear()

      const claimed = await tracked.createTimeEntry(maya, interval('2026-09-17'), boundary)
      await db.run(`UPDATE time_entries SET invoice_id = 1 WHERE id = ?`, claimed.id)
      await expect(
        tracked.updateTimeEntry(maya, claimed.id, { endedTime: '11:00' }, boundary),
      ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'invoiced' })
      await expect(tracked.deleteTimeEntry(maya, claimed.id, boundary)).rejects.toMatchObject({
        code: 'tracked_mutation_locked',
        reasonCode: 'invoiced',
      })
      await db.run(`UPDATE time_entries SET invoice_id = NULL WHERE id = ?`, claimed.id)

      // A submitted week takes a new interval into the submission...
      const approvals = createTimesheetApprovalRepository(db.orm)
      const submission = await approvals.submit(
        2,
        '2026-09-14',
        '2026-09-20',
        '2026-09-18T12:01:00.000Z',
      )
      const joined = await tracked.createTimeEntry(
        maya,
        interval('2026-09-18', '13:00', '13:30'),
        boundary,
      )
      expect(joined).toMatchObject({
        approvalStatus: 'submitted',
        timesheetSubmissionId: submission.id,
      })
      // ...and an approved one refuses it, and every edit to the ones inside.
      await approvals.approve(ada, submission.id, '2026-09-18T12:02:00.000Z')
      await expect(
        tracked.createTimeEntry(maya, interval('2026-09-19'), boundary),
      ).rejects.toMatchObject({ field: 'spent_date', reasonCode: 'approved_period' })
      await expect(
        tracked.updateTimeEntry(maya, joined.id, { endedTime: '14:00' }, boundary),
      ).rejects.toMatchObject({ code: 'tracked_mutation_locked', reasonCode: 'approved' })
      expect(
        await db.rows(`SELECT count(*) AS count FROM time_entries WHERE spent_date = '2026-09-19'`),
      ).toEqual([{ count: 0 }])
    }, 30_000)

    it('[unit] leaves a start_end organization exactly as it was', async () => {
      const { db, tracked } = await setup('start_end')
      await expect(
        tracked.createTimeEntry(
          maya,
          { projectId: 1, taskId: 1, spentDate: '2026-09-14', seconds: 600 },
          at('2026-09-14T12:00:00.000Z'),
        ),
      ).rejects.toMatchObject({ field: 'seconds', reasonCode: 'mode_mismatch' })
      // A timer here is a start/end timer, started at the local clock.
      const running = await tracked.createTimeEntry(
        maya,
        { projectId: 1, taskId: 1 },
        at('2026-09-14T09:00:00.000Z'),
      )
      expect(running).toMatchObject({
        spentDate: '2026-09-14',
        startedTime: '09:00',
        endedTime: null,
        timerStartedAt: null,
      })
      const stopped = await tracked.stopTimeEntry(maya, running.id, at('2026-09-14T09:20:00.000Z'))
      expect(stopped).toMatchObject({ endedTime: '09:20', seconds: 1_200, roundedSeconds: 1_800 })
      const interval = await tracked.createTimeEntry(
        maya,
        {
          projectId: 1,
          taskId: 2,
          spentDate: '2026-09-14',
          startedTime: '13:00',
          endedTime: '13:05',
        },
        at('2026-09-14T14:00:00.000Z'),
      )
      expect(interval).toMatchObject({ seconds: 300, roundedSeconds: 900 })

      // The database still refuses what 0002 refused here: a duration without
      // an interval, and a duration-style timer.
      await expect(insertRow(db, { id: 20, seconds: 3_600 })).rejects.toThrow(shapeRefusal)
      await expect(
        insertRow(db, { id: 21, seconds: 0, timerStartedAt: '2026-09-14T15:00:00.000Z' }),
      ).rejects.toThrow(shapeRefusal)
      // A correction still carries no interval and is still accepted.
      await insertRow(db, { id: 22, seconds: -900 })
      expect(
        await db.rows(`SELECT id, seconds, started_time FROM time_entries WHERE id = 22`),
      ).toEqual([{ id: 22, seconds: -900, started_time: null }])
    }, 30_000)
  })
}

/**
 * Every row shape, before 0100 and after it, in both modes.
 *
 * The migration is a change to one rule, so the proof is that one rule's
 * answers: run every combination of a signed duration, a timer, a start and an
 * end through the insert trigger on a database stopped at 0099 and on one
 * migrated through 0100, and the only answers that may differ are a duration
 * organization's stopped intervals. Container only: it is the same SQLite
 * engine under D1, and the cases above already cover both runtimes.
 */
describe('the 0100 insert rule, shape by shape', () => {
  const shapes = [3_600, -3_600].flatMap((seconds) =>
    [null, '2026-09-14T09:00:00.000Z'].flatMap((timerStartedAt) =>
      [null, '09:00'].flatMap((startedTime) =>
        [null, '10:00'].map((endedTime) => ({ seconds, timerStartedAt, startedTime, endedTime })),
      ),
    ),
  )
  const key = (shape: (typeof shapes)[number]): string =>
    `seconds=${shape.seconds} timer=${shape.timerStartedAt === null ? '-' : 'set'} ` +
    `start=${shape.startedTime ?? '-'} end=${shape.endedTime ?? '-'}`

  const answers = async (upToDate: boolean, mode: Mode): Promise<Record<string, string>> => {
    const sqlite = new BetterSqlite3(':memory:')
    try {
      if (upToDate) migrateContainer(sqlite)
      else migrateContainerThrough(sqlite, before0100)
      const db: TestDatabase = {
        orm: createContainerDatabase(sqlite),
        run: async (sql, ...params) => {
          sqlite.prepare(sql).run(...params)
        },
        rows: async <Row>(sql: string, ...params: unknown[]) =>
          sqlite.prepare(sql).all(...params) as Row[],
        migrate: async () => migrateContainer(sqlite),
        close: async () => {},
      }
      await installFixture(db, mode)
      const result: Record<string, string> = {}
      for (const shape of shapes) {
        sqlite.exec('SAVEPOINT shape')
        try {
          await insertRow(db, { id: 1, ...shape })
          result[key(shape)] = 'accepted'
        } catch (error) {
          result[key(shape)] = (error as Error).message
        } finally {
          sqlite.exec('ROLLBACK TO shape')
          sqlite.exec('RELEASE shape')
        }
      }
      return result
    } finally {
      sqlite.close()
    }
  }

  it("[unit] admits only a duration organization's stopped intervals; start_end answers are unchanged", async () => {
    const stoppedIntervals = shapes
      .filter(
        (shape) =>
          shape.timerStartedAt === null && shape.startedTime !== null && shape.endedTime !== null,
      )
      .map(key)
    expect(stoppedIntervals).toHaveLength(2)
    const verdicts = (answered: Record<string, string>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(answered).map(([shape, answer]) => [
          shape,
          answer === 'accepted' ? 'accepted' : 'refused',
        ]),
      )

    const durationBefore = await answers(false, 'duration')
    const durationAfter = await answers(true, 'duration')
    for (const shape of stoppedIntervals) {
      expect(durationBefore[shape]).toMatch(shapeRefusal)
    }
    // Two answers change, both to yes. A shape the table's own CHECKs forbid
    // (an end with no start, a timer beside an interval) is still refused; the
    // old trigger merely got to it before the CHECK did.
    expect(verdicts(durationAfter)).toEqual({
      ...verdicts(durationBefore),
      ...Object.fromEntries(stoppedIntervals.map((shape) => [shape, 'accepted'])),
    })
    // The running interval a duration timer is not: refused by the rule itself.
    expect(
      durationAfter[
        key({ seconds: 3_600, timerStartedAt: null, startedTime: '09:00', endedTime: null })
      ],
    ).toMatch(shapeRefusal)

    // In a start/end organization not even a message moves.
    expect(await answers(true, 'start_end')).toEqual(await answers(false, 'start_end'))
  }, 30_000)
})
