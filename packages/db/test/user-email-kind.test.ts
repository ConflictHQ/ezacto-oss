import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createReportRepository } from '../src/reports.js'

/**
 * Issues 280 and 421. A payout provider matches a person on an address, and the
 * one it matches on is the personal address -- Deel and Wise accounts were
 * opened against personal addresses, which is why the migration kept the source
 * system's address primary.
 *
 * So the payroll export read `is_primary`, and `is_primary` was being asked to
 * mean two things: the address we write to, and the address a provider knows
 * them by. Those are the same address today by coincidence.
 */

const at = '2026-08-15T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, currency, created_at, updated_at)
      VALUES ('CONFLICT', '{}', 'USD', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, is_active, is_contractor,
                       manager_grants, created_at, updated_at)
      VALUES (1, 'R.', 'Adeyemi', 'member', 1, 1, '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
      VALUES (1, 1, 'Phase 1', 'P1', 1, 'time_materials', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, cost_rate_cents, created_at, updated_at)
      VALUES (1, 1, 1, 1, 1, 1, '2026-08-10', 3600, 3600, 3600, 1, 10000, '${at}', '${at}');
    INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, created_at, updated_at)
      VALUES (1, 1, 'work@example.test', '${at}', 1, '${at}', '${at}');
  `)
  sqlite = database
  return createReportRepository(createContainerDatabase(database) as never)
}

const payrollEmail = async (reports: Awaited<ReturnType<typeof fixture>>) =>
  (await reports.contractorCost({ from: '2026-08-01', to: '2026-08-31' })).rows[0]?.payrollEmail

describe('which address the payroll run proposes', () => {
  it('[money] is the primary one until somebody names a payroll address', async () => {
    // Every address that exists today. Nothing changes until the kind is set,
    // which is why naming one is a deliberate act rather than an import guess.
    const reports = await fixture()
    expect(await payrollEmail(reports)).toBe('work@example.test')
  })

  it('[money] is the payroll-kind address once one is named', async () => {
    const reports = await fixture()
    sqlite!.exec(`
      INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind, created_at, updated_at)
        VALUES (2, 1, 'personal@example.test', '${at}', 0, 'payroll', '${at}', '${at}')`)
    expect(await payrollEmail(reports)).toBe('personal@example.test')
  })

  it('[money] ignores an invalidated payroll address and falls back', async () => {
    // An address somebody has retired is not where a payment reference goes.
    const reports = await fixture()
    sqlite!.exec(`
      INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind,
                               invalidated_at, created_at, updated_at)
        VALUES (2, 1, 'old@example.test', '${at}', 0, NULL, '${at}', '${at}', '${at}')`)
    sqlite!.exec(`UPDATE user_emails SET kind = 'payroll' WHERE id = 2 AND invalidated_at IS NULL`)
    expect(await payrollEmail(reports)).toBe('work@example.test')
  })
})

describe('what the schema holds a payroll address to', () => {
  it('[security] refuses an unverified address as the payroll one', async () => {
    // Proposing an unverified address to a payout provider is a guess about a
    // guess.
    await fixture()
    expect(() =>
      sqlite!.exec(`
        INSERT INTO user_emails (id, user_id, address, is_primary, kind, created_at, updated_at)
          VALUES (2, 1, 'unverified@example.test', 0, 'payroll', '${at}', '${at}')`),
    ).toThrow(/payroll address must be verified and live/u)
  })

  it('[security] refuses a second payroll address for one person', async () => {
    // Two addresses claiming to be the one a provider knows them by is the
    // ambiguity this column exists to remove.
    await fixture()
    sqlite!.exec(`
      INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind, created_at, updated_at)
        VALUES (2, 1, 'personal@example.test', '${at}', 0, 'payroll', '${at}', '${at}')`)
    expect(() =>
      sqlite!.exec(`
        INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind, created_at, updated_at)
          VALUES (3, 1, 'another@example.test', '${at}', 0, 'payroll', '${at}', '${at}')`),
    ).toThrow(/UNIQUE/iu)
  })

  it('[security] refuses a kind nobody defined', async () => {
    await fixture()
    expect(() =>
      sqlite!.exec(`
        INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind, created_at, updated_at)
          VALUES (2, 1, 'other@example.test', '${at}', 0, 'whatever', '${at}', '${at}')`),
    ).toThrow(/CHECK|constraint/iu)
  })

  it('[unit] lets an invalidated address keep its kind for the history', async () => {
    // The partial index is on the live rows, so retiring a payroll address does
    // not block the one that replaces it.
    await fixture()
    sqlite!.exec(`
      INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind, created_at, updated_at)
        VALUES (2, 1, 'personal@example.test', '${at}', 0, 'payroll', '${at}', '${at}')`)
    sqlite!.exec(`UPDATE user_emails SET invalidated_at = '${at}' WHERE id = 2`)
    sqlite!.exec(`
      INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, kind, created_at, updated_at)
        VALUES (3, 1, 'new-personal@example.test', '${at}', 0, 'payroll', '${at}', '${at}')`)
    expect(
      sqlite!.prepare(`SELECT count(*) AS n FROM user_emails WHERE kind = 'payroll'`).get(),
    ).toEqual({ n: 2 })
  })
})

/**
 * Issue 280's remaining column: "cost rate, or `mixed` when it changed inside
 * the period".
 *
 * The report knew the cost and the hours and never said which rate produced
 * them. A payroll run pastes a rate into another system, so "which rate" is not
 * a question the row should leave open.
 */
describe('the rate a payroll line was worked out at (#280)', () => {
  const entry = (id: number, spentDate: string, seconds: number, rate: number | null) =>
    sqlite!.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                                task_assignment_id, spent_date, seconds, seconds_without_timer,
                                rounded_seconds, billable, cost_rate_cents, created_at, updated_at)
        VALUES (${id}, 1, 1, 1, 1, 1, '${spentDate}', ${seconds}, ${seconds}, ${seconds}, 1,
                ${rate === null ? 'NULL' : rate}, '${at}', '${at}')`)

  const august = { from: '2026-08-01', to: '2026-08-31' }

  it('[money] states the rate where it did not move', async () => {
    const reports = await fixture()
    entry(2, '2026-08-11', 3_600, 10_000)
    const [row] = (await reports.contractorCost(august)).rows
    expect(row).toMatchObject({
      costRateCents: 10_000,
      costRateIsMixed: false,
      costCents: 20_000,
    })
  })

  it('[money] says mixed rather than averaging a rate nobody agreed to', async () => {
    const reports = await fixture()
    // The fixture entry is at 100.00; this one is at 150.00.
    entry(2, '2026-08-11', 3_600, 15_000)
    const [row] = (await reports.contractorCost(august)).rows
    // An average would read as a rate this person is paid, and they are not.
    expect(row?.costRateCents).toBeNull()
    expect(row?.costRateIsMixed).toBe(true)
    // The cost is still exact -- each entry was costed at its own rate.
    expect(row?.costCents).toBe(25_000)
  })

  it('[money] still names the rate when an entry simply has none', async () => {
    // Not the same as the rate moving. The person is on one rate and an entry
    // was logged without it, so "they are on 100.00 and one entry cannot be
    // costed" is the useful answer -- more useful than a null that would read
    // as though nobody knew what they were paid.
    const reports = await fixture()
    entry(2, '2026-08-11', 3_600, null)
    const [row] = (await reports.contractorCost(august)).rows
    expect(row).toMatchObject({
      costRateCents: 10_000,
      costRateIsMixed: false,
      entriesWithoutRate: 1,
      // The cost is still refused: a total that omitted those hours would look
      // payable and underpay. The rate being knowable does not make it payable.
      costCents: null,
    })
  })

  it('[money] tells a moved rate apart from a missing one', async () => {
    // Both are reasons a payroll line needs a person to look at it, and they
    // need different people: one is a rate change to confirm, the other is an
    // entry somebody forgot to rate.
    const moved = await fixture()
    entry(2, '2026-08-11', 3_600, 15_000)
    const [movedRow] = (await moved.contractorCost(august)).rows
    expect(movedRow).toMatchObject({ costRateIsMixed: true, entriesWithoutRate: 0 })

    const missing = await fixture()
    entry(2, '2026-08-11', 3_600, null)
    const [missingRow] = (await missing.contractorCost(august)).rows
    expect(missingRow).toMatchObject({ costRateIsMixed: false, entriesWithoutRate: 1 })
  })

  it('[money] stays mixed once it has moved, whatever follows', async () => {
    const reports = await fixture()
    entry(2, '2026-08-11', 3_600, 15_000)
    // Back to the original rate. The period still contains two rates.
    entry(3, '2026-08-12', 3_600, 10_000)
    const [row] = (await reports.contractorCost(august)).rows
    expect(row?.costRateIsMixed).toBe(true)
    expect(row?.costRateCents).toBeNull()
  })
})
