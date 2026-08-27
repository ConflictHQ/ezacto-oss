import type BetterSqlite3 from 'better-sqlite3'
import { orgPeopleMigration } from './migrations/0000_org_people.js'

const migrationId = '0000_org_people'
const ledger = `CREATE TABLE IF NOT EXISTS _ezacto_migrations (
  id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
) STRICT`

export const migrateContainer = (database: BetterSqlite3.Database): void => {
  database.pragma('foreign_keys = ON')
  database.exec(ledger)
  if (database.prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?').get(migrationId)) return
  database.exec('BEGIN')
  try {
    for (const statement of orgPeopleMigration) database.exec(statement)
    database
      .prepare('INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)')
      .run(migrationId, new Date().toISOString())
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export const migrateD1 = async (database: D1Database): Promise<void> => {
  await database.exec('PRAGMA foreign_keys = ON')
  await database.prepare(ledger).run()
  if (await database.prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?').bind(migrationId).first()) {
    return
  }
  await database.batch([
    ...orgPeopleMigration.map((sql) => database.prepare(sql)),
    database
      .prepare('INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)')
      .bind(migrationId, new Date().toISOString()),
  ])
}
