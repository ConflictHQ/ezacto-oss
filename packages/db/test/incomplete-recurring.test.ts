import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createMoneyResourceRepository } from '../src/money-resources.js'

/**
 * Issues 288 and 648. A migration can leave a recurring definition as a stub --
 * the schema allows `definition_status = 'incomplete'` with NULL terms precisely
 * so an import can say "this exists and we do not yet know how it bills".
 *
 * Three of those carried about ninety invoices between them and could not be
 * seen or repaired from inside the product, because migration 0024 admitted the
 * flip to `complete` only against worksheet authority, which is bound to a
 * snapshot digest and does not exist on hosted D1.
 *
 * Run against a real migrated database, because everything load-bearing here is
 * a trigger.
 */

const at = '2026-09-12T12:00:00.000Z'
const later = '2026-09-12T13:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

const lineItems = [
  {
    kind: 'Service',
    description: 'Monthly advisory',
    quantity: 1,
    unit_price_cents: 125_000,
    taxed: false,
    taxed2: false,
    project_id: null,
  },
]
const config = { schema_version: 1, type: 'fixed_lines', line_items: lineItems } as const

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.pragma('foreign_keys = ON')
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('CONFLICT', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}'),
             (2, 'Northpeak', 'USD', '${at}', '${at}');
    INSERT INTO recurring_invoices
      (id, harvest_id, client_id, definition_status, created_at, updated_at)
      VALUES (1, 466138, 1, 'incomplete', '${at}', '${at}'),
             (2, 440932, 2, 'incomplete', '${at}', '${at}');
    INSERT INTO recurring_invoices
      (id, client_id, definition_status, subject_template, notes_template,
       every_n_months, day_of_month, next_issue_on, amount_config, created_at, updated_at)
      VALUES (3, 1, 'complete', 'Monthly advisory', '', 1, 1, '2026-10-01',
              '${JSON.stringify(config)}', '${at}', '${at}');
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          recurring_invoice_id, created_at, updated_at)
      VALUES (10, 1, '1200', 'USD', '2026-08-01', '2026-08-31', 'draft', 1, '${at}', '${at}'),
             (11, 1, '1201', 'USD', '2026-09-01', '2026-09-30', 'draft', 1, '${at}', '${at}');
  `)
  sqlite = database
  return createMoneyResourceRepository(createContainerDatabase(database))
}

const terms = (overrides: Record<string, unknown> = {}) => ({
  clientId: 1,
  subjectTemplate: 'Monthly retainer',
  notesTemplate: 'Thank you.',
  everyNMonths: 1,
  dayOfMonth: 15,
  nextIssueOn: '2026-10-15',
  amountConfig: config,
  canDrawFromRetainerId: null,
      claimsProjectIds: null,
  occurredAt: later,
  actorUserId: 1,
  ...overrides,
})

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

describe('seeing what an import could not finish', () => {
  it('[money] lists the stubs, and what is riding on each', async () => {
    const money = await fixture()
    const stubs = await money.listIncompleteRecurring()
    expect(stubs.map((stub) => [stub.id, stub.harvest_id, stub.invoice_count])).toEqual([
      [1, 466138, 2],
      [2, 440932, 0],
    ])
    expect(stubs[0]!.client_name).toBe('Kestrel Environmental')
    expect(stubs[0]!.subject_template).toBeNull()
    expect(stubs[0]!.amount_config).toBeNull()
  })

  it('[money] never includes a definition that is already complete', async () => {
    const money = await fixture()
    expect((await money.listIncompleteRecurring()).map((stub) => stub.id)).not.toContain(3)
  })

  it('[security] a stub stays invisible to the ordinary read, which means live', async () => {
    // Generation refuses an incomplete definition, so the list that feeds the
    // recurring screen must keep meaning "definitions that will issue".
    const money = await fixture()
    expect(await money.getRecurring(1)).toBeNull()
  })
})

describe('giving a stub its terms', () => {
  it('[money] completes it, and it becomes an ordinary definition', async () => {
    const money = await fixture()
    const result = await money.completeRecurring(1, terms())
    expect(result.outcome).toBe('completed')
    expect(await money.getRecurring(1)).toMatchObject({
      id: 1,
      subject_template: 'Monthly retainer',
      every_n_months: 1,
      day_of_month: 15,
      next_issue_on: '2026-10-15',
    })
    expect((await money.listIncompleteRecurring()).map((stub) => stub.id)).toEqual([2])
  })

  it('[security] records who entered the terms', async () => {
    // A payment schedule that changed with no author is one nobody can be asked
    // about. This is the whole reason the operator door is separate from the
    // worksheet's.
    const money = await fixture()
    await money.completeRecurring(1, terms())
    expect(
      sqlite!
        .prepare(
          `SELECT recurring_invoice_id AS id, completed_by_user_id AS by,
                  subject_template AS subject
           FROM recurring_definition_completions`,
        )
        .all(),
    ).toEqual([{ id: 1, by: 1, subject: 'Monthly retainer' }])
  })

  it('[money] keeps the invoices that already point at it', async () => {
    const money = await fixture()
    await money.completeRecurring(1, terms())
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM invoices WHERE recurring_invoice_id = 1`).get(),
    ).toEqual({ n: 2 })
  })

  it('[money] refuses a definition that is already complete', async () => {
    // Completing is not editing. A caller that meant to edit and reached this
    // should be told rather than silently obeyed.
    const money = await fixture()
    expect((await money.completeRecurring(3, terms())).outcome).toBe('already_complete')
  })

  it('[money] answers not_found for an id that does not exist', async () => {
    const money = await fixture()
    expect((await money.completeRecurring(99, terms())).outcome).toBe('not_found')
  })

  it('[security] refuses terms the schema would not accept, and writes nothing', async () => {
    const money = await fixture()
    for (const bad of [
      { subjectTemplate: '   ' },
      { everyNMonths: 0 },
      { dayOfMonth: 32 },
      { dayOfMonth: 0 },
      { clientId: 0 },
      { actorUserId: 0 },
      { amountConfig: { schema_version: 1, type: 'fixed_lines', line_items: [] } },
    ]) {
      await expect(money.completeRecurring(1, terms(bad))).rejects.toThrow()
    }
    expect((await money.listIncompleteRecurring()).map((stub) => stub.id)).toEqual([1, 2])
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM recurring_definition_completions`).get(),
    ).toEqual({ n: 0 })
  })
})

describe('what the trigger refuses on its own', () => {
  it('[security] refuses a bare status flip with no authority at all', async () => {
    // The guard, stated directly. Without it the whole completion record is
    // decoration that a plain UPDATE walks past.
    await fixture()
    expect(() =>
      sqlite!.exec(`UPDATE recurring_invoices
        SET definition_status = 'complete', subject_template = 'Sneaked in',
            notes_template = '', every_n_months = 1, day_of_month = 1,
            next_issue_on = '2026-10-01', amount_config = '${JSON.stringify(config)}',
            updated_at = '${later}'
        WHERE id = 1`),
    ).toThrow(/worksheet or operator authority/u)
  })

  it('[security] refuses a completion whose terms do not match the write', async () => {
    // The completion is an exact claim about what is about to happen. A row that
    // authorised a different write would be a signature on a blank cheque.
    await fixture()
    sqlite!.exec(`INSERT INTO recurring_definition_completions
      (recurring_invoice_id, completed_by_user_id, completed_at, subject_template,
       notes_template, every_n_months, day_of_month, next_issue_on, amount_config,
       can_draw_from_retainer_id, target_updated_at)
      VALUES (1, 1, '${later}', 'Agreed terms', '', 1, 15, '2026-10-15',
              '${JSON.stringify(config)}', NULL, '${later}')`)
    expect(() =>
      sqlite!.exec(`UPDATE recurring_invoices
        SET definition_status = 'complete', subject_template = 'Different terms',
            notes_template = '', every_n_months = 1, day_of_month = 15,
            next_issue_on = '2026-10-15', amount_config = '${JSON.stringify(config)}',
            updated_at = '${later}'
        WHERE id = 1`),
    ).toThrow(/worksheet or operator authority/u)
  })

  it('[security] refuses a completion claimed for a definition that is not a stub', async () => {
    await fixture()
    expect(() =>
      sqlite!.exec(`INSERT INTO recurring_definition_completions
        (recurring_invoice_id, completed_by_user_id, completed_at, subject_template,
         notes_template, every_n_months, day_of_month, next_issue_on, amount_config,
         can_draw_from_retainer_id, target_updated_at)
        VALUES (3, 1, '${later}', 'Monthly advisory', '', 1, 1, '2026-10-01',
                '${JSON.stringify(config)}', NULL, '${later}')`),
    ).toThrow(/only an incomplete definition can be completed/u)
  })

  it('[security] keeps the record of who completed it immutable', async () => {
    const money = await fixture()
    await money.completeRecurring(1, terms())
    expect(() =>
      sqlite!.exec(`UPDATE recurring_definition_completions SET completed_by_user_id = 1`),
    ).toThrow(/immutable/u)
    expect(() => sqlite!.exec(`DELETE FROM recurring_definition_completions`)).toThrow(
      /immutable/u,
    )
  })
})
