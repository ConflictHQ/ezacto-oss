import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { orgPeopleMigration } from '../src/migrations/0000_org_people.js'
import { clientsMigration } from '../src/migrations/0001_clients.js'
import { projectsTimeMigration } from '../src/migrations/0002_projects_time.js'
import { repriceTimeEntry, resolveEntryRates } from '../src/rate-resolver.js'
import { createStoppedTimeEntry, startTimeEntry } from '../src/time-entries.js'

type DrizzleDatabase = Parameters<typeof resolveEntryRates>[0]

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
  return {
    drizzle: createContainerDatabase(sqlite),
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
  return {
    drizzle: createD1Database(d1),
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

const installBaseFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Halcyon Studio', ?, ?, ?)`,
    modules,
    timestamp,
    timestamp,
  )
  for (const id of [1, 2]) {
    await database.run(
      `INSERT INTO users
        (id, first_name, last_name, manager_grants, created_at, updated_at)
       VALUES (?, 'Rate', 'Tester', '[]', ?, ?)`,
      id,
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
  await database.run(
    `INSERT INTO projects
      (id, client_id, name, billing_method, bill_by, hourly_rate_cents,
       budget_by, budget_seconds, cost_budget_cents, created_at, updated_at)
     VALUES (1, 1, 'Resolver project', 'time_materials', 'people', 15000,
       'person', 90000, 800000, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Engineering', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO task_assignments
      (id, project_id, task_id, billable, hourly_rate_cents, budget_seconds,
       budget_cents, created_at, updated_at)
     VALUES (1, 1, 1, 1, 12000, 70000, 600000, ?, ?)`,
    timestamp,
    timestamp,
  )
  for (const [id, userId, useDefaultRates, hourlyRate, budget] of [
    [1, 1, 1, 13000, 50000],
    [2, 2, 1, 14000, 40000],
  ] as const) {
    await database.run(
      `INSERT INTO user_assignments
        (id, project_id, user_id, use_default_rates, hourly_rate_cents,
         budget_seconds, created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      useDefaultRates,
      hourlyRate,
      budget,
      timestamp,
      timestamp,
    )
  }
  for (const [table, first, second] of [
    ['user_billable_rates', 10_000, 20_000],
    ['user_cost_rates', 3_000, 4_000],
  ] as const) {
    await database.run(
      `INSERT INTO ${table}
        (id, user_id, amount_cents, start_date, created_at, updated_at)
       VALUES (1, 1, ?, NULL, ?, ?)`,
      first,
      timestamp,
      timestamp,
    )
    await database.run(
      `INSERT INTO ${table}
        (id, user_id, amount_cents, start_date, created_at, updated_at)
       VALUES (2, 1, ?, '2026-07-01', ?, ?)`,
      second,
      timestamp,
      timestamp,
    )
  }
}

const stoppedInput = (userId = 1, userAssignmentId = 1, spentDate = '2026-06-30') => ({
  userId,
  projectId: 1,
  taskId: 1,
  userAssignmentId,
  taskAssignmentId: 1,
  spentDate,
  seconds: 3600,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const installThroughProjectsTime = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `CREATE TABLE _ezacto_migrations (
      id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
    ) STRICT`,
  )
  for (const migration of [orgPeopleMigration, clientsMigration, projectsTimeMigration]) {
    for (const statement of migration) await database.run(statement)
  }
  await database.run(
    `INSERT INTO _ezacto_migrations (id, applied_at) VALUES
      ('0000_org_people', ?), ('0001_clients', ?), ('0002_projects_time', ?)`,
    timestamp,
    timestamp,
    timestamp,
  )
}

for (const [runtime, factory] of factories) {
  describe(`rate resolver persistence (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    const setup = async (): Promise<TestDatabase> => {
      database = await factory()
      await installBaseFixture(database)
      return database
    }

    it('[unit] populates both native snapshot columns from spent_date and returns the live budget grain', async () => {
      const db = await setup()
      const june = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      expect([june.billableRateCents, june.costRateCents]).toEqual([10_000, 3_000])

      const august = await startTimeEntry(db.drizzle, stoppedInput(1, 1, '2026-08-27'), {
        date: '2026-08-27',
        time: '09:00',
        instant: '2026-08-27T09:00:00.000Z',
      })
      expect([august.billableRateCents, august.costRateCents]).toEqual([20_000, 4_000])

      const live = await resolveEntryRates(db.drizzle, stoppedInput())
      expect(live.budget).toEqual({
        budgetBy: 'person',
        source: 'user_assignment',
        sourceId: 1,
        unit: 'seconds',
        amount: 50_000,
      })
      await db.run(`UPDATE user_assignments SET budget_seconds = 55555 WHERE id = 1`)
      expect((await resolveEntryRates(db.drizzle, stoppedInput())).budget?.amount).toBe(55_555)
    })

    it('[unit] copies missing native billable and cost rates as independent nulls', async () => {
      const db = await setup()
      const entry = await createStoppedTimeEntry(db.drizzle, stoppedInput(2, 2))
      expect([entry.billableRateCents, entry.costRateCents]).toEqual([null, null])
    })

    it('[unit] leaves native and imported snapshots stable until explicit audited reprice', async () => {
      const db = await setup()
      const native = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      await db.run(
        `INSERT INTO time_entries
          (harvest_id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES ('imported-1', 1, 1, 1, 1, 1, '2026-06-30', 3600, 3600, 3600,
           1, 0, 12345, 6789, ?, ?)`,
        timestamp,
        timestamp,
      )
      for (const [table, amount] of [
        ['user_billable_rates', 30_000],
        ['user_cost_rates', 5_000],
      ] as const) {
        await db.run(
          `INSERT INTO ${table}
            (id, user_id, amount_cents, start_date, created_at, updated_at)
           VALUES (3, 1, ?, '2026-08-01', ?, ?)`,
          amount,
          timestamp,
          timestamp,
        )
      }
      expect(
        await db.rows<{ billable: number; cost: number }>(
          `SELECT billable_rate_cents AS billable, cost_rate_cents AS cost
           FROM time_entries WHERE id = ?`,
          native.id,
        ),
      ).toEqual([{ billable: 10_000, cost: 3_000 }])
      await db.run(
        `UPDATE projects
         SET bill_by = 'project', hourly_rate_cents = 77777, updated_at = ?
         WHERE id = 1`,
        timestamp,
      )
      expect(
        await db.rows<{ harvest_id: string | null; billable: number | null; cost: number | null }>(
          `SELECT harvest_id, billable_rate_cents AS billable, cost_rate_cents AS cost
           FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        { harvest_id: null, billable: 10_000, cost: 3_000 },
        { harvest_id: 'imported-1', billable: 12_345, cost: 6_789 },
      ])

      const result = await repriceTimeEntry(db.drizzle, {
        timeEntryId: native.id,
        reason: 'Approved correction for June reporting',
        repricedAt: '2026-08-27T10:00:00.000Z',
      })
      expect([result.entry.billableRateCents, result.entry.costRateCents]).toEqual([77_777, 3_000])
      expect(result.audit).toMatchObject({
        timeEntryId: native.id,
        previousBillableRateCents: 10_000,
        billableRateCents: 77_777,
        previousCostRateCents: 3_000,
        costRateCents: 3_000,
        reason: 'Approved correction for June reporting',
        repricedAt: '2026-08-27T10:00:00.000Z',
      })
      expect(
        await db.rows<{ billable: number; cost: number }>(
          `SELECT billable_rate_cents AS billable, cost_rate_cents AS cost
           FROM time_entries WHERE harvest_id = 'imported-1'`,
        ),
      ).toEqual([{ billable: 12_345, cost: 6_789 }])

      await db.run(`UPDATE projects SET hourly_rate_cents = 88888 WHERE id = 1`)
      expect(
        await db.rows<{ billable: number }>(
          `SELECT billable_rate_cents AS billable FROM time_entries WHERE id = ?`,
          native.id,
        ),
      ).toEqual([{ billable: 77_777 }])
      await expect(
        db.run(
          `UPDATE time_entry_rate_reprices SET reason = 'rewritten' WHERE id = ?`,
          result.audit.id,
        ),
      ).rejects.toThrow(/append-only/)
      await expect(
        db.run(`DELETE FROM time_entry_rate_reprices WHERE id = ?`, result.audit.id),
      ).rejects.toThrow(/append-only/)
    })

    it('[unit] rolls back the audit insert when applying a reprice fails', async () => {
      const db = await setup()
      const entry = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      await db.run(
        `UPDATE projects SET bill_by = 'project', hourly_rate_cents = 77777 WHERE id = 1`,
      )
      await db.run(
        `CREATE TRIGGER test_reprice_failure
         BEFORE UPDATE OF billable_rate_cents ON time_entries
         BEGIN SELECT RAISE(ABORT, 'injected reprice failure'); END`,
      )
      await expect(
        repriceTimeEntry(db.drizzle, {
          timeEntryId: entry.id,
          reason: 'This must roll back',
          repricedAt: '2026-08-27T11:00:00.000Z',
        }),
      ).rejects.toThrow()
      expect(
        await db.rows<{ billable: number; audits: number }>(
          `SELECT billable_rate_cents AS billable,
            (SELECT count(*) FROM time_entry_rate_reprices) AS audits
           FROM time_entries WHERE id = ?`,
          entry.id,
        ),
      ).toEqual([{ billable: 10_000, audits: 0 }])
    })

    it('[unit] rejects normalized-invalid audit timestamps before applying snapshots', async () => {
      const db = await setup()
      const entry = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      const originalEntry = await db.rows<Record<string, unknown>>(
        `SELECT billable_rate_cents, cost_rate_cents, updated_at
         FROM time_entries WHERE id = ?`,
        entry.id,
      )
      for (const invalid of ['2026-02-30T09:00:00.000Z', '2026-08-27T24:00:00.000Z']) {
        await expect(
          db.run(
            `INSERT INTO time_entry_rate_reprices
              (time_entry_id, previous_billable_rate_cents, billable_rate_cents,
               previous_cost_rate_cents, cost_rate_cents, reason, repriced_at)
             VALUES (?, 10000, 1, 3000, 2, 'invalid timestamp attempt', ?)`,
            entry.id,
            invalid,
          ),
        ).rejects.toThrow()
      }
      expect(
        await db.rows<{ count: number }>(`SELECT count(*) AS count FROM time_entry_rate_reprices`),
      ).toEqual([{ count: 0 }])
      expect(
        await db.rows<Record<string, unknown>>(
          `SELECT billable_rate_cents, cost_rate_cents, updated_at
           FROM time_entries WHERE id = ?`,
          entry.id,
        ),
      ).toEqual(originalEntry)
    })

    it('[unit] rejects INSERT OR REPLACE collisions without rewriting audit history or snapshots', async () => {
      const db = await setup()
      const entry = await createStoppedTimeEntry(db.drizzle, stoppedInput())
      await db.run(
        `UPDATE projects SET bill_by = 'project', hourly_rate_cents = 77777 WHERE id = 1`,
      )
      const { audit } = await repriceTimeEntry(db.drizzle, {
        timeEntryId: entry.id,
        reason: 'Original authorized reprice',
        repricedAt: '2026-08-27T12:00:00.000Z',
      })
      const auditSql = `SELECT id, time_entry_id, previous_billable_rate_cents,
          billable_rate_cents, previous_cost_rate_cents, cost_rate_cents, reason, repriced_at
        FROM time_entry_rate_reprices WHERE id = ?`
      const entrySql = `SELECT billable_rate_cents, cost_rate_cents, updated_at
        FROM time_entries WHERE id = ?`
      const originalAudit = await db.rows<Record<string, unknown>>(auditSql, audit.id)
      const originalEntry = await db.rows<Record<string, unknown>>(entrySql, entry.id)

      await expect(
        db.run(
          `INSERT OR REPLACE INTO time_entry_rate_reprices
            (id, time_entry_id, previous_billable_rate_cents, billable_rate_cents,
             previous_cost_rate_cents, cost_rate_cents, reason, repriced_at)
           VALUES (?, ?, 77777, 1, 3000, 2, 'forged replacement',
             '2026-08-27T13:00:00.000Z')`,
          audit.id,
          entry.id,
        ),
      ).rejects.toThrow()
      expect(await db.rows<Record<string, unknown>>(auditSql, audit.id)).toEqual(originalAudit)
      expect(await db.rows<Record<string, unknown>>(entrySql, entry.id)).toEqual(originalEntry)
    })

    it('[unit] upgrades a genuine 0002 database without touching snapshots and reruns stably', async () => {
      database = await factory(false)
      const db = database
      await installThroughProjectsTime(db)
      await installBaseFixture(db)
      await db.run(
        `INSERT INTO time_entries
          (id, harvest_id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (91, 'legacy', 1, 1, 1, 1, 1, '2026-06-30', 3600, 3600, 3600,
           1, 0, 12345, NULL, ?, ?)`,
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
      ])
      expect(firstLedger.slice(0, 3).map(({ applied_at: appliedAt }) => appliedAt)).toEqual([
        timestamp,
        timestamp,
        timestamp,
      ])
      expect(
        await db.rows<{ billable: number; cost: number | null }>(
          `SELECT billable_rate_cents AS billable, cost_rate_cents AS cost
           FROM time_entries WHERE id = 91`,
        ),
      ).toEqual([{ billable: 12_345, cost: null }])
      await db.migrateAgain()
      expect(
        await db.rows<{ id: string; applied_at: string }>(
          `SELECT id, applied_at FROM _ezacto_migrations ORDER BY id`,
        ),
      ).toEqual(firstLedger)
    })

    it('[unit] rolls back a failed 0003 migration and retries without partial audit schema', async () => {
      database = await factory(false)
      const db = database
      await installThroughProjectsTime(db)
      await db.run(`CREATE TABLE rate_resolver_conflict (id INTEGER PRIMARY KEY) STRICT`)
      await db.run(`CREATE INDEX time_entry_rate_reprices_entry_id ON rate_resolver_conflict(id)`)
      await expect(db.migrateAgain()).rejects.toThrow()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id`),
      ).toEqual([{ id: '0000_org_people' }, { id: '0001_clients' }, { id: '0002_projects_time' }])
      expect(
        await db.rows<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE name IN ('time_entry_rate_reprices', 'time_entry_rate_reprices_apply')`,
        ),
      ).toEqual([])

      await db.run(`DROP INDEX time_entry_rate_reprices_entry_id`)
      await db.run(`DROP TABLE rate_resolver_conflict`)
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
      ])
    })
  })
}
