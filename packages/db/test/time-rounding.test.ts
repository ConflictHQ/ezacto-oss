import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import {
  timeRoundingFromLegacy,
  timeRoundingIncrements,
  timeRoundingModes,
  type LegacyTimeRounding,
  type TimeRoundingMinutes,
  type TimeRoundingMode,
} from '@ezacto/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'
import { executeReportTimeAction } from '../src/report-time-actions.js'
import {
  createStoppedTimeEntry,
  startTimeEntry,
  stopTimeEntry,
  type TimeBoundary,
} from '../src/time-entries.js'
import { createTimesheetApprovalRepository } from '../src/timesheet-approvals.js'
import {
  DrizzleTrackedResourceRepository,
  type PolicySubject,
  type TimeEntryActor,
} from '../src/tracked-resource-repository.js'

/**
 * Issue 949: rounding is a direction and an increment, set for the
 * organization and overridable per project, stored per entry when it is saved.
 *
 * Every case runs on a real migrated database, on the container and on D1: the
 * stop-previous rule is a trigger, and only a real schema enforces one.
 */

type AdapterDatabase =
  ReturnType<typeof createContainerDatabase> | ReturnType<typeof createD1Database>

interface TestDatabase {
  orm: AdapterDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

/** The migration before this one: a database as it stood without the new columns. */
const before0112 = '0111_invoice_totals_per_invoice'

const containerDatabase = async (upToDate: boolean): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  if (upToDate) migrateContainer(sqlite)
  else migrateContainerThrough(sqlite, before0112)
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

const d1Database = async (upToDate: boolean): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (upToDate) await migrateD1(d1)
  else await migrateD1Through(d1, before0112)
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
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

/** Every case migrates a database, and D1 runs a worker for it. */
const slowTimeout = 120_000

const t0 = '2026-09-01T08:00:00.000Z'
const stamps = (count: number): string[] => Array.from({ length: count }, () => t0)
const at = (instant: string): TimeBoundary => ({
  instant,
  date: instant.slice(0, 10),
  time: instant.slice(11, 16),
})
const maya: TimeEntryActor = { userId: 2, profile: 'member' }

/**
 * The rule stated independently of core's implementation, so a mistake in one
 * is not repeated in the other.
 */
const expectedRounded = (mode: TimeRoundingMode, minutes: number, seconds: number): number => {
  const increment = minutes * 60
  const floor = Math.floor(seconds / increment) * increment
  const remainder = seconds - floor
  if (mode === 'exact') return seconds
  if (mode === 'down') return floor
  if (mode === 'up') return remainder === 0 ? floor : floor + increment
  return remainder * 2 >= increment ? floor + increment : floor
}

/**
 * Two projects with one task each, both of which Maya (2) works on; Ada (1)
 * administers. Project 1 is Alpha, project 2 is Beta.
 */
const installFixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, time_entry_mode, modules, created_at, updated_at)
     VALUES ('Fictional Studio', 'duration', ?, ?, ?)`,
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
     VALUES (1, 1, 'Alpha', 'AL', ?, ?), (2, 1, 'Beta', 'BE', ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Design', ?, ?)`,
    ...stamps(2),
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 2, ?, ?), (2, 2, 2, ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?), (2, 2, 1, 1, ?, ?)`,
    ...stamps(4),
  )
  await db.run(
    `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES (1, 1, 'FICTIONAL-1', 'USD', '2026-09-30', '2026-10-30', ?, ?)`,
    ...stamps(2),
  )
}

const setOrganizationRule = (db: TestDatabase, mode: TimeRoundingMode, minutes: number) =>
  db.run(
    `UPDATE organizations SET time_rounding_mode = ?, time_rounding_minutes = ? WHERE id = 1`,
    mode,
    minutes,
  )

const setProjectRule = (
  db: TestDatabase,
  projectId: number,
  mode: TimeRoundingMode | null,
  minutes: number | null,
) =>
  db.run(
    `UPDATE projects SET time_rounding_mode = ?, time_rounding_minutes = ? WHERE id = ?`,
    mode,
    minutes,
    projectId,
  )

const weekEnd = (start: string): string => {
  const end = new Date(`${start}T00:00:00.000Z`)
  end.setUTCDate(end.getUTCDate() + 6)
  return end.toISOString().slice(0, 10)
}

/**
 * A stopped entry written straight to the table with the figure it was saved
 * with. An approved one goes through a submission and an approval of its week,
 * as the schema requires, so its date is the first day of a week that holds no
 * other entry.
 */
const insertEntry = async (
  db: TestDatabase,
  row: {
    id: number
    projectId?: 1 | 2
    spentDate?: string
    seconds: number
    roundedSeconds: number
    invoiceId?: number
    approved?: true
    timerStartedAt?: string
  },
): Promise<void> => {
  const spentDate = row.spentDate ?? '2026-09-14'
  await db.run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds,
      invoice_id, timer_started_at, billable, created_at, updated_at
    ) VALUES (?, 2, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    row.id,
    row.projectId ?? 1,
    row.projectId ?? 1,
    row.projectId ?? 1,
    spentDate,
    row.seconds,
    row.seconds,
    row.roundedSeconds,
    row.invoiceId ?? null,
    row.timerStartedAt ?? null,
    ...stamps(2),
  )
  if (row.approved === true) {
    const approvals = createTimesheetApprovalRepository(db.orm)
    const submission = await approvals.submit(2, spentDate, weekEnd(spentDate), t0)
    await approvals.approve({ userId: 1, profile: 'administrator' }, submission.id, t0)
  }
}

const rounded = async (db: TestDatabase, id: number): Promise<number> =>
  (
    await db.rows<{ rounded_seconds: number }>(
      `SELECT rounded_seconds FROM time_entries WHERE id = ?`,
      id,
    )
  )[0]!.rounded_seconds

const entryInput = (projectId: 1 | 2, seconds: number, at0 = '2026-09-14') => ({
  userId: 2,
  projectId,
  taskId: 1,
  userAssignmentId: projectId,
  taskAssignmentId: projectId,
  spentDate: at0,
  seconds,
  createdAt: t0,
  updatedAt: t0,
})

for (const [runtime, factory] of factories) {
  describe(`time rounding settings (${runtime})`, { timeout: slowTimeout }, () => {
    let database: TestDatabase | undefined
    const lockedDates = new Set<string>()

    afterEach(async () => {
      await database?.close()
      database = undefined
      lockedDates.clear()
    })

    const setup = async () => {
      database = await factory(true)
      await installFixture(database)
      const tracked = new DrizzleTrackedResourceRepository(database.orm, {
        isLocked: async (subject: Readonly<PolicySubject>) =>
          subject.entityType === 'tracked_date' && lockedDates.has(subject.spentDate),
      })
      return { db: database, tracked }
    }

    it('[unit] a fresh organization rounds nothing and keeps the old column out of the way', async () => {
      const { db } = await setup()
      expect(
        await db.rows(
          `SELECT time_rounding_mode AS mode, time_rounding_minutes AS minutes FROM organizations`,
        ),
      ).toEqual([{ mode: 'exact', minutes: 15 }])
      expect(
        await db.rows(`SELECT time_rounding_mode AS mode FROM projects ORDER BY id`),
      ).toEqual([{ mode: null }, { mode: null }])
    })

    it('[unit] rounds every direction at every increment, on a boundary and a second either side', async () => {
      const { db } = await setup()
      let id = 0
      for (const mode of timeRoundingModes) {
        for (const minutes of timeRoundingIncrements) {
          await setOrganizationRule(db, mode, minutes)
          const increment = minutes * 60
          const boundary = increment * 3
          for (const seconds of [0, boundary - 1, boundary, boundary + 1]) {
            id += 1
            const entry = await createStoppedTimeEntry(db.orm, {
              ...entryInput(1, seconds),
              harvestId: `h${id}`,
            })
            expect(entry.roundedSeconds, `${mode}/${minutes} of ${seconds}`).toBe(
              expectedRounded(mode, minutes, seconds),
            )
            // Written, and read back from the table rather than from the return.
            expect(await rounded(db, entry.id)).toBe(expectedRounded(mode, minutes, seconds))
          }
          // Half an increment: the one value where nearest and up agree, down does not.
          const half = boundary + increment / 2
          id += 1
          const entry = await createStoppedTimeEntry(db.orm, {
            ...entryInput(1, half),
            harvestId: `h${id}`,
          })
          expect(entry.roundedSeconds, `${mode}/${minutes} of ${half}`).toBe(
            expectedRounded(mode, minutes, half),
          )
        }
      }
    })

    it('[unit] refuses a rule outside the vocabulary, and half of a project rule', async () => {
      const { db } = await setup()
      await expect(setOrganizationRule(db, 'sideways' as TimeRoundingMode, 15)).rejects.toThrow(
        /time rounding must be/,
      )
      await expect(setOrganizationRule(db, 'up', 7)).rejects.toThrow(/time rounding must be/)
      await expect(
        db.run(`UPDATE organizations SET time_rounding_mode = NULL WHERE id = 1`),
      ).rejects.toThrow()
      await expect(setProjectRule(db, 1, 'up', null)).rejects.toThrow(/project time rounding/)
      await expect(setProjectRule(db, 1, null, 15)).rejects.toThrow(/project time rounding/)
      await expect(setProjectRule(db, 1, 'down', 45)).rejects.toThrow(/project time rounding/)
      await expect(
        db.run(
          `INSERT INTO projects (id, client_id, name, time_rounding_mode, time_rounding_minutes, created_at, updated_at)
           VALUES (3, 1, 'Gamma', 'up', 99, ?, ?)`,
          ...stamps(2),
        ),
      ).rejects.toThrow(/project time rounding/)
      await setProjectRule(db, 1, 'down', 10)
      await setProjectRule(db, 1, null, null)
    })

    it('[unit] a project rule beats the organization rule, and clearing it goes back', async () => {
      const { db, tracked } = await setup()
      await setOrganizationRule(db, 'up', 15)
      await setProjectRule(db, 2, 'nearest', 6)
      // 7 minutes: up to 15 on Alpha, nearest 6 minute step (6) on Beta.
      const alpha = await createStoppedTimeEntry(db.orm, { ...entryInput(1, 420), harvestId: 'a' })
      const beta = await createStoppedTimeEntry(db.orm, { ...entryInput(2, 420), harvestId: 'b' })
      expect(alpha.roundedSeconds).toBe(900)
      expect(beta.roundedSeconds).toBe(360)

      expect(await tracked.timeEntryOptions(2)).toEqual([
        {
          projectId: 1,
          taskId: 1,
          noteMinimumLength: 0,
          timeRounding: { mode: 'up', minutes: 15, source: 'organization' },
        },
        {
          projectId: 2,
          taskId: 1,
          noteMinimumLength: 0,
          timeRounding: { mode: 'nearest', minutes: 6, source: 'project' },
        },
      ])

      await setProjectRule(db, 2, null, null)
      const cleared = await createStoppedTimeEntry(db.orm, { ...entryInput(2, 420), harvestId: 'c' })
      expect(cleared.roundedSeconds).toBe(900)
      // The entry saved under the project's rule keeps its figure.
      expect(await rounded(db, beta.id)).toBe(360)
    })

    it('[unit] reads and sets the organization rule, half at a time', async () => {
      const { tracked } = await setup()
      expect((await tracked.timeEntrySettings()).timeRounding).toEqual({ mode: 'exact', minutes: 15 })
      expect(await tracked.updateTimeRoundingSettings({ mode: 'up' }, t0)).toEqual({
        mode: 'up',
        minutes: 15,
      })
      expect(await tracked.updateTimeRoundingSettings({ minutes: 30 }, t0)).toEqual({
        mode: 'up',
        minutes: 30,
      })
      await expect(
        tracked.updateTimeRoundingSettings({ minutes: 7 as TimeRoundingMinutes }, t0),
      ).rejects.toThrow(/unsupported time rounding increment/)
      expect((await tracked.timeEntrySettings()).timeRounding).toEqual({ mode: 'up', minutes: 30 })
    })

    it('[unit] a timer is rounded by its project when it stops, and when another start stops it', async () => {
      const { db } = await setup()
      await setOrganizationRule(db, 'up', 15)
      await setProjectRule(db, 1, 'down', 10)
      const base = (projectId: 1 | 2) => ({
        userId: 2,
        projectId,
        taskId: 1,
        userAssignmentId: projectId,
        taskAssignmentId: projectId,
      })
      // Explicit stop: 25 minutes on Alpha is 20 under down/10.
      const first = await startTimeEntry(db.orm, base(1), {
        ...at('2026-09-14T09:00:00.000Z'),
      }, false)
      const stopped = await stopTimeEntry(db.orm, first.id, at('2026-09-14T09:25:00.000Z'), false)
      expect(stopped.roundedSeconds).toBe(1_200)

      // Stopped by the next start, in the trigger: 25 minutes on Alpha again.
      const running = await startTimeEntry(db.orm, base(1), at('2026-09-14T10:00:00.000Z'), false)
      await startTimeEntry(db.orm, base(2), at('2026-09-14T10:25:00.000Z'), false)
      expect(await rounded(db, running.id)).toBe(1_200)

      // And the same trigger on Beta, which has no rule of its own: up to 15.
      const beta = (await db.rows<{ id: number }>(`SELECT id FROM time_entries WHERE project_id = 2`))[0]!
      await startTimeEntry(db.orm, base(1), at('2026-09-14T11:10:00.000Z'), false)
      expect(await rounded(db, beta.id)).toBe(2_700)
    })

    it('[unit] an edit rounds by the rule of the project the entry ends up on', async () => {
      const { db, tracked } = await setup()
      await setOrganizationRule(db, 'up', 15)
      await setProjectRule(db, 2, 'down', 30)
      const created = await tracked.createTimeEntry(
        maya,
        { projectId: 1, taskId: 1, spentDate: '2026-09-14', seconds: 1_000 },
        at('2026-09-14T12:00:00.000Z'),
      )
      expect(created.roundedSeconds).toBe(1_800)

      const longer = await tracked.updateTimeEntry(
        maya,
        created.id,
        { seconds: 2_000 },
        at('2026-09-14T12:01:00.000Z'),
      )
      expect(longer.roundedSeconds).toBe(2_700)

      // Moved, with the duration untouched: 2000 s is 33 min, down to 30.
      const moved = await tracked.updateTimeEntry(
        maya,
        created.id,
        { projectId: 2 },
        at('2026-09-14T12:02:00.000Z'),
      )
      expect(moved.roundedSeconds).toBe(1_800)
      expect(await rounded(db, created.id)).toBe(1_800)

      // An edit that changes neither the time nor the project leaves it alone,
      // even after the rule has moved on.
      await setProjectRule(db, 2, 'up', 60)
      const noted = await tracked.updateTimeEntry(
        maya,
        created.id,
        { notes: 'Reviewed' },
        at('2026-09-14T12:03:00.000Z'),
      )
      expect(noted.roundedSeconds).toBe(1_800)
    })

    it('[unit] the report Move action rounds moved time by the destination project', async () => {
      const { db } = await setup()
      await setOrganizationRule(db, 'up', 15)
      await setProjectRule(db, 2, 'nearest', 6)
      await insertEntry(db, { id: 1, projectId: 1, seconds: 420, roundedSeconds: 900 })
      await insertEntry(db, { id: 2, projectId: 1, seconds: -600, roundedSeconds: -600 })
      const result = await executeReportTimeAction(db.orm, {
        commandId: 'move-1',
        actorUserId: 1,
        action: 'move',
        entryIds: [1, 2],
        projectId: 2,
        taskId: 1,
        completedAt: '2026-09-20T10:00:00.000Z',
      })
      expect(result).toMatchObject({ changedEntryIds: [1, 2] })
      expect(await rounded(db, 1)).toBe(360)
      // A correction keeps the figure its source gave it.
      expect(await rounded(db, 2)).toBe(-600)
    })

    it('[unit] changing a setting rewrites nothing already saved', async () => {
      const { db, tracked } = await setup()
      await setOrganizationRule(db, 'up', 15)
      await insertEntry(db, { id: 1, seconds: 420, roundedSeconds: 900 })
      await insertEntry(db, { id: 2, seconds: 420, roundedSeconds: 900, invoiceId: 1 })
      const before = await db.rows(`SELECT * FROM time_entries ORDER BY id`)
      await tracked.updateTimeRoundingSettings({ mode: 'down', minutes: 6 }, '2026-09-20T10:00:00.000Z')
      await setProjectRule(db, 1, 'exact', 60)
      expect(await db.rows(`SELECT * FROM time_entries ORDER BY id`)).toEqual(before)
    })

    describe('recalculating open entries', () => {
      const apply = '2026-09-21T09:00:00.000Z'

      /** One entry of each kind, every one of them holding a figure the rule no longer gives. */
      const seedMixed = async (db: TestDatabase) => {
        await setOrganizationRule(db, 'down', 6)
        // Open, and 7 min rounds to 6 under down/6 rather than the 15 it holds.
        await insertEntry(db, { id: 1, projectId: 1, seconds: 420, roundedSeconds: 900 })
        await insertEntry(db, { id: 2, projectId: 2, seconds: 1_000, roundedSeconds: 1_800, spentDate: '2026-09-02' })
        // Open, already what the rule gives: counted as open, not as changed.
        await insertEntry(db, { id: 3, projectId: 1, seconds: 720, roundedSeconds: 720 })
        // Left alone: invoiced, approved, running, a correction, locked.
        await insertEntry(db, { id: 4, seconds: 420, roundedSeconds: 900, invoiceId: 1 })
        await insertEntry(db, { id: 5, seconds: 420, roundedSeconds: 900, approved: true, spentDate: '2026-09-07' })
        await insertEntry(db, {
          id: 6,
          seconds: 420,
          roundedSeconds: 900,
          timerStartedAt: '2026-09-14T09:00:00.000Z',
        })
        await insertEntry(db, { id: 7, seconds: -600, roundedSeconds: 0 })
        await insertEntry(db, { id: 8, seconds: 420, roundedSeconds: 900, spentDate: '2026-08-10' })
        lockedDates.add('2026-08-10')
      }

      it('[unit] previews exactly what it would change and writes nothing', async () => {
        const { db, tracked } = await setup()
        await seedMixed(db)
        const before = await db.rows(`SELECT * FROM time_entries ORDER BY id`)
        const preview = await tracked.previewTimeRoundingRecalculation({})

        expect(preview).toMatchObject({
          openEntries: 3,
          changedEntries: 2,
          roundedSecondsBefore: 2_700,
          roundedSecondsAfter: 360 + 1_000 - (1_000 % 360),
          earliestSpentDate: '2026-09-02',
          latestSpentDate: '2026-09-14',
          kept: { invoiced: 1, approved: 1, locked: 1, other: 2 },
        })
        expect(preview.projects.map((project) => [project.projectName, project.changedEntries])).toEqual([
          ['Alpha', 1],
          ['Beta', 1],
        ])
        expect(preview.projects[0]?.timeRounding).toEqual({
          mode: 'down',
          minutes: 6,
          source: 'organization',
        })
        expect(preview.fingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(await db.rows(`SELECT * FROM time_entries ORDER BY id`)).toEqual(before)

        // A scope narrows it.
        expect(await tracked.previewTimeRoundingRecalculation({ projectId: 2 })).toMatchObject({
          changedEntries: 1,
          openEntries: 1,
        })
        expect(
          await tracked.previewTimeRoundingRecalculation({ from: '2026-09-10', to: '2026-09-30' }),
        ).toMatchObject({ changedEntries: 1, earliestSpentDate: '2026-09-14' })
      })

      it('[unit] applies the preview it was given and nothing else', async () => {
        const { db, tracked } = await setup()
        await seedMixed(db)
        await setProjectRule(db, 2, 'up', 10)
        const preview = await tracked.previewTimeRoundingRecalculation({})
        const result = await tracked.applyTimeRoundingRecalculation({}, preview.fingerprint, apply)

        expect(result.status).toBe('applied')
        if (result.status !== 'applied') return
        expect(result.recalculatedEntries).toBe(preview.changedEntries)
        expect(result.preview).toEqual(preview)
        // Alpha is down/6 and Beta is up/10: each by its own project's rule.
        expect(await rounded(db, 1)).toBe(360)
        expect(await rounded(db, 2)).toBe(1_200)
        expect(await rounded(db, 3)).toBe(720)
        // Everything it was told to leave is as it was.
        for (const id of [4, 5, 6, 8]) expect(await rounded(db, id)).toBe(900)
        expect(await rounded(db, 7)).toBe(0)
        expect(
          await db.rows(`SELECT id FROM time_entries WHERE updated_at <> ? ORDER BY id`, t0),
        ).toEqual([{ id: 1 }, { id: 2 }])

        // Nothing is left to change, and the same preview cannot be applied twice.
        expect(await tracked.previewTimeRoundingRecalculation({})).toMatchObject({ changedEntries: 0 })
        expect(
          await tracked.applyTimeRoundingRecalculation({}, preview.fingerprint, apply),
        ).toMatchObject({ status: 'stale' })
      })

      it('[unit] refuses a stale preview and leaves every entry as it was', async () => {
        const { db, tracked } = await setup()
        await seedMixed(db)
        const preview = await tracked.previewTimeRoundingRecalculation({})
        const before = await db.rows(`SELECT * FROM time_entries ORDER BY id`)

        // Each of these changes the set the preview described.
        const changes: ReadonlyArray<readonly [string, () => Promise<void>]> = [
          ['an entry was edited', () => db.run(`UPDATE time_entries SET seconds = 480, seconds_without_timer = 480, updated_at = ? WHERE id = 1`, '2026-09-21T08:00:00.000Z')],
          ['an entry was invoiced', () => db.run(`UPDATE time_entries SET invoice_id = 1 WHERE id = 2`)],
          ['a rule changed', () => setProjectRule(db, 1, 'up', 6)],
          ['a date was locked', async () => void lockedDates.add('2026-09-02')],
        ]
        for (const [label, change] of changes) {
          await change()
          const result = await tracked.applyTimeRoundingRecalculation({}, preview.fingerprint, apply)
          expect(result.status, label).toBe('stale')
          if (result.status === 'stale') expect(result.preview.fingerprint).not.toBe(preview.fingerprint)
          await db.run(`UPDATE time_entries SET seconds = 420, seconds_without_timer = 420, invoice_id = NULL, updated_at = ? WHERE id IN (1, 2)`, t0)
          await db.run(`UPDATE time_entries SET seconds = 1000, seconds_without_timer = 1000 WHERE id = 2`)
          await setProjectRule(db, 1, null, null)
          lockedDates.delete('2026-09-02')
        }
        expect(await db.rows(`SELECT * FROM time_entries ORDER BY id`)).toEqual(before)
      })

      it('[unit] refuses a fingerprint from another scope', async () => {
        const { db, tracked } = await setup()
        await seedMixed(db)
        const everything = await tracked.previewTimeRoundingRecalculation({})
        expect(
          await tracked.applyTimeRoundingRecalculation({ projectId: 1 }, everything.fingerprint, apply),
        ).toMatchObject({ status: 'stale' })
        expect(await rounded(db, 1)).toBe(900)
      })

      it('[unit] an archived project, client or task is left alone', async () => {
        const { db, tracked } = await setup()
        await setOrganizationRule(db, 'down', 6)
        await insertEntry(db, { id: 1, projectId: 1, seconds: 420, roundedSeconds: 900 })
        await insertEntry(db, { id: 2, projectId: 2, seconds: 420, roundedSeconds: 900 })
        await db.run(`UPDATE projects SET is_active = 0 WHERE id = 2`)
        const preview = await tracked.previewTimeRoundingRecalculation({})
        expect(preview).toMatchObject({ openEntries: 1, changedEntries: 1 })
        await tracked.applyTimeRoundingRecalculation({}, preview.fingerprint, apply)
        expect(await rounded(db, 1)).toBe(360)
        expect(await rounded(db, 2)).toBe(900)
      })

      it('[unit] rejects a malformed scope', async () => {
        const { tracked } = await setup()
        await expect(tracked.previewTimeRoundingRecalculation({ from: '2026-9-1' })).rejects.toThrow(
          /YYYY-MM-DD/,
        )
        await expect(
          tracked.previewTimeRoundingRecalculation({ from: '2026-09-30', to: '2026-09-01' }),
        ).rejects.toThrow(/from must not be after to/)
        await expect(tracked.previewTimeRoundingRecalculation({ projectId: 0 })).rejects.toThrow(
          /project id/,
        )
      })
    })
  })
}

describe('migration 0112 (container)', { timeout: slowTimeout }, () => {
  const legacy: ReadonlyArray<LegacyTimeRounding> = [
    'none',
    'nearest_6',
    'nearest_15',
    'nearest_30',
    'up_6',
    'up_15',
    'up_30',
  ]

  it.each(legacy)('[unit] backfills %s and rewrites no entry', async (value) => {
    const db = await containerDatabase(false)
    try {
      await db.run(
        `INSERT INTO organizations (name, time_entry_mode, time_rounding, modules, created_at, updated_at)
         VALUES ('Fictional Studio', 'duration', ?, ?, ?, ?)`,
        value,
        JSON.stringify({ expenses: true, invoices: true }),
        ...stamps(2),
      )
      await db.run(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (2, 'Maya', 'Member', 'member', '[]', ?, ?)`,
        ...stamps(2),
      )
      await db.run(
        `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'C', 'USD', ?, ?)`,
        ...stamps(2),
      )
      await db.run(
        `INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Alpha', ?, ?)`,
        ...stamps(2),
      )
      await db.run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'T', ?, ?)`, ...stamps(2))
      await db.run(
        `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 2, ?, ?)`,
        ...stamps(2),
      )
      await db.run(
        `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at) VALUES (1, 1, 1, 1, ?, ?)`,
        ...stamps(2),
      )
      await insertEntry(db, { id: 1, seconds: 420, roundedSeconds: 900 })
      const entries = await db.rows(`SELECT * FROM time_entries`)

      // The ledger is hand-kept: apply what is pending to this connection.
      const sqlite = (db.orm as unknown as { $client: BetterSqlite3.Database }).$client
      migrateContainer(sqlite)

      const rule = timeRoundingFromLegacy(value)
      expect(
        await db.rows(
          `SELECT time_rounding_mode AS mode, time_rounding_minutes AS minutes, time_rounding AS old
           FROM organizations`,
        ),
      ).toEqual([{ mode: rule.mode, minutes: rule.minutes, old: value }])
      expect(await db.rows(`SELECT * FROM time_entries`)).toEqual(entries)
      expect(
        await db.rows(`SELECT time_rounding_mode AS mode FROM projects`),
      ).toEqual([{ mode: null }])
    } finally {
      await db.close()
    }
  })
})

describe('migration 0112 (D1)', { timeout: slowTimeout }, () => {
  it('[unit] backfills the old enum and rewrites no entry', async () => {
    const db = await d1Database(false)
    try {
      await db.run(
        `INSERT INTO organizations (name, time_entry_mode, time_rounding, modules, created_at, updated_at)
         VALUES ('Fictional Studio', 'duration', 'up_30', ?, ?, ?)`,
        JSON.stringify({ expenses: true, invoices: true }),
        ...stamps(2),
      )
      const raw = (db.orm as unknown as { $client: Parameters<typeof migrateD1>[0] }).$client
      await migrateD1(raw)
      expect(
        await db.rows(
          `SELECT time_rounding_mode AS mode, time_rounding_minutes AS minutes FROM organizations`,
        ),
      ).toEqual([{ mode: 'up', minutes: 30 }])
    } finally {
      await db.close()
    }
  })
})
