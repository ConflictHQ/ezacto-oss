import BetterSqlite3 from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { listContactVisibleClientIds } from '../src/operations.js'

const now = '2026-09-01T00:00:00.000Z'

// 1 Org
//   2 Dept A
//     4 Team A1
//       6 Cell A1x (inactive)
//         7 Sub-cell (active, under inactive)
//     5 Team A2 (inactive)
//   3 Dept B
// 8 Unrelated root, bill_to = 2
const rows: ReadonlyArray<readonly [number, number | null, number, number | null]> = [
  [1, null, 1, null],
  [2, 1, 1, null],
  [3, 1, 1, null],
  [4, 2, 1, null],
  [5, 2, 0, null],
  [6, 4, 0, null],
  [7, 6, 1, null],
  [8, null, 1, 2],
]

let sqlite: BetterSqlite3.Database
let database: ReturnType<typeof createContainerDatabase>

beforeAll(() => {
  sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  const insert = sqlite.prepare(
    `INSERT INTO clients (id, name, currency, parent_client_id, is_active, bill_to_client_id, created_at, updated_at)
     VALUES (?, ?, 'USD', ?, ?, ?, ?, ?)`,
  )
  for (const [id, parent, active, billTo] of rows) {
    insert.run(id, `Client ${id}`, parent, active, billTo, now, now)
  }
  database = createContainerDatabase(sqlite)
})

afterAll(() => sqlite.close())

describe('listContactVisibleClientIds', () => {
  it('shows the contact node and its active descendants', async () => {
    expect(await listContactVisibleClientIds(database, 1)).toEqual([1, 2, 3, 4])
  })

  it('never reaches ancestors, siblings or cousins', async () => {
    expect(await listContactVisibleClientIds(database, 2)).toEqual([2, 4])
    expect(await listContactVisibleClientIds(database, 3)).toEqual([3])
    expect(await listContactVisibleClientIds(database, 4)).toEqual([4])
  })

  it('prunes an inactive descendant together with its active children', async () => {
    const ids = await listContactVisibleClientIds(database, 1)
    expect(ids).not.toContain(5)
    expect(ids).not.toContain(6)
    expect(ids).not.toContain(7)
  })

  it('shows nothing when the contact node itself is inactive', async () => {
    expect(await listContactVisibleClientIds(database, 6)).toEqual([])
    expect(await listContactVisibleClientIds(database, 5)).toEqual([])
  })

  it('shows nothing for an unknown client', async () => {
    expect(await listContactVisibleClientIds(database, 999)).toEqual([])
  })

  it('does not treat bill-to as access to the worked-for tree', async () => {
    expect(await listContactVisibleClientIds(database, 8)).toEqual([8])
    expect(await listContactVisibleClientIds(database, 2)).not.toContain(8)
  })
})
