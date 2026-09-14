import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'

const at = '2026-09-11T12:00:00.000Z'

/** The shape 0010's trigger requires; the claim settings are what is under test. */
const AMOUNT_CONFIG = JSON.stringify({
    "schema_version": 1,
    "type": "fixed_lines",
    "line_items": [
      {
        "kind": "Service",
        "description": "Monthly band",
        "quantity": 1,
        "unit_price_cents": 125000,
        "taxed": true,
        "taxed2": false,
        "project_id": null
      }
    ]
  })
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

/**
 * What a band may claim (#707).
 *
 * The settings are refused in combinations that would read as something they
 * are not: a ceiling with no number claims nothing while looking like a band
 * that claims everything, and a number with no ceiling is a value nothing
 * applies.
 */
describe('the claim mode and its ceiling', () => {
  const fixture = async () => {
    const database = new BetterSqlite3(':memory:')
    sqlite = database
    await migrateContainer(database)
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('Fixture', '{}', '${at}', '${at}');
      INSERT INTO clients (id, name, currency, created_at, updated_at)
        VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
      INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
        VALUES (1, 1, 'Platform', 'PLT', '${at}', '${at}');
    `)
    return database
  }

  const define = (
    database: BetterSqlite3.Database,
    columns: string,
    values: string,
  ): void => {
    database.exec(`
      INSERT INTO recurring_invoices
        (id, client_id, definition_status, subject_template, notes_template,
         every_n_months, day_of_month, next_issue_on, amount_config,
         created_at, updated_at${columns})
      VALUES (1, 1, 'complete', 'Retainer', '', 1, 10, '2026-10-10',
        '${AMOUNT_CONFIG}',
        '${at}', '${at}'${values})`)
  }

  it('[db] defaults an existing definition to claiming everything', async () => {
    // #484 behaviour, unchanged for anything already defined.
    const database = await fixture()
    define(database, '', '')
    expect(
      database.prepare(`SELECT claim_mode, claim_ceiling_seconds FROM recurring_invoices`).get(),
    ).toEqual({ claim_mode: 'all', claim_ceiling_seconds: null })
  })

  it('[money] refuses a ceiling with no ceiling', async () => {
    // Silently, this would claim nothing while reading as a band that claims
    // everything -- the exact ambiguity the mode exists to remove.
    const database = await fixture()
    expect(() =>
      define(database, `, claims_project_ids, claim_mode`, `, '[1]', 'ceiling'`),
    ).toThrow(/ceiling claim needs a ceiling/u)
  })

  it('[money] refuses a ceiling on a band that claims no projects', async () => {
    const database = await fixture()
    expect(() =>
      define(database, `, claim_mode, claim_ceiling_seconds`, `, 'ceiling', 180000`),
    ).toThrow(/needs the projects it claims from/u)
  })

  it('[money] refuses a number on a band that has no ceiling', async () => {
    // A value nothing applies is a value somebody will later assume applied.
    const database = await fixture()
    expect(() =>
      define(database, `, claims_project_ids, claim_ceiling_seconds`, `, '[1]', 180000`),
    ).toThrow(/only a ceiling claim may carry one/u)
  })

  it('[money] holds the same rules when a definition is edited, not only created', async () => {
    // A definition that starts valid and is edited into an invalid pair is the
    // same defect arriving by a different door.
    const database = await fixture()
    define(database, `, claims_project_ids`, `, '[1]'`)
    expect(() =>
      database.exec(`UPDATE recurring_invoices SET claim_mode = 'ceiling' WHERE id = 1`),
    ).toThrow(/ceiling claim needs a ceiling/u)
    expect(() =>
      database.exec(`UPDATE recurring_invoices SET claim_ceiling_seconds = 180000 WHERE id = 1`),
    ).toThrow(/only a ceiling claim may carry one/u)
  })

  it('[db] accepts the pair the deal actually needs', async () => {
    const database = await fixture()
    define(
      database,
      `, claims_project_ids, claim_mode, claim_ceiling_seconds`,
      `, '[1]', 'ceiling', 180000`,
    )
    expect(
      database.prepare(`SELECT claim_mode, claim_ceiling_seconds FROM recurring_invoices`).get(),
    ).toEqual({ claim_mode: 'ceiling', claim_ceiling_seconds: 180_000 })
  })
})
