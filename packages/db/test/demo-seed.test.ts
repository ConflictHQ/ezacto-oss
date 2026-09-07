import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { demoSeedStatements } from '../src/demo-seed.js'
import { migrateContainer } from '../src/migrate.js'

const now = '2026-09-07T12:00:00.000Z'

const seeded = () => {
  const client = new BetterSqlite3(':memory:')
  client.pragma('foreign_keys = ON')
  migrateContainer(client)
  for (const statement of demoSeedStatements({ now })) {
    client.prepare(statement.text).run(...statement.bindings)
  }
  return client
}

describe('demo seed', () => {
  it('[unit] loads into a database built from the real migration ledger', () => {
    // The whole point of the test: every column list and CHECK constraint in
    // the seed is asserted against the schema the product actually ships,
    // rather than against a fixture that agrees with it by construction.
    const client = seeded()
    const count = (table: string) =>
      (client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

    expect(count('users')).toBe(8)
    expect(count('clients')).toBe(4)
    expect(count('projects')).toBe(6)
    expect(count('tasks')).toBe(5)
    expect(count('time_entries')).toBeGreaterThan(200)
    client.close()
  })

  it('[unit] holds no address that could reach a real person', () => {
    // example.com is reserved by RFC 2606 and can never be registered, so a
    // demo instance that sends mail cannot deliver it to someone real.
    const client = seeded()
    const addresses = client
      .prepare('SELECT address FROM user_emails')
      .all() as { address: string }[]

    expect(addresses).toHaveLength(8)
    for (const { address } of addresses) {
      expect(address).toMatch(/@example\.com$/)
    }
    client.close()
  })

  it('[unit] leaves the bootstrapped owner its own id', () => {
    // instance-bootstrap creates user 1 and nothing else. A seed that competed
    // for low ids would collide with the owner of any real instance it ran on.
    const client = seeded()
    const lowest = client
      .prepare('SELECT min(id) AS id FROM users')
      .get() as { id: number }

    expect(lowest.id).toBeGreaterThan(1)
    client.close()
  })

  it('[unit] produces the same demo twice', () => {
    // Deterministic, so a screenshot taken today still matches the data
    // tomorrow and the fixture stays reviewable.
    const first = demoSeedStatements({ now })
    const second = demoSeedStatements({ now })

    expect(second).toEqual(first)
  })

  it('[unit] prices billable time and leaves internal time unpriced', () => {
    const client = seeded()
    const billable = client
      .prepare(
        `SELECT count(*) AS n FROM time_entries WHERE billable = 1 AND billable_rate_cents IS NULL`,
      )
      .get() as { n: number }
    const internal = client
      .prepare(
        `SELECT count(*) AS n FROM time_entries WHERE billable = 0 AND billable_rate_cents IS NOT NULL`,
      )
      .get() as { n: number }

    expect(billable.n).toBe(0)
    expect(internal.n).toBe(0)
    client.close()
  })
})
