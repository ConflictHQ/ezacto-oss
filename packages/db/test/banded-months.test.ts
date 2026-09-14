import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { createReportRepository } from '../src/reports.js'

/**
 * Issue 484, part 3. A flat-rate engagement bills the same figure every month
 * whatever the team did, so "is this band priced right" cannot be answered from
 * the invoice. It is answerable from the two rate columns every entry already
 * carries.
 */

const at = '2026-08-01T12:00:00.000Z'
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
    INSERT INTO users (id, first_name, last_name, profile, is_active, manager_grants, created_at, updated_at)
      VALUES (1, 'R.', 'Adeyemi', 'member', 1, '[]', '${at}', '${at}'),
             (2, 'J.', 'Okafor', 'member', 1, '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Response Logix', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, is_active, billing_method, created_at, updated_at)
      VALUES (1, 1, 'Customer Data Platform Phase 1a', 'CDP', 1, 'time_materials', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}'), (2, 1, 2, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
  `)
  sqlite = database
  return createReportRepository(createContainerDatabase(database) as never)
}

let entryId = 0
const entry = (
  spentDate: string,
  seconds: number,
  billableRate: number | null,
  costRate: number | null,
  userId = 1,
  invoiceId: number | null = null,
) => {
  entryId += 1
  sqlite!.exec(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, billable_rate_cents, cost_rate_cents,
                              invoice_id, created_at, updated_at)
      VALUES (${entryId}, ${userId}, 1, 1, ${userId}, 1, '${spentDate}',
              ${seconds}, ${seconds}, ${seconds}, 1,
              ${billableRate === null ? 'NULL' : billableRate},
              ${costRate === null ? 'NULL' : costRate},
              ${invoiceId === null ? 'NULL' : invoiceId}, '${at}', '${at}')`)
}

/**
 * The invoice a band raised. Its total comes from a line item rather than being
 * written directly: invoice totals are trigger-derived, so an `amount_cents`
 * set by hand is silently zeroed -- which is the schema being right and the
 * first version of this fixture being wrong.
 */
const band = (amountCents: number, foregoneCents: number) =>
  sqlite!.exec(`
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          foregone_billable_cents, created_at, updated_at)
      VALUES (900, 1, '900', 'USD', '2026-09-10', '2026-10-10', 'draft',
              ${foregoneCents}, '${at}', '${at}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (900, 0, 'Service', 'Banded team', 1, ${amountCents}, ${amountCents},
              '${at}', '${at}')`)

/** A second invoice, in a currency the band is not billed in. */
const foreignBand = (amountCents: number) =>
  sqlite!.exec(`
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          foregone_billable_cents, created_at, updated_at)
      VALUES (901, 1, '901', 'EUR', '2026-09-10', '2026-10-10', 'draft',
              0, '${at}', '${at}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (901, 0, 'Service', 'Banded team', 1, ${amountCents}, ${amountCents},
              '${at}', '${at}')`)

const august = { from: '2026-08-01', to: '2026-08-31' }

describe('what a banded month was worth', () => {
  it('[money] values the month at billable and at cost, side by side', async () => {
    // A band sits between the two: below cost is losing money, near list is
    // barely a band.
    const reports = await fixture()
    entry('2026-08-10', 3600, 25_000, 10_000)
    entry('2026-08-11', 3600, 20_000, 8_000, 2)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row).toMatchObject({
      month: '2026-08',
      projectName: 'Customer Data Platform Phase 1a',
      clientName: 'Response Logix',
      roundedSeconds: 7_200,
      billableValueCents: 45_000,
      costValueCents: 18_000,
      currency: 'USD',
    })
  })

  it('[money] values per entry, never from an averaged rate', async () => {
    // Two people at different rates have no single rate, and averaging them
    // would invent one. One hour at $250 and three at $100 is $550, not 4 x $175.
    const reports = await fixture()
    entry('2026-08-10', 3600, 25_000, 10_000)
    entry('2026-08-11', 10_800, 10_000, 5_000, 2)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row!.billableValueCents).toBe(55_000)
  })

  it('[money] reports null rather than a total that omits unrated work', async () => {
    // A number that is silently short is worse than no number, and this one
    // decides whether a band is priced right.
    const reports = await fixture()
    entry('2026-08-10', 3600, 25_000, 10_000)
    entry('2026-08-11', 3600, null, 10_000, 2)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row!.billableValueCents).toBeNull()
    expect(row!.entriesWithoutBillableRate).toBe(1)
    // The cost side is unaffected: one missing rate does not blind the other.
    expect(row!.costValueCents).toBe(20_000)
  })

  it('[money] shows what the band charged and what it gave up', async () => {
    const reports = await fixture()
    band(1_250_000, 1_250_000)
    entry('2026-08-10', 180_000, 25_000, 10_000, 1, 900)
    const [row] = (await reports.bandedMonths(august)).rows
    // 50 hours at $250 is $25,000 of value; the band charged $12,500.
    expect(row).toMatchObject({
      billableValueCents: 1_250_000,
      billedCents: 1_250_000,
      foregoneCents: 1_250_000,
    })
  })

  it('[money] leaves an unbilled month null, not zero', async () => {
    // An unbilled month is not a band priced at nothing.
    const reports = await fixture()
    entry('2026-08-10', 3600, 25_000, 10_000)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row!.billedCents).toBeNull()
    expect(row!.foregoneCents).toBeNull()
  })

  it('[money] splits the months a range covers', async () => {
    // A band is reviewed monthly, so one row per month per project.
    const reports = await fixture()
    entry('2026-08-10', 3600, 25_000, 10_000)
    entry('2026-09-10', 7200, 25_000, 10_000)
    const rows = (await reports.bandedMonths({ from: '2026-08-01', to: '2026-09-30' })).rows
    expect(rows.map((row) => [row.month, row.roundedSeconds])).toEqual([
      ['2026-08', 3_600],
      ['2026-09', 7_200],
    ])
  })

  it('[unit] leaves non-billable time out of a billing question', async () => {
    const reports = await fixture()
    entry('2026-08-10', 3600, 25_000, 10_000)
    sqlite!.exec(`INSERT INTO time_entries (id, user_id, project_id, task_id,
        user_assignment_id, task_assignment_id, spent_date, seconds,
        seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
      VALUES (99, 1, 1, 1, 1, 1, '2026-08-12', 3600, 3600, 3600, 0, '${at}', '${at}')`)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row!.roundedSeconds).toBe(3_600)
  })

  it('[unit] answers an empty range with no rows rather than failing', async () => {
    const reports = await fixture()
    expect((await reports.bandedMonths(august)).rows).toEqual([])
  })
})

/**
 * Issue 522's second step: confirm the per-currency grouping holds everywhere
 * money is summed. It did not hold here.
 *
 * Reports in this codebase group per currency and never across, because adding
 * two currencies invents an exchange rate the system does not hold. This report
 * was labelling every row with the *organization's* currency and summing every
 * claiming invoice regardless of what it was raised in.
 */
describe('a band billed in a currency of its own (#522)', () => {
  it('[money] labels the row with the project’s currency, not the organization’s', async () => {
    const reports = await fixture()
    // The client bills in EUR while the organization's default is USD.
    sqlite!.exec(`UPDATE clients SET currency = 'EUR' WHERE id = 1`)
    entry('2026-08-03', 3_600, 20_000, 8_000)
    const [row] = (await reports.bandedMonths(august)).rows
    // Previously 'USD': a figure in a currency nobody charged. The number was
    // right and the unit was wrong, which is the worse of the two.
    expect(row?.currency).toBe('EUR')
  })

  it('[money] prefers the project’s own billing currency over the client’s', async () => {
    const reports = await fixture()
    sqlite!.exec(`UPDATE clients SET currency = 'EUR' WHERE id = 1`)
    sqlite!.exec(`UPDATE projects SET billing_currency = 'GBP' WHERE id = 1`)
    entry('2026-08-03', 3_600, 20_000, 8_000)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row?.currency).toBe('GBP')
  })

  it('[money] never adds an invoice raised in another currency into the total', async () => {
    const reports = await fixture()
    band(500_000, 0)
    foreignBand(900_000)
    entry('2026-08-03', 3_600, 20_000, 8_000, 1, 900)
    entry('2026-08-04', 3_600, 20_000, 8_000, 2, 901)
    const [row] = (await reports.bandedMonths(august)).rows
    // 500_000 alone. Adding the EUR invoice would have produced 1_400_000 --
    // a number that looks right and is a sum of two different units.
    expect(row?.billedCents).toBe(500_000)
    // Counted rather than dropped, so a total that looks low says why.
    expect(row?.claimedInOtherCurrency).toBe(1)
  })

  it('[money] reports nothing billed, not a wrong figure, when every claim is foreign', async () => {
    const reports = await fixture()
    foreignBand(900_000)
    entry('2026-08-03', 3_600, 20_000, 8_000, 1, 901)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row?.billedCents).toBeNull()
    expect(row?.claimedInOtherCurrency).toBe(1)
  })

  it('[money] leaves the ordinary single-currency case exactly as it was', async () => {
    const reports = await fixture()
    band(500_000, 120_000)
    entry('2026-08-03', 3_600, 20_000, 8_000, 1, 900)
    const [row] = (await reports.bandedMonths(august)).rows
    expect(row).toMatchObject({
      currency: 'USD',
      billedCents: 500_000,
      foregoneCents: 120_000,
      claimedInOtherCurrency: 0,
    })
  })
})
