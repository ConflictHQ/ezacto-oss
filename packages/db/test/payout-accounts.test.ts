import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createPayoutAccountStore, type PayoutAccountStore } from '../src/payout-accounts.js'

const t = (minute: number): string =>
  `2026-09-11T12:${String(minute).padStart(2, '0')}:00.000Z`

let sqlite: BetterSqlite3.Database | null = null

const fixture = async (): Promise<{
  sqlite: BetterSqlite3.Database
  store: PayoutAccountStore
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
  return { sqlite: database, store: createPayoutAccountStore(createContainerDatabase(database)) }
}

const link = (store: PayoutAccountStore, overrides: Record<string, unknown> = {}) =>
  store.link({
    userId: 2,
    provider: 'deel',
    externalId: 'deel-person-1',
    linkedByUserId: 1,
    now: t(1),
    ...overrides,
  } as never)

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('linking a person to a payout account (#421)', () => {
  it('[db] stores the provider’s own identifier, verbatim', async () => {
    const { store } = await fixture()
    const result = await link(store)
    expect(result).toMatchObject({
      outcome: 'linked',
      account: {
        userId: 2,
        provider: 'deel',
        externalId: 'deel-person-1',
        linkedByUserId: 1,
        linkedAt: t(1),
        // A link nobody checked is a claim. Paying against a claim is the
        // failure this table exists to prevent.
        verifiedAt: null,
        detachedAt: null,
      },
    })
  })

  it('[db] trims what it was given without otherwise reshaping it', async () => {
    // Not parsed and not normalised: what the id means is the provider's to
    // define, and a value we reshaped is one we can no longer hand back.
    const { store } = await fixture()
    const result = await link(store, { externalId: '  deel-person-1  ' })
    expect(result).toMatchObject({ account: { externalId: 'deel-person-1' } })
  })

  it('[db] lists only what a person is currently payable through', async () => {
    const { store } = await fixture()
    await link(store)
    await link(store, { provider: 'wise', externalId: 'wise-1' })
    expect((await store.listForUser(2)).map((a) => a.provider)).toEqual(['deel', 'wise'])
    expect(await store.listForUser(3)).toEqual([])
  })

  it('[security] refuses a second current account for the same provider', async () => {
    // Otherwise a person has two Deel destinations and the export picks one.
    const { store } = await fixture()
    await link(store)
    expect(await link(store, { externalId: 'deel-person-other' })).toEqual({
      outcome: 'already_linked',
    })
  })

  it('[security] refuses an identifier that already belongs to somebody else', async () => {
    // Two people on one Deel id means one is being paid for the other's work,
    // and a bank statement is the wrong place to discover that.
    const { store } = await fixture()
    await link(store)
    expect(await link(store, { userId: 3 })).toEqual({ outcome: 'external_id_taken' })
  })

  it('[db] says so rather than failing when the person does not exist', async () => {
    const { store } = await fixture()
    expect(await link(store, { userId: 999 })).toEqual({ outcome: 'unknown_user' })
  })

  it('[db] lets a different person hold the same id at another provider', async () => {
    // The uniqueness is per provider. Two providers may both call somebody 1.
    const { store } = await fixture()
    await link(store, { provider: 'deel', externalId: 'shared-1' })
    expect(await link(store, { userId: 3, provider: 'wise', externalId: 'shared-1' })).toMatchObject(
      { outcome: 'linked' },
    )
  })
})

describe('verifying a link', () => {
  it('[db] records that the provider confirmed the id resolves', async () => {
    const { store } = await fixture()
    const linked = await link(store)
    const id = (linked as { account: { id: number } }).account.id
    expect(await store.markVerified(id, t(5))).toMatchObject({ verifiedAt: t(5) })
  })

  it('[db] will not verify an account that has been detached', async () => {
    const { store } = await fixture()
    const linked = await link(store)
    const id = (linked as { account: { id: number } }).account.id
    await store.detach(id, t(6))
    expect(await store.markVerified(id, t(7))).toBeNull()
  })
})

describe('detaching', () => {
  it('[db] keeps the row, so payout history stays readable', async () => {
    // Set rather than deleted: after somebody moves providers, where money
    // could have gone and when is still answerable.
    const { store } = await fixture()
    const linked = await link(store)
    const id = (linked as { account: { id: number } }).account.id
    expect(await store.detach(id, t(6))).toBe(true)
    expect(await store.listForUser(2)).toEqual([])
    expect((await store.historyForUser(2)).map((a) => a.detachedAt)).toEqual([t(6)])
  })

  it('[db] frees the identifier for whoever actually holds it now', async () => {
    const { store } = await fixture()
    const linked = await link(store)
    await store.detach((linked as { account: { id: number } }).account.id, t(6))
    expect(await link(store, { userId: 3, now: t(7) })).toMatchObject({ outcome: 'linked' })
  })

  it('[db] answers false for an account that was already detached', async () => {
    const { store } = await fixture()
    const linked = await link(store)
    const id = (linked as { account: { id: number } }).account.id
    await store.detach(id, t(6))
    expect(await store.detach(id, t(7))).toBe(false)
  })

  it('[security] the schema refuses re-attaching a detached account', async () => {
    // Re-attaching is a new row, so the record of when money could have gone
    // where stays true. The store cannot do it and neither can anything else.
    const { sqlite: database, store } = await fixture()
    const linked = await link(store)
    const id = (linked as { account: { id: number } }).account.id
    await store.detach(id, t(6))
    expect(() =>
      database
        .prepare('UPDATE user_payout_accounts SET detached_at = NULL WHERE id = ?')
        .run(id),
    ).toThrow(/cannot be reattached/u)
  })

  it('[security] the schema refuses repointing a link at a different account', async () => {
    // An external id is the thing payments follow, so it is immutable.
    const { sqlite: database, store } = await fixture()
    const linked = await link(store)
    const id = (linked as { account: { id: number } }).account.id
    for (const statement of [
      `UPDATE user_payout_accounts SET external_id = 'deel-other' WHERE id = ?`,
      `UPDATE user_payout_accounts SET user_id = 3 WHERE id = ?`,
      `UPDATE user_payout_accounts SET provider = 'wise' WHERE id = ?`,
    ]) {
      expect(() => database.prepare(statement).run(id)).toThrow(/identity is immutable/u)
    }
  })
})

describe('reading a provider’s whole set, for an export', () => {
  it('[db] returns the current accounts and leaves detached ones out', async () => {
    const { store } = await fixture()
    await link(store)
    await link(store, { userId: 3, externalId: 'deel-person-3' })
    await link(store, { provider: 'wise', externalId: 'wise-2' })
    expect((await store.listForProvider('deel')).map((a) => a.userId)).toEqual([2, 3])
    expect((await store.listForProvider('wise')).map((a) => a.externalId)).toEqual(['wise-2'])
  })
})
