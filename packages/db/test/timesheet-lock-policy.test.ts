import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  createTimesheetLockPolicyRepository,
  type TimesheetLockPolicyActor,
} from '../src/timesheet-lock-policy.js'
import { createTimesheetApprovalRepository } from '../src/timesheet-approvals.js'

type LockDatabase = Parameters<typeof createTimesheetLockPolicyRepository>[0]

interface TestDatabase {
  orm: LockDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>
  interleaveLockInsert(sql: string, ...params: unknown[]): LockDatabase
  observeStatements(): { orm: LockDatabase; count(): number }
  close(): Promise<void>
}

const ormWithNativeClient = (orm: LockDatabase, client: unknown): LockDatabase =>
  new Proxy(orm, {
    get(target, property) {
      if (property === '$client') return client
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const orm = createContainerDatabase(sqlite)
  return {
    orm,
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[],
    interleaveLockInsert: (interleavedSql, ...interleavedParams) => {
      let pending = true
      const client = new Proxy(sqlite, {
        get(target, property) {
          if (property === 'prepare') {
            return (statement: string) => {
              const prepared = target.prepare(statement)
              if (!statement.includes('INSERT INTO timesheet_lock_windows')) return prepared
              return new Proxy(prepared, {
                get(preparedTarget, preparedProperty) {
                  if (preparedProperty === 'get') {
                    return (...params: unknown[]) => {
                      if (pending) {
                        pending = false
                        target.prepare(interleavedSql).run(...interleavedParams)
                      }
                      return preparedTarget.get(...params)
                    }
                  }
                  const value: unknown = Reflect.get(
                    preparedTarget,
                    preparedProperty,
                    preparedTarget,
                  )
                  return typeof value === 'function' ? value.bind(preparedTarget) : value
                },
              })
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return ormWithNativeClient(orm, client)
    },
    observeStatements: () => {
      let count = 0
      const client = new Proxy(sqlite, {
        get(target, property) {
          if (property === 'prepare') {
            return (statement: string) => {
              count += 1
              return target.prepare(statement)
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return { orm: ormWithNativeClient(orm, client), count: () => count }
    },
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
  const orm = createD1Database(d1)
  return {
    orm,
    run: async (sql, ...params) => {
      await d1.prepare(sql).bind(...params).run()
    },
    rows: async <Row>(sql: string, ...params: unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<Row>()).results,
    interleaveLockInsert: (interleavedSql, ...interleavedParams) => {
      let pending = true
      const client = new Proxy(d1, {
        get(target, property) {
          if (property === 'prepare') {
            return (statement: string) => {
              const prepared = target.prepare(statement)
              if (!statement.includes('INSERT INTO timesheet_lock_windows')) return prepared
              return new Proxy(prepared, {
                get(preparedTarget, preparedProperty) {
                  if (preparedProperty === 'bind') {
                    return (...params: unknown[]) => {
                      const bound = preparedTarget.bind(...params)
                      return new Proxy(bound, {
                        get(boundTarget, boundProperty) {
                          if (boundProperty === 'first') {
                            return async <Row>() => {
                              if (pending) {
                                pending = false
                                await target
                                  .prepare(interleavedSql)
                                  .bind(...interleavedParams)
                                  .run()
                              }
                              return boundTarget.first<Row>()
                            }
                          }
                          const value: unknown = Reflect.get(
                            boundTarget,
                            boundProperty,
                            boundTarget,
                          )
                          return typeof value === 'function' ? value.bind(boundTarget) : value
                        },
                      })
                    }
                  }
                  const value: unknown = Reflect.get(
                    preparedTarget,
                    preparedProperty,
                    preparedTarget,
                  )
                  return typeof value === 'function' ? value.bind(preparedTarget) : value
                },
              })
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return ormWithNativeClient(orm, client)
    },
    observeStatements: () => {
      let count = 0
      const client = new Proxy(d1, {
        get(target, property) {
          if (property === 'prepare') {
            return (statement: string) => {
              count += 1
              return target.prepare(statement)
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
      return { orm: ormWithNativeClient(orm, client), count: () => count }
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const t0 = '2026-08-24T12:00:00.000Z'
const t1 = '2026-08-31T12:00:00.000Z'
const t2 = '2026-08-31T13:00:00.000Z'
const t3 = '2026-08-31T13:01:00.000Z'
const commandFingerprint = `sha256:${'a'.repeat(64)}`

const actor = (
  userId: number,
  profile: TimesheetLockPolicyActor['profile'],
): TimesheetLockPolicyActor => ({ userId, profile })

const installFixture = async (db: TestDatabase): Promise<void> => {
  await db.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Lock org', '{"expenses":true,"invoices":true,"approval":true}', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES
      (10, 'Ada', 'Admin', 'administrator', '[]', ?, ?),
      (11, 'Evan', 'Executive', 'executive_manager', '[]', ?, ?),
      (1, 'Maya', 'Member', 'member', '[]', ?, ?)`,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Lock client', 'USD', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at)
     VALUES (1, 1, 'Lock project', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Lock task', ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO user_assignments
      (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 1, ?, ?)`,
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
      'Locked work', 1, ?, ?)`,
    t0,
    t0,
  )
  await db.run(
    `INSERT INTO expenses (
      id, user_id, project_id, expense_category_id, spent_date, notes,
      total_cost_cents, billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, '2026-08-25', 'Locked expense', 1000, 1, ?, ?)`,
    t0,
    t0,
  )
}

for (const [runtime, factory] of factories) {
  describe(`timesheet lock policy (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[db] persists a global manual cutoff across module disable and audits explicit unlock', async () => {
      database = await factory()
      await installFixture(database)
      const locks = createTimesheetLockPolicyRepository(database.orm, { clock: () => t1 })

      const locked = await locks.createManualLock(
        actor(10, 'administrator'),
        '2026-08-25',
        'Month-end close',
        t1,
        'manual-lock-1',
        commandFingerprint,
      )
      expect(locked).toMatchObject({
        kind: 'manual_cutoff',
        periodStart: null,
        periodEnd: '2026-08-25',
        lockedByUserId: 10,
      })
      await expect(locks.resolve({ entityType: 'time_entry', entityId: 1 })).resolves.toMatchObject({
        locked: true,
        cause: 'manual_cutoff',
        reason: 'Month-end close',
      })
      await expect(
        database.run(`UPDATE time_entries SET spent_date = '2026-08-26' WHERE id = 1`),
      ).rejects.toThrow(/locked by timesheet policy/i)
      await expect(database.run(`DELETE FROM expenses WHERE id = 1`)).rejects.toThrow(
        /locked by timesheet policy/i,
      )
      await expect(
        database.run(
          `INSERT INTO expenses (
            id, user_id, project_id, expense_category_id, spent_date,
            total_cost_cents, billable, created_at, updated_at
          ) VALUES (2, 1, 1, 1, '2026-08-24', 500, 1, ?, ?)`,
          t1,
          t1,
        ),
      ).rejects.toThrow(/locked by timesheet policy/i)

      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('false'))
         WHERE id = 1`,
      )
      await expect(locks.isLocked({ entityType: 'expense', entityId: 1 })).resolves.toBe(true)

      const unlocked = await locks.unlock(
        actor(11, 'executive_manager'),
        locked.id,
        'Corrections authorized',
        t2,
      )
      expect(unlocked).toMatchObject({
        unlockedByUserId: 11,
        unlockedAt: t2,
        unlockReason: 'Corrections authorized',
      })
      await expect(locks.isLocked({ entityType: 'time_entry', entityId: 1 })).resolves.toBe(false)
      expect(
        await database.rows<{ event_type: string; aggregate_sequence: number }>(
          `SELECT event_type, aggregate_sequence FROM event_outbox
           WHERE aggregate_type = 'timesheet_lock' ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { event_type: 'timesheet.locked', aggregate_sequence: 1 },
        { event_type: 'timesheet.unlocked', aggregate_sequence: 2 },
      ])
    })

    it('[db] validates lock, unlock, and withdrawal reasons by Unicode code point', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const locks = createTimesheetLockPolicyRepository(database.orm)
      const maximumAstralReason = '😀'.repeat(10_000)

      const locked = await locks.createManualLock(
        actor(10, 'administrator'),
        '2026-08-25',
        maximumAstralReason,
        t1,
        'unicode-reason-lock',
        commandFingerprint,
      )
      await expect(
        locks.unlock(actor(10, 'administrator'), locked.id, maximumAstralReason, t2),
      ).resolves.toMatchObject({ unlockReason: maximumAstralReason })

      const submitted = await approvals.submit(1, '2026-08-24', '2026-08-30', t1)
      await approvals.approve(actor(10, 'administrator'), submitted.id, t2)
      await expect(
        locks.withdrawTimesheet(
          actor(10, 'administrator'),
          submitted.id,
          maximumAstralReason,
          t3,
        ),
      ).resolves.toMatchObject({ rejectionReason: maximumAstralReason })

      await expect(
        locks.createManualLock(
          actor(10, 'administrator'),
          '2026-08-25',
          `${maximumAstralReason}😀`,
          t3,
          'unicode-reason-too-long',
          commandFingerprint,
        ),
      ).rejects.toMatchObject({ code: 'invalid_settings' })
    })

    it('[unit] materializes an org-local weekly deadline exactly at the timezone boundary', async () => {
      database = await factory()
      await installFixture(database)
      const locks = createTimesheetLockPolicyRepository(database.orm)
      await locks.updateSettings(
        actor(10, 'administrator'),
        {
          autoLock: true,
          timesheetDeadline: { day: 'monday', time: '09:00' },
          timezone: 'America/New_York',
        },
        t1,
      )

      await expect(
        locks.materializeAutoLocks('2026-08-31T12:59:59.000Z'),
      ).resolves.toEqual([])
      const [locked] = await locks.materializeAutoLocks(t2)
      expect(locked).toMatchObject({
        kind: 'weekly_deadline',
        periodStart: '2026-08-24',
        periodEnd: '2026-08-30',
        deadlineDay: 'monday',
        deadlineTime: '09:00',
        timezone: 'America/New_York',
      })
      await expect(locks.materializeAutoLocks(t3)).resolves.toEqual([])

      await locks.unlock(actor(10, 'administrator'), locked!.id, 'Late correction', t3)
      await expect(locks.materializeAutoLocks('2026-09-01T13:00:00.000Z')).resolves.toEqual([])
      expect(
        await database.rows<{ count: number }>(
          `SELECT count(*) AS count FROM timesheet_lock_windows
           WHERE kind = 'weekly_deadline'`,
        ),
      ).toEqual([{ count: 1 }])
    })

    it('[unit] defines DST deadline boundaries and every supported week start', async () => {
      const boundaryCases = [
        {
          name: 'spring-forward skipped 02:30 locks at the first later wall time',
          entryDate: '2026-03-02',
          weekStart: 'sunday',
          deadline: { day: 'sunday', time: '02:30' },
          before: '2026-03-08T06:59:59.000Z',
          at: '2026-03-08T07:00:00.000Z',
          expectedStart: '2026-03-01',
        },
        {
          name: 'fall-back repeated 01:30 locks on the first occurrence',
          entryDate: '2026-10-26',
          weekStart: 'sunday',
          deadline: { day: 'sunday', time: '01:30' },
          before: '2026-11-01T05:29:59.000Z',
          at: '2026-11-01T05:30:00.000Z',
          expectedStart: '2026-10-25',
        },
      ] as const
      for (const boundaryCase of boundaryCases) {
        database = await factory()
        await installFixture(database)
        await database.run(`DELETE FROM expenses`)
        await database.run(
          `UPDATE time_entries SET spent_date = ?, updated_at = ? WHERE id = 1`,
          boundaryCase.entryDate,
          t1,
        )
        await database.run(
          `UPDATE organizations SET week_start_day = ? WHERE id = 1`,
          boundaryCase.weekStart,
        )
        const locks = createTimesheetLockPolicyRepository(database.orm)
        await locks.updateSettings(
          actor(10, 'administrator'),
          {
            autoLock: true,
            timesheetDeadline: boundaryCase.deadline,
            timezone: 'America/New_York',
          },
          t1,
        )

        await expect(
          locks.materializeAutoLocks(boundaryCase.before),
          boundaryCase.name,
        ).resolves.toEqual([])
        const result = await locks.materializeAutoLocks(boundaryCase.at)
        expect(result, boundaryCase.name).toHaveLength(1)
        expect(result[0], boundaryCase.name).toMatchObject({
          periodStart: boundaryCase.expectedStart,
        })
        await database.close()
        database = undefined
      }

      for (const [weekStartDay, expectedStart] of [
        ['saturday', '2026-08-22'],
        ['sunday', '2026-08-23'],
        ['monday', '2026-08-24'],
      ] as const) {
        database = await factory()
        await installFixture(database)
        await database.run(`UPDATE organizations SET week_start_day = ? WHERE id = 1`, weekStartDay)
        const locks = createTimesheetLockPolicyRepository(database.orm)
        await locks.updateSettings(
          actor(10, 'administrator'),
          {
            autoLock: true,
            timesheetDeadline: { day: 'monday', time: '09:00' },
            timezone: 'UTC',
          },
          t1,
        )
        const result = await locks.materializeAutoLocks('2026-09-30T12:00:00.000Z')
        expect(result).toContainEqual(expect.objectContaining({ periodStart: expectedStart }))
        await database.close()
        database = undefined
      }
    }, 120_000)

    it('[db] preserves concurrent partial policy updates without lost fields', async () => {
      database = await factory()
      await installFixture(database)
      const locks = createTimesheetLockPolicyRepository(database.orm)

      await Promise.all([
        locks.updateSettings(
          actor(10, 'administrator'),
          {
            autoLock: true,
            timesheetDeadline: { day: 'monday', time: '09:00' },
          },
          t1,
        ),
        locks.updateSettings(
          actor(11, 'executive_manager'),
          { timezone: 'America/New_York' },
          t2,
        ),
      ])

      await expect(locks.settings()).resolves.toMatchObject({
        autoLock: true,
        timesheetDeadline: { day: 'monday', time: '09:00' },
        timezone: 'America/New_York',
      })
    })

    it('[db] replays a manual-lock command and rejects changed input', async () => {
      database = await factory()
      await installFixture(database)
      const locks = createTimesheetLockPolicyRepository(database.orm)

      const created = await locks.createManualLock(
        actor(10, 'administrator'),
        '2026-08-25',
        'Month-end close',
        t1,
        'manual-retry',
        commandFingerprint,
      )
      await expect(
        locks.createManualLock(
          actor(10, 'administrator'),
          '2026-08-25',
          'Month-end close',
          t2,
          'manual-retry',
          commandFingerprint,
        ),
      ).resolves.toEqual(created)
      await expect(
        locks.createManualLock(
          actor(10, 'administrator'),
          '2026-08-26',
          'Different close',
          t2,
          'manual-retry',
          `sha256:${'b'.repeat(64)}`,
        ),
      ).rejects.toMatchObject({ code: 'command_id_reused' })
      expect(
        await database.rows<{ locks: number; events: number }>(
          `SELECT count(*) AS locks,
            (SELECT count(*) FROM event_outbox WHERE aggregate_type = 'timesheet_lock') AS events
           FROM timesheet_lock_windows`,
        ),
      ).toEqual([{ locks: 1, events: 1 }])
    })

    it('[db] does not materialize from a stale policy snapshot', async () => {
      for (const [name, statement, params] of [
        [
          'disabled',
          `UPDATE organizations SET auto_lock = 0, updated_at = ? WHERE id = 1`,
          [t2],
        ],
        [
          'deadline changed',
          `UPDATE organizations
           SET timesheet_deadline = '{"day":"monday","time":"17:00"}', updated_at = ?
           WHERE id = 1`,
          [t2],
        ],
        [
          'timezone changed',
          `UPDATE organizations SET timezone = 'America/New_York', updated_at = ? WHERE id = 1`,
          [t2],
        ],
      ] as const) {
        database = await factory()
        await installFixture(database)
        const initial = createTimesheetLockPolicyRepository(database.orm)
        await initial.updateSettings(
          actor(10, 'administrator'),
          {
            autoLock: true,
            timesheetDeadline: { day: 'monday', time: '09:00' },
            timezone: 'UTC',
          },
          t1,
        )
        const interleaved = createTimesheetLockPolicyRepository(
          database.interleaveLockInsert(statement, ...params),
        )

        await expect(interleaved.materializeAutoLocks(t2), name).resolves.toEqual([])
        expect(
          await database.rows<{ count: number }>(
            `SELECT count(*) AS count FROM timesheet_lock_windows`,
          ),
          name,
        ).toEqual([{ count: 0 }])
        await database.close()
        database = undefined
      }
      // Same budget as the sibling below, and for the same reason: this builds
      // a fresh database per case in a loop, and the default five seconds is
      // not a statement about this test so much as about how long one D1
      // migration run takes on an unloaded machine. It fails on a busy one,
      // which is how it reached CI as a flake rather than a failure.
    }, 60_000)

    it('[db] materializes a passed old deadline before changing policy without prior traffic', async () => {
      for (const [name, patch] of [
        ['disable', { autoLock: false }],
        ['deadline change', { timesheetDeadline: { day: 'monday', time: '17:00' } }],
        ['timezone change', { timezone: 'UTC' }],
      ] as const) {
        database = await factory()
        await installFixture(database)
        const locks = createTimesheetLockPolicyRepository(database.orm)
        await locks.updateSettings(
          actor(10, 'administrator'),
          {
            autoLock: true,
            timesheetDeadline: { day: 'monday', time: '09:00' },
            timezone: 'America/New_York',
          },
          t1,
        )

        await locks.updateSettings(actor(10, 'administrator'), patch, t2)

        expect(
          await database.rows<{
            kind: string
            deadline_time: string
            timezone: string
          }>(
            `SELECT kind, deadline_time, timezone FROM timesheet_lock_windows
             WHERE unlocked_at IS NULL`,
          ),
          name,
        ).toEqual([{
          kind: 'weekly_deadline',
          deadline_time: '09:00',
          timezone: 'America/New_York',
        }])
        await database.close()
        database = undefined
      }
    }, 60_000)

    it('[db] resolves a high-cardinality date page without repeated historical writes', async () => {
      database = await factory()
      await installFixture(database)
      const initial = createTimesheetLockPolicyRepository(database.orm)
      await initial.updateSettings(
        actor(10, 'administrator'),
        {
          autoLock: true,
          timesheetDeadline: { day: 'monday', time: '09:00' },
          timezone: 'UTC',
        },
        t1,
      )
      const dates = Array.from({ length: 200 }, (_, index) => {
        const date = new Date(Date.UTC(2025, 8, 1 + index * 2))
        return date.toISOString().slice(0, 10)
      })
      const observed = database.observeStatements()
      const locks = createTimesheetLockPolicyRepository(observed.orm, {
        clock: () => '2026-10-31T12:00:00.000Z',
      })

      const first = await locks.lockedDates(dates)
      expect(first.size).toBe(200)
      const afterFirst = observed.count()
      const beforeFacts = await database.rows<{ locks: number; events: number }>(
        `SELECT count(*) AS locks,
          (SELECT count(*) FROM event_outbox WHERE aggregate_type = 'timesheet_lock') AS events
         FROM timesheet_lock_windows`,
      )
      await locks.lockedDates(dates)
      const repeatedStatements = observed.count() - afterFirst
      const afterFacts = await database.rows<{ locks: number; events: number }>(
        `SELECT count(*) AS locks,
          (SELECT count(*) FROM event_outbox WHERE aggregate_type = 'timesheet_lock') AS events
         FROM timesheet_lock_windows`,
      )

      expect(repeatedStatements).toBeLessThanOrEqual(5)
      expect(afterFacts).toEqual(beforeFacts)
    }, 30_000)

    it('[security] rejects unauthorized policy actors and refuses to trap a running timer', async () => {
      database = await factory()
      await installFixture(database)
      const locks = createTimesheetLockPolicyRepository(database.orm)
      await expect(
        locks.createManualLock(
          actor(1, 'member'),
          '2026-08-31',
          'No authority',
          t1,
          'unauthorized-lock',
          commandFingerprint,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' })

      await database.run(
        `UPDATE time_entries SET timer_started_at = ?, updated_at = ? WHERE id = 1`,
        t1,
        t1,
      )
      await expect(
        locks.createManualLock(
          actor(10, 'administrator'),
          '2026-08-31',
          'Close now',
          t2,
          'running-lock',
          commandFingerprint,
        ),
      ).rejects.toMatchObject({ code: 'running_entry' })
      expect(
        await database.rows<{ count: number }>(`SELECT count(*) AS count FROM timesheet_lock_windows`),
      ).toEqual([{ count: 0 }])
    })

    it('[db] withdraws an approval across time and expenses with an append-only event', async () => {
      database = await factory()
      await installFixture(database)
      const approvals = createTimesheetApprovalRepository(database.orm)
      const locks = createTimesheetLockPolicyRepository(database.orm)
      const submitted = await approvals.submit(1, '2026-08-24', '2026-08-30', t1)
      await approvals.approve(actor(10, 'administrator'), submitted.id, t2)
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('false'))
         WHERE id = 1`,
      )

      await expect(
        locks.withdrawTimesheet(
          actor(11, 'executive_manager'),
          submitted.id,
          'Disabled module',
          t3,
        ),
      ).rejects.toMatchObject({ code: 'module_disabled' })
      expect(
        await database.rows<{ status: string; events: number }>(
          `SELECT submission.status,
            (SELECT count(*) FROM event_outbox event
             WHERE event.aggregate_type = 'timesheet_submission'
               AND event.aggregate_id = submission.id) AS events
           FROM timesheet_submissions submission WHERE submission.id = ?`,
          submitted.id,
        ),
      ).toEqual([{ status: 'approved', events: 2 }])
      await database.run(
        `UPDATE organizations SET modules = json_set(modules, '$.approval', json('true'))
         WHERE id = 1`,
      )
      await expect(
        locks.withdrawTimesheet(actor(1, 'member'), submitted.id, 'No authority', t3),
      ).rejects.toMatchObject({ code: 'forbidden' })
      const withdrawn = await locks.withdrawTimesheet(
        actor(11, 'executive_manager'),
        submitted.id,
        'Approved in error',
        t3,
      )
      expect(withdrawn).toMatchObject({
        status: 'unsubmitted',
        reviewedByUserId: 11,
        rejectionReason: 'Approved in error',
      })
      expect(
        await database.rows<{ kind: string; approval_status: string }>(
          `SELECT 'time' AS kind, approval_status FROM time_entries WHERE id = 1
           UNION ALL SELECT 'expense', approval_status FROM expenses WHERE id = 1
           ORDER BY kind`,
        ),
      ).toEqual([
        { kind: 'expense', approval_status: 'unsubmitted' },
        { kind: 'time', approval_status: 'unsubmitted' },
      ])
      expect(
        await database.rows<{ event_type: string }>(
          `SELECT event_type FROM event_outbox
           WHERE aggregate_type = 'timesheet_submission' ORDER BY aggregate_sequence`,
        ),
      ).toEqual([
        { event_type: 'timesheet.submitted' },
        { event_type: 'timesheet.approved' },
        { event_type: 'timesheet.withdrawn' },
      ])
      await expect(
        database.run(
          `DELETE FROM event_outbox
           WHERE aggregate_type = 'timesheet_submission' AND event_type = 'timesheet.withdrawn'`,
        ),
      ).rejects.toThrow(/immutable/i)
    })
  })
}
