import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'

const at = '2026-09-09T09:00:00.000Z'

const setup = (): BetterSqlite3.Database => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database
    .prepare(
      `INSERT INTO users
        (id, first_name, last_name, profile, manager_grants, is_contractor, is_active,
         created_at, updated_at)
       VALUES (1, 'Ada', 'Byron', 'administrator', '[]', 0, 1, ?, ?),
              (2, 'Kai', 'Reyes', 'member', '[]', 1, 1, ?, ?),
              (3, 'Nell', 'Ward', 'member', '[]', 1, 1, ?, ?)`,
    )
    .run(at, at, at, at, at, at)
  return database
}

const link = (
  database: BetterSqlite3.Database,
  id: number,
  userId: number,
  provider: string,
  externalId: string,
  detachedAt: string | null = null,
): void => {
  database
    .prepare(
      `INSERT INTO user_payout_accounts
        (id, user_id, provider, external_id, linked_by_user_id, linked_at,
         verified_at, detached_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, provider, externalId, at, at, detachedAt, at, at)
}

describe('payout account links', () => {
  it('[db] lets one person hold an account at each provider', () => {
    // The whole reason this is a table rather than a deel_id column: somebody
    // with a Wise id and no Deel account is payable, and somebody with both is
    // not a conflict.
    const database = setup()
    link(database, 1, 2, 'deel', 'deel-abc')
    link(database, 2, 2, 'wise', 'wise-xyz')
    expect(
      database.prepare(`SELECT count(*) AS n FROM user_payout_accounts`).get(),
    ).toEqual({ n: 2 })
    database.close()
  })

  it('[db] refuses a second current account at the same provider', () => {
    const database = setup()
    link(database, 1, 2, 'deel', 'deel-abc')
    expect(() => link(database, 2, 2, 'deel', 'deel-second')).toThrow(/UNIQUE/)
    database.close()
  })

  it('[security] refuses two people pointing at the same provider account', () => {
    // One of them would be paid for the other's work, and the place that gets
    // discovered is a bank statement.
    const database = setup()
    link(database, 1, 2, 'deel', 'deel-abc')
    expect(() => link(database, 2, 3, 'deel', 'deel-abc')).toThrow(/UNIQUE/)
    database.close()
  })

  it('[db] frees the identifier once the old link is detached', () => {
    // A person moving providers, or an account reassigned after somebody
    // leaves. History stays; the constraint only binds current rows.
    const database = setup()
    link(database, 1, 2, 'deel', 'deel-abc', at)
    link(database, 2, 3, 'deel', 'deel-abc')
    expect(
      database.prepare(`SELECT count(*) AS n FROM user_payout_accounts`).get(),
    ).toEqual({ n: 2 })
    database.close()
  })

  it('[security] refuses to repoint a link at another account or person', () => {
    // Payments follow the external id. Repointing in place would move where
    // money goes while leaving no record that it moved.
    const database = setup()
    link(database, 1, 2, 'deel', 'deel-abc')
    expect(() =>
      database
        .prepare(`UPDATE user_payout_accounts SET external_id = 'deel-other' WHERE id = 1`)
        .run(),
    ).toThrow(/identity is immutable/)
    expect(() =>
      database.prepare(`UPDATE user_payout_accounts SET user_id = 3 WHERE id = 1`).run(),
    ).toThrow(/identity is immutable/)
    database.close()
  })

  it('[db] refuses to reattach a detached account', () => {
    // Re-attaching is a new row, so the record of when money could have gone
    // where stays true.
    const database = setup()
    link(database, 1, 2, 'deel', 'deel-abc', at)
    expect(() =>
      database.prepare(`UPDATE user_payout_accounts SET detached_at = NULL WHERE id = 1`).run(),
    ).toThrow(/cannot be reattached/)
    database.close()
  })

  it('[db] refuses a provider it does not know', () => {
    const database = setup()
    expect(() => link(database, 1, 2, 'paypal', 'pp-1')).toThrow(/CHECK/)
    database.close()
  })
})
