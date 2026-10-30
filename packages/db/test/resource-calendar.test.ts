import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import type { TeamViewer } from '@ezacto/core'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createResourceCalendarRepository } from '../src/resource-calendar.js'
import { DrizzleAllocationRepository } from '../src/allocations.js'

const stamp = '2026-10-05T12:00:00.000Z'
const admin: TeamViewer = { userId: 1, profile: 'administrator', managerGrants: [] }
const manager: TeamViewer = { userId: 2, profile: 'project_manager', managerGrants: [] }
const member: TeamViewer = { userId: 3, profile: 'member', managerGrants: [] }
const query = { view: 'team', from: '2026-10-07', to: '2026-10-09' } as const
const disposals: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((close) => close()))
})

const setup = async (runtime: 'SQLite' | 'D1') => {
  const sqlite = runtime === 'SQLite' ? new BetterSqlite3(':memory:') : null
  const miniflare = sqlite
    ? null
    : new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: ['DB'],
      })
  const d1 = miniflare ? await miniflare.getD1Database('DB') : null
  if (sqlite) migrateContainer(sqlite)
  else await migrateD1(d1!)
  disposals.push(async () => {
    sqlite?.close()
    await miniflare?.dispose()
  })
  const database = sqlite ? createContainerDatabase(sqlite) : createD1Database(d1!)
  const run = async (text: string, ...params: unknown[]) => {
    if (sqlite) sqlite.prepare(text).run(...params)
    else
      await d1!
        .prepare(text)
        .bind(...params)
        .run()
  }
  await run(
    `INSERT INTO organizations(name,timezone,week_start_day,modules,created_at,updated_at)
    VALUES('Owned calendar fixture','America/Los_Angeles','monday','{"expenses":true,"invoices":true,"approval":true}',?,?)`,
    stamp,
    stamp,
  )
  for (const [id, profile, capacity] of [
    [1, 'administrator', 126000],
    [2, 'project_manager', 126000],
    [3, 'member', 72000],
    [4, 'member', 0],
  ] as const)
    await run(
      `INSERT INTO users(id,first_name,last_name,profile,manager_grants,weekly_capacity,created_at,updated_at)
      VALUES(?,'Owned',?, ?,'[]',?,?,?)`,
      id,
      `Person ${id}`,
      profile,
      capacity,
      stamp,
      stamp,
    )
  await run(
    "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','USD',?,?)",
    stamp,
    stamp,
  )
  for (const [id, name] of [
    [1, 'Visible project'],
    [2, 'Secret project'],
    [3, 'Archived project'],
  ] as const)
    await run(
      "INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(?,1,?,'people',?,?)",
      id,
      name,
      stamp,
      stamp,
    )
  await run(
    "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'Owned task',?,?)",
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO user_assignments(id,user_id,project_id,is_project_manager,created_at,updated_at)
    VALUES(1,2,1,1,?,?),(2,3,1,0,?,?),(3,3,2,0,?,?),(4,3,3,0,?,?)`,
    ...Array(8).fill(stamp),
  )
  await run(
    `INSERT INTO task_assignments(id,project_id,task_id,billable,created_at,updated_at)
    VALUES(1,1,1,1,?,?),(2,2,1,1,?,?),(3,3,1,1,?,?)`,
    ...Array(6).fill(stamp),
  )
  for (const [project, hours] of [
    [1, 10],
    [2, 15],
    [3, 100],
  ] as const)
    await run(
      `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
      VALUES(3,?,'2026-10-07','2026-10-09',?,?,?)`,
      project,
      hours * 3600,
      stamp,
      stamp,
    )
  await run(
    `INSERT INTO time_off(user_id,start_date,end_date,kind,seconds_per_day,created_at,updated_at)
    VALUES(3,'2026-10-05','2026-10-05','vacation',18000,?,?)`,
    stamp,
    stamp,
  )
  await run(
    "INSERT INTO organization_holidays(holiday_date,name,created_at,updated_at) VALUES('2026-10-05','Owned holiday',?,?)",
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO time_entries(user_id,project_id,task_id,user_assignment_id,task_assignment_id,
    spent_date,seconds,seconds_without_timer,rounded_seconds,billable,created_at,updated_at)
    VALUES(3,3,1,4,3,'2026-10-06',4442,4442,4500,1,?,?)`,
    stamp,
    stamp,
  )
  await run('UPDATE projects SET is_active=0 WHERE id=3')
  await run(
    "INSERT INTO placeholders(id,name,created_by_user_id,created_at,updated_at) VALUES(1,'Owned demand',1,?,?)",
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO placeholder_allocations(placeholder_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(1,1,'2026-10-08','2026-10-08',7200,?,?)`,
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO placeholder_allocations(placeholder_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(1,2,'2026-10-12','2026-10-12',7200,?,?)`,
    stamp,
    stamp,
  )
  await run(
    `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(4,1,'2026-10-08','2026-10-09',4442,?,?)`,
    stamp,
    stamp,
  )
  return { database, run, sqlite, repository: createResourceCalendarRepository(database) }
}

for (const runtime of ['SQLite', 'D1'] as const)
  describe(`resource calendar ${runtime}`, () => {
    it('reuses capacity totals including whole touched weeks, holiday/leave max, archived actuals and separate demand', async () => {
      const { database, repository, sqlite } = await setup(runtime)
      const capacity = await new DrizzleAllocationRepository(database).capacity(admin, query)
      sqlite?.pragma('query_only=ON')
      const result = await repository.read(admin, query, new Date('2026-10-05T00:30:00Z'))
      expect(await repository.context(admin, new Date('2026-10-05T00:30:00Z'))).toEqual(
        result.context,
      )
      expect(result.context).toEqual({
        timeZone: 'America/Los_Angeles',
        weekStartDay: 'monday',
        today: '2026-10-04',
        currentWeekStart: '2026-09-28',
      })
      const actual = result.people.find((person) => person.personId === 3)!.weeks[0]!
      const expected = capacity.people.find((person) => person.userId === 3)!.weeks[0]!
      expect(actual).toMatchObject({
        plannedSeconds: expected.plannedSeconds,
        availableSeconds: expected.availableCapacitySeconds,
        trackedSeconds: expected.trackedSeconds,
        overAllocated: expected.overAllocated,
      })
      expect(actual).toMatchObject({
        plannedSeconds: 90000,
        availableSeconds: 54000,
        trackedSeconds: 4500,
        overAllocated: true,
      })
      expect(result.unassigned).toEqual([
        {
          weekStart: '2026-10-05',
          placeholderId: 1,
          name: 'Owned demand',
          projectId: 1,
          plannedSeconds: 7200,
        },
      ])
      const scoped = await repository.read(manager, query, new Date(stamp))
      expect(scoped.people.map((person) => person.personId)).toEqual([2, 3])
      expect(scoped.people.find((person) => person.personId === 3)!.weeks[0]).toMatchObject({
        personOtherScopePlannedSeconds: 54000,
        otherScopeTrackedSeconds: 4500,
        projects: [{ projectId: 1, plannedSeconds: 36000 }],
      })
      expect(scoped.hasOtherScope).toBe(true)
      expect(JSON.stringify(scoped)).not.toContain('Secret project')
      expect(JSON.stringify(scoped)).not.toContain('vacation')
      const own = await repository.read(member, query, new Date(stamp))
      expect(own.people.map((person) => person.personId)).toEqual([3])
      expect(own.unassigned).toEqual([])
      const hiddenDemand = await repository.read(
        manager,
        { ...query, from: '2026-10-12', to: '2026-10-18' },
        new Date(stamp),
      )
      expect(hiddenDemand.hasOtherScope).toBe(true)
      expect(hiddenDemand.unassigned).toEqual([])
      expect(JSON.stringify(hiddenDemand)).not.toContain('Secret project')
      const project = await repository.read(
        manager,
        { ...query, view: 'project', projectId: 1 },
        new Date(stamp),
      )
      expect(project.people.find((person) => person.personId === 3)!.weeks[0]).toMatchObject({
        plannedSeconds: 36000,
        personPlannedSeconds: 90000,
        personOtherScopePlannedSeconds: 54000,
        trackedSeconds: 0,
        overAllocated: true,
      })
    })

    it('checks current authority and filter scope, pages deterministically, and refreshes context independently of revision', async () => {
      const { repository, run } = await setup(runtime)
      await expect(
        repository.read(manager, { ...query, view: 'project', projectId: 2 }, new Date(stamp)),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        repository.read(member, { ...query, personId: 4 }, new Date(stamp)),
      ).rejects.toMatchObject({ code: 'not_found' })
      const first = await repository.read(
        admin,
        { ...query, limit: 2 },
        new Date('2026-10-05T06:59:00Z'),
      )
      expect(first.people.map((person) => person.personId)).toEqual([1, 2])
      expect(first.nextCursor).toBe(2)
      const next = await repository.read(admin, { ...query, limit: 2, cursor: 2 }, new Date(stamp))
      expect(next.people.map((person) => person.personId)).toEqual([3, 4])
      expect(next.nextCursor).toBeNull()
      expect(next.unassigned).toEqual([])
      const midnight = await repository.read(
        admin,
        { ...query, limit: 2 },
        new Date('2026-10-05T07:01:00Z'),
      )
      expect(first.revision).toBe(midnight.revision)
      expect(first.context.today).toBe('2026-10-04')
      expect(midnight.context.today).toBe('2026-10-05')
      for (const [weekStartDay, weekStart, planned] of [
        ['monday', '2026-10-05', 90000],
        ['saturday', '2026-10-10', 0],
        ['sunday', '2026-10-11', 0],
      ] as const) {
        await run('UPDATE organizations SET week_start_day=? WHERE id=1', weekStartDay)
        const boundary = await repository.read(
          admin,
          { ...query, from: '2026-10-11', to: '2026-10-11', personId: 3 },
          new Date('2026-11-01T08:30:00Z'),
        )
        expect(boundary.weekStarts).toEqual([weekStart])
        expect(boundary.people[0]!.weeks[0]!.plannedSeconds).toBe(planned)
        expect(boundary.context.today).toBe('2026-11-01')
        const dst = await repository.read(
          admin,
          { ...query, from: '2026-10-11', to: '2026-10-11', personId: 3 },
          new Date('2026-11-01T09:30:00Z'),
        )
        expect(dst.context).toEqual(boundary.context)
      }
      await run("UPDATE organizations SET timezone='Imported invalid zone' WHERE id=1")
      expect((await repository.read(admin, query, new Date(stamp))).context.timeZone).toBe('UTC')
      await run("UPDATE users SET profile='member' WHERE id=2")
      await expect(repository.read(manager, query, new Date(stamp))).rejects.toMatchObject({
        code: 'actor_required',
      })
      await expect(repository.context(manager, new Date(stamp))).rejects.toMatchObject({
        code: 'actor_required',
      })
      await expect(repository.projects(manager, {})).rejects.toMatchObject({
        code: 'actor_required',
      })
      await expect(repository.allocations(manager, query)).rejects.toMatchObject({
        code: 'actor_required',
      })
    })
    it('returns only authorized saved ranges and project identities with exact seconds and live bounded cursors', async () => {
      const { repository, run, sqlite } = await setup(runtime)
      sqlite?.pragma('query_only=ON')
      expect(await repository.projects(manager, {})).toEqual({
        rows: [{ id: 1, name: 'Visible project', isActive: true }],
        nextCursor: null,
      })
      expect(
        (await repository.projects(member, {})).rows.map((row) => [row.id, row.isActive]),
      ).toEqual([
        [1, true],
        [2, true],
        [3, false],
      ])
      expect(
        (await repository.projects(member, { isActive: true })).rows.map((row) => row.id),
      ).toEqual([1, 2])
      const first = await repository.projects(admin, { limit: 1 })
      expect(first.nextCursor).toBe(1)
      expect((await repository.projects(admin, { limit: 1, cursor: 1 })).rows[0]!.id).toBe(2)
      const exact = await repository.allocations(admin, { ...query, personId: 4 })
      expect(exact).toEqual({
        rows: [
          {
            id: 4,
            version: 0,
            userId: 4,
            projectId: 1,
            projectName: 'Visible project',
            startDate: '2026-10-08',
            endDate: '2026-10-09',
            plannedSecondsPerWeek: 4442,
          },
        ],
        nextCursor: null,
      })
      const scoped = await repository.allocations(manager, {
        ...query,
        from: '2026-10-11',
        to: '2026-10-11',
      })
      expect(scoped.rows.map((row) => row.projectId)).toEqual([1])
      expect(scoped.rows[0]).toMatchObject({
        startDate: '2026-10-07',
        endDate: '2026-10-09',
        plannedSecondsPerWeek: 36000,
      })
      expect(JSON.stringify(scoped)).not.toContain('Secret project')
      const ranges = await repository.allocations(admin, { ...query, limit: 1 })
      expect(ranges.rows[0]!.id).toBe(1)
      expect(ranges.nextCursor).toBe(1)
      expect(
        (await repository.allocations(admin, { ...query, limit: 1, cursor: 1 })).rows[0]!.id,
      ).toBe(2)
      await expect(
        repository.allocations(manager, { ...query, view: 'project', projectId: 2 }),
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(repository.allocations(member, { ...query, personId: 4 })).rejects.toMatchObject(
        { code: 'not_found' },
      )
      sqlite?.pragma('query_only=OFF')
      await run('UPDATE user_assignments SET is_project_manager=0 WHERE user_id=2')
      expect((await repository.projects(manager, {})).rows).toEqual([])
      expect((await repository.allocations(manager, query)).rows).toEqual([])
    })
  })
