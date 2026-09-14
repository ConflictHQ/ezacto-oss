import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer, migrateContainerThrough } from '../src/migrate.js'
import { payoutDestinationKindMigration } from '../src/migrations/0070_payout_destination_kind.js'
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

describe('which id space the external id lives in (#543)', () => {
  it('[db] defaults to an account, which is what every id before this was', async () => {
    const { store } = await fixture()
    const result = await link(store)
    expect(result).toMatchObject({ outcome: 'linked', account: { kind: 'account' } })
  })

  it('[money] records a Wise contact as a contact, not as an account id', async () => {
    // A contact id and a recipient account id are different id spaces. Stored
    // without saying which, a payout has to guess from the shape of a string.
    const { store } = await fixture()
    const result = await link(store, {
      provider: 'wise',
      externalId: '00000000-0000-4000-8000-000000000001',
      kind: 'contact',
    })
    expect(result).toMatchObject({ outcome: 'linked', account: { kind: 'contact' } })
    expect((await store.listForUser(2)).map((account) => account.kind)).toEqual(['contact'])
  })

  it('[money] keeps one current destination per person, whichever kind it is', async () => {
    // Holding a contact and a recipient account at once is two answers to
    // "where does their money go", and there is no safe reading of that.
    const { store } = await fixture()
    await link(store, { provider: 'wise', externalId: 'wise-account-1' })
    expect(
      await link(store, { provider: 'wise', externalId: 'wise-contact-1', kind: 'contact' }),
    ).toEqual({ outcome: 'already_linked' })
  })

  it('[db] holds the kind still, because it says how to read the id', async () => {
    const { store, sqlite: database } = await fixture()
    const linked = await link(store, { provider: 'wise', externalId: 'wise-1', kind: 'contact' })
    const id = linked.outcome === 'linked' ? linked.account.id : 0
    expect(() =>
      database.prepare(`UPDATE user_payout_accounts SET kind = 'account' WHERE id = ?`).run(id),
    ).toThrow(/identity is immutable/u)
  })

  it('[money] refuses a contact on a provider that has none', async () => {
    // Only Wise has contacts. A Deel row claiming one is an id nothing can
    // resolve, found at the moment somebody is owed money.
    const { store, sqlite: database } = await fixture()
    await link(store, { provider: 'wise', externalId: 'wise-1', kind: 'contact' })
    expect(() =>
      database
        .prepare(
          `INSERT INTO user_payout_accounts
             (user_id, provider, external_id, kind, linked_by_user_id, linked_at,
              created_at, updated_at)
           VALUES (3, 'deel', 'deel-contact', 'contact', 1, ?, ?, ?)`,
        )
        .run(t(1), t(1), t(1)),
    ).toThrow(/only Wise destinations can be a contact/u)
  })
})

describe('what 0070 does to destinations that already exist', () => {
  it('[db] calls every id that predates it an account, because that is what it is', async () => {
    // The migrations apply lazily against a live database, so the question is
    // what happens to rows written before the column existed -- not what a
    // fresh one looks like.
    const database = new BetterSqlite3(':memory:')
    migrateContainerThrough(database, '0069_drop_exchange_rates')
    sqlite = database
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
      INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
      INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (2, 'Contractor', 'Two', 'member', '[]', '${t(0)}', '${t(0)}');
      INSERT INTO user_payout_accounts
        (user_id, provider, external_id, linked_by_user_id, linked_at, created_at, updated_at)
        VALUES (2, 'wise', '701234567', 1, '${t(1)}', '${t(1)}', '${t(1)}');
    `)
    for (const statement of payoutDestinationKindMigration) database.exec(statement)
    expect(
      database.prepare(`SELECT kind FROM user_payout_accounts WHERE user_id = 2`).get(),
    ).toEqual({ kind: 'account' })
  })
})

describe('who still has nowhere to be paid (#421)', () => {
  it('[db] lists active people with no destination, and the address to propose from', async () => {
    const { store, sqlite: database } = await fixture()
    database.exec(`
      INSERT INTO user_emails
        (user_id, address, kind, is_primary, verified_at, created_at, updated_at)
        VALUES (2, 'work@example.test', 'work', 1, '${t(0)}', '${t(0)}', '${t(0)}');
      INSERT INTO user_emails
        (user_id, address, kind, is_primary, verified_at, created_at, updated_at)
        VALUES (2, 'personal@example.test', 'payroll', 0, '${t(0)}', '${t(0)}', '${t(0)}');
      INSERT INTO user_emails
        (user_id, address, kind, is_primary, verified_at, created_at, updated_at)
        VALUES (3, 'three@example.test', 'work', 1, '${t(0)}', '${t(0)}', '${t(0)}');
    `)

    const awaiting = await store.awaitingDestination('wise')
    // The payroll-kind address wins where one is named. Deel and Wise accounts
    // were set up against personal addresses, which is the whole reason 0061
    // let one be named rather than implied (#280).
    expect(awaiting).toEqual([
      { userId: 1, name: 'Operator One', payrollEmail: null },
      { userId: 2, name: 'Contractor Two', payrollEmail: 'personal@example.test' },
      { userId: 3, name: 'Contractor Three', payrollEmail: 'three@example.test' },
    ])
  })

  it('[money] drops somebody the moment they have a destination, per provider', async () => {
    const { store } = await fixture()
    await link(store, { userId: 2, provider: 'wise', externalId: 'wise-2' })
    expect((await store.awaitingDestination('wise')).map((row) => row.userId)).toEqual([1, 3])
    // Their Wise destination says nothing about Deel. A person payable through
    // one provider and not the other is the ordinary case, not an edge one.
    expect((await store.awaitingDestination('deel')).map((row) => row.userId)).toEqual([1, 2, 3])
  })

  it('[money] brings them back when the destination is detached', async () => {
    // Detaching is final and the row stays for history, so a query reading the
    // history rather than the current state would never list them again.
    const { store } = await fixture()
    const linked = await link(store, { userId: 2, provider: 'wise', externalId: 'wise-2' })
    await store.detach(linked.outcome === 'linked' ? linked.account.id : 0, t(2))
    expect((await store.awaitingDestination('wise')).map((row) => row.userId)).toEqual([1, 2, 3])
  })

  it('[db] leaves out somebody who cannot track work', async () => {
    const { store, sqlite: database } = await fixture()
    database.prepare(`UPDATE users SET is_active = 0 WHERE id = 3`).run()
    expect((await store.awaitingDestination('wise')).map((row) => row.userId)).toEqual([1, 2])
  })
})
