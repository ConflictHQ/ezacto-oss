import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import {
  billDemoBacklog,
  createContainerDemoResetDriver,
  PRESERVED_TABLES,
  wipeAndSeedDemo,
  type DemoResetDriver,
} from '../src/demo-reset.js'
import type { InvoiceGenerationDatabase } from '../src/invoice-generation.js'
import { migrateContainer } from '../src/migrate.js'

const now = '2026-09-09T12:00:00.000Z'
// Long enough that several client-months are billable, short enough that the
// suite is not billing three years of eight clients to prove it can bill one.
const years = 0.3

let open: BetterSqlite3.Database | undefined
afterEach(() => {
  open?.close()
  open = undefined
})

const harness = (): { client: BetterSqlite3.Database; driver: DemoResetDriver } => {
  const client = new BetterSqlite3(':memory:')
  open = client
  client.pragma('foreign_keys = ON')
  const orm = createContainerDatabase(client) as unknown as InvoiceGenerationDatabase
  return { client, driver: createContainerDemoResetDriver(client, orm, migrateContainer) }
}

const count = (client: BetterSqlite3.Database, table: string): number =>
  (client.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n

const tablesOf = (client: BetterSqlite3.Database): string[] =>
  (
    client
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((row) => row.name)

describe('demo reset', () => {
  it('[unit] refuses without the spelled-out confirmation', async () => {
    // The first thing a reset does is empty every table. A boolean would read
    // as a flag; this has to read as a decision at the call site.
    const { driver } = harness()

    await expect(
      wipeAndSeedDemo(driver, { now, years, confirm: 'yes' as 'wipe-and-reload' }),
    ).rejects.toThrow('wipe-and-reload')
  })

  it('[unit] preserves exactly the tables a fresh migration run fills', () => {
    // The drift guard. A migration that seeds a new table has to be added to
    // PRESERVED_TABLES, or the nightly wipe empties it and the install breaks
    // in a way nobody would connect back to the migration.
    const { client } = harness()
    migrateContainer(client)
    const filled = tablesOf(client).filter((table) => count(client, table) > 0)

    expect([...filled].sort()).toEqual([...PRESERVED_TABLES].sort())
  })

  it('[security] puts the triggers back when the wipe fails halfway through', async () => {
    // The wipe drops every trigger before it empties anything, so if the drops
    // commit and the rest does not, what is left is a live database with no
    // write guards on it -- and nothing says so. That is what happened to
    // ezacto.io: one refused DELETE, and three hundred triggers gone until
    // somebody thought to count them. One transaction is the whole defence.
    const { client, driver } = harness()
    migrateContainer(client)
    const triggers = () =>
      (client.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get() as {
        n: number
      }).n
    const before = triggers()
    // A table in the list that is not in the database. Any statement of the
    // wipe failing earns the same rollback; this is the cheapest one to stage.
    const failing: DemoResetDriver = {
      ...driver,
      schemaObjects: async () => {
        const objects = await driver.schemaObjects()
        return { ...objects, tables: [...objects.tables, 'table_that_is_not_there'] }
      },
    }

    await expect(
      wipeAndSeedDemo(failing, { now, years, confirm: 'wipe-and-reload' }),
    ).rejects.toThrow()

    expect(before).toBeGreaterThan(300)
    expect(triggers()).toBe(before)
  })

  it('[unit] leaves the bookkeeping table D1 keeps for itself alone', async () => {
    // The wipe reads its table list out of sqlite_master, and on D1 that list
    // includes `_cf_KV`, which D1's authorizer refuses every statement against.
    // A DELETE against it does not empty a table -- it fails the batch with
    // SQLITE_AUTH, and the demo stays wiped-but-unbuilt until someone notices.
    // Nothing creates `_cf_KV` here, so the test puts one there itself; the
    // surviving row is the proof no DELETE was ever aimed at it.
    const { client, driver } = harness()
    migrateContainer(client)
    client.exec('CREATE TABLE "_cf_KV" (key TEXT PRIMARY KEY, value BLOB)')
    client.prepare('INSERT INTO "_cf_KV" (key, value) VALUES (?, ?)').run('k', 'v')

    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(count(client, '_cf_KV')).toBe(1)
  })

  it('[unit] empties everything else and puts every trigger back', async () => {
    const { client, driver } = harness()
    const summary = await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    const triggersAfter = (
      client.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'`).get() as {
        n: number
      }
    ).n

    expect(summary.restoredTriggers).toBeGreaterThan(300)
    expect(triggersAfter).toBe(summary.restoredTriggers)
    // Rebuilt, not reinstalled: the ledger still records every migration, so
    // the next request does not try to apply them over the tables they made.
    expect(count(client, '_ezacto_migrations')).toBeGreaterThan(0)
    expect(count(client, 'users')).toBe(21)
  })

  it('[security] leaves the write guards biting after the wipe put them back', async () => {
    // The wipe drops every trigger and recreates it from its own SQL. If that
    // round trip lost one, the demo would keep working and the product's
    // invariants would be gone -- which is the failure this test exists for.
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(() =>
      client
        .prepare(
          `INSERT INTO invoice_line_items
             (id, invoice_id, position, kind, description, quantity,
              unit_price_cents, amount_cents, created_at, updated_at)
           VALUES (1, 1, 0, 'Service', 'x', 1, 100, 100, ?, ?)`,
        )
        .run(now, now),
    ).toThrow()
  })

  it('[unit] starts the demo at invoice number one however many it issued before', async () => {
    // The counter is preserved through the wipe because generation needs a row
    // to read, and reset because every invoice below it has just been deleted.
    const { client, driver } = harness()
    migrateContainer(client)
    client.prepare('UPDATE invoice_number_sequence SET next_number = 5000').run()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })

    expect(
      (client.prepare('SELECT next_number AS n FROM invoice_number_sequence').get() as {
        n: number
      }).n,
    ).toBe(1)
  })

  it('[unit] bills a bounded slice and resumes where the last one stopped', async () => {
    // The caller is a cron tick with a CPU budget, so a reset that can only run
    // to completion in one go is a reset that never completes.
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    const tick = (limit: number) =>
      billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload', limit })

    const first = await tick(4)
    const afterFirst = count(client, 'invoices')
    const second = await tick(4)

    // Resumed, not restarted: the backlog shrinks by exactly what the tick took
    // on, because what is done is read off the invoices themselves rather than
    // counted in memory that a dead tick would have taken with it.
    expect(first.billed).toBe(4)
    expect(second.remaining).toBe(first.remaining - 4)
    expect(count(client, 'invoices')).toBe(afterFirst + 4)
  }, 120_000)

  it('[unit] issues no second invoice for a month it has already billed', async () => {
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    await billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload' })
    const settled = count(client, 'invoices')

    const again = await billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload' })

    // The backlog is the uninvoiced work, so a completed demo has none left.
    expect(again).toMatchObject({ billed: 0, remaining: 0 })
    expect(count(client, 'invoices')).toBe(settled)
    const duplicates = client
      .prepare(
        `SELECT count(*) AS n FROM (
           SELECT client_id, period_start FROM invoices
           GROUP BY client_id, period_start HAVING count(*) > 1
         )`,
      )
      .get() as { n: number }
    expect(duplicates.n).toBe(0)
  }, 300_000)

  it('[unit] leaves recent invoices outstanding and settles the older ones', async () => {
    // An accounts-receivable screen where everything is paid shows nothing, and
    // the aging buckets are among the things a visitor came to look at.
    const { client, driver } = harness()
    await wipeAndSeedDemo(driver, { now, years, confirm: 'wipe-and-reload' })
    await billDemoBacklog(driver, { now, years, confirm: 'wipe-and-reload' })

    const states = client
      .prepare(`SELECT state, count(*) AS n FROM invoices GROUP BY state`)
      .all() as { state: string; n: number }[]
    const by = new Map(states.map((row) => [row.state, row.n]))

    expect(by.get('paid') ?? 0).toBeGreaterThan(0)
    expect(by.get('open') ?? 0).toBeGreaterThan(0)
    expect(by.get('draft') ?? 0).toBe(0)
  }, 300_000)

})
