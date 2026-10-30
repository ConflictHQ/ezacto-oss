import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { createGeneralResourceRepository } from '../src/general-resources.js'
import { migrateContainer } from '../src/migrate.js'

describe('general-resources repository input keys', () => {
  it('refuses inherited property names instead of treating them as columns', async () => {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    const repository = createGeneralResourceRepository(createContainerDatabase(sqlite) as never)
    const now = '2026-08-28T12:00:00.000Z'
    for (const field of ['constructor', 'toString', 'hasOwnProperty']) {
      const input = { name: 'Kestrel', [field]: 'x' } as never
      await expect(repository.create('clients', input, now)).rejects.toMatchObject({
        code: 'invalid_input',
      })
      await expect(repository.update('clients', 1, input, now)).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    sqlite.close()
  })
})
