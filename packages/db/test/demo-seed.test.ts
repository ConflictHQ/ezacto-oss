import BetterSqlite3 from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  demoAccounts,
  demoClientProjects,
  demoRetainers,
  demoSeedStatements,
} from '../src/demo-seed.js'
import { migrateContainer } from '../src/migrate.js'
import { PASSWORD_MIN_CODE_POINTS } from '@ezacto/core'

const now = '2026-09-09T12:00:00.000Z'

/**
 * One database for every read-only assertion. Three years of twenty people is
 * twenty thousand rows and the seed is deterministic, so building it once per
 * test would spend most of the suite's time proving the same insert twice.
 */
let shared: BetterSqlite3.Database | undefined
const sharedDemo = (): BetterSqlite3.Database => (shared ??= seeded())

const seeded = (years = 0.5) => {
  const client = new BetterSqlite3(':memory:')
  client.pragma('foreign_keys = ON')
  migrateContainer(client)
  client
    .prepare(
      `INSERT INTO organizations (id, name, modules, created_at, updated_at)
       VALUES (1, 'Folding Forks', '{}', ?, ?)`,
    )
    .run(now, now)
  const statements = demoSeedStatements({ now, years })
  client.transaction(() => {
    for (const statement of statements) {
      client.prepare(statement.text).run(...statement.bindings)
    }
  })()
  return client
}

const count = (client: BetterSqlite3.Database, table: string): number =>
  (client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

describe('demo seed', () => {
  it('[unit] loads into a database built from the real migration ledger', () => {
    // The whole point of the test: every column list and CHECK constraint in
    // the seed is asserted against the schema the product actually ships,
    // rather than against a fixture that agrees with it by construction.
    const client = sharedDemo()

    expect(count(client, 'users')).toBe(20)
    expect(count(client, 'clients')).toBe(8)
    expect(count(client, 'projects')).toBe(16)
    expect(count(client, 'tasks')).toBe(6)
    expect(count(client, 'expense_categories')).toBe(6)
    expect(count(client, 'time_entries')).toBeGreaterThan(500)
    expect(count(client, 'expenses')).toBeGreaterThan(0)
  })

  it('[unit] holds no address that could reach a real person', () => {
    // example.com is reserved by RFC 2606 and can never be registered, so a
    // demo instance that sends mail cannot deliver it to someone real.
    const client = sharedDemo()
    const addresses = client
      .prepare('SELECT address FROM user_emails')
      .all() as { address: string }[]

    expect(addresses).toHaveLength(20)
    for (const { address } of addresses) {
      expect(address).toMatch(/@example\.com$/)
    }
  })

  it('[unit] leaves the bootstrapped owner its own id', () => {
    // instance-bootstrap creates user 1 and nothing else. A seed that competed
    // for low ids would collide with the owner of any real instance it ran on.
    const client = sharedDemo()
    const lowest = client.prepare('SELECT min(id) AS id FROM users').get() as { id: number }

    expect(lowest.id).toBeGreaterThan(1)
  })

  it('[unit] produces the same demo twice', () => {
    // Deterministic, so a screenshot taken today still matches the data
    // tomorrow and the fixture stays reviewable.
    const first = demoSeedStatements({ now, years: 0.2 })
    const second = demoSeedStatements({ now, years: 0.2 })

    expect(second).toEqual(first)
  })

  it('[unit] anchors the history to the day it is built, not to a fixed calendar', () => {
    // The demo is rebuilt nightly. A fixed anchor would show a book of work
    // that stopped on the day the fixture was written, which is exactly the
    // thing a visitor notices first.
    const dates = (at: string) =>
      demoSeedStatements({ now: at, years: 0.2 })
        .filter((statement) => statement.text.startsWith('INSERT INTO time_entries'))
        .map((statement) => statement.bindings[6] as string)
    const today = dates(now)
    const tomorrow = dates('2026-09-10T12:00:00.000Z')

    expect(today.at(-1)).not.toEqual(tomorrow.at(-1))
    expect(tomorrow.at(-1)! > today.at(-1)!).toBe(true)
  })

  it('[unit] prices billable time and leaves internal time unpriced', () => {
    const client = sharedDemo()
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
  })

  it('[unit] logs no time to a project outside the window it ran in', () => {
    // Projects start and finish over the three years. Time booked to a project
    // that had not been sold yet is the detail that gives a demo away.
    const client = sharedDemo()
    const stray = client
      .prepare(
        `SELECT count(*) AS n FROM time_entries entry
         JOIN projects project ON project.id = entry.project_id
         WHERE entry.spent_date < project.starts_on
           OR (project.ends_on IS NOT NULL AND entry.spent_date > project.ends_on)`,
      )
      .get() as { n: number }

    expect(stray.n).toBe(0)
  })

  it('[unit] books no time on a weekend', () => {
    const client = sharedDemo()
    const weekend = client
      .prepare(
        `SELECT count(*) AS n FROM time_entries
         WHERE strftime('%w', spent_date) IN ('0', '6')`,
      )
      .get() as { n: number }

    expect(weekend.n).toBe(0)
  })

  it('[security] publishes only passwords the password policy would accept', () => {
    // The credentials are printed on the demo's own front page, so the
    // temptation is admin/admin. Nothing here relaxes `validatePassword`; the
    // published passwords are simply long enough to pass it.
    for (const account of demoAccounts) {
      expect([...account.password].length).toBeGreaterThanOrEqual(PASSWORD_MIN_CODE_POINTS)
    }
  })

  it('[unit] gives every published account a seeded identity to sign in as', () => {
    // A published credential whose user does not exist is a demo that turns
    // people away at the door.
    const client = sharedDemo()
    for (const account of demoAccounts) {
      if (account.userId === 1) continue
      const row = client
        .prepare('SELECT address FROM user_emails WHERE user_id = ?')
        .get(account.userId) as { address: string } | undefined
      expect(row?.address).toBe(account.email)
    }
  })

  it('[unit] opens a retainer in each denomination, at its full balance', () => {
    // Money and hours behave differently on every screen that shows them, so a
    // demo with only one of them hides half the feature. They carry no ledger:
    // a movement has to name an invoice linked to the retainer, and nothing in
    // the product writes that link (#449), so seeding one would show a book the
    // product could not have produced.
    const client = sharedDemo()
    const rows = client
      .prepare(
        `SELECT retainer.denomination AS denomination, retainer.amount_cents AS cents,
                retainer.seconds AS seconds, project.client_id AS projectClient,
                retainer.client_id AS clientId,
                (SELECT count(*) FROM retainer_ledger WHERE retainer_id = retainer.id) AS movements
         FROM retainers retainer
         JOIN projects project ON project.id = retainer.project_id
         ORDER BY retainer.id`,
      )
      .all() as {
      denomination: string
      cents: number | null
      seconds: number | null
      projectClient: number
      clientId: number
      movements: number
    }[]

    expect(rows).toHaveLength(demoRetainers.length)
    expect(rows.map((row) => row.denomination).sort()).toEqual(['hours', 'money'])
    for (const row of rows) {
      // A retainer whose project belongs to another client is refused by the
      // schema; asserting it here says the seed means what it says.
      expect(row.projectClient).toBe(row.clientId)
      expect(row.movements).toBe(0)
      expect(row.denomination === 'money' ? row.cents : row.seconds).toBeGreaterThan(0)
    }
  })

  it('[unit] maps every client to the projects the seed actually created', () => {
    // Invoice generation takes an explicit project list, so a mapping that
    // drifts from the seed silently bills nothing.
    const client = sharedDemo()
    for (const { clientId, projectIds } of demoClientProjects) {
      const actual = (
        client
          .prepare('SELECT id FROM projects WHERE client_id = ? ORDER BY id')
          .all(clientId) as { id: number }[]
      ).map((row) => row.id)
      expect(actual).toEqual([...projectIds].sort((a, b) => a - b))
    }
  })
})
