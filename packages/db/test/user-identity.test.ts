import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { readUserIdentity } from '../src/operations.js'

const at = '2026-10-08T09:00:00.000Z'

const migrated = () => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const run = (sql: string, ...bindings: unknown[]) => void sqlite.prepare(sql).run(...bindings)
  run(
    `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('Example Studio LLC', '{}', ?, ?)`,
    at,
    at,
  )
  run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Ana', 'Example', 'administrator', '[]', ?, ?)`,
    at,
    at,
  )
  return { orm: createContainerDatabase(sqlite), run, sqlite }
}

describe('readUserIdentity (the identity card read "User #1")', () => {
  it('[integration] returns the name and the live primary address', async () => {
    const { orm, run } = migrated()
    run(
      `INSERT INTO user_emails (user_id, address, is_primary, verified_at, invalidated_at, created_at, updated_at)
       VALUES (1, 'old@example.test', 0, ?, NULL, ?, ?)`,
      at,
      at,
      at,
    )
    run(
      `INSERT INTO user_emails (user_id, address, is_primary, verified_at, invalidated_at, created_at, updated_at)
       VALUES (1, 'ana@example.test', 1, ?, NULL, ?, ?)`,
      at,
      at,
      at,
    )
    expect(await readUserIdentity(orm, 1)).toEqual({
      firstName: 'Ana',
      lastName: 'Example',
      email: 'ana@example.test',
    })
  })

  it('[integration] has no address without a primary one, and nothing for an unknown user', async () => {
    const { orm, run } = migrated()
    // A secondary address is not the person's address of record.
    run(
      `INSERT INTO user_emails (user_id, address, is_primary, verified_at, invalidated_at, created_at, updated_at)
       VALUES (1, 'other@example.test', 0, ?, NULL, ?, ?)`,
      at,
      at,
      at,
    )
    expect(await readUserIdentity(orm, 1)).toEqual({
      firstName: 'Ana',
      lastName: 'Example',
      email: null,
    })
    expect(await readUserIdentity(orm, 99)).toBeNull()
  })
})
