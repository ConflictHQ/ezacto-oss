import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { PlaceholderAssignmentError, type TeamViewer, type UserProfile } from '@ezacto/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { createPlaceholderAllocationRepository } from '../src/placeholder-allocations.js'

/**
 * Issue 1191. Unassigned demand lives in its own tables; the assignment command
 * is one batch that makes the person's plan, consumes the placeholder
 * allocation, keeps the idempotency result and writes the audit event. Each case
 * runs on SQLite and on D1 because atomicity is a transaction on one and a batch
 * on the other.
 */

interface Fixture {
  repo: ReturnType<typeof createPlaceholderAllocationRepository>
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  close(): Promise<void>
}

const t0 = '2026-10-05T12:00:00.000Z'
const t1 = '2026-10-06T12:00:00.000Z'
const hours = (count: number) => count * 3_600

const sqliteFixture = async (): Promise<Fixture> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    repo: createPlaceholderAllocationRepository(createContainerDatabase(sqlite)),
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

const d1Fixture = async (): Promise<Fixture> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const d1 = await miniflare.getD1Database('DB')
  await migrateD1(d1)
  return {
    repo: createPlaceholderAllocationRepository(createD1Database(d1)),
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
    close: () => miniflare.dispose(),
  }
}

const viewer = (userId: number, profile: UserProfile): TeamViewer => ({
  userId,
  profile,
  managerGrants: [],
})
const ada = viewer(10, 'administrator')
const gus = viewer(4, 'executive_manager')
const pia = viewer(2, 'project_manager') // manages project 1 only
const maya = viewer(1, 'member')

/**
 * Ada administers, Gus is an executive manager, Pia manages project 1. Maya (1,
 * 20h week) is on project 1; Milo (6) is on project 2 only; Pat (3) is archived.
 * Project 3 is archived.
 */
const install = async (db: Fixture): Promise<void> => {
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
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Fictional Client', 'USD', ?, ?)`,
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
    `INSERT INTO user_assignments (id, project_id, user_id, is_project_manager, created_at, updated_at)
     VALUES (1, 1, 2, 1, ?, ?), (2, 1, 1, 0, ?, ?), (3, 2, 6, 0, ?, ?)`,
    ...Array(6).fill(t0),
  )
}

const demand = (overrides: Partial<Parameters<Fixture['repo']['createAllocation']>[1]> = {}) => ({
  placeholderId: 1,
  projectId: 1,
  startDate: '2026-10-05',
  endDate: '2026-10-25',
  plannedSecondsPerWeek: hours(16),
  ...overrides,
})

const assignment = (overrides: Partial<Parameters<Fixture['repo']['assign']>[1]> = {}) => ({
  idempotencyKey: 'key-1',
  placeholderAllocationId: 1,
  expectedRevision: 0,
  userId: 1,
  ...overrides,
})

const counts = async (db: Fixture) => ({
  allocations: (await db.rows<{ n: number }>('SELECT count(*) AS n FROM allocations'))[0]!.n,
  keys: (await db.rows<{ n: number }>('SELECT count(*) AS n FROM placeholder_assignment_keys'))[0]!
    .n,
  events: (
    await db.rows<{ n: number }>(
      "SELECT count(*) AS n FROM event_outbox WHERE aggregate_type = 'placeholder_allocation'",
    )
  )[0]!.n,
})

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlaceholderAssignmentError) return error.code
    throw error
  }
  throw new Error('expected a refusal')
}

for (const [runtime, factory] of [
  ['SQLite', sqliteFixture],
  ['D1', d1Fixture],
] as const)
  describe(`placeholder allocations (${runtime})`, () => {
    let close: (() => Promise<void>) | undefined
    afterEach(async () => close?.())
    const setup = async () => {
      const db = await factory()
      close = db.close
      await install(db)
      await db.repo.createPlaceholder(ada, { name: 'Senior engineer' }, t0)
      await db.repo.createAllocation(ada, demand(), t0)
      return db
    }

    it('creates, lists and archives demand with revisions and audit, never reusing an id', async () => {
      const db = await setup()
      const [row] = await db.repo.list(ada)
      expect(row).toMatchObject({
        id: '1',
        name: 'Senior engineer',
        state: 'open',
        revision: 0,
        assignedAllocationId: null,
      })
      const archived = await db.repo.archive(ada, 1, 0, t1)
      expect(archived).toMatchObject({ state: 'archived', revision: 1 })
      expect(await refusal(db.repo.archive(ada, 1, 1, t1))).toBe('placeholder_not_open')
      expect(await refusal(db.repo.archive(ada, 1, 0, t1))).toBe('placeholder_stale')
      const next = await db.repo.createAllocation(ada, demand(), t1)
      expect(next.id).toBe('2')
      const types = await db.rows<{ event_type: string }>(
        "SELECT event_type FROM event_outbox WHERE aggregate_type = 'placeholder_allocation' ORDER BY rowid",
      )
      expect(types.map((r) => r.event_type)).toEqual([
        'placeholder_allocation.created',
        'placeholder_allocation.archived',
        'placeholder_allocation.created',
      ])
      await expect(db.run('DELETE FROM placeholder_allocations WHERE id = 1')).rejects.toThrow()
      await expect(
        db.run("UPDATE placeholder_allocations SET state = 'open', revision = 2 WHERE id = 1"),
      ).rejects.toThrow()
    })

    it('scopes reads and writes: administrators and executives see all, project managers their projects, members nothing', async () => {
      const db = await setup()
      await db.repo.createAllocation(ada, demand({ projectId: 2 }), t0)
      expect((await db.repo.list(ada)).map((r) => r.id)).toEqual(['1', '2'])
      expect((await db.repo.list(gus)).map((r) => r.id)).toEqual(['1', '2'])
      expect((await db.repo.list(pia)).map((r) => r.id)).toEqual(['1'])
      expect(await refusal(db.repo.list(maya))).toBe('placeholder_forbidden')
      await expect(
        db.repo.createAllocation(pia, demand({ projectId: 2 }), t0),
      ).rejects.toMatchObject({ reasonCode: 'unknown_project' })
      await expect(
        db.repo.createAllocation(ada, demand({ projectId: 3 }), t0),
      ).rejects.toMatchObject({ reasonCode: 'unknown_project' })
      expect(
        await refusal(db.repo.assign(pia, assignment({ placeholderAllocationId: 2 }), t1)),
      ).toBe('placeholder_forbidden')
      expect(await refusal(db.repo.assign(maya, assignment(), t1))).toBe('placeholder_forbidden')
      expect(
        await refusal(db.repo.assign(ada, assignment({ placeholderAllocationId: 99 }), t1)),
      ).toBe('placeholder_not_found')
      expect(await counts(db)).toEqual({ allocations: 0, keys: 0, events: 2 })
    })

    it('assigns atomically, replays without writing, and refuses a reused key', async () => {
      const db = await setup()
      const first = await db.repo.assign(pia, assignment(), t1)
      expect(first.placeholder).toMatchObject({
        state: 'assigned',
        revision: 1,
        assignedAllocationId: '1',
      })
      expect(first.allocation).toMatchObject({
        id: '1',
        userId: '1',
        projectId: '1',
        startDate: '2026-10-05',
        plannedSecondsPerWeek: hours(16),
      })
      expect(
        await db.rows('SELECT user_id, project_id, planned_seconds_per_week FROM allocations'),
      ).toEqual([{ user_id: 1, project_id: 1, planned_seconds_per_week: hours(16) }])
      const before = await counts(db)
      expect(before).toEqual({ allocations: 1, keys: 1, events: 2 })
      expect(await db.repo.assign(pia, assignment(), t1)).toEqual(first)
      expect(await counts(db)).toEqual(before)
      expect(await refusal(db.repo.assign(pia, assignment({ userId: 6 }), t1))).toBe(
        'idempotency_key_reused',
      )
      expect(
        await refusal(
          db.repo.assign(pia, assignment({ idempotencyKey: 'key-2', expectedRevision: 1 }), t1),
        ),
      ).toBe('placeholder_not_open')
      expect(await counts(db)).toEqual(before)
      const [event] = await db.rows<{ payload_json: string }>(
        "SELECT payload_json FROM event_outbox WHERE event_type = 'placeholder_allocation.assigned'",
      )
      expect(JSON.parse(event!.payload_json)).toMatchObject({ user_id: 1, allocation_id: 1 })
    })

    it('lets a replay lose authority and a concurrent pair of assignments make one plan', async () => {
      const db = await setup()
      await db.repo.assign(pia, assignment(), t1)
      await db.run("UPDATE users SET profile = 'member' WHERE id = 2")
      expect(await refusal(db.repo.assign(pia, assignment(), t1))).toBe('placeholder_forbidden')
      await db.run("UPDATE users SET profile = 'project_manager' WHERE id = 2")
      await db.repo.createAllocation(
        ada,
        demand({ startDate: '2026-11-02', endDate: '2026-11-08' }),
        t1,
      )
      const outcomes = await Promise.allSettled([
        db.repo.assign(
          ada,
          assignment({ idempotencyKey: 'a', placeholderAllocationId: 2, userId: 6 }),
          t1,
        ),
        db.repo.assign(
          ada,
          assignment({ idempotencyKey: 'b', placeholderAllocationId: 2, userId: 1 }),
          t1,
        ),
      ])
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      expect((await counts(db)).allocations).toBe(2)
    })

    it('refuses an overlap without consuming the placeholder, and refuses stale and inactive targets', async () => {
      const db = await setup()
      await db.run(
        `INSERT INTO allocations (user_id, project_id, start_date, end_date, planned_seconds_per_week, created_at, updated_at)
         VALUES (1, 1, '2026-10-20', '2026-10-30', 3600, ?, ?)`,
        t0,
        t0,
      )
      expect(await refusal(db.repo.assign(ada, assignment(), t1))).toBe('allocation_overlap')
      expect(await refusal(db.repo.assign(ada, assignment({ expectedRevision: 5 }), t1))).toBe(
        'placeholder_stale',
      )
      expect(await refusal(db.repo.assign(ada, assignment({ userId: 3 }), t1))).toBe(
        'assignment_target_inactive',
      )
      expect(await db.rows('SELECT state, revision FROM placeholder_allocations')).toEqual([
        { state: 'open', revision: 0 },
      ])
      expect(await counts(db)).toEqual({ allocations: 1, keys: 0, events: 1 })
    })

    it('warns about over-allocation and shows missing project access without granting it', async () => {
      const db = await setup()
      await db.run(
        `INSERT INTO allocations (user_id, project_id, start_date, end_date, planned_seconds_per_week, created_at, updated_at)
         VALUES (1, 2, '2026-10-05', '2026-10-11', ?, ?, ?)`,
        hours(10),
        t0,
        t0,
      )
      const result = await db.repo.assign(ada, assignment(), t1)
      expect(result.warnings).toEqual([
        {
          code: 'over_allocated',
          weekStart: '2026-10-05',
          plannedSeconds: hours(26),
          capacitySeconds: 72000,
        },
      ])
      expect(result.prerequisites).toEqual([])
      await db.repo.createAllocation(
        ada,
        demand({ startDate: '2026-12-07', endDate: '2026-12-13' }),
        t1,
      )
      const milo = await db.repo.assign(
        ada,
        assignment({ idempotencyKey: 'k2', placeholderAllocationId: 2, userId: 6 }),
        t1,
      )
      expect(milo.prerequisites).toEqual([{ code: 'project_access_missing' }])
      expect(await db.rows('SELECT count(*) AS n FROM user_assignments')).toEqual([{ n: 3 }])
      expect(await db.rows('SELECT count(*) AS n FROM time_entries')).toEqual([{ n: 0 }])
    })
  })
