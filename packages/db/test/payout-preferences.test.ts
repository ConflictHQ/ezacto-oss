import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { StaffPaymentError } from '@ezacto/core'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createPayoutPreferenceStore } from '../src/payout-preferences.js'

const fixture = () => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  const insertUser = database.prepare(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (?, ?, ?, 'member', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
  )
  insertUser.run(1, 'Admin', 'One')
  insertUser.run(2, 'Ana', 'Personal')
  insertUser.run(3, 'Byron', 'Second')
  database
    .prepare(
      `INSERT INTO user_payout_accounts (user_id, provider, external_id, kind, linked_by_user_id, linked_at, created_at, updated_at)
       VALUES (2, 'deel', 'ana@example.test', 'account', 1, '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')`,
    )
    .run()
  return createPayoutPreferenceStore(createContainerDatabase(database))
}

const at = '2026-10-22T09:00:00.000Z'

describe('payout defaults per person (issue 1152)', () => {
  it('[unit] a person with no choice uses the organization default, and the version starts at 0', async () => {
    const store = fixture()
    expect(await store.read(2)).toEqual({ userId: 2, provider: null, version: 0, source: null })
    expect(await store.orgDefault()).toBe('wise')
  })

  it('[unit] a choice is recorded with who made it, and a stale version is refused', async () => {
    const store = fixture()
    await store.set({ id: 'pref-a', userId: 2, provider: 'deel', expectedVersion: 0, note: 'Chosen by the person.', actorId: 2, requestId: 'r1', now: at })
    expect(await store.read(2)).toEqual({ userId: 2, provider: 'deel', version: 1, source: 'person' })

    await expect(
      store.set({ id: 'pref-b', userId: 2, provider: 'wise', expectedVersion: 0, note: 'Set by an administrator.', actorId: 1, requestId: 'r2', now: at }),
    ).rejects.toBeInstanceOf(StaffPaymentError)
    expect((await store.read(2)).provider).toBe('deel')
  })

  it('[unit] an administrator override is recorded as the administrator\'s', async () => {
    const store = fixture()
    await store.set({ id: 'pref-c', userId: 3, provider: 'wise', expectedVersion: 0, note: 'Set by an administrator.', actorId: 1, requestId: 'r3', now: at })
    expect(await store.read(3)).toEqual({ userId: 3, provider: 'wise', version: 1, source: 'administrator' })
  })

  it('[unit] the automatic choice made by a first link is recognised as automatic', async () => {
    const store = fixture()
    await store.set({
      id: 'pref-d',
      userId: 2,
      provider: 'deel',
      expectedVersion: 0,
      note: 'Set automatically when the first account was linked.',
      actorId: 1,
      requestId: 'r4',
      now: at,
    })
    expect((await store.read(2)).source).toBe('automatic')
  })

  it('[unit] the roster lists everyone with their choice and the providers they hold', async () => {
    const store = fixture()
    await store.set({ id: 'pref-e', userId: 2, provider: 'deel', expectedVersion: 0, note: 'Chosen by the person.', actorId: 2, requestId: 'r5', now: at })
    const roster = await store.roster()
    expect(roster).toEqual([
      { userId: 1, name: 'Admin One', provider: null, version: 0, source: null, linked: [] },
      { userId: 2, name: 'Ana Personal', provider: 'deel', version: 1, source: 'person', linked: ['deel'] },
      { userId: 3, name: 'Byron Second', provider: null, version: 0, source: null, linked: [] },
    ])
  })
})
