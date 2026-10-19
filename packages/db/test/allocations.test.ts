import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import {
  AllocationNotFoundError,
  AllocationOverlapError,
  TrackedResourceInputError,
  type TeamViewer,
  type UserProfile,
} from '@ezacto/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { DrizzleAllocationRepository } from '../src/allocations.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

/**
 * Issue 1007, slices 1 and 2. A plan is not work: planned hours live in their
 * own table, every write leaves an outbox event for the activity log in the
 * same batch, and the capacity read only sets the plan beside what was tracked.
 * Each case runs on both runtimes because the write and its event are one
 * transaction (better-sqlite3) or one batch (D1).
 */

interface TestDatabase {
  orm: ReturnType<typeof createContainerDatabase>
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-10-05T12:00:00.000Z'
const t1 = '2026-10-06T12:00:00.000Z'
const hours = (count: number) => count * 3_600

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
    orm: createD1Database(d1) as unknown as ReturnType<typeof createContainerDatabase>,
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

const viewer = (userId: number, profile: UserProfile): TeamViewer => ({
  userId,
  profile,
  managerGrants: [],
})
const ada = viewer(10, 'administrator')
const pia = viewer(2, 'project_manager') // manages project 1 only
const maya = viewer(1, 'member')
const milo = viewer(6, 'member')
const gus = viewer(4, 'executive_manager')

/**
 * Ada (10) administers. Pia (2) is a project manager of project 1. Maya (1) and
 * Milo (6) are members on project 1; Maya has a part-time week of 20 hours and
 * Milo is on project 2 only. Pat (3) is archived. Project 3 is archived. The
 * organization starts its week on Monday.
 */
const installFixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, week_start_day, modules, created_at, updated_at)
     VALUES ('Fictional Studio', 'monday', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, is_active, weekly_capacity, created_at, updated_at)
     VALUES
      (10, 'Ada', 'Admin', 'administrator', '[]', 1, 126000, ?, ?),
      (2, 'Pia', 'Manager', 'project_manager', '[]', 1, 126000, ?, ?),
      (4, 'Gus', 'Exec', 'executive_manager', '[]', 1, 126000, ?, ?),
      (1, 'Maya', 'Member', 'member', '[]', 1, 72000, ?, ?),
      (6, 'Milo', 'Member', 'member', '[]', 1, 126000, ?, ?),
      (3, 'Pat', 'Gone', 'member', '[]', 0, 126000, ?, ?)`,
    ...Array(12).fill(t0),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Fictional Client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, bill_by, is_active, created_at, updated_at)
     VALUES (1, 1, 'Alpha', 'people', 1, ?, ?), (2, 1, 'Beta', 'people', 1, ?, ?),
            (3, 1, 'Closed', 'people', 0, ?, ?)`,
    ...Array(6).fill(t0),
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Work', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 2, 1, ?, ?), (2, 1, 1, 0, ?, ?), (3, 2, 6, 0, ?, ?)`,
    ...Array(6).fill(t0),
  )
  await db.run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
}

interface OutboxRow {
  aggregate_id: number
  aggregate_sequence: number
  event_type: string
  payload_json: string
}

const events = (db: TestDatabase) =>
  db.rows<OutboxRow>(
    `SELECT aggregate_id, aggregate_sequence, event_type, payload_json FROM event_outbox
     WHERE aggregate_type = 'allocation' ORDER BY aggregate_id, aggregate_sequence`,
  )

const plan = (overrides: Partial<Parameters<DrizzleAllocationRepository['create']>[1]> = {}) => ({
  userId: 1,
  projectId: 1,
  startDate: '2026-10-05',
  endDate: '2026-10-25',
  plannedSecondsPerWeek: hours(16),
  ...overrides,
})

let open: TestDatabase | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
})

const setup = async (factory: () => Promise<TestDatabase>) => {
  const db = await factory()
  open = db
  await installFixture(db)
  return { db, repository: new DrizzleAllocationRepository(db.orm) }
}

for (const [runtime, factory] of factories) {
  describe(`allocations on ${runtime} (issue 1007)`, () => {
    it('[container/D1] an administrator plans a week and the activity log hears of it', async () => {
      const { db, repository } = await setup(factory)
      const created = await repository.create(ada, plan(), t0)
      expect(created).toMatchObject({
        userId: 1,
        projectId: 1,
        startDate: '2026-10-05',
        endDate: '2026-10-25',
        plannedSecondsPerWeek: hours(16),
      })
      const [event, ...rest] = await events(db)
      expect(rest).toEqual([])
      expect(event).toMatchObject({
        aggregate_id: created.id,
        aggregate_sequence: 1,
        event_type: 'allocation.created',
      })
      expect(JSON.parse(event!.payload_json)).toMatchObject({
        aggregate: { type: 'allocation', id: created.id, sequence: 1 },
        actor: { type: 'user', id: 10 },
        allocation: {
          before: null,
          after: { id: created.id, user_id: 1, project_id: 1, planned_seconds_per_week: hours(16) },
        },
      })
    })

    it('[container/D1] planned hours never touch time entries or invoices', async () => {
      const { db, repository } = await setup(factory)
      await repository.create(ada, plan(), t0)
      expect(await db.rows('SELECT id FROM time_entries')).toEqual([])
      expect(await db.rows('SELECT id FROM invoices')).toEqual([])
    })

    it('[container/D1] refuses a backwards range, a bad figure and an overlap on the same project', async () => {
      const { db, repository } = await setup(factory)
      await expect(repository.create(ada, plan({ endDate: '2026-10-04' }), t0)).rejects.toMatchObject({
        field: 'end_date',
        reasonCode: 'invalid_range',
      })
      await expect(
        repository.create(ada, plan({ plannedSecondsPerWeek: 0 }), t0),
      ).rejects.toBeInstanceOf(TrackedResourceInputError)
      await expect(
        repository.create(ada, plan({ plannedSecondsPerWeek: hours(169) }), t0),
      ).rejects.toBeInstanceOf(TrackedResourceInputError)
      await expect(
        repository.create(ada, plan({ startDate: '2026-02-30' }), t0),
      ).rejects.toMatchObject({ reasonCode: 'invalid_date' })
      await repository.create(ada, plan(), t0)
      await expect(
        repository.create(ada, plan({ startDate: '2026-10-25', endDate: '2026-11-01' }), t0),
      ).rejects.toBeInstanceOf(AllocationOverlapError)
      // Another project may overlap freely, and so may the day after the range ends.
      await repository.create(ada, plan({ projectId: 2 }), t0)
      await repository.create(ada, plan({ startDate: '2026-10-26', endDate: '2026-11-01' }), t0)
      // Refusals left no events behind.
      expect(await events(db)).toHaveLength(3)
    })

    it('[container/D1] refuses an archived or unknown person or project', async () => {
      const { repository } = await setup(factory)
      await expect(repository.create(ada, plan({ userId: 3 }), t0)).rejects.toMatchObject({
        field: 'user_id',
        reasonCode: 'inactive_user',
      })
      await expect(repository.create(ada, plan({ projectId: 3 }), t0)).rejects.toMatchObject({
        field: 'project_id',
        reasonCode: 'inactive_project',
      })
      await expect(repository.create(ada, plan({ userId: 99 }), t0)).rejects.toMatchObject({
        reasonCode: 'unknown_user',
      })
      await expect(repository.create(ada, plan({ projectId: 99 }), t0)).rejects.toMatchObject({
        reasonCode: 'unknown_project',
      })
    })

    it('[container/D1] an update and a delete are audited', async () => {
      const { db, repository } = await setup(factory)
      const created = await repository.create(ada, plan(), t0)
      const updated = await repository.update(ada, created.id, { plannedSecondsPerWeek: hours(8) }, t1)
      expect(updated).toMatchObject({ plannedSecondsPerWeek: hours(8), updatedAt: t1 })
      await expect(
        repository.update(ada, created.id, { endDate: '2026-10-01' }, t1),
      ).rejects.toMatchObject({ reasonCode: 'invalid_range' })
      await repository.delete(ada, created.id, t1)
      await expect(repository.get(ada, created.id)).rejects.toBeInstanceOf(AllocationNotFoundError)
      expect((await events(db)).map((event) => [event.aggregate_sequence, event.event_type])).toEqual([
        [1, 'allocation.created'],
        [2, 'allocation.updated'],
        [3, 'allocation.deleted'],
      ])
      const deleted = JSON.parse((await events(db))[2]!.payload_json)
      expect(deleted.allocation.after).toBeNull()
      expect(deleted.allocation.before).toMatchObject({ planned_seconds_per_week: hours(8) })
      await expect(repository.delete(ada, created.id, t1)).rejects.toBeInstanceOf(AllocationNotFoundError)
    })

    it('[container/D1] a person archived later can still have a plan removed', async () => {
      const { db, repository } = await setup(factory)
      const created = await repository.create(ada, plan(), t0)
      await db.run('UPDATE users SET is_active = 0 WHERE id = 1')
      await expect(
        repository.update(ada, created.id, { plannedSecondsPerWeek: hours(8) }, t1),
      ).rejects.toMatchObject({ reasonCode: 'inactive_user' })
      await repository.delete(ada, created.id, t1)
      expect(await db.rows('SELECT id FROM allocations')).toEqual([])
    })

    it('[container/D1] a project manager plans only inside what they manage', async () => {
      const { repository } = await setup(factory)
      // Maya is on Pia's project; Milo is not, and project 2 is not Pia's.
      const mine = await repository.create(pia, plan(), t0)
      await expect(repository.create(pia, plan({ userId: 6 }), t0)).rejects.toMatchObject({
        reasonCode: 'unknown_user',
      })
      await expect(repository.create(pia, plan({ projectId: 2 }), t0)).rejects.toMatchObject({
        reasonCode: 'unknown_project',
      })
      const theirs = await repository.create(ada, plan({ userId: 6, projectId: 2 }), t0)
      await expect(repository.update(pia, theirs.id, { plannedSecondsPerWeek: 3_600 }, t1)).rejects.toBeInstanceOf(
        AllocationNotFoundError,
      )
      await expect(repository.delete(pia, theirs.id, t1)).rejects.toBeInstanceOf(AllocationNotFoundError)
      await expect(repository.get(pia, theirs.id)).rejects.toBeInstanceOf(AllocationNotFoundError)
      await expect(repository.get(pia, mine.id)).resolves.toMatchObject({ id: mine.id })
    })

    it('[container/D1] a member reads only their own plan and cannot write', async () => {
      const { repository } = await setup(factory)
      const own = await repository.create(ada, plan(), t0)
      const other = await repository.create(ada, plan({ userId: 6, projectId: 2 }), t0)
      const listed = async (who: TeamViewer) => {
        const source = repository.allocations(who, {})
        const through = await source.highWatermark()
        return (await source.list({ afterId: null, throughId: through ?? 0, take: 50 })).map(
          (row) => row.id,
        )
      }
      expect(await listed(maya)).toEqual([own.id])
      expect(await listed(milo)).toEqual([other.id])
      expect(await listed(ada)).toEqual([own.id, other.id])
      expect(await listed(gus)).toEqual([own.id, other.id])
      expect(await listed(pia)).toEqual([own.id])
      await expect(repository.get(maya, other.id)).rejects.toBeInstanceOf(AllocationNotFoundError)
      await expect(repository.create(maya, plan(), t0)).rejects.toBeInstanceOf(AllocationNotFoundError)
      await expect(repository.update(maya, own.id, { plannedSecondsPerWeek: 3_600 }, t1)).rejects.toBeInstanceOf(
        AllocationNotFoundError,
      )
      await expect(repository.delete(maya, own.id, t1)).rejects.toBeInstanceOf(AllocationNotFoundError)
    })

    it('[container/D1] filters by person, project and the dates a plan reaches', async () => {
      const { repository } = await setup(factory)
      const a = await repository.create(ada, plan(), t0)
      const b = await repository.create(
        ada,
        plan({ projectId: 2, startDate: '2026-12-01', endDate: '2026-12-31' }),
        t0,
      )
      const ids = async (filters: Parameters<DrizzleAllocationRepository['allocations']>[1]) => {
        const source = repository.allocations(ada, filters)
        const through = await source.highWatermark()
        return (await source.list({ afterId: null, throughId: through ?? 0, take: 50 })).map(
          (row) => row.id,
        )
      }
      expect(await ids({ projectId: 2 })).toEqual([b.id])
      expect(await ids({ from: '2026-11-01' })).toEqual([b.id])
      expect(await ids({ to: '2026-11-01' })).toEqual([a.id])
      expect(await ids({ userId: 6 })).toEqual([])
    })
  })

  describe(`capacity on ${runtime} (issue 1007)`, () => {
    const entry = (id: number, userId: number, date: string, seconds: number) =>
      [
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
          spent_date, seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at
        ) VALUES (?, ?, 1, 1, 2, 1, ?, ?, ?, ?, 1, ?, ?)`,
        id,
        userId,
        date,
        seconds,
        seconds,
        seconds,
        t0,
        t0,
      ] as const

    it('[container/D1] sets plan beside capacity and tracked time, week by week from the week start day', async () => {
      const { db, repository } = await setup(factory)
      // Weeks start on Monday: 5 Oct, 12 Oct, 19 Oct, 26 Oct. The range starts on a
      // Wednesday and ends on a Tuesday, so it touches 5 Oct through 26 Oct.
      await repository.create(ada, plan({ startDate: '2026-10-07', endDate: '2026-10-21' }), t0)
      await repository.create(ada, plan({ projectId: 2, plannedSecondsPerWeek: hours(8), startDate: '2026-10-12', endDate: '2026-10-18' }), t0)
      await db.run(...entry(1, 1, '2026-10-06', hours(5)))
      await db.run(...entry(2, 1, '2026-10-11', hours(2)))
      await db.run(...entry(3, 1, '2026-10-12', hours(3)))
      const report = await repository.capacity(ada, { from: '2026-10-07', to: '2026-10-27' })
      expect(report.weekStartDay).toBe('monday')
      expect(report.weeks).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'])
      const maya = report.people.find((person) => person.userId === 1)!
      // Part-time: Maya's capacity is her own 20 hours, not the organization's.
      expect(maya.weeklyCapacitySeconds).toBe(hours(20))
      expect(maya.weeks.map((week) => [week.weekStart, week.plannedSeconds, week.trackedSeconds, week.overAllocated])).toEqual([
        ['2026-10-05', hours(16), hours(7), false],
        // 16 + 8 hours against 20: over-allocated, and still allowed.
        ['2026-10-12', hours(24), hours(3), true],
        ['2026-10-19', hours(16), 0, false],
        ['2026-10-26', 0, 0, false],
      ])
    })

    it('[container/D1] leaves out archived people and plans on archived projects, and lists the unplanned', async () => {
      const { db, repository } = await setup(factory)
      await repository.create(ada, plan(), t0)
      // A project archived after it was planned drops out of the figures.
      await db.run('UPDATE projects SET is_active = 0 WHERE id = 1')
      const report = await repository.capacity(ada, { from: '2026-10-05', to: '2026-10-11' })
      expect(report.people.map((person) => person.userId)).toEqual([10, 4, 1, 6, 2])
      expect(report.people.every((person) => person.weeks[0]!.plannedSeconds === 0)).toBe(true)
      expect(report.people.some((person) => person.userId === 3)).toBe(false)
    })

    it('[container/D1] a member sees only themselves; a project manager only the people they manage', async () => {
      const { repository } = await setup(factory)
      await repository.create(ada, plan(), t0)
      await repository.create(ada, plan({ userId: 6, projectId: 2 }), t0)
      const range = { from: '2026-10-05', to: '2026-10-11' }
      expect((await repository.capacity(maya, range)).people.map((person) => person.userId)).toEqual([1])
      expect((await repository.capacity(milo, range)).people.map((person) => person.userId)).toEqual([6])
      // Pia manages project 1, so sees herself and Maya, not Milo, Ada or Gus.
      expect((await repository.capacity(pia, range)).people.map((person) => person.userId)).toEqual([1, 2])
      expect((await repository.capacity(gus, range)).people).toHaveLength(5)
    })

    it('[container/D1] refuses a backwards range and one wider than a year', async () => {
      const { repository } = await setup(factory)
      await expect(
        repository.capacity(ada, { from: '2026-10-12', to: '2026-10-05' }),
      ).rejects.toMatchObject({ reasonCode: 'invalid_range' })
      await expect(
        repository.capacity(ada, { from: '2026-01-01', to: '2027-12-31' }),
      ).rejects.toMatchObject({ reasonCode: 'range_too_wide' })
    })
  })
}
