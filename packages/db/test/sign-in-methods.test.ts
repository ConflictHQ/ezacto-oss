import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'
import { createSignInMethodRepository } from '../src/sign-in-methods.js'
import * as schema from '../src/schema.js'

/**
 * Issue 761, against a real migrated database. Two properties matter here and
 * neither survives a fake: that an instance which never touched the setting
 * reads as fully enabled, and that `usableBy` reports evidence rather than
 * eligibility -- it is the input to a lockout guard.
 */

const at = '2026-09-15T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const seed = (extra = '') => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, timezone, time_entry_mode, created_at, updated_at)
      VALUES ('Kestrel Environmental', '{"time":true}', 'UTC', 'duration', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
      VALUES (1, 'Ada', 'Okonkwo', 'administrator', 1, '[]', '${at}', '${at}');
    ${extra}
  `)
  sqlite = database
  return createSignInMethodRepository(drizzle(database, { schema }))
}

describe('the sign-in method setting', () => {
  it('[security] reads as fully enabled before anybody touches it', async () => {
    // The upgrade path. A migration that turned a method off would lock an
    // instance out of itself, so the absent key has to mean enabled.
    const repository = seed()
    expect(await repository.list()).toEqual([
      { method: 'password', enabled: true },
      { method: 'magic_link', enabled: true },
      { method: 'google', enabled: true },
      { method: 'github', enabled: true },
      { method: 'apple', enabled: true },
    ])
  })

  it('[api] records only the decisions somebody made', async () => {
    const repository = seed()
    expect(await repository.setEnabled('password', false, at)).toEqual([
      { method: 'password', enabled: false },
      { method: 'magic_link', enabled: true },
      { method: 'google', enabled: true },
      { method: 'github', enabled: true },
      { method: 'apple', enabled: true },
    ])
    // The column holds the one decision, not a snapshot of all four.
    const stored = sqlite!
      .prepare(`SELECT sign_in_methods AS value FROM organizations WHERE id = 1`)
      .get() as { value: string }
    expect(JSON.parse(stored.value)).toEqual({ password: false })

    expect(await repository.setEnabled('password', true, at)).toContainEqual({
      method: 'password',
      enabled: true,
    })
  })

  it('[security] usableBy is evidence, not eligibility', async () => {
    // A guard built on "they probably could" is a guard that hands someone a
    // locked instance and an explanation. A verified address earns the emailed
    // link; a provider is earned by having signed in that way at least once.
    const repository = seed(`
      INSERT INTO user_emails (user_id, address, is_primary, verified_at, created_at, updated_at)
        VALUES (1, 'ada@example.test', 1, '${at}', '${at}', '${at}');
      INSERT INTO user_identities (user_id, provider, provider_subject, created_at, updated_at)
        VALUES (1, 'google', 'sub-1', '${at}', '${at}');
    `)
    expect(await repository.usableBy(1)).toEqual(['magic_link', 'google'])
  })

  it('[security] an unverified address earns nothing', async () => {
    // The schema already refuses an unverified primary, so this is the shape an
    // unverified address actually takes: added, not yet proved.
    const repository = seed(`
      INSERT INTO user_emails (user_id, address, is_primary, created_at, updated_at)
        VALUES (1, 'ada@example.test', 0, '${at}', '${at}');
    `)
    expect(await repository.usableBy(1)).toEqual([])
  })

  it('[security] never reports another user as able to sign in', async () => {
    const repository = seed(`
      INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
        VALUES (2, 'Robin', 'Diaz', 'member', 1, '[]', '${at}', '${at}');
      INSERT INTO user_identities (user_id, provider, provider_subject, created_at, updated_at)
        VALUES (2, 'github', 'sub-2', '${at}', '${at}');
    `)
    expect(await repository.usableBy(1)).toEqual([])
    expect(await repository.usableBy(2)).toEqual(['github'])
  })

  it('[api] refuses a user id that is not one', async () => {
    const repository = seed()
    await expect(repository.usableBy(0)).rejects.toBeInstanceOf(RangeError)
  })

  it('[security] counts an Apple identity as a way in', async () => {
    // Apple draws no button on the sign-in card -- the app holds the platform
    // prompt -- so it is easy to forget it is a way in at all. The lockout
    // guard has to see it, or it would refuse a change that is in fact safe.
    const repository = seed(`
      INSERT INTO user_identities (user_id, provider, provider_subject, created_at, updated_at)
        VALUES (1, 'apple', 'sub-apple', '${at}', '${at}');
    `)
    expect(await repository.usableBy(1)).toEqual(['apple'])
  })
})
