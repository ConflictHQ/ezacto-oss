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
 * that claims everything, a number with no ceiling is a value nothing applies,
 * and a ceiling in both units at once is two answers to one question.
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
      database
        .prepare(
          `SELECT claim_mode, claim_ceiling_seconds, claim_ceiling_cents
             FROM recurring_invoices`,
        )
        .get(),
    ).toEqual({ claim_mode: 'all', claim_ceiling_seconds: null, claim_ceiling_cents: null })
  })

  it('[money] refuses a ceiling with no ceiling', async () => {
    // Silently, this would claim nothing while reading as a band that claims
    // everything -- the exact ambiguity the mode exists to remove.
    const database = await fixture()
    expect(() =>
      define(database, `, claims_project_ids, claim_mode`, `, '[1]', 'ceiling'`),
    ).toThrow(/needs exactly one ceiling/u)
  })

  it('[money] refuses a ceiling stated in both units at once', async () => {
    // Two numbers answering one question, and whichever the reader saw last
    // wins. The deal is either a capacity promise or a budget, never both.
    const database = await fixture()
    expect(() =>
      define(
        database,
        `, claims_project_ids, claim_mode, claim_ceiling_seconds, claim_ceiling_cents`,
        `, '[1]', 'ceiling', 180000, 2500000`,
      ),
    ).toThrow(/needs exactly one ceiling/u)
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
    ).toThrow(/needs exactly one ceiling/u)
    expect(() =>
      define(database, `, claims_project_ids, claim_ceiling_cents`, `, '[1]', 2500000`),
    ).toThrow(/needs exactly one ceiling/u)
  })

  it('[money] holds the same rules when a definition is edited, not only created', async () => {
    // A definition that starts valid and is edited into an invalid pair is the
    // same defect arriving by a different door.
    const database = await fixture()
    define(database, `, claims_project_ids`, `, '[1]'`)
    expect(() =>
      database.exec(`UPDATE recurring_invoices SET claim_mode = 'ceiling' WHERE id = 1`),
    ).toThrow(/needs exactly one ceiling/u)
    expect(() =>
      database.exec(`UPDATE recurring_invoices SET claim_ceiling_seconds = 180000 WHERE id = 1`),
    ).toThrow(/needs exactly one ceiling/u)
    expect(() =>
      database.exec(`UPDATE recurring_invoices SET claim_ceiling_cents = 2500000 WHERE id = 1`),
    ).toThrow(/needs exactly one ceiling/u)
  })

  it('[db] accepts a capacity promise stated in time', async () => {
    const database = await fixture()
    define(
      database,
      `, claims_project_ids, claim_mode, claim_ceiling_seconds`,
      `, '[1]', 'ceiling', 180000`,
    )
    expect(
      database
        .prepare(
          `SELECT claim_mode, claim_ceiling_seconds, claim_ceiling_cents
             FROM recurring_invoices`,
        )
        .get(),
    ).toEqual({ claim_mode: 'ceiling', claim_ceiling_seconds: 180_000, claim_ceiling_cents: null })
  })

  it('[db] defaults an existing definition to counting billable hours only', async () => {
    // #708 widens what a band may absorb. A migration that widened a live band
    // would pull months of non-billable hours onto the next invoice.
    const database = await fixture()
    define(database, '', '')
    expect(
      database.prepare(`SELECT claim_scope FROM recurring_invoices`).get(),
    ).toEqual({ claim_scope: 'billable' })
  })

  it('[money] refuses a claim scope on a band that claims no projects', async () => {
    // Same rule the mode carries: a setting about what a band claims means
    // nothing on a definition that claims nothing.
    const database = await fixture()
    expect(() =>
      define(database, `, claim_scope`, `, 'tracked'`),
    ).toThrow(/claim scope needs the projects/u)
  })

  it('[db] accepts a band that counts every tracked hour', async () => {
    const database = await fixture()
    define(database, `, claims_project_ids, claim_scope`, `, '[1]', 'tracked'`)
    expect(
      database.prepare(`SELECT claim_scope FROM recurring_invoices`).get(),
    ).toEqual({ claim_scope: 'tracked' })
  })

  it('[db] accepts a budget stated in money', async () => {
    // The other contract the same band writes: "covers work worth up to X at
    // list" rather than "covers N hours".
    const database = await fixture()
    define(
      database,
      `, claims_project_ids, claim_mode, claim_ceiling_cents`,
      `, '[1]', 'ceiling', 2500000`,
    )
    expect(
      database
        .prepare(
          `SELECT claim_mode, claim_ceiling_seconds, claim_ceiling_cents
             FROM recurring_invoices`,
        )
        .get(),
    ).toEqual({ claim_mode: 'ceiling', claim_ceiling_seconds: null, claim_ceiling_cents: 2_500_000 })
  })
})
