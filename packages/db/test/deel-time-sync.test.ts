import BetterSqlite3 from 'better-sqlite3'
import { createDeelSyncRuntime } from '@ezacto/integrations'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import {
  createDeelSyncStore,
  DEEL_SYNC_STALE_RUN_MS,
  type DeelSyncStore,
} from '../src/deel-time-sync.js'
import { migrateContainer } from '../src/migrate.js'

/**
 * Issue 103. Against a real migrated database, because the guarantees are the
 * schema's: the primary key is what stops a second transfer record for an
 * entry, the triggers are what keep the log append-only, and the partial
 * unique index is what lets only one run hold the lock. Deel itself is a
 * recorded fixture; nothing here reaches it and no money moves.
 */

const at = '2026-10-19T03:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

// Migrating takes seconds on a busy machine, so it is done once and each test
// starts from a copy of the migrated, seeded image.
const seeded = (async (): Promise<Buffer> => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, currency, created_at, updated_at)
      VALUES ('Fixture', '{"approval":1}', 'USD', '${at}', '${at}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}'),
             (2, 'Ana', 'Vasquez', 'member', '[]', '${at}', '${at}'),
             (3, 'Byron', 'Ellis', 'member', '[]', '${at}', '${at}');
    INSERT INTO user_emails (user_id, address, verified_at, kind, created_at, updated_at)
      VALUES (2, 'ana.personal@example.test', '${at}', 'payroll', '${at}', '${at}'),
             (3, 'byron.personal@example.test', '${at}', 'payroll', '${at}', '${at}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${at}', '${at}');
    INSERT INTO projects (id, client_id, name, code, created_at, updated_at)
      VALUES (1, 1, 'Platform', 'PLT', '${at}', '${at}');
    INSERT INTO tasks (id, name, billable_by_default, is_default, is_active, created_at, updated_at)
      VALUES (1, 'Advisory', 1, 1, 1, '${at}', '${at}');
    INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, '${at}', '${at}'), (2, 1, 2, '${at}', '${at}'), (3, 1, 3, '${at}', '${at}');
    INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, '${at}', '${at}');
  `)
  const image = database.serialize()
  database.close()
  return image
})()

const fixture = async (): Promise<{
  database: BetterSqlite3.Database
  store: DeelSyncStore
}> => {
  const database = new BetterSqlite3(await seeded)
  nextEntry = 0
  pending.clear()
  sqlite = database
  return { database, store: createDeelSyncStore(createContainerDatabase(database)) }
}

let provider = 0
/** `userId` null sets the organization default. */
const choose = (
  database: BetterSqlite3.Database,
  userId: number | null,
  chosen: 'deel' | 'wise' | null,
): void => {
  provider += 1
  const scope = userId === null ? 'organization' : `user:${userId}`
  const version = (
    database
      .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM staff_payment_provider_events WHERE scope = ?`)
      .get(scope) as { v: number }
  ).v
  database
    .prepare(
      `INSERT INTO staff_payment_provider_events
        (id, user_id, scope, version, provider, command_json, actor_id, recorded_at, request_id)
       VALUES (?, ?, ?, ?, ?, '{}', 1, ?, ?)`,
    )
    .run(`choice-${provider}`, userId, scope, version, chosen, at, `request-${provider}`)
}

/** Entries that should end up approved, by id; see `approveAll`. */
const pending = new Set<number>()

let nextEntry = 0
const entry = (
  database: BetterSqlite3.Database,
  userId: number,
  spentDate: string,
  seconds: number,
  approval: 'unsubmitted' | 'approved' = 'approved',
): number => {
  nextEntry += 1
  database.exec(`
    INSERT INTO time_entries (id, user_id, project_id, task_id, user_assignment_id,
      task_assignment_id, spent_date, seconds, seconds_without_timer, rounded_seconds,
      billable, created_at, updated_at)
    VALUES (${nextEntry}, ${userId}, 1, 1, ${userId}, 1, '${spentDate}',
      ${seconds}, ${seconds}, ${seconds}, 1, '${at}', '${at}')`)
  if (approval === 'approved') pending.add(nextEntry)
  return nextEntry
}

/**
 * The schema only lets an entry join a submission that already covers it, and
 * only lets a submission exist for a week that has entries, so approval is
 * done the way the product does it: entries first, then one submission per
 * person-week, then approval of that submission.
 */
const approveAll = (database: BetterSqlite3.Database): void => {
  const rows = database
    .prepare(`SELECT id, user_id, spent_date FROM time_entries WHERE id IN (${[...pending].join(',') || 'NULL'})`)
    .all() as { id: number; user_id: number; spent_date: string }[]
  const weeks = new Map<string, { userId: number; start: string; end: string; ids: number[] }>()
  for (const row of rows) {
    const day = new Date(`${row.spent_date}T00:00:00Z`)
    day.setUTCDate(day.getUTCDate() - day.getUTCDay())
    const start = day.toISOString().slice(0, 10)
    day.setUTCDate(day.getUTCDate() + 6)
    const key = `${row.user_id}:${start}`
    const week = weeks.get(key) ?? { userId: row.user_id, start, end: day.toISOString().slice(0, 10), ids: [] }
    week.ids.push(row.id)
    weeks.set(key, week)
  }
  for (const week of weeks.values()) {
    const id = Number(
      database
        .prepare(
          `INSERT INTO timesheet_submissions (user_id, period_start, period_end, status,
             submitted_by_user_id, submitted_at, version, created_at, updated_at)
           VALUES (?, ?, ?, 'submitted', ?, ?, 0, ?, ?)`,
        )
        .run(week.userId, week.start, week.end, week.userId, at, at, at).lastInsertRowid,
    )
    database.exec(`UPDATE time_entries SET approval_status = 'submitted', timesheet_submission_id = ${id}
      WHERE id IN (${week.ids.join(',')})`)
    database.exec(`UPDATE timesheet_submissions SET status = 'approved', version = 1,
      reviewed_by_user_id = 1, reviewed_at = '${at}' WHERE id = ${id}`)
    database.exec(`UPDATE time_entries SET approval_status = 'approved' WHERE id IN (${week.ids.join(',')})`)
  }
  pending.clear()
}

const window = { from: '2026-09-01', to: '2026-10-18' }

describe('Deel sync store: whose time is eligible', () => {
  it('reads only approved, finished time of people whose provider is Deel', async () => {
    const { database, store } = await fixture()
    choose(database, 2, 'deel')
    const wanted = entry(database, 2, '2026-09-02', 3_600)
    entry(database, 2, '2026-09-16', 3_600, 'unsubmitted')
    entry(database, 2, '2026-08-31', 3_600)
    entry(database, 2, '2026-10-19', 3_600)
    entry(database, 3, '2026-09-02', 3_600)
    approveAll(database)
    expect(await store.entries(window)).toEqual([
      { id: wanted, userId: 2, spentDate: '2026-09-02', roundedSeconds: 3_600 },
    ])
    expect(await store.directory()).toEqual([
      { userId: 2, emails: [{ address: 'ana.personal@example.test', kind: 'payroll' }] },
    ])
  })

  it('follows the organization default, which a person may override either way', async () => {
    const { database, store } = await fixture()
    // Wise is the default with nothing recorded.
    expect(await store.directory()).toEqual([])

    choose(database, null, 'deel')
    choose(database, 3, 'wise')
    expect((await store.directory()).map((person) => person.userId)).toEqual([1, 2])

    // Back to inheriting: the latest event for the person is "no preference".
    choose(database, 3, null)
    expect((await store.directory()).map((person) => person.userId)).toEqual([1, 2, 3])
  })
})

describe('Deel sync store: the transfer log', () => {
  it('refuses a second record for one entry and never rewrites a first', async () => {
    const { database, store } = await fixture()
    const id = entry(database, 2, '2026-09-02', 3_600)
    approveAll(database)
    await store.record({ entryId: id, fingerprint: 'con:2026-09-02:3600', timesheetId: 'tms_1' }, at)

    await expect(
      store.record({ entryId: id, fingerprint: 'con:2026-09-02:3600', timesheetId: 'tms_2' }, at),
    ).rejects.toThrow()
    expect(() =>
      database.exec(`UPDATE deel_transfer_log SET timesheet_id = 'tms_9'`),
    ).toThrow(/immutable/)
    expect(() => database.exec(`DELETE FROM deel_transfer_log`)).toThrow(/immutable/)
    expect(
      database.prepare(`SELECT timesheet_id FROM deel_transfer_log`).all(),
    ).toEqual([{ timesheet_id: 'tms_1' }])
  })

  it('reads a log row whose entry no longer exists as one with no current entry', async () => {
    // The log has no foreign key to time entries, so a row can outlive its
    // entry (an approved entry cannot be deleted, but an import or a restore
    // can still leave one behind). It must still be reported, not dropped.
    const { store } = await fixture()
    await store.record({ entryId: 777, fingerprint: 'con:2026-09-02:3600', timesheetId: 'tms_1' }, at)

    expect(await store.logged()).toEqual([
      { entryId: 777, fingerprint: 'con:2026-09-02:3600', timesheetId: 'tms_1', current: null },
    ])
  })
})

describe('Deel sync store: the run lock', () => {
  it('allows one running run, releases on finish, and abandons a stale one', async () => {
    const { store } = await fixture()
    const first = await store.beginRun(at)
    expect(first).not.toBeNull()
    expect(await store.beginRun('2026-10-19T03:00:05.000Z')).toBeNull()

    await store.finishRun(
      first as number,
      'completed',
      { timesheetsSubmitted: 1, entriesTransferred: 2, detail: { ok: true } },
      '2026-10-19T03:01:00.000Z',
    )
    const second = await store.beginRun('2026-10-19T04:00:00.000Z')
    expect(second).not.toBeNull()

    // Never finished, and an hour later: taken to have died, and said so.
    const later = new Date(Date.parse('2026-10-19T04:00:00.000Z') + DEEL_SYNC_STALE_RUN_MS + 1_000)
    const third = await store.beginRun(later.toISOString())
    expect(third).not.toBeNull()

    const runs = await store.recentRuns(5)
    expect(runs.map((run) => run.outcome)).toEqual(['running', 'failed', 'completed'])
    expect(JSON.stringify(runs[1]?.detail)).toMatch(/abandoned/)
    expect(runs[2]).toMatchObject({ timesheetsSubmitted: 1, entriesTransferred: 2 })
  })
})

describe('Deel sync runtime over the real store', () => {
  const people = {
    data: [
      {
        id: 'per_ana',
        full_name: 'Ana Vasquez',
        emails: [{ type: 'primary', value: 'Ana.Personal@example.test' }],
        employments: [{ id: 'con_ana_hourly', contract_status: 'in_progress' }],
      },
    ],
  }

  it('[unit] sends the same approved hours to Deel once across repeated runs', async () => {
    const { database, store } = await fixture()
    choose(database, 2, 'deel')
    entry(database, 2, '2026-09-02', 3_600)
    entry(database, 2, '2026-09-02', 1_800)
    entry(database, 3, '2026-09-02', 3_600)
    approveAll(database)
    const posts: unknown[] = []
    let created = 0
    const runtime = createDeelSyncRuntime({
      config: { token: 'fixture-token', startDate: '2026-09-01' },
      source: store,
      fetch: async (request) => {
        if (request.method === 'GET') return Response.json(people)
        posts.push(JSON.parse(await request.text()))
        created += 1
        return Response.json({ data: { id: `tms_${created}` } })
      },
      now: () => new Date(at),
    })

    expect(await runtime.run()).toMatchObject({
      status: 'completed',
      timesheetsSubmitted: 1,
      entriesTransferred: 2,
    })
    expect(await runtime.run()).toMatchObject({ status: 'completed', timesheetsSubmitted: 0 })

    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ data: { contract_id: 'con_ana_hourly', quantity: 1.5 } })
    expect(database.prepare(`SELECT entry_id, timesheet_id FROM deel_transfer_log ORDER BY 1`).all()).toEqual([
      { entry_id: 1, timesheet_id: 'tms_1' },
      { entry_id: 2, timesheet_id: 'tms_1' },
    ])
    const [latest, earliest] = await store.recentRuns(2)
    expect(latest?.outcome).toBe('completed')
    expect(earliest).toMatchObject({ timesheetsSubmitted: 1, entriesTransferred: 2 })
  })

  it('reconciles an entry that changed after it was sent', async () => {
    const { database, store } = await fixture()
    choose(database, 2, 'deel')
    const id = entry(database, 2, '2026-09-02', 3_600)
    approveAll(database)
    const runtime = createDeelSyncRuntime({
      config: { token: 'fixture-token', startDate: '2026-09-01' },
      source: store,
      fetch: async (request) =>
        request.method === 'GET' ? Response.json(people) : Response.json({ data: { id: 'tms_1' } }),
      now: () => new Date(at),
    })
    await runtime.run()

    database.exec(`UPDATE time_entries SET rounded_seconds = 5400 WHERE id = ${id}`)
    const report = await runtime.reconcile()

    expect(report).toMatchObject({ confirmed: 0, edited: [{ entryId: id, timesheetId: 'tms_1' }] })
  })

  it('does nothing without configuration: no request, no run, no log', async () => {
    const { database, store } = await fixture()
    choose(database, 2, 'deel')
    entry(database, 2, '2026-09-02', 3_600)
    approveAll(database)
    let requests = 0
    const runtime = createDeelSyncRuntime({
      config: { startDate: '2026-09-01' },
      source: store,
      fetch: async () => {
        requests += 1
        return new Response('{}', { status: 500 })
      },
      now: () => new Date(at),
    })

    expect(await runtime.run()).toMatchObject({ status: 'unconfigured' })
    expect(requests).toBe(0)
    expect(await store.recentRuns(5)).toEqual([])
    expect(database.prepare(`SELECT count(*) AS n FROM deel_transfer_log`).get()).toEqual({ n: 0 })
  })
})
