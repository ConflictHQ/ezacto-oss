import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createWiseGrantStore, type WiseGrantStore } from '../src/wise-grants.js'

/**
 * Issue 543. A contractor authorises their own Wise account; what the handshake
 * leaves behind is a credential and a payment destination, and the two must not
 * be able to take each other down.
 */

const t = (minute: number): string =>
  `2026-09-13T12:${String(minute).padStart(2, '0')}:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (): Promise<{
  sqlite: BetterSqlite3.Database
  store: WiseGrantStore
}> => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (2, 'Contractor', 'Two', 'member', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (3, 'Contractor', 'Three', 'member', '[]', '${t(0)}', '${t(0)}');
  `)
  sqlite = database
  return { sqlite: database, store: createWiseGrantStore(createContainerDatabase(database)) }
}

const record = (store: WiseGrantStore, overrides: Record<string, unknown> = {}) =>
  store.record({
    userId: 2,
    environment: 'sandbox',
    profileId: '41000001',
    profileType: 'personal',
    accessToken: 'access-one',
    refreshToken: 'refresh-one',
    accessTokenExpiresAt: t(30),
    now: t(1),
    ...overrides,
  } as never)

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('the state that ties a callback to a request (#543)', () => {
  it('[db] hands back what the request said, once', async () => {
    const { store } = await fixture()
    await store.beginAuthorization({
      state: 'a-state-long-enough',
      userId: 2,
      environment: 'sandbox',
      redirectUri: 'https://time.example.test/api/v1/integrations/wise/callback',
      now: t(1),
      expiresAt: t(11),
    })
    expect(await store.claimState('a-state-long-enough', t(2))).toEqual({
      claim: 'valid',
      state: {
        state: 'a-state-long-enough',
        requestedByUserId: 2,
        environment: 'sandbox',
        redirectUri: 'https://time.example.test/api/v1/integrations/wise/callback',
        expiresAt: t(11),
      },
    })
    // Single use. A replayed callback finds nothing, which is the whole of what
    // stops a third party walking somebody through connecting an account.
    expect(await store.claimState('a-state-long-enough', t(3))).toEqual({ claim: 'unknown' })
  })

  it('[db] consumes an expired state rather than leaving it to be replayed later', async () => {
    const { sqlite: database, store } = await fixture()
    await store.beginAuthorization({
      state: 'an-expired-state-x',
      userId: 2,
      environment: 'sandbox',
      redirectUri: 'https://time.example.test/callback',
      now: t(1),
      expiresAt: t(2),
    })
    expect(await store.claimState('an-expired-state-x', t(9))).toEqual({ claim: 'expired' })
    expect(
      database.prepare(`SELECT count(*) AS n FROM wise_oauth_states`).get(),
    ).toEqual({ n: 0 })
  })

  it('[db] refuses a state nobody issued', async () => {
    const { store } = await fixture()
    expect(await store.claimState('never-issued-state', t(2))).toEqual({ claim: 'unknown' })
  })

  it('[db] prunes the states nobody came back for', async () => {
    const { store } = await fixture()
    await store.beginAuthorization({
      state: 'stale-state-value-1',
      userId: 2,
      environment: 'live',
      redirectUri: 'https://time.example.test/callback',
      now: t(1),
      expiresAt: t(2),
    })
    await store.beginAuthorization({
      state: 'fresh-state-value-1',
      userId: 3,
      environment: 'live',
      redirectUri: 'https://time.example.test/callback',
      now: t(1),
      expiresAt: t(40),
    })
    expect(await store.pruneStates(t(9))).toBe(1)
    expect(await store.claimState('fresh-state-value-1', t(9))).toMatchObject({ claim: 'valid' })
  })
})

describe('recording a grant (#543)', () => {
  it('[db] keeps the profile id as a string, exactly as Wise gave it', async () => {
    const { store } = await fixture()
    // Wise sends these as JSON numbers large enough to lose precision as a
    // double. A rounded profile id addresses somebody else.
    const result = await record(store, { profileId: '9007199254740993' })
    expect(result).toMatchObject({
      outcome: 'granted',
      grant: {
        userId: 2,
        environment: 'sandbox',
        profileId: '9007199254740993',
        profileType: 'personal',
        grantedAt: t(1),
        revokedAt: null,
      },
    })
  })

  it('[money] refuses a second grant for the same person', async () => {
    const { store } = await fixture()
    await record(store)
    expect(await record(store, { profileId: '41000002' })).toEqual({
      outcome: 'already_connected',
    })
  })

  it('[money] refuses a profile somebody else is already paid through', async () => {
    const { store } = await fixture()
    await record(store)
    // Two people behind one profile means one is paid for the other's work.
    expect(await record(store, { userId: 3 })).toEqual({ outcome: 'profile_taken' })
  })

  it('[db] tells the same profile in two environments apart', async () => {
    const { store } = await fixture()
    await record(store)
    // Sandbox and live are separate account namespaces. The same number in each
    // is two unrelated accounts.
    expect(await record(store, { userId: 3, environment: 'live' })).toMatchObject({
      outcome: 'granted',
    })
  })

  it('[db] refuses a grant for somebody who does not exist', async () => {
    const { store } = await fixture()
    expect(await record(store, { userId: 99 })).toEqual({ outcome: 'unknown_user' })
  })
})

describe('rotating the credential (#543)', () => {
  it('[db] replaces both tokens, because Wise rotates the refresh token too', async () => {
    const { store } = await fixture()
    const granted = await record(store)
    if (granted.outcome !== 'granted') throw new Error(granted.outcome)
    const rotated = await store.refreshTokens(
      granted.grant.id,
      {
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
        accessTokenExpiresAt: t(50),
      },
      t(20),
    )
    expect(rotated).toMatchObject({
      accessToken: 'access-two',
      refreshToken: 'refresh-two',
      accessTokenExpiresAt: t(50),
      // The facts a payout follows are untouched by a refresh.
      profileId: '41000001',
      userId: 2,
      grantedAt: t(1),
    })
  })

  it('[money] cannot repoint a grant at a different person or profile', async () => {
    const { sqlite: database, store } = await fixture()
    const granted = await record(store)
    if (granted.outcome !== 'granted') throw new Error(granted.outcome)
    expect(() =>
      database
        .prepare(`UPDATE wise_grants SET profile_id = '41000009' WHERE id = ?`)
        .run(granted.grant.id),
    ).toThrow(/identity is immutable/u)
    expect(() =>
      database.prepare(`UPDATE wise_grants SET user_id = 3 WHERE id = ?`).run(granted.grant.id),
    ).toThrow(/identity is immutable/u)
  })
})

describe('revoking (#543)', () => {
  it('[db] is final, and frees the person and the profile to connect again', async () => {
    const { store } = await fixture()
    await record(store)
    expect(await store.revoke(2, t(20))).toBe(true)
    expect(await store.readCurrent(2)).toBeNull()
    // Re-authorising is a new row, so the record of when money could have gone
    // where stays true.
    expect(await record(store, { now: t(21) })).toMatchObject({ outcome: 'granted' })
    expect(await store.historyForUser(2)).toHaveLength(2)
  })

  it('[db] says nothing was revoked where there was no connection', async () => {
    const { store } = await fixture()
    expect(await store.revoke(2, t(20))).toBe(false)
  })

  it('[money] refuses to refresh a revoked grant', async () => {
    const { sqlite: database, store } = await fixture()
    const granted = await record(store)
    if (granted.outcome !== 'granted') throw new Error(granted.outcome)
    await store.revoke(2, t(20))
    // Through the store the row is simply unreachable...
    expect(
      await store.refreshTokens(
        granted.grant.id,
        { accessToken: 'a', refreshToken: 'b', accessTokenExpiresAt: t(50) },
        t(21),
      ),
    ).toBeNull()
    // ...and the schema refuses it even to a writer that goes around the store,
    // because a working credential for a disconnected account is the failure.
    expect(() =>
      database
        .prepare(`UPDATE wise_grants SET access_token = 'a' WHERE id = ?`)
        .run(granted.grant.id),
    ).toThrow(/cannot be refreshed/u)
  })

  it('[db] cannot be undone', async () => {
    const { sqlite: database, store } = await fixture()
    const granted = await record(store)
    if (granted.outcome !== 'granted') throw new Error(granted.outcome)
    await store.revoke(2, t(20))
    expect(() =>
      database.prepare(`UPDATE wise_grants SET revoked_at = NULL WHERE id = ?`).run(granted.grant.id),
    ).toThrow(/cannot be restored/u)
  })
})
