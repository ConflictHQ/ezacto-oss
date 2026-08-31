import BetterSqlite3 from 'better-sqlite3'
import { and, eq } from 'drizzle-orm'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import {
  migrateContainer,
  migrateContainerThrough,
  migrateD1,
  migrateD1Through,
} from '../src/migrate.js'
import { timeEntries } from '../src/schema.js'
import {
  assertStoredTimeEntryNoteRequirement,
  currentTimeEntryNotePolicyAllows,
} from '../src/time-entry-note-requirements.js'

type OrmDatabase = Parameters<typeof assertStoredTimeEntryNoteRequirement>[0]

interface TestDatabase {
  orm: OrmDatabase
  run(sql: string, ...params: unknown[]): Promise<void>
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>
  migrateCurrent(): Promise<void>
  close(): Promise<void>
}

const containerDatabase = async (): Promise<TestDatabase> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainerThrough(sqlite, '0024_migration_worksheet_completions')
  return {
    orm: createContainerDatabase(sqlite),
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params)
    },
    rows: async <T>(sql: string, ...params: unknown[]) => sqlite.prepare(sql).all(...params) as T[],
    migrateCurrent: async () => migrateContainer(sqlite),
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
  await migrateD1Through(d1, '0024_migration_worksheet_completions')
  return {
    orm: createD1Database(d1),
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
    migrateCurrent: async () => migrateD1(d1),
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerDatabase],
  ['D1', d1Database],
] as const

const now = '2026-08-31T12:00:00.000Z'

for (const [runtime, factory] of factories) {
  describe(`time-entry note requirement migration (${runtime})`, () => {
    let database: TestDatabase | undefined

    afterEach(async () => database?.close())

    it('[db] upgrades populated 0024 data with backward-compatible defaults and bounds', async () => {
      database = await factory()
      const db = database
      await db.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at)
          VALUES (?, '{}', ?, ?)`,
        'Policy org',
        now,
        now,
      )
      await db.run(
        `INSERT INTO users
          (id, first_name, last_name, manager_grants, created_at, updated_at)
          VALUES (1, 'Policy', 'Person', '[]', ?, ?)`,
        now,
        now,
      )
      await db.run(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
          VALUES (1, 'Policy client', 'USD', ?, ?)`,
        now,
        now,
      )
      await db.run(
        `INSERT INTO projects (id, client_id, name, created_at, updated_at)
          VALUES (1, 1, 'Policy project', ?, ?)`,
        now,
        now,
      )
      await db.run(
        `INSERT INTO user_assignments
          (id, project_id, user_id, created_at, updated_at)
          VALUES (1, 1, 1, ?, ?)`,
        now,
        now,
      )
      await db.run(
        `INSERT INTO tasks (id, name, created_at, updated_at)
          VALUES (1, 'Policy task', ?, ?)`,
        now,
        now,
      )
      await db.run(
        `INSERT INTO task_assignments
          (id, project_id, task_id, billable, created_at, updated_at)
          VALUES (1, 1, 1, 1, ?, ?)`,
        now,
        now,
      )
      await db.run(
        `INSERT INTO time_entries (
          id, user_id, project_id, task_id, user_assignment_id,
          task_assignment_id, spent_date, seconds, seconds_without_timer,
          rounded_seconds, notes, billable, created_at, updated_at
        ) VALUES
          (1, 1, 1, 1, 1, 1, '2026-08-30', 60, 60, 60, NULL, 1, ?, ?),
          (2, 1, 1, 1, 1, 1, '2026-08-31', 60, 60, 60, ' x ', 1, ?, ?)`,
        now,
        now,
        now,
        now,
      )

      await db.migrateCurrent()

      expect(
        await db.rows<{ id: number; notes: string | null }>(
          `SELECT id, notes FROM time_entries ORDER BY id`,
        ),
      ).toEqual([
        { id: 1, notes: null },
        { id: 2, notes: ' x ' },
      ])

      await db.run(
        `UPDATE organizations
          SET time_entry_notes_required = 1,
            time_entry_notes_minimum_length = 1
          WHERE id = 1`,
      )
      await expect(
        assertStoredTimeEntryNoteRequirement(db.orm, 1, 1, 'x'),
      ).resolves.toMatchObject({ minimumLength: 1 })
      await db.run(
        `UPDATE organizations
          SET time_entry_notes_minimum_length = 2
          WHERE id = 1`,
      )
      const racedWrite = await db.orm
        .update(timeEntries)
        .set({ notes: 'x' })
        .where(
          and(
            eq(timeEntries.id, 2),
            currentTimeEntryNotePolicyAllows(1, 1, 'x'),
          ),
        )
        .returning()
      expect(racedWrite).toEqual([])
      expect(
        await db.rows<{ notes: string }>(
          `SELECT notes FROM time_entries WHERE id = 2`,
        ),
      ).toEqual([{ notes: ' x ' }])
      await db.run(
        `UPDATE organizations
          SET time_entry_notes_required = 0,
            time_entry_notes_minimum_length = 1
          WHERE id = 1`,
      )

      expect(
        await db.rows<{
          organization_minimum: number
          organization_required: number
          project_minimum: number | null
          person_minimum: number | null
          pair_minimum: number | null
        }>(
          `SELECT organization.time_entry_notes_minimum_length AS organization_minimum,
            organization.time_entry_notes_required AS organization_required,
            project.time_entry_notes_minimum_length AS project_minimum,
            person.time_entry_notes_minimum_length AS person_minimum,
            pair.time_entry_notes_minimum_length AS pair_minimum
          FROM organizations AS organization
          CROSS JOIN projects AS project
          CROSS JOIN users AS person
          CROSS JOIN user_assignments AS pair
          WHERE organization.id = 1 AND project.id = 1
            AND person.id = 1 AND pair.id = 1`,
        ),
      ).toEqual([
        {
          organization_minimum: 1,
          organization_required: 0,
          project_minimum: null,
          person_minimum: null,
          pair_minimum: null,
        },
      ])

      await db.run(`UPDATE organizations SET time_entry_notes_minimum_length = 10000 WHERE id = 1`)
      await db.run(`UPDATE projects SET time_entry_notes_minimum_length = 1 WHERE id = 1`)
      await db.run(`UPDATE users SET time_entry_notes_minimum_length = 10000 WHERE id = 1`)
      await db.run(
        `UPDATE user_assignments SET time_entry_notes_minimum_length = NULL WHERE id = 1`,
      )

      const targets = ['organizations', 'projects', 'users', 'user_assignments'] as const
      for (const table of targets) {
        for (const invalid of [0, 10_001, 1.5]) {
          await expect(
            db.run(`UPDATE ${table} SET time_entry_notes_minimum_length = ? WHERE id = 1`, invalid),
            `${table}:${invalid}`,
          ).rejects.toThrow()
        }
      }
      await expect(
        db.run(`UPDATE organizations SET time_entry_notes_minimum_length = NULL WHERE id = 1`),
      ).rejects.toThrow()

      await db.migrateCurrent()
      expect(
        await db.rows<{ id: string; total: number }>(
          `SELECT id, count(*) AS total FROM _ezacto_migrations
            WHERE id = '0025_time_entry_note_requirements' GROUP BY id`,
        ),
      ).toEqual([{ id: '0025_time_entry_note_requirements', total: 1 }])
    })
  })
}
