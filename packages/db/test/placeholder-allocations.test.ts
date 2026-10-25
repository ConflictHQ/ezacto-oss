import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { PlaceholderAssignmentError, type TeamViewer, type UserProfile } from '@ezacto/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { DrizzleAllocationRepository } from '../src/allocations.js'
import { createAccountClosureRepository } from '../src/account-closure.js'
import { createAccountDeletionRequestRepository } from '../src/account-deletion-requests.js'
import { createAccountRetentionRepository } from '../src/account-retention.js'
import { createPlaceholderAllocationRepository } from '../src/placeholder-allocations.js'

/**
 * Issue 1191. Unassigned demand lives in its own tables; the assignment command
 * is one batch that makes the person's plan, consumes the placeholder
 * allocation, keeps the idempotency result and writes the audit event. Each case
 * runs on SQLite and on D1 because atomicity is a transaction on one and a batch
 * on the other.
 */

interface Fixture {
  database: Parameters<typeof createPlaceholderAllocationRepository>[0]
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
  const database = createContainerDatabase(sqlite)
  return {
    database,
    repo: createPlaceholderAllocationRepository(database),
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
  const database = createD1Database(d1)
  return {
    database,
    repo: createPlaceholderAllocationRepository(database),
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
      ).rejects.toMatchObject({ code: 'placeholder_forbidden' })
      // Current project authority precedes hidden/missing definition details.
      expect(
        await refusal(
          db.repo.createAllocation(pia, demand({ projectId: 2, placeholderId: 999 }), t0),
        ),
      ).toBe('placeholder_forbidden')
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

    it('replays concurrent identical commands without a second plan or audit', async () => {
      const db = await setup()
      const results = await Promise.all([
        db.repo.assign(ada, assignment(), t1),
        createPlaceholderAllocationRepository(db.database).assign(ada, assignment(), t1),
      ])
      expect(results[1]).toEqual(results[0])
      expect(await counts(db)).toEqual({ allocations: 1, keys: 1, events: 2 })
    })

    it('edits open demand and definitions with current revisions and atomically archives all open children', async () => {
      const db = await setup()
      const renamed = await db.repo.updatePlaceholder(ada, 1, 0, { name: 'Engineer' }, t1)
      expect(renamed).toMatchObject({ name: 'Engineer', revision: 1, isActive: true })
      expect(await refusal(db.repo.updatePlaceholder(ada, 1, 0, { name: 'Old draft' }, t1))).toBe(
        'placeholder_stale',
      )
      const edited = await db.repo.updateAllocation(
        ada,
        1,
        0,
        { plannedSecondsPerWeek: hours(8), endDate: '2026-10-11' },
        t1,
      )
      expect(edited).toMatchObject({
        revision: 1,
        plannedSecondsPerWeek: hours(8),
        endDate: '2026-10-11',
      })
      expect(
        await refusal(db.repo.updateAllocation(ada, 1, 0, { plannedSecondsPerWeek: hours(9) }, t1)),
      ).toBe('placeholder_stale')
      await db.repo.assign(ada, assignment({ expectedRevision: 1 }), t1)
      await db.repo.createAllocation(ada, demand({ projectId: 2 }), t1)
      await db.repo.createAllocation(
        ada,
        demand({ startDate: '2026-11-01', endDate: '2026-11-07' }),
        t1,
      )
      const archived = await db.repo.updatePlaceholder(ada, 1, 1, { isActive: false }, t1)
      expect(archived).toMatchObject({ isActive: false, revision: 2 })
      expect((await db.repo.list(ada)).map((row) => [row.id, row.state, row.revision])).toEqual([
        ['1', 'assigned', 2],
        ['2', 'archived', 1],
        ['3', 'archived', 1],
      ])
      const [audit] = await db.rows<{ payload_json: string }>(
        "SELECT payload_json FROM event_outbox WHERE event_type='placeholder.archived'",
      )
      expect(JSON.parse(audit!.payload_json).archived_allocation_ids).toEqual([2, 3])
      expect(
        await refusal(
          db.repo.assign(
            ada,
            assignment({ placeholderAllocationId: 2, idempotencyKey: 'archived-child' }),
            t1,
          ),
        ),
      ).toBe('placeholder_stale')
      expect(await refusal(db.repo.updatePlaceholder(ada, 1, 2, { name: 'Reopen' }, t1))).toBe(
        'placeholder_not_open',
      )
      await expect(db.run('DELETE FROM placeholders WHERE id=1')).rejects.toThrow()
      expect((await db.repo.createPlaceholder(ada, { name: 'New demand' }, t1)).id).toBe(2)
      expect(await db.rows('SELECT user_id FROM allocations')).toEqual([{ user_id: 1 }])
    })

    it('hides private definitions and people, but permits explicitly managed teammates without granting project access', async () => {
      const db = await setup()
      const hidden = await db.repo.createPlaceholder(ada, { name: 'Hidden role' }, t1)
      await db.repo.createAllocation(ada, demand({ placeholderId: hidden.id, projectId: 2 }), t1)
      expect((await db.repo.definitions(pia)).map((row) => row.id)).toEqual([1])
      expect(
        await refusal(db.repo.createAllocation(pia, demand({ placeholderId: hidden.id }), t1)),
      ).toBe('placeholder_not_found')
      expect(
        await refusal(db.repo.updatePlaceholder(pia, hidden.id, 0, { name: 'Guess' }, t1)),
      ).toBe('placeholder_not_found')
      const before = await counts(db)
      expect(await refusal(db.repo.assign(pia, assignment({ userId: 6 }), t1))).toBe(
        'assignment_target_inactive',
      )
      expect(await counts(db)).toEqual(before)
      await db.run(
        'INSERT INTO teammate_assignments(manager_id,user_id,created_at,updated_at) VALUES(2,6,?,?)',
        t1,
        t1,
      )
      const assigned = await db.repo.assign(pia, assignment({ userId: 6 }), t1)
      expect(assigned.prerequisites).toEqual([{ code: 'project_access_missing' }])
      expect(
        await db.rows('SELECT 1 FROM user_assignments WHERE user_id=6 AND project_id=1'),
      ).toEqual([])
      await db.run('DELETE FROM teammate_assignments WHERE manager_id=2 AND user_id=6')
      expect(await refusal(db.repo.assign(pia, assignment({ userId: 6 }), t1))).toBe(
        'placeholder_forbidden',
      )
    })

    it('rechecks the current actor before revealing key reuse or replaying a result', async () => {
      const db = await setup()
      const first = await db.repo.assign(pia, assignment(), t1)
      await db.repo.updatePlaceholder(ada, 1, 0, { name: 'Renamed after assignment' }, t1)
      await db.run(`UPDATE users SET manager_grants='["billable_rates_manager"]' WHERE id=2`)
      expect(await refusal(db.repo.assign(pia, assignment({ userId: 6 }), t1))).toBe(
        'placeholder_forbidden',
      )
      expect(await refusal(db.repo.assign(pia, assignment(), t1))).toBe('placeholder_forbidden')
      expect(
        await db.repo.assign(
          { ...pia, managerGrants: ['billable_rates_manager'] },
          assignment(),
          t1,
        ),
      ).toEqual(first)
      expect(await counts(db)).toEqual({ allocations: 1, keys: 1, events: 2 })
    })

    it.each([
      { label: 'target', userId: 1 },
      { label: 'actor', userId: 2 },
    ])(
      'real $label account closure erases replay payloads without reopening or reusing assigned demand',
      async ({ userId }) => {
        const db = await setup()
        const assigner = userId === 1 ? ada : pia
        await db.repo.assign(assigner, assignment(), t1)
        const policies = createAccountRetentionRepository(db.database)
        await policies.publish({
          actorUserId: 10,
          expectedVersion: 0,
          now: t0,
          policy: {
            frameworks: [],
            retained_records: ['audit_and_security', 'time_and_worker_attribution'].map(
              (category) => ({
                category,
                reason: 'Keep minimal reviewed attribution.',
                period: 'One year after closure, then review.',
                review_after_days: 30,
              }),
            ),
            response_target_days: 14,
            operator_contact: 'privacy@example.test',
            user_notice: 'Operator reviewed.',
            backup_handling: 'Replay closure before restored access.',
            acknowledged: true,
          },
        })
        await createAccountDeletionRequestRepository(db.database).request({
          userId,
          id: 'close-plan-target',
          now: t1,
          expectedPolicyVersion: 1,
        })
        const closure = createAccountClosureRepository(db.database),
          preview = await closure.preview(10, 'close-plan-target')
        expect(preview.uncovered_categories).toEqual([])
        await closure.close({
          actorUserId: 10,
          id: 'close-plan-target',
          reviewToken: preview.review_token,
          expectedVersion: preview.request_version,
          expectedPolicyVersion: 1,
          now: t1,
          acknowledged: true,
        })
        expect(await db.rows('SELECT * FROM allocations WHERE user_id=?', userId)).toEqual([])
        expect(await db.rows('SELECT * FROM placeholder_assignment_keys')).toEqual([])
        expect(
          await db.rows(
            'SELECT id,state,revision,assigned_allocation_id FROM placeholder_allocations',
          ),
        ).toEqual([{ id: 1, state: 'assigned', revision: 1, assigned_allocation_id: 1 }])
        expect(await refusal(db.repo.assign(assigner, assignment(), t1))).toBe(
          userId === 1 ? 'placeholder_stale' : 'placeholder_forbidden',
        )
        expect(await db.rows('SELECT user_id FROM allocations')).toEqual(
          userId === 1 ? [] : [{ user_id: 1 }],
        )
      },
    )

    it('warns against the same holiday/leave-adjusted availability and archived-project policy as the shipped Capacity grid', async () => {
      const db = await setup()
      await db.run('UPDATE users SET weekly_capacity=144000 WHERE id=1')
      // Archived-project plans do not inflate the shipped grid's planned total.
      await db.run(
        `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at) VALUES(1,3,'2026-10-05','2026-10-25',360000,?,?)`,
        t0,
        t0,
      )
      await db.run(
        `INSERT INTO organization_holidays(holiday_date,name,created_at,updated_at) VALUES('2026-10-05','Owned holiday',?,?)`,
        t0,
        t0,
      )
      await db.run(
        `INSERT INTO time_off(user_id,kind,start_date,end_date,seconds_per_day,created_at,updated_at) VALUES(1,'vacation','2026-10-05','2026-10-05',28800,?,?)`,
        t0,
        t0,
      )
      await db.repo.updateAllocation(
        ada,
        1,
        0,
        { startDate: '2026-10-07', endDate: '2026-10-09', plannedSecondsPerWeek: 126000 },
        t1,
      )
      const result = await db.repo.assign(ada, assignment({ expectedRevision: 1 }), t1)
      expect(result.warnings).toEqual([
        {
          code: 'over_allocated',
          weekStart: '2026-10-05',
          plannedSeconds: 126000,
          capacitySeconds: 115200,
        },
      ])
      const capacity = await new DrizzleAllocationRepository(db.database).capacity(ada, {
        from: '2026-10-05',
        to: '2026-10-11',
      })
      const target = capacity.people.find((person) => person.userId === 1)!.weeks[0]!
      expect(target).toMatchObject({
        availableCapacitySeconds: 115200,
        plannedSeconds: 126000,
        overAllocated: true,
      })
    })

    it('captures children added after preflight inside the atomic parent-archive audit', async () => {
      const db = await setup()
      await db.run(`CREATE TRIGGER owned_child_before_archive BEFORE UPDATE OF is_active ON placeholders WHEN NEW.is_active=0 BEGIN
        INSERT INTO placeholder_allocations(placeholder_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
          VALUES(OLD.id,1,'2026-12-01','2026-12-07',3600,'${t1}','${t1}'); END`)
      await db.repo.updatePlaceholder(ada, 1, 0, { isActive: false }, t1)
      const [event] = await db.rows<{ payload_json: string }>(
        "SELECT payload_json FROM event_outbox WHERE event_type='placeholder.archived'",
      )
      expect(JSON.parse(event!.payload_json).archived_allocation_ids).toEqual([1, 2])
      expect((await db.repo.list(ada)).map((row) => row.state)).toEqual(['archived', 'archived'])
    })

    it('rolls back the plan, claim and state if the final native audit fails', async () => {
      const db = await setup(),
        before = await counts(db)
      await db.run(`CREATE TRIGGER owned_assignment_audit_failure BEFORE INSERT ON event_outbox WHEN NEW.event_type='placeholder_allocation.assigned'
        BEGIN SELECT RAISE(ABORT,'owned_assignment_audit_failure'); END`)
      await expect(db.repo.assign(ada, assignment(), t1)).rejects.toThrow(
        'owned_assignment_audit_failure',
      )
      expect(await counts(db)).toEqual(before)
      expect((await db.repo.list(ada))[0]).toMatchObject({
        state: 'open',
        revision: 0,
        assignedAllocationId: null,
      })
      await db.run('DROP TRIGGER owned_assignment_audit_failure')
      await db.repo.assign(ada, assignment(), t1)
      expect(await counts(db)).toEqual({ allocations: 1, keys: 1, events: 2 })
      for (const table of ['time_entries', 'invoices', 'invoice_payments', 'payout_transfers'])
        expect(await db.rows(`SELECT 1 FROM ${table}`)).toEqual([])
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
