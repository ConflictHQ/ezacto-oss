import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer, migrateContainerThrough } from '../src/migrate.js'

/**
 * Removing a rate somebody did not mean to add (#727).
 *
 * Rates stayed append-only because a rate is what priced somebody's work. That
 * is the right rule for a rate that has done its job and the wrong one for a
 * rate thirty seconds old -- particularly because inserting one *ends the rate
 * before it*, so a misclick on the wrong section of the screen silently
 * replaces a live rate with a different number and there was no way back.
 */
const at = '2026-09-10T12:00:00.000Z'
const later = '2026-09-14T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Ada', 'Lovelace', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
      VALUES (1, 1, 'Platform', 'PLT', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
  `)
  sqlite = database
  return database
}

const rate = (
  database: BetterSqlite3.Database,
  id: number,
  amountCents: number,
  startDate: string | null,
  createdAt = at,
  table = 'user_cost_rates',
): void => {
  database.exec(`
    INSERT INTO ${table} (id, user_id, amount_cents, start_date, created_at, updated_at)
    VALUES (${id}, 1, ${amountCents}, ${startDate === null ? 'NULL' : `'${startDate}'`},
      '${createdAt}', '${createdAt}')`)
}

/**
 * An hour priced for cost by default, because the tests below are mostly about
 * the cost table. A rate only holds an entry that carries a figure of its own
 * kind, so an entry with no cost rate is no evidence about a cost rate (#746).
 */
const entry = (
  database: BetterSqlite3.Database,
  id: number,
  spentDate: string,
  createdAt: string,
  costRateCents: number | null = 4_000,
): void => {
  database.exec(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, cost_rate_cents, created_at, updated_at)
    VALUES (${id}, 1, 1, 1, 1, 1, '${spentDate}', 3600, 3600, 3600, 1,
      ${costRateCents === null ? 'NULL' : costRateCents}, '${createdAt}', '${createdAt}')`)
}

const rows = (database: BetterSqlite3.Database, table = 'user_cost_rates') =>
  database
    .prepare(`SELECT id, amount_cents, start_date, end_date FROM ${table} ORDER BY id`)
    .all()

/**
 * Widening what a command may be means rebuilding the ledger, because SQLite
 * cannot alter a CHECK. The receipts in it are what make a command idempotent,
 * so a rebuild that dropped them would make every past command replayable a
 * second time -- and this is the only place that says it does not.
 */
describe('rebuilding the team command ledger', () => {
  it('[money] carries existing receipts across, still immutable', async () => {
    const database = new BetterSqlite3(':memory:')
    sqlite = database
    await migrateContainerThrough(database, '0075_band_claim_scope')
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('Fixture', '{}', '${at}', '${at}');
      INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (1, 'Ada', 'Lovelace', 'administrator', '[]', '${at}', '${at}');
      INSERT INTO team_command_ledger
        (target_user_id, command_kind, command_id, input_fingerprint, actor_user_id,
         result_json, occurred_at)
      VALUES (1, 'person.cost_rate.append', 'already-run', 'sha256:${'a'.repeat(64)}', 1,
        '{"schema_version":1,"data":{}}', '2026-09-10T12:00:00Z')`)

    await migrateContainer(database)

    // The receipt survived, in the second-precision shape the old check
    // admitted -- a rebuild that tightened the timestamp rule would have
    // rejected this row halfway through somebody's migration.
    expect(
      database
        .prepare(`SELECT command_kind, command_id, occurred_at FROM team_command_ledger`)
        .all(),
    ).toEqual([
      {
        command_kind: 'person.cost_rate.append',
        command_id: 'already-run',
        occurred_at: '2026-09-10T12:00:00Z',
      },
    ])
    expect(() => database.exec(`DELETE FROM team_command_ledger`)).toThrow(/append-only/u)
    expect(() =>
      database.exec(`UPDATE team_command_ledger SET actor_user_id = 1`),
    ).toThrow(/immutable/u)
    // And the kinds the removal needs are admitted now, where they were not.
    database.exec(`
      INSERT INTO team_command_ledger
        (target_user_id, command_kind, command_id, input_fingerprint, actor_user_id,
         result_json, occurred_at)
      VALUES (1, 'person.cost_rate.remove', 'undo', 'sha256:${'b'.repeat(64)}', 1,
        '{"schema_version":1,"data":{}}', '2026-09-14T12:00:00.000Z')`)
    expect(() =>
      database.exec(`
        INSERT INTO team_command_ledger
          (target_user_id, command_kind, command_id, input_fingerprint, actor_user_id,
           result_json, occurred_at)
        VALUES (1, 'person.invent', 'x', 'sha256:${'c'.repeat(64)}', 1,
          '{"schema_version":1,"data":{}}', '2026-09-14T12:00:00.000Z')`),
    ).toThrow(/command_kind/u)
  })
})

describe('removing a rate', () => {
  it('[money] puts back the rate the mistake displaced', async () => {
    // The whole reason this exists. Inserting a rate ends the one before it, so
    // removing the insert has to reopen it -- otherwise taking away the mistake
    // leaves the damage, and every day after it is priced by nothing.
    const database = await fixture()
    rate(database, 1, 15_000, null)
    rate(database, 2, 10_000, '2026-09-14', later)
    expect(rows(database)).toEqual([
      { id: 1, amount_cents: 15_000, start_date: null, end_date: '2026-09-13' },
      { id: 2, amount_cents: 10_000, start_date: '2026-09-14', end_date: null },
    ])

    database.exec(`DELETE FROM user_cost_rates WHERE id = 2`)

    expect(rows(database)).toEqual([
      { id: 1, amount_cents: 15_000, start_date: null, end_date: null },
    ])
  })

  it('[unit] ignores work dated before the rate could have applied', async () => {
    // An entry the rate's window never covered was not priced by it, whatever
    // happened to it afterwards.
    const database = await fixture()
    entry(database, 1, '2026-09-11', '2026-09-11T09:00:00.000Z')
    rate(database, 1, 10_000, '2026-09-14', later)
    database.exec(`
      INSERT INTO time_entry_rate_reprices
        (id, time_entry_id, cost_rate_cents, reason, repriced_at)
      VALUES (1, 1, 9000, 'corrected an older month', '2026-09-14T13:00:00.000Z')`)
    database.exec(`DELETE FROM user_cost_rates WHERE id = 1`)
    expect(rows(database)).toEqual([])
  })

  it('[money] refuses a rate that has priced work', async () => {
    // A rate that did its job is history, and a history that can be edited is
    // one that cannot explain the money it produced.
    const database = await fixture()
    rate(database, 1, 10_000, '2026-09-14', later)
    entry(database, 1, '2026-09-14', '2026-09-14T13:00:00.000Z')
    expect(() => database.exec(`DELETE FROM user_cost_rates WHERE id = 1`)).toThrow(
      /priced work cannot be removed/u,
    )
  })

  it('[money] refuses a rate a reprice was recorded against', async () => {
    // The other mark pricing leaves, isolated: the entry was created *before*
    // the rate, so its own creation says nothing and only the reprice ties the
    // two together.
    const database = await fixture()
    entry(database, 1, '2026-09-14', '2026-09-14T09:00:00.000Z')
    rate(database, 1, 10_000, '2026-09-14', later)
    database.exec(`
      INSERT INTO time_entry_rate_reprices
        (id, time_entry_id, cost_rate_cents, reason, repriced_at)
      VALUES (1, 1, 10000, 'applied the new rate', '2026-09-14T13:00:00.000Z')`)
    expect(() => database.exec(`DELETE FROM user_cost_rates WHERE id = 1`)).toThrow(
      /priced work cannot be removed/u,
    )
  })

  it('[money] takes no evidence from an entry carrying no figure of that kind', async () => {
    // An entry that was never priced for cost cannot be what a cost rate
    // priced, whenever it was created.
    const database = await fixture()
    rate(database, 1, 10_000, '2026-09-14', later)
    entry(database, 1, '2026-09-14', '2026-09-14T13:00:00.000Z', null)
    database.exec(`DELETE FROM user_cost_rates WHERE id = 1`)
    expect(rows(database)).toEqual([])
  })

  it('[unit] does not lock a rate because somebody edited a note afterwards', async () => {
    // `updated_at` moves for reasons that are not pricing. A rate that becomes
    // permanent because a colleague fixed a typo is the original problem
    // wearing a different hat, so the test is the marks pricing leaves. The
    // entry is inside the rate's window and older than it, so only the edit
    // could lock it.
    const database = await fixture()
    entry(database, 1, '2026-09-14', '2026-09-14T09:00:00.000Z')
    rate(database, 1, 10_000, '2026-09-14', later)
    database.exec(`UPDATE time_entries SET notes = 'tidied the wording',
      updated_at = '2026-09-14T14:00:00.000Z' WHERE id = 1`)
    database.exec(`DELETE FROM user_cost_rates WHERE id = 1`)
    expect(rows(database)).toEqual([])
  })

  it('[money] does not let a cost-priced hour hold a billable rate hostage', async () => {
    // The case that appeared in practice (#746): two non-billable entries
    // carrying only a cost rate made a mistyped *billable* rate permanent. A
    // guard blind to which kind of rate an entry actually took refuses for a
    // reason that is not true, and a rule that refuses untruthfully is one
    // people route around.
    const database = await fixture()
    rate(database, 1, 10_000, '2026-09-14', later, 'user_billable_rates')
    rate(database, 2, 10_000, '2026-09-14', later, 'user_cost_rates')
    // Non-billable, no billable rate, priced only for cost -- created after
    // both rates, so the old guard blocked both removals.
    database.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                task_assignment_id, spent_date, seconds,
                                seconds_without_timer, rounded_seconds, billable,
                                billable_rate_cents, cost_rate_cents, created_at, updated_at)
      VALUES (1, 1, 1, 1, 1, 1, '2026-09-14', 4500, 4500, 4500, 0,
        NULL, 10000, '2026-09-14T14:00:00.000Z', '2026-09-14T14:00:00.000Z')`)

    // The billable rate never priced it, so it comes out.
    database.exec(`DELETE FROM user_billable_rates WHERE id = 1`)
    expect(rows(database, 'user_billable_rates')).toEqual([])
    // The cost rate did price it, so it stays -- the guard still has teeth.
    expect(() => database.exec(`DELETE FROM user_cost_rates WHERE id = 2`)).toThrow(
      /priced work cannot be removed/u,
    )
  })

  it('[money] reads a reprice as evidence only about the kind it moved', async () => {
    // A reprice that moved the cost figure says nothing about the billable
    // rate, in either direction -- so both the new and the previous column of
    // that kind count, and neither counts for the other kind.
    const database = await fixture()
    entry(database, 1, '2026-09-14', '2026-09-14T09:00:00.000Z')
    rate(database, 1, 10_000, '2026-09-14', later, 'user_billable_rates')
    rate(database, 2, 10_000, '2026-09-14', later, 'user_cost_rates')
    database.exec(`
      INSERT INTO time_entry_rate_reprices
        (id, time_entry_id, previous_cost_rate_cents, cost_rate_cents, reason, repriced_at)
      VALUES (1, 1, 4000, NULL, 'cleared the cost rate', '2026-09-14T15:00:00.000Z')`)

    // Cost was touched, so the cost rate is held even though the new value is
    // null -- clearing a figure is still having priced it.
    expect(() => database.exec(`DELETE FROM user_cost_rates WHERE id = 2`)).toThrow(
      /priced work cannot be removed/u,
    )
    // Billable was not touched by that reprice, so its rate is free.
    database.exec(`DELETE FROM user_billable_rates WHERE id = 1`)
    expect(rows(database, 'user_billable_rates')).toEqual([])
  })

  it('[money] refuses a rate from the middle of the history', async () => {
    // Removing it would leave the period it covered belonging to nothing, and
    // the chain of end dates describing a range nobody was ever charged.
    const database = await fixture()
    rate(database, 1, 15_000, null)
    rate(database, 2, 10_000, '2026-09-12', later)
    rate(database, 3, 20_000, '2026-09-14', later)
    expect(() => database.exec(`DELETE FROM user_cost_rates WHERE id = 2`)).toThrow(
      /only the current rate may be removed/u,
    )
    expect(() => database.exec(`DELETE FROM user_cost_rates WHERE id = 1`)).toThrow(
      /only the current rate may be removed/u,
    )
  })

  it('[unit] reopens by start date, not by whichever row was written last', async () => {
    // An import writes rates in whatever order it reads them, so the newest row
    // is not the latest rate. Reopening the wrong one would leave two rates
    // open at once, which is a person with two current rates.
    const database = await fixture()
    rate(database, 9, 12_000, '2026-09-11', at)
    rate(database, 3, 15_000, '2026-09-12', at)
    rate(database, 7, 10_000, '2026-09-14', later)
    database.exec(`DELETE FROM user_cost_rates WHERE id = 7`)
    expect(rows(database)).toEqual([
      { id: 3, amount_cents: 15_000, start_date: '2026-09-12', end_date: null },
      { id: 9, amount_cents: 12_000, start_date: '2026-09-11', end_date: '2026-09-11' },
    ])
  })

  it('[unit] holds the same rules for billable rates', async () => {
    // One screen, two sections side by side, and the misclick this exists for
    // was on the other one.
    const database = await fixture()
    rate(database, 1, 15_000, null, at, 'user_billable_rates')
    rate(database, 2, 10_000, '2026-09-14', later, 'user_billable_rates')
    database.exec(`DELETE FROM user_billable_rates WHERE id = 2`)
    expect(rows(database, 'user_billable_rates')).toEqual([
      { id: 1, amount_cents: 15_000, start_date: null, end_date: null },
    ])
  })

  it('[money] still refuses every other edit to a rate', async () => {
    // Removing one is now possible; rewriting one is not, and the amount that
    // priced somebody's work stays what it was.
    const database = await fixture()
    rate(database, 1, 15_000, null)
    expect(() =>
      database.exec(`UPDATE user_cost_rates SET amount_cents = 20000 WHERE id = 1`),
    ).toThrow(/append-only/u)
    expect(() =>
      database.exec(`UPDATE user_cost_rates SET start_date = '2026-09-01' WHERE id = 1`),
    ).toThrow(/append-only/u)
    // Reopening one that nothing closed would be a second current rate.
    rate(database, 2, 10_000, '2026-09-14', later)
    expect(() =>
      database.exec(`UPDATE user_cost_rates SET end_date = NULL WHERE id = 1`),
    ).toThrow(/append-only/u)
  })
})
