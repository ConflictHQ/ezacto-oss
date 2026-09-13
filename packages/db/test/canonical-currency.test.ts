import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer, migrateContainerThrough } from '../src/migrate.js'
import { canonicalCurrencyMigration } from '../src/migrations/0059_canonical_currency.js'

/**
 * Issue 522. A currency that is not a currency code does not fail loudly; it
 * fails by leaving money out of an invoice.
 *
 * The generator matches billable time with
 * `upper(coalesce(project.billing_currency, client.currency)) = <invoice currency>`,
 * so a client saved as 'dollars' becomes 'DOLLARS', matches nothing, and every
 * entry on that client is quietly excluded. The operator gets an empty invoice
 * and no reason for it.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const fresh = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('CONFLICT', '{}', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
  `)
  sqlite = database
  return database
}

describe('what may be stored as a currency', () => {
  it('[money] refuses a value that is not a three-letter code', async () => {
    const database = await fresh()
    for (const bad of ['dollars', 'us', 'USDD', 'Usd', 'US1', '   ', '$']) {
      expect(() =>
        database.exec(
          `INSERT INTO clients (name, currency, created_at, updated_at)
           VALUES ('Northpeak', '${bad}', '${at}', '${at}')`,
        ),
        bad,
      ).toThrow(/three-letter uppercase code/u)
    }
  })

  it('[money] refuses one arriving by update, not only by insert', async () => {
    // A client created correctly and edited badly is the same empty invoice.
    const database = await fresh()
    expect(() => database.exec(`UPDATE clients SET currency = 'dollars' WHERE id = 1`)).toThrow(
      /three-letter uppercase code/u,
    )
  })

  it('[unit] accepts an ordinary code', async () => {
    const database = await fresh()
    for (const good of ['USD', 'EUR', 'GBP', 'CRC']) {
      database.exec(
        `INSERT INTO clients (name, currency, created_at, updated_at)
         VALUES ('Client ${good}', '${good}', '${at}', '${at}')`,
      )
    }
    expect(
      database.prepare(`SELECT count(*) AS n FROM clients WHERE length(currency) = 3`).get(),
    ).toEqual({ n: 5 })
  })

  it('[money] holds a project billing currency to the same rule, and still allows none', async () => {
    // Null is how a project says "whatever the client bills in", which is what
    // the generator's coalesce is for.
    const database = await fresh()
    const project = (currency: string | null) =>
      database.exec(
        `INSERT INTO projects (client_id, name, code, is_active, billing_method,
                               billing_currency, created_at, updated_at)
         VALUES (1, 'Phase 1', 'P1', 1, 'time_materials',
                 ${currency === null ? 'NULL' : `'${currency}'`}, '${at}', '${at}')`,
      )
    expect(() => project('euros')).toThrow(/three-letter uppercase code/u)
    project(null)
    project('EUR')
    expect(
      database.prepare(`SELECT count(*) AS n FROM projects`).get(),
    ).toEqual({ n: 2 })
  })
})

describe('what the migration does to what is already stored', () => {
  const upgrade = (seed: (database: BetterSqlite3.Database) => void) => {
    const database = new BetterSqlite3(':memory:')
    migrateContainerThrough(database, '0058_invoice_extras_set')
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('CONFLICT', '{}', '${at}', '${at}');
    `)
    seed(database)
    for (const statement of canonicalCurrencyMigration) database.exec(statement)
    sqlite = database
    return database
  }

  it('[money] repairs a case-only mistake rather than refusing to deploy', async () => {
    const database = upgrade((db) => {
      db.exec(`INSERT INTO clients (id, name, currency, created_at, updated_at)
               VALUES (1, 'Kestrel', 'usd', '${at}', '${at}')`)
    })
    expect(database.prepare(`SELECT currency FROM clients WHERE id = 1`).get()).toEqual({
      currency: 'USD',
    })
  })

  it('[security] leaves a value it cannot repair, rather than guessing or failing', async () => {
    // Migrations here apply lazily on the first data request. A table CHECK
    // would be validated against every existing row, so one unrepairable value
    // would take the instance down instead of failing a form -- and this
    // migration has no idea what somebody meant by 'dollars'.
    const database = upgrade((db) => {
      db.exec(`INSERT INTO clients (id, name, currency, created_at, updated_at)
               VALUES (1, 'Kestrel', 'dollars', '${at}', '${at}')`)
    })
    expect(database.prepare(`SELECT currency FROM clients WHERE id = 1`).get()).toEqual({
      currency: 'dollars',
    })
    // But it cannot spread: the next write to that row has to be a real code.
    expect(() => database.exec(`UPDATE clients SET currency = 'pounds' WHERE id = 1`)).toThrow(
      /three-letter uppercase code/u,
    )
  })
})
