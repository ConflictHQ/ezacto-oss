import type BetterSqlite3 from 'better-sqlite3'
import { orgPeopleMigration } from './migrations/0000_org_people.js'
import { clientsMigration } from './migrations/0001_clients.js'
import { projectsTimeMigration } from './migrations/0002_projects_time.js'
import { rateResolverMigration } from './migrations/0003_rate_resolver.js'

const ledger = `CREATE TABLE IF NOT EXISTS _ezacto_migrations (
  id TEXT PRIMARY KEY, applied_at TEXT NOT NULL
) STRICT`

const migrations = [
  { id: '0000_org_people', statements: orgPeopleMigration },
  { id: '0001_clients', statements: clientsMigration },
  { id: '0002_projects_time', statements: projectsTimeMigration },
  { id: '0003_rate_resolver', statements: rateResolverMigration },
] as const

export const migrateContainer = (database: BetterSqlite3.Database): void => {
  database.pragma('foreign_keys = ON')
  database.exec(ledger)
  for (const migration of migrations) {
    database.exec('BEGIN IMMEDIATE')
    try {
      if (database.prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?').get(migration.id)) {
        database.exec('COMMIT')
        continue
      }
      for (const statement of migration.statements) database.exec(statement)
      database
        .prepare('INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)')
        .run(migration.id, new Date().toISOString())
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

export const migrateD1 = async (database: D1Database): Promise<void> => {
  // D1 migrations are a serialized deploy/admin operation; batch supplies each
  // migration's atomic boundary, while the ledger remains its concurrency contract.
  await database.exec('PRAGMA foreign_keys = ON')
  await database.prepare(ledger).run()
  for (const migration of migrations) {
    if (
      await database
        .prepare('SELECT 1 FROM _ezacto_migrations WHERE id = ?')
        .bind(migration.id)
        .first()
    ) {
      continue
    }
    await database.batch([
      ...migration.statements.map((sql) => database.prepare(sql)),
      database
        .prepare('INSERT INTO _ezacto_migrations (id, applied_at) VALUES (?, ?)')
        .bind(migration.id, new Date().toISOString()),
    ])
  }
}
