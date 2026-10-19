import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import {
  TimeOffNotFoundError,
  TimeOffOverlapError,
  TrackedResourceInputError,
  type TeamViewer,
  type UserProfile,
} from '@ezacto/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { DrizzleAllocationRepository } from '../src/allocations.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

/**
 * Issue 1007, slice 3. Time off is entered by an administrator, never requested
 * or approved. It lives in its own table, every write leaves an outbox event in
 * the same transaction, and the capacity read subtracts it without ever
 * refusing a plan. Each case runs on both runtimes.
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

/**
 * Ada (10) administers. Pia (2) manages project 1. Maya (1, a 20 hour week) is
 * on project 1; Milo (6) is on project 2 only. Pat (3) is archived. Weeks start
 * on Monday.
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
      (1, 'Maya', 'Member', 'member', '[]', 1, 72000, ?, ?),
      (6, 'Milo', 'Member', 'member', '[]', 1, 126000, ?, ?),
      (3, 'Pat', 'Gone', 'member', '[]', 0, 126000, ?, ?)`,
    ...Array(10).fill(t0),
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Fictional Client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, bill_by, is_active, created_at, updated_at)
     VALUES (1, 1, 'Alpha', 'people', 1, ?, ?), (2, 1, 'Beta', 'people', 1, ?, ?)`,
    ...Array(4).fill(t0),
  )
  await db.run(
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 2, 1, ?, ?), (2, 1, 1, 0, ?, ?), (3, 2, 6, 0, ?, ?)`,
    ...Array(6).fill(t0),
  )
}

const away = (overrides: Record<string, unknown> = {}) => ({
  userId: 1,
  startDate: '2026-10-12',
  endDate: '2026-10-14',
  kind: 'vacation' as const,
  secondsPerDay: null,
  ...overrides,
})

const plan = (overrides: Record<string, unknown> = {}) => ({
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
  const repository = new DrizzleAllocationRepository(db.orm)
  return { db, repository, timeOff: repository.timeOff }
}

const eventsOf = (db: TestDatabase) =>
  db.rows<{ aggregate_sequence: number; event_type: string; payload_json: string }>(
    `SELECT aggregate_sequence, event_type, payload_json FROM event_outbox
     WHERE aggregate_type = 'time_off' ORDER BY aggregate_id, aggregate_sequence`,
  )

const listed = async (
  timeOff: DrizzleAllocationRepository['timeOff'],
  who: TeamViewer,
  filters: Parameters<DrizzleAllocationRepository['timeOff']['entries']>[1] = {},
) => {
  const source = timeOff.entries(who, filters)
  const through = await source.highWatermark()
  return (await source.list({ afterId: null, throughId: through ?? 0, take: 50 })).map((row) => row.id)
}

for (const [runtime, factory] of factories) {
  describe(`time off on ${runtime} (issue 1007)`, () => {
    it('[container/D1] an administrator enters time off and the activity log hears of it', async () => {
      const { db, timeOff } = await setup(factory)
      const created = await timeOff.create(ada, away(), t0)
      expect(created).toMatchObject({
        userId: 1,
        startDate: '2026-10-12',
        endDate: '2026-10-14',
        kind: 'vacation',
        secondsPerDay: null,
      })
      const [event, ...rest] = await eventsOf(db)
      expect(rest).toEqual([])
      expect(event).toMatchObject({ aggregate_sequence: 1, event_type: 'time_off.created' })
      expect(JSON.parse(event!.payload_json)).toMatchObject({
        aggregate: { type: 'time_off', id: created.id, sequence: 1 },
        actor: { type: 'user', id: 10 },
        time_off: { before: null, after: { id: created.id, user_id: 1, kind: 'vacation' } },
      })
    })

    it('[container/D1] time off never touches time entries or invoices', async () => {
      const { db, timeOff } = await setup(factory)
      await timeOff.create(ada, away(), t0)
      expect(await db.rows('SELECT id FROM time_entries')).toEqual([])
      expect(await db.rows('SELECT id FROM invoices')).toEqual([])
    })

    it('[container/D1] refuses bad fields, an archived person and overlapping time off', async () => {
      const { db, timeOff } = await setup(factory)
      await expect(timeOff.create(ada, away({ endDate: '2026-10-11' }), t0)).rejects.toMatchObject({
        field: 'end_date',
        reasonCode: 'invalid_range',
      })
      await expect(timeOff.create(ada, away({ kind: 'sabbatical' }), t0)).rejects.toMatchObject({
        field: 'kind',
      })
      await expect(timeOff.create(ada, away({ secondsPerDay: 0 }), t0)).rejects.toBeInstanceOf(
        TrackedResourceInputError,
      )
      await expect(timeOff.create(ada, away({ userId: 3 }), t0)).rejects.toMatchObject({
        reasonCode: 'inactive_user',
      })
      await expect(timeOff.create(ada, away({ userId: 99 }), t0)).rejects.toMatchObject({
        reasonCode: 'unknown_user',
      })
      await timeOff.create(ada, away(), t0)
      await expect(
        timeOff.create(ada, away({ startDate: '2026-10-14', endDate: '2026-10-20' }), t0),
      ).rejects.toBeInstanceOf(TimeOffOverlapError)
      // Another person may be away the same days, and so may the day after the range.
      await timeOff.create(ada, away({ userId: 6 }), t0)
      await timeOff.create(ada, away({ startDate: '2026-10-15', endDate: '2026-10-15' }), t0)
      // Refusals left no events behind.
      expect(await eventsOf(db)).toHaveLength(3)
    })

    it('[container/D1] an update and a delete are audited, and an overlap on update is refused', async () => {
      const { db, timeOff } = await setup(factory)
      const first = await timeOff.create(ada, away(), t0)
      const second = await timeOff.create(
        ada,
        away({ startDate: '2026-10-19', endDate: '2026-10-20', kind: 'sick' }),
        t0,
      )
      const updated = await timeOff.update(ada, first.id, { secondsPerDay: hours(4) }, t1)
      expect(updated).toMatchObject({ secondsPerDay: hours(4), updatedAt: t1 })
      await expect(
        timeOff.update(ada, second.id, { startDate: '2026-10-14' }, t1),
      ).rejects.toBeInstanceOf(TimeOffOverlapError)
      await timeOff.delete(ada, first.id, t1)
      await expect(timeOff.get(ada, first.id)).rejects.toBeInstanceOf(TimeOffNotFoundError)
      const kinds = (await eventsOf(db)).map((event) => event.event_type)
      expect(kinds).toEqual([
        'time_off.created',
        'time_off.updated',
        'time_off.deleted',
        'time_off.created',
      ])
    })

    it('[container/D1] a project manager enters time off only for the people they manage', async () => {
      const { timeOff } = await setup(factory)
      // Maya is on Pia's project; Milo is not.
      const mine = await timeOff.create(pia, away(), t0)
      await expect(timeOff.create(pia, away({ userId: 6 }), t0)).rejects.toMatchObject({
        reasonCode: 'unknown_user',
      })
      const theirs = await timeOff.create(ada, away({ userId: 6 }), t0)
      await expect(timeOff.update(pia, theirs.id, { kind: 'sick' }, t1)).rejects.toBeInstanceOf(
        TimeOffNotFoundError,
      )
      await expect(timeOff.get(pia, theirs.id)).rejects.toBeInstanceOf(TimeOffNotFoundError)
      await expect(timeOff.get(pia, mine.id)).resolves.toMatchObject({ id: mine.id })
    })

    it('[container/D1] a member reads only their own time off and cannot write', async () => {
      const { timeOff } = await setup(factory)
      const own = await timeOff.create(ada, away(), t0)
      const other = await timeOff.create(ada, away({ userId: 6 }), t0)
      expect(await listed(timeOff, maya)).toEqual([own.id])
      expect(await listed(timeOff, milo)).toEqual([other.id])
      expect(await listed(timeOff, ada)).toEqual([own.id, other.id])
      expect(await listed(timeOff, pia)).toEqual([own.id])
      await expect(timeOff.get(maya, other.id)).rejects.toBeInstanceOf(TimeOffNotFoundError)
      await expect(timeOff.create(maya, away(), t0)).rejects.toBeInstanceOf(TimeOffNotFoundError)
      await expect(timeOff.update(maya, own.id, { kind: 'sick' }, t1)).rejects.toBeInstanceOf(
        TimeOffNotFoundError,
      )
      await expect(timeOff.delete(maya, own.id, t1)).rejects.toBeInstanceOf(TimeOffNotFoundError)
    })

    it('[container/D1] filters by person and the dates the time off reaches', async () => {
      const { timeOff } = await setup(factory)
      const a = await timeOff.create(ada, away(), t0)
      const b = await timeOff.create(
        ada,
        away({ startDate: '2026-12-21', endDate: '2026-12-31' }),
        t0,
      )
      expect(await listed(timeOff, ada, { from: '2026-11-01' })).toEqual([b.id])
      expect(await listed(timeOff, ada, { to: '2026-11-01' })).toEqual([a.id])
      expect(await listed(timeOff, ada, { userId: 6 })).toEqual([])
    })

    it('[container/D1] a person archived later can still have time off removed', async () => {
      const { db, timeOff } = await setup(factory)
      const created = await timeOff.create(ada, away(), t0)
      await db.run('UPDATE users SET is_active = 0 WHERE id = 1')
      await expect(timeOff.update(ada, created.id, { kind: 'sick' }, t1)).rejects.toMatchObject({
        reasonCode: 'inactive_user',
      })
      await timeOff.delete(ada, created.id, t1)
      expect(await db.rows('SELECT id FROM time_off')).toEqual([])
    })
  })

  describe(`capacity less time off on ${runtime} (issue 1007)`, () => {
    it('[container/D1] time off reduces capacity and a plan beyond what is left is flagged, not refused', async () => {
      const { repository, timeOff } = await setup(factory)
      // Maya: 20 hours a week, so a whole day is 4 hours. Mon-Wed 12-14 Oct off: 12 hours.
      await timeOff.create(ada, away(), t0)
      // 16 hours planned fits 20 hours, but not the 8 hours left in the week of 12 Oct.
      await repository.create(ada, plan(), t0)
      const report = await repository.capacity(ada, { from: '2026-10-05', to: '2026-10-25' })
      const row = report.people.find((person) => person.userId === 1)!
      expect(row.weeklyCapacitySeconds).toBe(hours(20))
      expect(
        row.weeks.map((week) => [
          week.weekStart,
          week.timeOffSeconds,
          week.availableCapacitySeconds,
          week.plannedSeconds,
          week.overAllocated,
        ]),
      ).toEqual([
        ['2026-10-05', 0, hours(20), hours(16), false],
        ['2026-10-12', hours(12), hours(8), hours(16), true],
        ['2026-10-19', 0, hours(20), hours(16), false],
      ])
    })

    it('[container/D1] a part-day figure, a weekend and a range across weeks count correctly', async () => {
      const { repository, timeOff } = await setup(factory)
      // Thu 15 Oct to Tue 20 Oct at 2 hours a day: Thu, Fri | Mon, Tue (Sat and Sun carry none).
      await timeOff.create(
        ada,
        away({ userId: 6, startDate: '2026-10-15', endDate: '2026-10-20', secondsPerDay: hours(2) }),
        t0,
      )
      const report = await repository.capacity(ada, { from: '2026-10-12', to: '2026-10-19' })
      const row = report.people.find((person) => person.userId === 6)!
      expect(row.weeks.map((week) => [week.weekStart, week.timeOffSeconds])).toEqual([
        ['2026-10-12', hours(4)],
        ['2026-10-19', hours(4)],
      ])
    })

    it('[container/D1] time off beyond the whole week leaves zero capacity, never negative', async () => {
      const { repository, timeOff } = await setup(factory)
      await timeOff.create(ada, away({ secondsPerDay: hours(24), endDate: '2026-10-16' }), t0)
      const report = await repository.capacity(ada, { from: '2026-10-12', to: '2026-10-12' })
      const week = report.people.find((person) => person.userId === 1)!.weeks[0]!
      expect(week).toMatchObject({ timeOffSeconds: hours(20), availableCapacitySeconds: 0 })
    })

    it('[container/D1] overlapping entries cannot double-subtract: the second is refused', async () => {
      const { repository, timeOff } = await setup(factory)
      await timeOff.create(ada, away({ startDate: '2026-10-12', endDate: '2026-10-12' }), t0)
      await expect(
        timeOff.create(ada, away({ startDate: '2026-10-12', endDate: '2026-10-13' }), t0),
      ).rejects.toBeInstanceOf(TimeOffOverlapError)
      const report = await repository.capacity(ada, { from: '2026-10-12', to: '2026-10-12' })
      expect(report.people.find((person) => person.userId === 1)!.weeks[0]!.timeOffSeconds).toBe(
        hours(4),
      )
    })

    it('[container/D1] a member sees only their own time off in the capacity view', async () => {
      const { repository, timeOff } = await setup(factory)
      await timeOff.create(ada, away(), t0)
      await timeOff.create(ada, away({ userId: 6 }), t0)
      const range = { from: '2026-10-12', to: '2026-10-12' }
      const mine = await repository.capacity(maya, range)
      expect(mine.people.map((person) => [person.userId, person.weeks[0]!.timeOffSeconds])).toEqual([
        [1, hours(12)],
      ])
    })
  })
}
