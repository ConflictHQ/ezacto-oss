import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { createPayoutProviderEnablementStore } from '../src/payout-provider-enablement.js'
import { migrateContainer } from '../src/migrate.js'

const fixture = () => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return createPayoutProviderEnablementStore(createContainerDatabase(database))
}

describe('payout provider enablement (#1152)', () => {
  it('[unit] every provider is enabled until an administrator turns one off', async () => {
    const store = fixture()
    expect(await store.list()).toEqual([
      { provider: 'deel', enabled: true, updatedAt: '1970-01-01T00:00:00.000Z', updatedByUserId: null },
      { provider: 'wise', enabled: true, updatedAt: '1970-01-01T00:00:00.000Z', updatedByUserId: null },
    ])
  })

  it('[unit] an administrator can disable one provider and re-enable it, recording who did it', async () => {
    const store = fixture()
    expect(await store.setEnabled('wise', false, 4, '2026-10-22T09:00:00.000Z')).toBe(true)
    expect(await store.list()).toEqual(
      expect.arrayContaining([
        { provider: 'wise', enabled: false, updatedAt: '2026-10-22T09:00:00.000Z', updatedByUserId: 4 },
      ]),
    )
    expect(await store.setEnabled('wise', true, 4, '2026-10-22T10:00:00.000Z')).toBe(true)
    expect((await store.list()).find((row) => row.provider === 'wise')?.enabled).toBe(true)
  })

  it('[unit] a provider with no row is not invented by a toggle', async () => {
    const store = fixture()
    expect(await store.setEnabled('bank', true, 4, '2026-10-22T09:00:00.000Z')).toBe(false)
    expect((await store.list()).map((row) => row.provider)).toEqual(['deel', 'wise'])
  })
})
