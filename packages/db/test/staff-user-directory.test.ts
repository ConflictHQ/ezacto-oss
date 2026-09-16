import BetterSqlite3 from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createContainerStaffUserDirectory } from '../src/staff-user-directory.js'
import { migrateContainer } from '../src/migrate.js'

const at = '2026-09-15T12:00:00.000Z'

let database: BetterSqlite3.Database

/**
 * A real migrated database rather than a stub: the whole of this behaviour is
 * one SQL predicate, and a fake would only restate the predicate back at us.
 */
const seed = () => {
  database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Ada', 'Admin', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, is_active, created_at, updated_at)
      VALUES (2, 'Gone', 'Away', 'member', '[]', 0, '${at}', '${at}');
    INSERT INTO user_emails (user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at)
      VALUES (1, 'ada@example.com', '${at}', 1, NULL, '${at}', '${at}');
    INSERT INTO user_emails (user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at)
      VALUES (1, 'attacker@evil.example', NULL, 0, NULL, '${at}', '${at}');
    INSERT INTO user_emails (user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at)
      VALUES (1, 'old@example.com', '${at}', 0, '${at}', '${at}', '${at}');
    INSERT INTO user_emails (user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at)
      VALUES (2, 'gone@example.com', '${at}', 1, NULL, '${at}', '${at}');
  `)
}

beforeEach(seed)

describe('staff user directory', () => {
  const directory = () => createContainerStaffUserDirectory(database)

  it('resolves a verified address on an active user', async () => {
    expect(await directory().findByEmail('ada@example.com')).toEqual({ userId: 1 })
  })

  it('is case and whitespace insensitive, the way sign-in is', async () => {
    expect(await directory().findByEmail('  ADA@Example.com ')).toEqual({ userId: 1 })
  })

  /**
   * #730. A pending address is a claim, not a proof. Anyone able to add one to
   * a user could otherwise have a magic link minting that user's session
   * mailed to an address they control -- and on an administrator that is a
   * full takeover. Password reset, OIDC linking and Cloudflare Access all
   * require verification; this path used to be the only one that did not.
   */
  it('refuses an unverified address, so a pending row cannot mint a session', async () => {
    expect(await directory().findByEmail('attacker@evil.example')).toBeNull()
  })

  it('refuses an invalidated address', async () => {
    expect(await directory().findByEmail('old@example.com')).toBeNull()
  })

  it('refuses an address on a deactivated user', async () => {
    expect(await directory().findByEmail('gone@example.com')).toBeNull()
  })

  it('is null for an address nobody holds', async () => {
    expect(await directory().findByEmail('nobody@example.com')).toBeNull()
  })
})
