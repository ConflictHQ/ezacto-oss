import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { backfillCostRates } from '../src/cost-rate-backfill.js'
import { migrateContainer } from '../src/migrate.js'

/**
 * Issue 750. A cost rate added to a person does not reach backwards, so years
 * of tracked hours stay unpriced and every figure derived from cost answers
 * nothing for them. The backfill stamps a rate the operator supplies, over a
 * range the operator names, through the audited reprice record.
 */
const at = '2026-10-18T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

let nextEntry = 0
const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, currency, created_at, updated_at)
      VALUES ('Fixture', '{}', 'USD', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Ada', 'Lovelace', 'administrator', '[]', '${at}', '${at}'),
             (2, 'Grace', 'Hopper', 'member', '[]', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
      VALUES (1, 1, 'Platform', 'PLT', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}'), (2, 1, 2, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
  `)
  sqlite = database
  nextEntry = 0
  return { database, orm: createContainerDatabase(database) as never }
}

const entry = (
  database: BetterSqlite3.Database,
  spentDate: string,
  seconds: number,
  costRateCents: number | null,
  userId = 1,
): number => {
  nextEntry += 1
  database.exec(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
                              task_assignment_id, spent_date, seconds, seconds_without_timer,
                              rounded_seconds, billable, billable_rate_cents, cost_rate_cents,
                              created_at, updated_at)
    VALUES (${nextEntry}, ${userId}, 1, 1, ${userId}, 1, '${spentDate}',
      ${seconds}, ${seconds}, ${seconds}, 1, 20000,
      ${costRateCents === null ? 'NULL' : costRateCents}, '${at}', '${at}')`)
  return nextEntry
}

const run = (orm: never, extra: Record<string, unknown> = {}) =>
  backfillCostRates(orm, {
    userId: 1,
    from: '2019-01-01',
    to: '2026-12-31',
    costRateCents: 9_000,
    reason: 'Opening cost rate for history before the rate existed',
    actorUserId: 2,
    runId: 'cost-1',
    occurredAt: at,
    ...extra,
  } as never)

const stamped = (database: BetterSqlite3.Database) =>
  database.prepare(`SELECT id, cost_rate_cents AS c FROM time_entries ORDER BY id`).all()

describe('pricing the cost of hours tracked before a cost rate existed', () => {
  it('[money] reports per month what it would stamp and writes nothing', async () => {
    const { database, orm } = await fixture()
    entry(database, '2025-01-10', 3_600, null)
    entry(database, '2025-01-20', 1_800, null)
    entry(database, '2025-03-05', 7_200, null)

    const report = await run(orm)
    expect(report.applied).toBe(false)
    expect(report.periods).toEqual([
      { month: '2025-01', entryCount: 2, seconds: 5_400, costCents: 13_500 },
      { month: '2025-03', entryCount: 1, seconds: 7_200, costCents: 18_000 },
    ])
    expect([report.entryCount, report.seconds, report.costCents]).toEqual([3, 12_600, 31_500])
    expect(stamped(database)).toEqual([
      { id: 1, c: null },
      { id: 2, c: null },
      { id: 3, c: null },
    ])
    expect(database.prepare(`SELECT count(*) AS n FROM time_entry_rate_reprices`).get()).toEqual({
      n: 0,
    })
  })

  it('[money] records every change as a reprice naming the actor and the run', async () => {
    const { database, orm } = await fixture()
    const first = entry(database, '2025-01-10', 3_600, null)

    const report = await run(orm, { apply: true })
    expect(report.applied).toBe(true)
    expect(stamped(database)).toEqual([{ id: first, c: 9_000 }])
    expect(database.prepare(`SELECT * FROM time_entry_rate_reprices`).all()).toEqual([
      {
        id: 1,
        time_entry_id: first,
        previous_billable_rate_cents: 20_000,
        billable_rate_cents: 20_000,
        previous_cost_rate_cents: null,
        cost_rate_cents: 9_000,
        reason: 'Opening cost rate for history before the rate existed',
        repriced_at: at,
        run_id: 'cost-1',
        actor_user_id: 2,
      },
    ])
  })

  it('[unit] stamps nothing the second time', async () => {
    const { database, orm } = await fixture()
    entry(database, '2025-01-10', 3_600, null)

    await run(orm, { apply: true })
    const again = await run(orm, { apply: true, runId: 'cost-2' })
    expect(again.entryCount).toBe(0)
    expect(again.capturedEntryCount).toBe(1)
    expect(database.prepare(`SELECT count(*) AS n FROM time_entry_rate_reprices`).get()).toEqual({
      n: 1,
    })
  })

  it('[unit] leaves an entry that already carries a cost rate alone by default', async () => {
    const { database, orm } = await fixture()
    entry(database, '2025-01-10', 3_600, 12_000)
    entry(database, '2025-01-11', 3_600, null)

    const report = await run(orm, { apply: true })
    expect(report.entryCount).toBe(1)
    expect(report.capturedEntryCount).toBe(1)
    expect(stamped(database)).toEqual([
      { id: 1, c: 12_000 },
      { id: 2, c: 9_000 },
    ])
  })

  it('[money] restamps a captured rate only when asked, and never one already at the rate', async () => {
    const { database, orm } = await fixture()
    entry(database, '2025-01-10', 3_600, 12_000)
    entry(database, '2025-01-11', 3_600, 9_000)

    const report = await run(orm, { apply: true, replaceCaptured: true })
    expect(report.entryCount).toBe(1)
    expect(stamped(database)).toEqual([
      { id: 1, c: 9_000 },
      { id: 2, c: 9_000 },
    ])
    expect(
      database
        .prepare(`SELECT previous_cost_rate_cents AS p FROM time_entry_rate_reprices`)
        .all(),
    ).toEqual([{ p: 12_000 }])
  })

  it('[unit] stays inside the named person, the named range and stopped entries', async () => {
    const { database, orm } = await fixture()
    entry(database, '2025-01-10', 3_600, null)
    entry(database, '2024-12-31', 3_600, null)
    entry(database, '2025-01-10', 3_600, null, 2)
    database.exec(`
      INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
        task_assignment_id, spent_date, seconds, seconds_without_timer, rounded_seconds,
        billable, timer_started_at, created_at, updated_at)
      VALUES (99, 1, 1, 1, 1, 1, '2025-01-12', 0, 0, 0, 1, '${at}', '${at}', '${at}')`)

    const report = await run(orm, { apply: true, from: '2025-01-01', to: '2025-01-31' })
    expect(report.entryCount).toBe(1)
    expect(report.runningEntryCount).toBe(1)
    expect(
      database.prepare(`SELECT id FROM time_entries WHERE cost_rate_cents IS NOT NULL`).all(),
    ).toEqual([{ id: 1 }])
  })

  it('[unit] refuses an unbounded or invented scope', async () => {
    const { orm } = await fixture()
    await expect(run(orm, { from: '2026-02-30' })).rejects.toThrow(/from must be a real/)
    await expect(run(orm, { from: '2026-02-01', to: '2026-01-01' })).rejects.toThrow(/after/)
    await expect(run(orm, { costRateCents: -1 })).rejects.toThrow(/cost rate/)
    await expect(run(orm, { costRateCents: 1.5 })).rejects.toThrow(/cost rate/)
    await expect(run(orm, { reason: '  ' })).rejects.toThrow(/reason/)
    await expect(run(orm, { userId: 77 })).rejects.toThrow(/must exist/)
  })
})
