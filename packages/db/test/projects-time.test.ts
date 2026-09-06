import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import {
  createStoppedTimeEntry,
  elapsedDurationSeconds,
  elapsedWallClockSeconds,
  restartTimeEntry,
  roundSeconds,
  startTimeEntry,
  stopTimeEntry,
  type CreateStoppedTimeEntryInput,
  type StartTimeEntryInput,
  type TimeBoundary,
  type TimeRounding,
} from '../src/time-entries.js'

type DrizzleDatabase = Parameters<typeof startTimeEntry>[0]

interface TestDatabase {
  drizzle: DrizzleDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

const timestamp = '2026-08-27T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })

const containerDatabase = (migrate = true): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  if (migrate) migrateContainer(sqlite)
  const drizzle = createContainerDatabase(sqlite)
  return {
    drizzle,
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
    close: async () => {
      sqlite.close()
    },
  }
}

const d1Database = async (migrate = true): Promise<TestDatabase> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  if (migrate) await migrateD1(d1)
  const drizzle = createD1Database(d1)
  return {
    drizzle,
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run()
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async (migrate = true) => containerDatabase(migrate)],
  ['D1', d1Database],
] as const

const boundary = (time: string, instant: string, date = '2026-08-27'): TimeBoundary => ({
  date,
  time,
  instant,
})

const baseInput: StartTimeEntryInput = {
  userId: 1,
  projectId: 1,
  taskId: 1,
  userAssignmentId: 1,
  taskAssignmentId: 1,
}

const installFixture = async (
  database: TestDatabase,
  mode: 'duration' | 'start_end' = 'duration',
  rounding: TimeRounding = 'none',
): Promise<void> => {
  await database.run(
    `INSERT INTO organizations
      (name, time_entry_mode, time_rounding, modules, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    'Halcyon Studio',
    mode,
    rounding,
    modules,
    timestamp,
    timestamp,
  )
  for (const id of [1, 2]) {
    await database.run(
      `INSERT INTO users
        (id, first_name, last_name, manager_grants, created_at, updated_at)
       VALUES (?, ?, 'Example', '[]', ?, ?)`,
      id,
      `User${id}`,
      timestamp,
      timestamp,
    )
  }
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Ridgeline IT', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  for (const [id, name] of [
    [1, 'Primary project'],
    [2, 'Other project'],
  ] as const) {
    await database.run(
      `INSERT INTO projects (id, client_id, name, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?)`,
      id,
      name,
      timestamp,
      timestamp,
    )
  }
  for (const [id, name] of [
    [1, 'Engineering'],
    [2, 'Design'],
  ] as const) {
    await database.run(
      `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      id,
      name,
      timestamp,
      timestamp,
    )
  }
  for (const [id, projectId, userId] of [
    [1, 1, 1],
    [2, 1, 2],
    [3, 2, 1],
  ] as const) {
    await database.run(
      `INSERT INTO user_assignments
        (id, project_id, user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      projectId,
      userId,
      timestamp,
      timestamp,
    )
  }
  for (const [id, projectId, taskId, billable] of [
    [1, 1, 1, 1],
    [2, 1, 2, 0],
    [3, 2, 1, 1],
  ] as const) {
    await database.run(
      `INSERT INTO task_assignments
        (id, project_id, task_id, billable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      taskId,
      billable,
      timestamp,
      timestamp,
    )
  }
}

const stoppedInput = (
  overrides: Partial<CreateStoppedTimeEntryInput> = {},
): CreateStoppedTimeEntryInput => ({
  ...baseInput,
  spentDate: '2026-08-27',
  seconds: 60,
  createdAt: timestamp,
  updatedAt: timestamp,
  ...overrides,
})

const startEndStoppedInput = (
  startedTime: string,
  endedTime: string,
): CreateStoppedTimeEntryInput => ({
  ...baseInput,
  spentDate: '2026-08-27',
  startedTime,
  endedTime,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const upRoundingCases = [
  ['up_6', 360],
  ['up_15', 900],
  ['up_30', 1_800],
] as const satisfies ReadonlyArray<readonly [TimeRounding, number]>

for (const [runtime, factory] of factories) {
  describe(`projects/time acceptance (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => {
      await database?.close()
      database = undefined
    })

    const setup = async (
      mode: 'duration' | 'start_end' = 'duration',
      rounding: TimeRounding = 'none',
    ): Promise<TestDatabase> => {
      database = await factory()
      await installFixture(database, mode, rounding)
      return database
    }

    it('[unit] [inv-01] rolls duration timers, preserves checkpoints, and rolls back a failed replacement', async () => {
      const db = await setup('duration', 'nearest_6')
      const first = await startTimeEntry(
        db.drizzle,
        baseInput,
        boundary('09:00', '2026-08-27T09:00:00.000Z'),
        false,
      )
      const second = await startTimeEntry(
        db.drizzle,
        { ...baseInput, taskId: 2, taskAssignmentId: 2 },
        boundary('09:03', '2026-08-27T09:03:00.000Z'),
        false,
      )

      expect(
        await db.rows<{
          id: number
          seconds: number
          seconds_without_timer: number
          rounded_seconds: number
          timer_started_at: string | null
          started_time: string | null
          ended_time: string | null
        }>(
          `SELECT id, seconds, seconds_without_timer, rounded_seconds,
                  timer_started_at, started_time, ended_time
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        {
          id: first.id,
          seconds: 180,
          seconds_without_timer: 180,
          rounded_seconds: 360,
          timer_started_at: null,
          started_time: null,
          ended_time: null,
        },
        {
          id: second.id,
          seconds: 0,
          seconds_without_timer: 0,
          rounded_seconds: 0,
          timer_started_at: '2026-08-27T09:03:00.000Z',
          started_time: null,
          ended_time: null,
        },
      ])

      await expect(
        startTimeEntry(
          db.drizzle,
          { ...baseInput, taskId: 2, taskAssignmentId: 2 },
          boundary('09:02', '2026-08-27T09:02:00.000Z'),
          false,
        ),
      ).rejects.toThrow()
      expect(
        await db.rows<{ id: number }>(
          `SELECT id FROM time_entries WHERE timer_started_at IS NOT NULL`,
        ),
      ).toEqual([{ id: second.id }])

      await expect(
        startTimeEntry(
          db.drizzle,
          { ...baseInput, userAssignmentId: 2 },
          boundary('09:05', '2026-08-27T09:05:00.000Z'),
          false,
        ),
      ).rejects.toThrow()
      expect(
        await db.rows<{
          id: number
          seconds: number
          seconds_without_timer: number
          timer_started_at: string | null
        }>(
          `SELECT id, seconds, seconds_without_timer, timer_started_at
           FROM time_entries
           WHERE timer_started_at IS NOT NULL
              OR (started_time IS NOT NULL AND ended_time IS NULL)`,
        ),
      ).toEqual([
        {
          id: second.id,
          seconds: 0,
          seconds_without_timer: 0,
          timer_started_at: '2026-08-27T09:03:00.000Z',
        },
      ])

      await stopTimeEntry(
        db.drizzle,
        second.id,
        boundary('09:06', '2026-08-27T09:06:00.000Z'),
        false,
      )

      const fractionalFirst = await startTimeEntry(
        db.drizzle,
        baseInput,
        boundary('09:10', '2026-08-27T09:10:00.900Z'),
        false,
      )
      await startTimeEntry(
        db.drizzle,
        { ...baseInput, taskId: 2, taskAssignmentId: 2 },
        boundary('09:10', '2026-08-27T09:10:01.100Z'),
        false,
      )
      expect(
        await db.rows<{ seconds: number }>(
          `SELECT seconds FROM time_entries WHERE id = ?`,
          fractionalFirst.id,
        ),
      ).toEqual([{ seconds: 0 }])
      expect(
        elapsedDurationSeconds(0, '2026-08-27T09:10:00.900Z', '2026-08-27T09:10:01.100Z'),
      ).toBe(0)

      const activeDuration = (
        await db.rows<{ id: number }>(
          `SELECT id FROM time_entries WHERE timer_started_at IS NOT NULL`,
        )
      )[0]!
      const stoppedAfterModeChange = await stopTimeEntry(
        db.drizzle,
        activeDuration.id,
        boundary('09:11', '2026-08-27T09:11:00.000Z'),
        false,
      )
      expect(stoppedAfterModeChange.timerStartedAt).toBeNull()

      const stopped = await createStoppedTimeEntry(db.drizzle, stoppedInput({ seconds: 120 }))
      const restarted = await restartTimeEntry(
        db.drizzle,
        stopped.id,
        boundary('10:00', '2026-08-27T10:00:00.000Z'),
        false,
        false,
      )
      expect(restarted.secondsWithoutTimer).toBe(120)
      const finalized = await stopTimeEntry(
        db.drizzle,
        stopped.id,
        boundary('10:02', '2026-08-27T10:02:00.000Z'),
        false,
      )
      expect(finalized).toMatchObject({
        seconds: 240,
        secondsWithoutTimer: 240,
        roundedSeconds: 360,
        timerStartedAt: null,
      })
    })

    it('[unit] rejects timestamps with more than millisecond precision', async () => {
      const db = await setup('duration')

      await expect(
        startTimeEntry(
          db.drizzle,
          baseInput,
          boundary('09:00', '2026-08-27T09:00:00.0001Z'),
          false,
        ),
      ).rejects.toThrow()
      expect(() =>
        elapsedDurationSeconds(0, '2026-08-27T09:00:00.1234Z', '2026-08-27T09:00:01.000Z'),
      ).toThrow()
      await expect(
        createStoppedTimeEntry(
          db.drizzle,
          stoppedInput({ createdAt: '2026-08-27T09:00:00.123456Z' }),
        ),
      ).rejects.toThrow()
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM time_entries`),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] rejects normalized-invalid timer timestamps written through direct SQL', async () => {
      const db = await setup('duration')
      for (const invalid of ['2026-02-30T09:00:00Z', '2026-08-27T24:00:00Z']) {
        await expect(
          db.run(
            `INSERT INTO time_entries
              (user_id, project_id, task_id, user_assignment_id, task_assignment_id,
               spent_date, seconds, seconds_without_timer, rounded_seconds,
               timer_started_at, billable, created_at, updated_at)
             VALUES (1, 1, 1, 1, 1, '2026-08-27', 0, 0, 0, ?, 1, ?, ?)`,
            invalid,
            timestamp,
            timestamp,
          ),
        ).rejects.toThrow()
      }
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM time_entries`),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] preserves exact safe upward-rounded totals through explicit JS stops', async () => {
      const db = await setup('duration')
      for (const [index, [policy, increment]] of upRoundingCases.entries()) {
        await db.run(`UPDATE organizations SET time_rounding = ? WHERE id = 1`, policy)
        const exactSafeMultiple = Math.floor(Number.MAX_SAFE_INTEGER / increment) * increment
        expect(Number.isSafeInteger(exactSafeMultiple)).toBe(true)
        expect(exactSafeMultiple % increment).toBe(0)
        const hour = String(9 + index).padStart(2, '0')
        const running = await startTimeEntry(
          db.drizzle,
          baseInput,
          boundary(`${hour}:00`, `2026-08-27T${hour}:00:00.000Z`),
          false,
        )
        await db.run(
          `UPDATE time_entries
           SET seconds = ?, seconds_without_timer = ?, rounded_seconds = ?
           WHERE id = ?`,
          exactSafeMultiple - 1,
          exactSafeMultiple - 1,
          exactSafeMultiple - 1,
          running.id,
        )

        const stopped = await stopTimeEntry(
          db.drizzle,
          running.id,
          boundary(`${hour}:00`, `2026-08-27T${hour}:00:01.000Z`),
          false,
        )
        expect(stopped).toMatchObject({
          seconds: exactSafeMultiple,
          secondsWithoutTimer: exactSafeMultiple,
          roundedSeconds: exactSafeMultiple,
          timerStartedAt: null,
        })
      }
    })

    it('[unit] preserves the same exact safe totals through trigger replacements', async () => {
      const db = await setup('duration')
      for (const [index, [policy, increment]] of upRoundingCases.entries()) {
        await db.run(`UPDATE organizations SET time_rounding = ? WHERE id = 1`, policy)
        const exactSafeMultiple = Math.floor(Number.MAX_SAFE_INTEGER / increment) * increment
        const hour = String(13 + index).padStart(2, '0')
        const running = await startTimeEntry(
          db.drizzle,
          baseInput,
          boundary(`${hour}:00`, `2026-08-27T${hour}:00:00.000Z`),
          false,
        )
        await db.run(
          `UPDATE time_entries
           SET seconds = ?, seconds_without_timer = ?, rounded_seconds = ?
           WHERE id = ?`,
          exactSafeMultiple - 1,
          exactSafeMultiple - 1,
          exactSafeMultiple - 1,
          running.id,
        )

        const replacement = await startTimeEntry(
          db.drizzle,
          { ...baseInput, taskId: 2, taskAssignmentId: 2 },
          boundary(`${hour}:00`, `2026-08-27T${hour}:00:01.000Z`),
          false,
        )
        expect(
          await db.rows<{
            seconds: number
            seconds_without_timer: number
            rounded_seconds: number
            timer_started_at: string | null
          }>(
            `SELECT seconds, seconds_without_timer, rounded_seconds, timer_started_at
             FROM time_entries WHERE id = ?`,
            running.id,
          ),
        ).toEqual([
          {
            seconds: exactSafeMultiple,
            seconds_without_timer: exactSafeMultiple,
            rounded_seconds: exactSafeMultiple,
            timer_started_at: null,
          },
        ])
        await stopTimeEntry(
          db.drizzle,
          replacement.id,
          boundary(`${hour}:00`, `2026-08-27T${hour}:00:02.000Z`),
          false,
        )
      }
    })

    it('[unit] blocks time-entry mode changes in both directions while a timer runs', async () => {
      const db = await setup('duration')
      const durationEntry = await startTimeEntry(
        db.drizzle,
        baseInput,
        boundary('09:00', '2026-08-27T09:00:00.000Z'),
        false,
      )

      await expect(
        db.run(`UPDATE organizations SET time_entry_mode = 'start_end' WHERE id = 1`),
      ).rejects.toThrow()
      expect(
        await db.rows<{ time_entry_mode: string }>(
          `SELECT time_entry_mode FROM organizations WHERE id = 1`,
        ),
      ).toEqual([{ time_entry_mode: 'duration' }])
      expect(
        await db.rows<{ timer_started_at: string | null }>(
          `SELECT timer_started_at FROM time_entries WHERE id = ?`,
          durationEntry.id,
        ),
      ).toEqual([{ timer_started_at: '2026-08-27T09:00:00.000Z' }])

      await stopTimeEntry(
        db.drizzle,
        durationEntry.id,
        boundary('09:05', '2026-08-27T09:05:00.000Z'),
        false,
      )
      await db.run(`UPDATE organizations SET time_entry_mode = 'start_end' WHERE id = 1`)
      expect(
        await db.rows<{ time_entry_mode: string }>(
          `SELECT time_entry_mode FROM organizations WHERE id = 1`,
        ),
      ).toEqual([{ time_entry_mode: 'start_end' }])

      const startEndEntry = await startTimeEntry(
        db.drizzle,
        baseInput,
        boundary('10:00', '2026-08-27T10:00:00.000Z'),
        false,
      )
      await expect(
        db.run(`UPDATE organizations SET time_entry_mode = 'duration' WHERE id = 1`),
      ).rejects.toThrow()
      expect(
        await db.rows<{
          time_entry_mode: string
          started_time: string | null
          ended_time: string | null
          timer_started_at: string | null
        }>(
          `SELECT organizations.time_entry_mode, time_entries.started_time,
                  time_entries.ended_time, time_entries.timer_started_at
           FROM organizations CROSS JOIN time_entries
           WHERE organizations.id = 1 AND time_entries.id = ?`,
          startEndEntry.id,
        ),
      ).toEqual([
        {
          time_entry_mode: 'start_end',
          started_time: '10:00',
          ended_time: null,
          timer_started_at: null,
        },
      ])

      await stopTimeEntry(
        db.drizzle,
        startEndEntry.id,
        boundary('10:05', '2026-08-27T10:05:00.000Z'),
        false,
      )
      await db.run(`UPDATE organizations SET time_entry_mode = 'duration' WHERE id = 1`)
      expect(
        await db.rows<{ time_entry_mode: string }>(
          `SELECT time_entry_mode FROM organizations WHERE id = 1`,
        ),
      ).toEqual([{ time_entry_mode: 'duration' }])
    })

    it('[unit] rejects overflowing auto-stop inserts and restarts without changing either row', async () => {
      const db = await setup('duration', 'none')
      const running = await startTimeEntry(
        db.drizzle,
        baseInput,
        boundary('09:00', '2026-08-27T09:00:00.000Z'),
        false,
      )
      await db.run(
        `UPDATE time_entries
         SET seconds = ?, seconds_without_timer = ?, rounded_seconds = ?
         WHERE id = ?`,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        running.id,
      )

      await expect(
        startTimeEntry(
          db.drizzle,
          { ...baseInput, taskId: 2, taskAssignmentId: 2 },
          boundary('09:00', '2026-08-27T09:00:01.000Z'),
          false,
        ),
      ).rejects.toThrow()
      expect(
        await db.rows<{
          id: number
          seconds: number
          seconds_without_timer: number
          rounded_seconds: number
          timer_started_at: string | null
        }>(
          `SELECT id, seconds, seconds_without_timer, rounded_seconds, timer_started_at
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        {
          id: running.id,
          seconds: Number.MAX_SAFE_INTEGER,
          seconds_without_timer: Number.MAX_SAFE_INTEGER,
          rounded_seconds: Number.MAX_SAFE_INTEGER,
          timer_started_at: '2026-08-27T09:00:00.000Z',
        },
      ])

      const stopped = await createStoppedTimeEntry(db.drizzle, stoppedInput({ seconds: 60 }))
      await expect(
        restartTimeEntry(
          db.drizzle,
          stopped.id,
          boundary('09:00', '2026-08-27T09:00:01.000Z'),
          false,
          false,
        ),
      ).rejects.toThrow()
      expect(
        await db.rows<{
          id: number
          seconds: number
          seconds_without_timer: number
          timer_started_at: string | null
        }>(
          `SELECT id, seconds, seconds_without_timer, timer_started_at
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        {
          id: running.id,
          seconds: Number.MAX_SAFE_INTEGER,
          seconds_without_timer: Number.MAX_SAFE_INTEGER,
          timer_started_at: '2026-08-27T09:00:00.000Z',
        },
        {
          id: stopped.id,
          seconds: 60,
          seconds_without_timer: 60,
          timer_started_at: null,
        },
      ])
    })

    it('[unit] [inv-02] stores canonical start/end timers without timer_started_at and accumulates checkpoints', async () => {
      const db = await setup('start_end', 'nearest_15')
      const first = await startTimeEntry(
        db.drizzle,
        baseInput,
        boundary('09:00', '2026-08-27T09:00:00.000Z'),
        false,
      )
      const second = await startTimeEntry(
        db.drizzle,
        { ...baseInput, taskId: 2, taskAssignmentId: 2 },
        boundary('09:30', '2026-08-27T09:30:00.000Z'),
        false,
      )
      expect(
        await db.rows<{
          id: number
          seconds: number
          seconds_without_timer: number
          rounded_seconds: number
          timer_started_at: string | null
          started_time: string
          ended_time: string | null
        }>(
          `SELECT id, seconds, seconds_without_timer, rounded_seconds,
                  timer_started_at, started_time, ended_time
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        {
          id: first.id,
          seconds: 1_800,
          seconds_without_timer: 1_800,
          rounded_seconds: 1_800,
          timer_started_at: null,
          started_time: '09:00',
          ended_time: '09:30',
        },
        {
          id: second.id,
          seconds: 0,
          seconds_without_timer: 0,
          rounded_seconds: 0,
          timer_started_at: null,
          started_time: '09:30',
          ended_time: null,
        },
      ])

      await stopTimeEntry(
        db.drizzle,
        second.id,
        boundary('10:00', '2026-08-27T10:00:00.000Z'),
        false,
      )
      const restarted = await restartTimeEntry(
        db.drizzle,
        first.id,
        boundary('11:00', '2026-08-27T11:00:00.000Z'),
        false,
        false,
      )
      expect(restarted).toMatchObject({
        seconds: 1_800,
        secondsWithoutTimer: 1_800,
        timerStartedAt: null,
        startedTime: '11:00',
        endedTime: null,
      })
      const finalized = await stopTimeEntry(
        db.drizzle,
        first.id,
        boundary('11:15', '2026-08-27T11:15:00.000Z'),
        false,
      )
      expect(finalized).toMatchObject({
        seconds: 2_700,
        secondsWithoutTimer: 2_700,
        roundedSeconds: 2_700,
        timerStartedAt: null,
        startedTime: '11:00',
        endedTime: '11:15',
      })

      const activeStartEnd = await startTimeEntry(
        db.drizzle,
        { ...baseInput, taskId: 2, taskAssignmentId: 2 },
        boundary('12:00', '2026-08-27T12:00:00.000Z'),
        false,
      )
      const stoppedAfterModeChange = await stopTimeEntry(
        db.drizzle,
        activeStartEnd.id,
        boundary('12:05', '2026-08-27T12:05:00.000Z'),
        false,
      )
      expect(stoppedAfterModeChange).toMatchObject({
        seconds: 300,
        timerStartedAt: null,
        endedTime: '12:05',
      })

      expect(elapsedWallClockSeconds(120, '2026-08-27', '23:59', '2026-08-28', '00:01')).toBe(240)
      const overnight = await createStoppedTimeEntry(
        db.drizzle,
        startEndStoppedInput('23:55', '00:05'),
      )
      expect(overnight).toMatchObject({
        seconds: 600,
        secondsWithoutTimer: 600,
        roundedSeconds: 900,
        timerStartedAt: null,
      })
      await expect(
        createStoppedTimeEntry(db.drizzle, startEndStoppedInput('9:00', '10:00')),
      ).rejects.toThrow(/canonical HH:MM/)
      expect(
        await db.rows<{ count: number }>(
          `SELECT count(*) AS count FROM time_entries WHERE timer_started_at IS NOT NULL`,
        ),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] rounds every supported policy at exact boundaries and stores the result', async () => {
      const db = await setup('duration')
      const cases: ReadonlyArray<readonly [TimeRounding, number, number]> = [
        ['none', 179, 179],
        ['none', 180, 180],
        ['none', 181, 181],
        ['nearest_6', 179, 0],
        ['nearest_6', 180, 360],
        ['nearest_6', 181, 360],
        ['nearest_15', 449, 0],
        ['nearest_15', 450, 900],
        ['nearest_15', 451, 900],
        ['nearest_30', 899, 0],
        ['nearest_30', 900, 1_800],
        ['nearest_30', 901, 1_800],
        ['up_6', 0, 0],
        ['up_6', 360, 360],
        ['up_6', 361, 720],
        ['up_15', 0, 0],
        ['up_15', 900, 900],
        ['up_15', 901, 1_800],
        ['up_30', 0, 0],
        ['up_30', 1_800, 1_800],
        ['up_30', 1_801, 3_600],
      ]

      for (const [policy, seconds, expected] of cases) {
        expect(roundSeconds(seconds, policy), `${policy}(${seconds})`).toBe(expected)
        await db.run(`UPDATE organizations SET time_rounding = ? WHERE id = 1`, policy)
        const entry = await createStoppedTimeEntry(db.drizzle, stoppedInput({ seconds }))
        expect(entry.roundedSeconds, `stored ${policy}(${seconds})`).toBe(expected)
      }
      expect(() => roundSeconds(-1, 'none')).toThrow(/non-negative/)
      expect(() => roundSeconds(1.5, 'up_6')).toThrow(/safe integer/)
      expect(() => roundSeconds(1, 'nearest_5' as TimeRounding)).toThrow(/unsupported/)
    })

    it('[unit] exposes two nullable rate snapshots and stages real invoice links only in 0004', async () => {
      const db = await setup('duration')
      const columns = await db.rows<{
        name: string
        notnull: number
        dflt_value: string | null
      }>(`PRAGMA table_info(time_entries)`)
      expect(
        columns
          .filter(({ name }) => name.endsWith('rate_cents'))
          .map(({ name, notnull, dflt_value: defaultValue }) => ({
            name,
            notnull,
            defaultValue,
          })),
      ).toEqual([
        { name: 'billable_rate_cents', notnull: 0, defaultValue: null },
        { name: 'cost_rate_cents', notnull: 0, defaultValue: null },
      ])

      const first = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      const second = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      await db.run(`UPDATE time_entries SET cost_rate_cents = 5000 WHERE id = ?`, first.id)
      await db.run(`UPDATE time_entries SET billable_rate_cents = 12500 WHERE id = ?`, second.id)
      expect(
        await db.rows<{
          billable_rate_cents: number | null
          cost_rate_cents: number | null
        }>(
          `SELECT billable_rate_cents, cost_rate_cents
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        { billable_rate_cents: null, cost_rate_cents: 5_000 },
        { billable_rate_cents: 12_500, cost_rate_cents: null },
      ])

      const bigintEntry = await createStoppedTimeEntry(
        db.drizzle,
        stoppedInput({ harvestId: '9007199254740993' }),
      )
      expect(bigintEntry.harvestId).toBe('9007199254740993')

      const milestoneColumns = await db.rows<{
        name: string
        notnull: number
        dflt_value: string | null
      }>(`PRAGMA table_info(project_milestones)`)
      const allNames = [...columns, ...milestoneColumns].map(({ name }) => name)
      expect(columns.find(({ name }) => name === 'invoice_id')).toMatchObject({
        notnull: 0,
        dflt_value: null,
      })
      expect(milestoneColumns.find(({ name }) => name === 'invoiced_invoice_id')).toMatchObject({
        notnull: 0,
        dflt_value: null,
      })
      for (const forbidden of ['is_locked', 'locked_reason']) {
        expect(allNames).not.toContain(forbidden)
      }
      const definitions = await db.rows<{ sql: string | null }>(
        `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL`,
      )
      expect(definitions.map(({ sql }) => sql).join('\n')).not.toMatch(
        /\b(?:is_locked|locked_reason)\b/,
      )
      expect(projectsTimeMigration.join('\n')).not.toMatch(
        /\b(?:invoice_id|invoiced_invoice_id|is_locked|locked_reason)\b/,
      )
    })

    it('[unit] round-trips project tags, rejects duplicates, and enforces assignment identity', async () => {
      const db = await setup('duration')
      await db.run(
        `INSERT INTO project_tags (id, name, created_at, updated_at)
         VALUES (1, 'priority', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO project_tag_assignments
          (project_id, project_tag_id, created_at, updated_at)
         VALUES (1, 1, ?, ?)`,
        timestamp,
        timestamp,
      )
      expect(
        await db.rows<{ project: string; tag: string }>(
          `SELECT projects.name AS project, project_tags.name AS tag
           FROM project_tag_assignments
           JOIN projects ON projects.id = project_tag_assignments.project_id
           JOIN project_tags ON project_tags.id = project_tag_assignments.project_tag_id`,
        ),
      ).toEqual([{ project: 'Primary project', tag: 'priority' }])
      await expect(
        db.run(
          `INSERT INTO project_tag_assignments
            (project_id, project_tag_id, created_at, updated_at)
           VALUES (1, 1, ?, ?)`,
          timestamp,
          timestamp,
        ),
      ).rejects.toThrow(/UNIQUE constraint|PRIMARY KEY/i)
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM project_tag_assignments`),
      ).toEqual([{ count: 1 }])

      await expect(
        createStoppedTimeEntry(db.drizzle, stoppedInput({ userAssignmentId: 2 })),
      ).rejects.toThrow()
      await expect(
        createStoppedTimeEntry(db.drizzle, stoppedInput({ taskId: 2, taskAssignmentId: 1 })),
      ).rejects.toThrow()
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM time_entries`),
      ).toEqual([{ count: 0 }])
    })

    it('[unit] upgrades a populated 0001 database and keeps the ordered ledger idempotent', async () => {
      database = await factory(false)
      const db = database
      await db.run(
        `CREATE TABLE _ezacto_migrations (
          id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
        ) STRICT`,
      )
      for (const statement of orgPeopleMigration) await db.run(statement)
      for (const statement of clientsMigration) await db.run(statement)
      const originalAppliedAt = '2000-01-01T00:00:00.000Z'
      await db.run(
        `INSERT INTO _ezacto_migrations (id, applied_at) VALUES
          ('0000_org_people', ?), ('0001_clients', ?)`,
        originalAppliedAt,
        originalAppliedAt,
      )
      await db.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at)
         VALUES ('Existing organization', ?, ?, ?)`,
        modules,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO users
          (id, first_name, last_name, manager_grants, created_at, updated_at)
         VALUES (42, 'Existing', 'User', '[]', ?, ?)`,
        timestamp,
        timestamp,
      )
      await db.run(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (7, 'Existing client', 'USD', ?, ?)`,
        timestamp,
        timestamp,
      )

      await db.migrateAgain()
      const firstLedger = await db.rows<{ id: string; applied_at: string }>(
        `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
      )
      expect(firstLedger.map(({ id }) => id)).toEqual([
        '0000_org_people',
        '0001_clients',
        '0002_projects_time',
        '0003_rate_resolver',
        '0004_invoice_foundation',
        '0005_invoice_payments_totals',
        '0006_invoice_state_events',
        '0007_expenses',
        '0008_retainer_ledger',
        '0009_three_axis_state',
        '0010_recurring_invoices',
        '0011_api_tokens',
        '0012_instance_bootstrap',
        '0013_password_auth',
        '0014_sessions',
        '0015_oidc_transactions',
        '0016_email_log',
        '0017_email_delivery_details',
        '0018_estimates',
        '0019_attachments',
        '0020_argon2_passwords',
        '0021_estimate_commands',
        '0022_resource_create_commands',
        '0023_migration_import_authority',
        '0024_migration_worksheet_completions',
        '0025_time_entry_note_requirements',
        '0026_invoice_generation',
        '0027_timesheet_approvals',
        '0028_timesheet_lock_policy',
        '0029_outbox_delivery',
        '0030_email_templates',
        '0031_team_people',
        '0032_invoice_email_delivery',
        '0033_contact_portal',
        '0035_backup_runs',
        '0036_client_budgets',
      ])
      expect(firstLedger.slice(0, 2).map(({ applied_at: appliedAt }) => appliedAt)).toEqual([
        originalAppliedAt,
        originalAppliedAt,
      ])
      expect(
        await db.rows<{ organization: string; client: string }>(
          `SELECT organizations.name AS organization, clients.name AS client
           FROM organizations CROSS JOIN clients`,
        ),
      ).toEqual([{ organization: 'Existing organization', client: 'Existing client' }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('projects', 'time_entries') ORDER BY name`,
        ),
      ).toEqual([{ name: 'projects' }, { name: 'time_entries' }])

      await db.migrateAgain()
      expect(
        await db.rows<{ id: string; applied_at: string }>(
          `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
        ),
      ).toEqual(firstLedger)
    }, 15_000)

    it('[unit] rolls back a failed 0002 migration and retries without partial schema', async () => {
      database = await factory(false)
      const db = database
      await db.run(
        `CREATE TABLE _ezacto_migrations (
          id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
        ) STRICT`,
      )
      for (const statement of orgPeopleMigration) await db.run(statement)
      for (const statement of clientsMigration) await db.run(statement)
      await db.run(
        `INSERT INTO _ezacto_migrations (id, applied_at) VALUES
          ('0000_org_people', ?), ('0001_clients', ?)`,
        timestamp,
        timestamp,
      )
      await db.run(`CREATE TABLE tasks (id INTEGER PRIMARY KEY) STRICT`)

      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual([{ id: '0000_org_people' }, { id: '0001_clients' }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name IN ('projects', 'project_tags', 'time_entries') ORDER BY name`,
        ),
      ).toEqual([])

      await db.run(`DROP TABLE tasks`)
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual([
        { id: '0000_org_people' },
        { id: '0001_clients' },
        { id: '0002_projects_time' },
        { id: '0003_rate_resolver' },
        { id: '0004_invoice_foundation' },
        { id: '0005_invoice_payments_totals' },
        { id: '0006_invoice_state_events' },
        { id: '0007_expenses' },
        { id: '0008_retainer_ledger' },
        { id: '0009_three_axis_state' },
        { id: '0010_recurring_invoices' },
        { id: '0011_api_tokens' },
        { id: '0012_instance_bootstrap' },
        { id: '0013_password_auth' },
        { id: '0014_sessions' },
        { id: '0015_oidc_transactions' },
        { id: '0016_email_log' },
        { id: '0017_email_delivery_details' },
        { id: '0018_estimates' },
        { id: '0019_attachments' },
        { id: '0020_argon2_passwords' },
        { id: '0021_estimate_commands' },
        { id: '0022_resource_create_commands' },
        { id: '0023_migration_import_authority' },
        { id: '0024_migration_worksheet_completions' },
        { id: '0025_time_entry_note_requirements' },
        { id: '0026_invoice_generation' },
        { id: '0027_timesheet_approvals' },
        { id: '0028_timesheet_lock_policy' },
        { id: '0029_outbox_delivery' },
        { id: '0030_email_templates' },
        { id: '0031_team_people' },
        { id: '0032_invoice_email_delivery' },
        { id: '0033_contact_portal' },
        { id: '0035_backup_runs' },
        { id: '0036_client_budgets' },
      ])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN ('projects', 'tasks', 'time_entries') ORDER BY name`,
        ),
      ).toEqual([{ name: 'projects' }, { name: 'tasks' }, { name: 'time_entries' }])
    }, 15_000)
  })
}
