import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer, migrateContainerThrough } from '../src/migrate.js'
import { sourceLineageMigration } from '../src/migrations/0071_source_lineage.js'

const at = '2026-09-11T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

/**
 * The import lineage a refresh compares against (#665).
 *
 * `source_updated_at` is not `updated_at`, and the difference is the whole
 * point: a person editing a row moves `updated_at`, so comparing that would let
 * a snapshot overwrite an edit made five minutes ago on a client while the same
 * sentence about an invoice would not. One column, one meaning.
 */
describe('the lineage a refresh reads', () => {
  const upgraded = (seed: (database: BetterSqlite3.Database) => void) => {
    const database = new BetterSqlite3(':memory:')
    migrateContainerThrough(database, '0070_payout_destination_kind')
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('Fixture', '{}', '${at}', '${at}');
    `)
    seed(database)
    for (const statement of sourceLineageMigration) database.exec(statement)
    sqlite = database
    return database
  }

  it('[db] backfills an imported row from the timestamp the loader copied', async () => {
    const database = upgraded((db) => {
      db.exec(`INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
               VALUES (1, 4242, 'Kestrel Environmental', 'USD', '${at}', '2026-08-01T09:00:00.000Z')`)
    })
    expect(
      database.prepare(`SELECT source_updated_at FROM clients WHERE id = 1`).get(),
    ).toEqual({ source_updated_at: '2026-08-01T09:00:00.000Z' })
  })

  it('[money] leaves a row this system created with no lineage at all', async () => {
    // A client somebody added here has no upstream to be newer than it. Giving
    // it one would invite a refresh to compare against something that never
    // existed.
    const database = upgraded((db) => {
      db.exec(`INSERT INTO clients (id, name, currency, created_at, updated_at)
               VALUES (2, 'Northpeak', 'USD', '${at}', '${at}')`)
    })
    expect(
      database.prepare(`SELECT source_updated_at FROM clients WHERE id = 2`).get(),
    ).toEqual({ source_updated_at: null })
  })

  it('[money] a local edit moves updated_at and leaves the lineage where it was', async () => {
    // The property the whole column exists for. After this edit the row looks
    // newer than the snapshot by `updated_at` and older by lineage, and only
    // the second is the question a refresh is asking.
    const database = upgraded((db) => {
      db.exec(`INSERT INTO clients (id, harvest_id, name, currency, created_at, updated_at)
               VALUES (3, 4243, 'Halcyon Biolabs', 'USD', '${at}', '2026-08-01T09:00:00.000Z')`)
    })
    database
      .prepare(`UPDATE clients SET name = ?, updated_at = ? WHERE id = 3`)
      .run('Halcyon Biolabs Ltd', '2026-09-20T10:00:00.000Z')
    expect(database.prepare(`SELECT updated_at, source_updated_at FROM clients WHERE id = 3`).get())
      .toEqual({
        updated_at: '2026-09-20T10:00:00.000Z',
        source_updated_at: '2026-08-01T09:00:00.000Z',
      })
  })

  it('[db] reaches every simple resource the loader writes a harvest id into', async () => {
    const database = new BetterSqlite3(':memory:')
    sqlite = database
    await migrateContainer(database)
    const carries = (table: string): boolean =>
      (
        database
          .prepare(`SELECT count(*) AS n FROM pragma_table_info(?) WHERE name = 'source_updated_at'`)
          .get(table) as { n: number }
      ).n > 0
    for (const table of [
      'users', 'roles', 'clients', 'contacts', 'tasks', 'projects',
      'expense_categories', 'task_assignments', 'user_assignments',
      'estimates', 'time_entries', 'expenses',
    ]) {
      expect(carries(table), `${table} has no lineage column`).toBe(true)
    }
    // Invoices had it first; the refresh rule is the same one.
    expect(carries('invoices')).toBe(true)
    // And the two that must not have it: rates are append-only, so a refresh
    // can never write them and a lineage there would be read by nothing.
    expect(carries('user_billable_rates'), 'rates are append-only').toBe(false)
    expect(carries('user_cost_rates'), 'rates are append-only').toBe(false)
  })
})
