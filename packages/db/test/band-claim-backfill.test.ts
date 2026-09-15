import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { backfillBandClaims } from '../src/band-claim-backfill.js'

/**
 * Issue 712. A band issued before it carried `claims_project_ids` claimed
 * nothing, and nothing afterwards could correct it. Those hours read as
 * uninvoiced for ever -- they are not, they were paid for by a flat invoice
 * that has settled -- so every figure asking "what has been delivered and not
 * billed" counts them.
 */
const at = '2026-09-14T12:00:00.000Z'
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
      VALUES ('Fixture', '{}', 'USD', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Ada', 'Lovelace', 'administrator', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}'),
             (2, 'Northpeak', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
      VALUES (1, 1, 'Platform', 'PLT', '${at}', '${at}'),
             (2, 2, 'Other', 'OTH', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}'), (2, 2, 1, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}'), (2, 2, 1, 1, '${at}', '${at}');
  `)
  sqlite = database
  return { database, orm: createContainerDatabase(database) as never }
}

const invoice = (
  database: BetterSqlite3.Database,
  id: number,
  issueDate: string,
  amountCents: number,
  state = 'draft',
  clientId = 1,
): void => {
  // Draft, because the line-item guard admits a direct insert only on an
  // untouched draft and settling one properly needs the whole command
  // machinery -- which is not what is under test here. Nothing in the backfill
  // reads the state, and the rehearsal against real data covers the case that
  // matters, where every invoice is already paid.
  database.exec(`
    INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
                          foregone_billable_cents, created_at, updated_at)
      VALUES (${id}, ${clientId}, '${id}', 'USD', '${issueDate}', '2026-12-31', '${state}',
              0, '${at}', '${at}');
    INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
                                    unit_price_cents, amount_cents, created_at, updated_at)
      VALUES (${id}, 0, 'Service', 'Banded team', 1, ${amountCents}, ${amountCents},
              '${at}', '${at}')`)
}

let nextEntry = 0
const entry = (
  database: BetterSqlite3.Database,
  spentDate: string,
  seconds: number,
  rateCents: number | null,
  projectId = 1,
): number => {
  nextEntry += 1
  database.exec(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, billable_rate_cents,
                              created_at, updated_at)
    VALUES (${nextEntry}, 1, ${projectId}, 1, ${projectId}, ${projectId}, '${spentDate}',
      ${seconds}, ${seconds}, ${seconds}, 1,
      ${rateCents === null ? 'NULL' : rateCents}, '${at}', '${at}')`)
  return nextEntry
}

const run = (orm: never, extra: Record<string, unknown> = {}) =>
  backfillBandClaims(orm, {
    invoiceIds: [10, 20],
    projectIds: [1],
    actorUserId: 1,
    runId: 'backfill-1',
    occurredAt: at,
    ...extra,
  } as never)

describe('filling in a band that was issued before it could claim', () => {
  it('[money] reports what it would claim per invoice and writes nothing', async () => {
    // The figures are large enough that nobody should approve them from a
    // description, so a dry run is the default and comes first.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 9_368_500)
    entry(database, '2026-07-10', 3_600, 25_000)
    entry(database, '2026-08-10', 7_200, 25_000)

    const report = await run(orm)
    expect(report.applied).toBe(false)
    expect(report.invoices.map((line) => [line.invoiceId, line.entryCount, line.seconds])).toEqual([
      [10, 1, 3_600],
      [20, 1, 7_200],
    ])
    // Nothing written: every entry is still unbilled.
    expect(
      database.prepare(`SELECT count(*) AS n FROM time_entries WHERE invoice_id IS NULL`).get(),
    ).toEqual({ n: 2 })
    expect(
      database.prepare(`SELECT count(*) AS n FROM time_entry_claim_backfills`).get(),
    ).toEqual({ n: 0 })
  })

  it('[money] claims oldest invoice first, so each takes the work of its own period', async () => {
    // Any other order hands old hours to a recent invoice and leaves the old
    // one holding nothing, which is a period nobody can reconcile.
    const { database, orm } = await fixture()
    invoice(database, 20, '2026-08-31', 9_368_500)
    invoice(database, 10, '2026-07-31', 2_250_000)
    const july = entry(database, '2026-07-10', 3_600, 25_000)
    const august = entry(database, '2026-08-10', 7_200, 25_000)

    const report = await run(orm, { apply: true })
    expect(report.applied).toBe(true)
    expect(
      database
        .prepare(`SELECT id, invoice_id FROM time_entries ORDER BY id`)
        .all(),
    ).toEqual([
      { id: july, invoice_id: 10 },
      { id: august, invoice_id: 20 },
    ])
  })

  it('[unit] running twice claims nothing the second time', async () => {
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 9_368_500)
    entry(database, '2026-07-10', 3_600, 25_000)

    const first = await run(orm, { apply: true })
    expect(first.invoices.reduce((sum, line) => sum + line.entryCount, 0)).toBe(1)
    const second = await run(orm, { apply: true, runId: 'backfill-2' })
    expect(second.invoices.reduce((sum, line) => sum + line.entryCount, 0)).toBe(0)
    expect(
      database.prepare(`SELECT count(*) AS n FROM time_entry_claim_backfills`).get(),
    ).toEqual({ n: 1 })
  })

  it('[money] records what the band absorbed, and leaves the invoice total alone', async () => {
    // A band prices the period, not the hours: the client owes the flat amount
    // whatever the team did, so the total must not move. What the band absorbed
    // is value delivered and never charged, which is a different column.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 1_000_000)
    invoice(database, 20, '2026-08-31', 1_000_000)
    // 60 hours at $250 = $15,000 against $10,000 charged.
    entry(database, '2026-07-10', 216_000, 25_000)

    const before = database.prepare(`SELECT amount_cents FROM invoices WHERE id = 10`).get()
    const report = await run(orm, { apply: true })
    expect(report.invoices[0]).toMatchObject({
      billableValueCents: 1_500_000,
      foregoneBillableCents: 500_000,
    })
    expect(
      database
        .prepare(`SELECT amount_cents, foregone_billable_cents FROM invoices WHERE id = 10`)
        .get(),
    ).toEqual({ ...(before as object), foregone_billable_cents: 500_000 })
  })

  it('[money] records nothing forgone when the band charged more than the work was worth', async () => {
    // A good month, and a real one: a fixed-bid project carries no billable
    // rates at all, so its value at list is zero against a five-figure amount.
    // Without the floor the invoice would report having forgone *negative*
    // twenty-two thousand, which is not a smaller number than zero -- it is a
    // different claim, and one nobody could read.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 2_250_000)
    entry(database, '2026-07-10', 3_600, null)

    const report = await run(orm, { apply: true })
    expect(report.invoices[0]).toMatchObject({
      entryCount: 1,
      billableValueCents: 0,
      foregoneBillableCents: 0,
    })
    expect(
      database.prepare(`SELECT foregone_billable_cents FROM invoices WHERE id = 10`).get(),
    ).toEqual({ foregone_billable_cents: 0 })
  })

  it('[money] says how much it could not price rather than reporting a smaller value', async () => {
    // A fixed-bid project carries no billable rates at all. Its value at list
    // is not low, it is unknown, and a figure that did not say so would read as
    // a band that absorbed nothing.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 2_250_000)
    entry(database, '2026-07-10', 3_600, null)
    entry(database, '2026-07-11', 3_600, 25_000)

    const report = await run(orm)
    expect(report.invoices[0]).toMatchObject({
      entryCount: 2,
      entriesWithoutBillableRate: 1,
      billableValueCents: 25_000,
    })
  })

  it('[money] refuses work done after the invoice was issued', async () => {
    // Claiming it would attribute the hours to a period they were not in, which
    // is the distortion this exists to remove rather than relocate.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 2_250_000)
    const late = entry(database, '2026-09-10', 3_600, 25_000)

    const report = await run(orm, { apply: true })
    expect(report.invoices.every((line) => line.entryCount === 0)).toBe(true)
    expect(
      database.prepare(`SELECT invoice_id FROM time_entries WHERE id = ${late}`).get(),
    ).toEqual({ invoice_id: null })
    // And the schema refuses it even if a caller tries directly.
    expect(() =>
      database.exec(`INSERT INTO time_entry_claim_backfills
        (run_id, time_entry_id, invoice_id, actor_user_id, claimed_at)
        VALUES ('x', ${late}, 10, 1, '${at}')`),
    ).toThrow(/after it was issued/u)
  })

  it('[money] refuses to claim another client work', async () => {
    const { database } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    const other = entry(database, '2026-07-10', 3_600, 25_000, 2)
    expect(() =>
      database.exec(`INSERT INTO time_entry_claim_backfills
        (run_id, time_entry_id, invoice_id, actor_user_id, claimed_at)
        VALUES ('x', ${other}, 10, 1, '${at}')`),
    ).toThrow(/another client/u)
  })

  it('[money] refuses an entry that already belongs to an invoice', async () => {
    // What makes a second run a no-op by rule rather than by a WHERE clause
    // somebody has to remember.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 2_250_000)
    const only = entry(database, '2026-07-10', 3_600, 25_000)
    await run(orm, { apply: true })
    expect(() =>
      database.exec(`INSERT INTO time_entry_claim_backfills
        (run_id, time_entry_id, invoice_id, actor_user_id, claimed_at)
        VALUES ('again', ${only}, 20, 1, '${at}')`),
    ).toThrow(/already on an invoice/u)
  })

  it('[unit] leaves work no named invoice covers, and counts it either way', async () => {
    // Hours after the last invoice belong to the next generation, not to the
    // backfill, and a run that quietly swallowed them would bill a period twice.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 2_250_000)
    entry(database, '2026-07-10', 3_600, 25_000)
    entry(database, '2026-09-20', 7_200, 25_000)

    const rehearsal = await run(orm)
    expect(rehearsal).toMatchObject({ remainingEntryCount: 1, remainingSeconds: 7_200 })
    const applied = await run(orm, { apply: true })
    expect(applied).toMatchObject({ remainingEntryCount: 1, remainingSeconds: 7_200 })
  })

  it('[unit] refuses a run that names no invoice or no project', async () => {
    const { orm } = await fixture()
    await expect(run(orm, { invoiceIds: [] })).rejects.toThrow(/at least one invoice/u)
    await expect(run(orm, { projectIds: [] })).rejects.toThrow(/at least one project/u)
  })

  it('[unit] refuses a run naming an invoice that does not exist', async () => {
    // Silently skipping it would report less work than the operator approved.
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    await expect(run(orm, { invoiceIds: [10, 99] })).rejects.toThrow(/must exist/u)
  })

  it('[money] writes an audit row naming the run, the invoice and who did it', async () => {
    const { database, orm } = await fixture()
    invoice(database, 10, '2026-07-31', 2_250_000)
    invoice(database, 20, '2026-08-31', 2_250_000)
    const only = entry(database, '2026-07-10', 3_600, 25_000)
    await run(orm, { apply: true, recurringInvoiceId: null })
    expect(
      database
        .prepare(
          `SELECT run_id, time_entry_id, invoice_id, actor_user_id, claimed_at
           FROM time_entry_claim_backfills`,
        )
        .all(),
    ).toEqual([
      {
        run_id: 'backfill-1',
        time_entry_id: only,
        invoice_id: 10,
        actor_user_id: 1,
        claimed_at: at,
      },
    ])
    // Append-only, like every other record of a money write.
    expect(() =>
      database.exec(`UPDATE time_entry_claim_backfills SET invoice_id = 20`),
    ).toThrow(/append-only/u)
    expect(() => database.exec(`DELETE FROM time_entry_claim_backfills`)).toThrow(
      /append-only/u,
    )
  })
})
