import { TrackedMutationLockedError } from '@ezacto/core'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import {
  getTrackedState,
  guardTrackedEntityMutation,
  type TrackedEntityReference,
} from '../src/tracked-state.js'

type OrmDatabase = Parameters<typeof getTrackedState>[0]

interface TestDatabase {
  orm: OrmDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateAgain(): Promise<void>
  close(): Promise<void>
}

const timestamp = '2026-08-28T00:00:00.000Z'
const modules = JSON.stringify({ expenses: true, invoices: true })

const containerDatabase = (): TestDatabase => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (statement, ...params) => {
      sqlite.prepare(statement).run(...params)
    },
    rows: async <T>(statement: string, ...params: unknown[]) =>
      sqlite.prepare(statement).all(...params) as T[],
    migrateAgain: async () => migrateContainer(sqlite),
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
    orm: createD1Database(d1),
    run: async (statement, ...params) => {
      await d1
        .prepare(statement)
        .bind(...params)
        .run()
    },
    rows: async <T>(statement: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(statement)
          .bind(...params)
          .all<T>()
      ).results,
    migrateAgain: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', async () => containerDatabase()],
  ['D1', d1Database],
] as const

const reference = (
  entityType: TrackedEntityReference['entityType'],
  policyLocked = false,
): TrackedEntityReference => ({
  entityType,
  entityId: entityType === 'time_entry' ? 1 : 2,
  policyLocked,
})

const installFixture = async (database: TestDatabase): Promise<void> => {
  await database.run(
    `INSERT INTO organizations (name, modules, created_at, updated_at)
     VALUES ('Sanitized Organization', ?, ?, ?)`,
    modules,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO users
      (id, first_name, last_name, manager_grants, created_at, updated_at)
     VALUES (1, 'Sanitized', 'User', '[]', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Sanitized Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
     VALUES (1, 1, 'Sanitized Project', 'SAFE', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Sanitized Task', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO user_assignments
      (id, project_id, user_id, created_at, updated_at)
     VALUES (1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO task_assignments
      (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO expense_categories (id, name, created_at, updated_at)
     VALUES (1, 'Sanitized Category', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO invoices
      (id, client_id, number, currency, issue_date, due_date, created_at, updated_at)
     VALUES (1, 1, 'SAFE-1', 'USD', '2026-08-01', '2026-08-31', ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, notes, billable,
       created_at, updated_at)
     VALUES (1, 1, 1, 1, 1, 1, '2026-08-28', 60, 60, 60, 'time before', 1, ?, ?)`,
    timestamp,
    timestamp,
  )
  await database.run(
    `INSERT INTO expenses
      (id, user_id, project_id, expense_category_id, spent_date, notes,
       total_cost_cents, created_at, updated_at)
     VALUES (2, 1, 1, 1, '2026-08-28', 'expense before', 1000, ?, ?)`,
    timestamp,
    timestamp,
  )
}

for (const [runtime, factory] of factories) {
  describe(`shared three-axis persistence (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    const setup = async (): Promise<TestDatabase> => {
      database = await factory()
      await installFixture(database)
      return database
    }

    it('[unit] installs time-entry approval storage without storing derived lock state', async () => {
      const db = await setup()
      expect(
        await db.rows<{ id: string }>(`SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1`),
      ).toEqual([{ id: '0009_three_axis_state' }])
      for (const table of ['time_entries', 'expenses']) {
        const columns = await db.rows<{
          name: string
          notnull: number
          dflt_value: string | null
        }>(`PRAGMA table_info(${table})`)
        expect(columns.map(({ name }) => name)).toContain('approval_status')
        expect(columns.find(({ name }) => name === 'approval_status')).toMatchObject({
          notnull: 1,
          dflt_value: "'unsubmitted'",
        })
        for (const forbidden of [
          'locked',
          'is_locked',
          'locked_reason',
          'locked_reason_code',
          'is_billed',
        ]) {
          expect(columns.map(({ name }) => name)).not.toContain(forbidden)
        }
      }
      const definitions = await db.rows<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE sql IS NOT NULL`,
      )
      expect(definitions.map(({ sql }) => sql).join('\n')).not.toMatch(
        /\b(?:is_locked|locked_reason|locked_reason_code)\b/,
      )
      await expect(db.run(`UPDATE time_entries SET approval_status = 'invalid'`)).rejects.toThrow()
      await db.migrateAgain()
      expect(
        await db.rows<{ count: number }>(
          `SELECT count(*) AS count FROM _ezacto_migrations
           WHERE id = '0009_three_axis_state'`,
        ),
      ).toEqual([{ count: 1 }])
    })

    it('[unit] derives both entity families through one fact-loader and domain path', async () => {
      const db = await setup()
      for (const entityType of ['time_entry', 'expense'] as const) {
        expect(await getTrackedState(db.orm, reference(entityType))).toEqual({
          approvalStatus: 'unsubmitted',
          invoiceId: null,
          isBilled: false,
          isLocked: false,
          lockedReasonCode: null,
          lockedReason: null,
        })
      }
      await expect(
        getTrackedState(db.orm, {
          ...reference('time_entry'),
          policyLocked: undefined,
        } as unknown as TrackedEntityReference),
      ).rejects.toThrow(/already-computed boolean fact/)

      await db.run(`UPDATE time_entries SET invoice_id = 1, approval_status = 'approved'`)
      await db.run(`UPDATE expenses SET invoice_id = 1, approval_status = 'approved'`)
      await db.run(`UPDATE clients SET is_active = 0`)
      await db.run(`UPDATE projects SET is_active = 0`)
      await db.run(`UPDATE tasks SET is_active = 0`)

      for (const entityType of ['time_entry', 'expense'] as const) {
        expect(await getTrackedState(db.orm, reference(entityType, true))).toMatchObject({
          isBilled: true,
          isLocked: true,
          lockedReasonCode: 'invoiced',
        })
      }
      await db.run(`UPDATE time_entries SET invoice_id = NULL`)
      await db.run(`UPDATE expenses SET invoice_id = NULL`)
      for (const entityType of ['time_entry', 'expense'] as const) {
        expect(await getTrackedState(db.orm, reference(entityType, true))).toMatchObject({
          isBilled: false,
          lockedReasonCode: 'approved',
        })
      }
      await db.run(`UPDATE time_entries SET approval_status = 'submitted'`)
      await db.run(`UPDATE expenses SET approval_status = 'submitted'`)
      for (const entityType of ['time_entry', 'expense'] as const) {
        expect(await getTrackedState(db.orm, reference(entityType, true))).toMatchObject({
          lockedReasonCode: 'policy_locked',
        })
        expect(await getTrackedState(db.orm, reference(entityType))).toMatchObject({
          lockedReasonCode: 'client_archived',
        })
      }
      await db.run(`UPDATE clients SET is_active = 1`)
      for (const entityType of ['time_entry', 'expense'] as const) {
        expect(await getTrackedState(db.orm, reference(entityType))).toMatchObject({
          lockedReasonCode: 'project_archived',
        })
      }
      await db.run(`UPDATE projects SET is_active = 1`)
      expect(await getTrackedState(db.orm, reference('time_entry'))).toMatchObject({
        lockedReasonCode: 'task_archived',
      })
      expect(await getTrackedState(db.orm, reference('expense'))).toMatchObject({
        isLocked: false,
        lockedReasonCode: null,
      })
    })

    it('[unit] returns the typed reason before either locked mutation changes data', async () => {
      const db = await setup()
      await db.run(`UPDATE time_entries SET approval_status = 'approved'`)
      await db.run(`UPDATE expenses SET approval_status = 'approved'`)

      const updateNotes = async (entityType: TrackedEntityReference['entityType']) => {
        await guardTrackedEntityMutation(db.orm, reference(entityType))
        const table = entityType === 'time_entry' ? 'time_entries' : 'expenses'
        await db.run(
          `UPDATE ${table} SET notes = 'after' WHERE id = ?`,
          reference(entityType).entityId,
        )
      }

      for (const entityType of ['time_entry', 'expense'] as const) {
        let caught: unknown
        try {
          await updateNotes(entityType)
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(TrackedMutationLockedError)
        expect(caught).toMatchObject({
          name: 'TrackedMutationLockedError',
          code: 'tracked_mutation_locked',
          reasonCode: 'approved',
          reason: 'Approved',
        })
      }
      expect(await db.rows<{ notes: string }>(`SELECT notes FROM time_entries`)).toEqual([
        { notes: 'time before' },
      ])
      expect(await db.rows<{ notes: string }>(`SELECT notes FROM expenses`)).toEqual([
        { notes: 'expense before' },
      ])
    })
  })
}
