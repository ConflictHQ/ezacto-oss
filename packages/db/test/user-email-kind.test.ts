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
