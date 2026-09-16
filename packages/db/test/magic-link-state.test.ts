import BetterSqlite3 from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { createContainerMagicLinkStore } from '../src/magic-link-state.js'
import { migrateContainer } from '../src/migrate.js'

const at = '2026-09-16T12:00:00.000Z'
const hour = (h: number) => `2026-09-16T${String(h).padStart(2, '0')}:00:00.000Z`

let database: BetterSqlite3.Database

/** A real migrated database: the sweep and the throttle are both SQL. */
const seed = () => {
  database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel', 'USD', '${at}', '${at}');
    INSERT INTO contacts (id, client_id, first_name, last_name, email, created_at, updated_at)
      VALUES (1, 1, 'Alice', 'Ng', 'alice@kestrel.test', '${at}', '${at}');
  `)
}

const store = (now: string) => createContainerMagicLinkStore(database, { now: () => now })

const insert = (jti: string, expiresAt: string, usedAt: string | null, createdAt: string) =>
  database
    .prepare(
      `INSERT INTO magic_link_tokens
        (jti, contact_email, contact_id, client_id, token_hash, expires_at, used_at, created_at)
       VALUES (?, 'alice@kestrel.test', 1, 1, ?, ?, ?, ?)`,
    )
    .run(jti, hashFor(jti), expiresAt, usedAt, createdAt)

const hashFor = (jti: string) => jti.padEnd(64, '0').slice(0, 64).replace(/[^0-9a-f]/g, 'a')

const remaining = () =>
  (database.prepare('SELECT jti FROM magic_link_tokens ORDER BY jti').all() as { jti: string }[]).map(
    (row) => row.jti,
  )

beforeEach(seed)

describe('portal magic link store', () => {
  /**
   * #734. Nothing ever deleted from this table, so it grew one row per request
   * for ever, including every request nobody clicked. An unauthenticated route
   * fed it.
   */
  it('sweeps expired and used rows when it writes a new one', async () => {
    insert('expired', hour(11), null, hour(10))
    insert('used', hour(23), hour(11), hour(10))
    insert('live', hour(23), null, hour(11))
    await store(hour(12)).create({
      jti: 'fresh',
      contactEmail: 'alice@kestrel.test',
      contactId: 1,
      clientId: 1,
      tokenHash: hashFor('fresh'),
      expiresAt: hour(23),
    })
    expect(remaining()).toEqual(['fresh', 'live'])
  })

  it('reports a live link for the address, so a repeat request does not mail again', async () => {
    insert('live', hour(23), null, hour(11))
    expect(await store(hour(12)).hasActiveLink('alice@kestrel.test', hour(12), hour(11))).toBe(true)
  })

  it('matches the address case-insensitively, as sign-in does', async () => {
    insert('live', hour(23), null, hour(11))
    expect(await store(hour(12)).hasActiveLink('ALICE@Kestrel.test', hour(12), hour(11))).toBe(true)
  })

  it('does not count a link issued before the throttle window', async () => {
    insert('old', hour(23), null, hour(9))
    expect(await store(hour(12)).hasActiveLink('alice@kestrel.test', hour(12), hour(11))).toBe(false)
  })

  it('does not count an expired or an already used link', async () => {
    insert('expired', hour(11), null, hour(11))
    insert('used', hour(23), hour(11), hour(11))
    expect(await store(hour(12)).hasActiveLink('alice@kestrel.test', hour(12), hour(11))).toBe(false)
  })

  it('is false for an address with no links at all', async () => {
    expect(await store(hour(12)).hasActiveLink('nobody@kestrel.test', hour(12), hour(11))).toBe(false)
  })
})
