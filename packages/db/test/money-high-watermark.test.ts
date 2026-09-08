import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'

/**
 * CursorSource documents highWatermark as "the maximum visible id at the start
 * of a traversal, or null for an empty collection", and cursorPage answers an
 * empty page when it gets null. Coalescing to 0 instead handed a zero to an
 * assertion that requires a POSITIVE id, so all four of these endpoints
 * answered 500 rather than an empty list on a table nobody had written to.
 *
 * That is not an edge case here: it is a fresh install, and it was the state of
 * a freshly imported production database whose estimates table was empty.
 */
describe('money collection high-water marks', () => {
  const repository = () => {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    return createMoneyResourceRepository(createContainerDatabase(sqlite))
  }

  it('[unit] answers null for every empty collection, not zero', async () => {
    const money = repository()

    // All four, because the bug was one shared implementation and fixing only
    // the collection whose screen exposed it would leave the other three.
    expect(await money.highWatermark('invoices')).toBeNull()
    expect(await money.highWatermark('estimates')).toBeNull()
    expect(await money.highWatermark('retainers')).toBeNull()
    expect(await money.highWatermark('recurring-invoices')).toBeNull()
  })

  it('[unit] answers the maximum id once a collection has rows', async () => {
    const sqlite = new BetterSqlite3(':memory:')
    migrateContainer(sqlite)
    const money = createMoneyResourceRepository(createContainerDatabase(sqlite))
    const now = '2026-09-08T00:00:00.000Z'

    sqlite
      .prepare(
        `INSERT INTO clients (id, name, currency, is_active, created_at, updated_at)
         VALUES (1, 'Northwind Freight', 'USD', 1, ?, ?)`,
      )
      .run(now, now)
    sqlite
      .prepare(
        `INSERT INTO retainers
           (id, client_id, project_id, denomination, amount_cents, created_at, updated_at)
         VALUES (7, 1, NULL, 'money', 500000, ?, ?)`,
      )
      .run(now, now)

    // The non-empty answer must not regress into null while we are making the
    // empty one non-zero.
    expect(await money.highWatermark('retainers')).toBe(7)
    expect(await money.highWatermark('invoices')).toBeNull()
  })
})
