import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer, migrateContainerThrough } from '@ezacto/db'
import { applyCsvImport, dryRunCsvImport, planCsvImport } from '../src/csv-import.js'
import { createContainerDatabase } from '@ezacto/db'
import { parseMapping } from '../src/csv-mapping.js'
import { runCsvImport } from '../src/csv-run.js'

const HEADER = 'date,person_email,client,project,task,hours,notes,billable'
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const file = (...rows: string[]): Uint8Array => encode([HEADER, ...rows].join('\n') + '\n')
const t0 = '2026-09-02T12:00:00.000Z'

const open: BetterSqlite3.Database[] = []
const folders: string[] = []
afterEach(async () => {
  while (open.length > 0) open.pop()!.close()
  while (folders.length > 0) await rm(folders.pop()!, { recursive: true, force: true })
})

/**
 * A migrated instance: Olivia (owner, administrator) and Ann (a member), one
 * client with one project and one task, and Ann assigned to it.
 */
const seed = (
  options: { mode?: 'duration' | 'start_end'; path?: string; through?: string } = {},
) => {
  const sqlite = new BetterSqlite3(options.path ?? ':memory:')
  open.push(sqlite)
  if (options.through === undefined) migrateContainer(sqlite)
  else migrateContainerThrough(sqlite, options.through as never)
  const run = (query: string, ...params: unknown[]) => sqlite.prepare(query).run(...params)
  run(
    `INSERT INTO organizations (name, currency, modules, time_entry_mode, created_at, updated_at)
     VALUES ('Fictional Studio', 'USD', ?, ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
    options.mode ?? 'duration',
    t0,
    t0,
  )
  run(
    `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
     VALUES (1, 'Olivia', 'Owner', 'administrator', '[]', ?, ?), (2, 'Ann', 'Member', 'member', '[]', ?, ?)`,
    t0,
    t0,
    t0,
    t0,
  )
  run(
    `INSERT INTO user_emails (user_id, address, verified_at, is_primary, created_at, updated_at)
     VALUES (1, 'olivia@here.example', ?, 1, ?, ?), (2, 'ann@here.example', ?, 1, ?, ?)`,
    t0,
    t0,
    t0,
    t0,
    t0,
    t0,
  )
  run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Acme', 'USD', ?, ?)`,
    t0,
    t0,
  )
  run(
    `INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Website', ?, ?)`,
    t0,
    t0,
  )
  run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Dev', ?, ?)`, t0, t0)
  run(
    `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 2, ?, ?)`,
    t0,
    t0,
  )
  run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  return sqlite
}

const all = <T = Record<string, unknown>>(sqlite: BetterSqlite3.Database, query: string): T[] =>
  sqlite.prepare(query).all() as T[]
const count = (sqlite: BetterSqlite3.Database, table: string): number =>
  (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

/** Every table's rows, so "changed nothing" is a comparison and not a hope. */
const dump = (sqlite: BetterSqlite3.Database): string => {
  const tables = all<{ name: string }>(
    sqlite,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )
  return JSON.stringify(
    tables.map(({ name }) => [name, all(sqlite, `SELECT * FROM "${name}" ORDER BY 1`)]),
  )
}

const ann = (date: string, hours: string, extra = '') =>
  `${date},ann@here.example,Acme,Website,Dev,${hours},${extra || ''},`

describe('CSV import dry run', () => {
  it('[container] reports new, matched and rejected people, clients, projects and tasks, and writes nothing', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'csv-import-'))
    folders.push(folder)
    const path = join(folder, 'instance.db')
    const sqlite = seed({ path })
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
    const before = {
      dump: dump(sqlite),
      bytes: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    }

    const mapping = parseMapping(
      JSON.stringify({
        people: { 'bo@old.example': { create: { firstName: 'Bo', lastName: 'Lee' } } },
      }),
    )
    const report = await dryRunCsvImport(
      sqlite,
      file(
        ann('2026-09-01', '1.5'),
        ann('2026-09-02', '2'),
        'x,ann@here.example,Acme,Website,Dev,1,,',
        '2026-09-03,bo@old.example,Globex,Launch,Design,3,,',
        '2026-09-03,cy@old.example,Acme,Website,Dev,1,,',
        '2026-09-03,ann@here.example,Acme,Website,Dev,1,,',
      ),
      { sourceId: 'demo', mapping },
    )

    expect(report.fileErrors).toEqual([])
    expect(report.entries).toEqual({ total: 6, new: 4, alreadyImported: 0, rejected: 2 })
    expect(report.people).toEqual({ matched: 1, new: 1, rejected: 1 })
    expect(report.clients).toEqual({ matched: 1, new: 1, rejected: 0 })
    expect(report.projects).toEqual({ matched: 1, new: 1, rejected: 0 })
    expect(report.tasks).toEqual({ matched: 1, new: 1, rejected: 0 })
    expect(report.assignments).toEqual({ userProject: 1, projectTask: 1 })
    expect(report.rejected.map(({ line, category, code }) => [line, category, code])).toEqual([
      [4, 'invalid', 'invalid_date'],
      [6, 'unsupported', 'person_unmapped'],
    ])

    expect(dump(sqlite)).toBe(before.dump)
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
    expect(
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    ).toBe(before.bytes)
  })

  it('[container] lists unsupported rows with their line numbers', async () => {
    const sqlite = seed()
    sqlite
      .prepare(
        `INSERT INTO timesheet_lock_windows
           (kind, period_start, period_end, locked_by_user_id, locked_at, lock_reason, command_id, input_fingerprint, created_at, updated_at)
         VALUES ('manual_cutoff', NULL, '2026-08-31', 1, ?, 'Closed', 'lock-1', ?, ?, ?)`,
      )
      .run(t0, `sha256:${'a'.repeat(64)}`, t0, t0)
    sqlite
      .prepare(
        `INSERT INTO time_entries
           (user_id, project_id, task_id, user_assignment_id, task_assignment_id, spent_date,
            seconds, seconds_without_timer, rounded_seconds, billable, created_at, updated_at)
         VALUES (2, 1, 1, 1, 1, '2026-09-09', 3600, 3600, 3600, 1, ?, ?)`,
      )
      .run(t0, t0)
    sqlite
      .prepare(
        `INSERT INTO timesheet_submissions
           (user_id, period_start, period_end, status, submitted_by_user_id, submitted_at, version, created_at, updated_at)
         VALUES (2, '2026-09-07', '2026-09-13', 'submitted', 2, ?, 0, ?, ?)`,
      )
      .run(t0, t0, t0)
    sqlite
      .prepare(
        `UPDATE timesheet_submissions
         SET status = 'approved', reviewed_by_user_id = 1, reviewed_at = ?, version = 1, updated_at = ?`,
      )
      .run(t0, t0)
    sqlite
      .prepare(
        `INSERT INTO projects (id, client_id, name, is_active, created_at, updated_at) VALUES (2, 1, 'Old', 0, ?, ?)`,
      )
      .run(t0, t0)

    const report = await dryRunCsvImport(
      sqlite,
      file(
        ann('2026-08-15', '1'),
        ann('2026-09-08', '1'),
        '2026-09-01,ann@here.example,Acme,Old,Dev,1,,',
        '2026-09-01,ann@here.example,Acme,Website,Dev,1,,',
      ),
      { sourceId: 'demo' },
    )
    expect(report.rejected.map(({ line, code }) => [line, code])).toEqual([
      [2, 'period_locked'],
      [3, 'period_approved'],
      [4, 'project_archived'],
    ])
    expect(report.entries).toMatchObject({ new: 1, rejected: 3 })
  })

  it('[container] refuses hours-only rows in an organization that records start and end times', async () => {
    const sqlite = seed({ mode: 'start_end' })
    const report = await dryRunCsvImport(sqlite, file(ann('2026-09-01', '1')), { sourceId: 'demo' })
    expect(report.rejected.map(({ code }) => code)).toEqual(['hours_not_accepted'])
  })

  it('[container] reports a file that cannot be read as file errors only', async () => {
    const sqlite = seed()
    const report = await dryRunCsvImport(sqlite, Uint8Array.from([0xff, 0xfe]), {
      sourceId: 'demo',
    })
    expect(report.fileErrors.map(({ code }) => code)).toEqual(['not_utf8'])
    expect(report.entries.new).toBe(0)
  })

  it('[container] reads a database that predates the import ledger', async () => {
    const sqlite = seed({ through: '0117_calendar_proposals' })
    const before = dump(sqlite)
    const report = await dryRunCsvImport(sqlite, file(ann('2026-09-01', '1')), { sourceId: 'demo' })
    expect(report.entries).toMatchObject({ new: 1, alreadyImported: 0 })
    expect(dump(sqlite)).toBe(before)
  })

  it('[container] warns where a rate, a currency or a billable flag would not be applied', async () => {
    const sqlite = seed()
    const report = await dryRunCsvImport(
      sqlite,
      encode(
        `${HEADER},rate,currency\n2026-09-01,ann@here.example,Acme,Website,Dev,1,,false,150,EUR\n`,
      ),
      { sourceId: 'demo' },
    )
    expect(report.warnings.map(({ code }) => code).sort()).toEqual([
      'billable_not_applied',
      'currency_differs',
      'rate_not_applied',
    ])
  })
})

describe('CSV import apply', () => {
  const rows = [
    ann('2026-09-01', '1.5', 'one'),
    ann('2026-09-02', '2', 'two'),
    ann('2026-09-03', '0.5', 'three'),
  ]

  it('[container] writes the time through the ordinary path and records a source key per entry', async () => {
    const sqlite = seed()
    const result = await applyCsvImport(sqlite, file(...rows), { sourceId: 'demo' })
    expect(result).toMatchObject({ status: 'complete', created: 3, rejected: 0 })
    expect(
      all(
        sqlite,
        `SELECT user_id, project_id, task_id, spent_date, seconds, billable, notes, approval_status FROM time_entries ORDER BY spent_date`,
      ),
    ).toEqual([
      {
        user_id: 2,
        project_id: 1,
        task_id: 1,
        spent_date: '2026-09-01',
        seconds: 5400,
        billable: 1,
        notes: 'one',
        approval_status: 'unsubmitted',
      },
      {
        user_id: 2,
        project_id: 1,
        task_id: 1,
        spent_date: '2026-09-02',
        seconds: 7200,
        billable: 1,
        notes: 'two',
        approval_status: 'unsubmitted',
      },
      {
        user_id: 2,
        project_id: 1,
        task_id: 1,
        spent_date: '2026-09-03',
        seconds: 1800,
        billable: 1,
        notes: 'three',
        approval_status: 'unsubmitted',
      },
    ])
    expect(count(sqlite, 'csv_import_entries')).toBe(3)
    expect(all(sqlite, `SELECT status, total_rows FROM csv_import_runs`)).toEqual([
      { status: 'complete', total_rows: 3 },
    ])
    // The importer writes time, never money.
    for (const table of ['invoices', 'invoice_line_items', 'expenses', 'invoice_payments']) {
      expect(count(sqlite, table)).toBe(0)
    }
  })

  it('[container] applying the same file again adds nothing and edits nothing', async () => {
    const sqlite = seed()
    await applyCsvImport(sqlite, file(...rows), { sourceId: 'demo' })
    const entries = dump(sqlite)
    const again = await applyCsvImport(sqlite, file(...rows), { sourceId: 'demo' })
    expect(again).toMatchObject({ status: 'complete', created: 0, alreadyImported: 3 })
    const entriesAfter = all(sqlite, `SELECT * FROM time_entries`)
    expect(entriesAfter).toEqual(
      JSON.parse(entries).find(([name]: [string]) => name === 'time_entries')[1],
    )
    expect(count(sqlite, 'time_entries')).toBe(3)
    expect(count(sqlite, 'csv_import_runs')).toBe(1)
    expect(count(sqlite, 'csv_import_entries')).toBe(3)
  })

  it('[container] keeps genuinely identical rows as separate entries, once each', async () => {
    const sqlite = seed()
    const twin = ann('2026-09-01', '1', 'standup')
    await applyCsvImport(sqlite, file(twin, twin), { sourceId: 'demo' })
    await applyCsvImport(sqlite, file(twin, twin), { sourceId: 'demo' })
    expect(count(sqlite, 'time_entries')).toBe(2)
  })

  it('[container] an updated export of the same source adds only the rows it did not have', async () => {
    const sqlite = seed()
    await applyCsvImport(sqlite, file(...rows.slice(0, 2)), { sourceId: 'demo' })
    const result = await applyCsvImport(sqlite, file(...rows), { sourceId: 'demo' })
    expect(result).toMatchObject({ status: 'complete', created: 1, alreadyImported: 2 })
    expect(count(sqlite, 'time_entries')).toBe(3)
    expect(count(sqlite, 'csv_import_runs')).toBe(2)
    // Another source id is another source, even for the same rows.
    await applyCsvImport(sqlite, file(...rows), { sourceId: 'other' })
    expect(count(sqlite, 'time_entries')).toBe(6)
  })

  it('[container] does not bring back an entry that was deleted after it was imported', async () => {
    const sqlite = seed()
    await applyCsvImport(sqlite, file(...rows), { sourceId: 'demo' })
    sqlite.prepare(`DELETE FROM time_entries WHERE spent_date = '2026-09-02'`).run()
    expect(
      all(sqlite, `SELECT 1 FROM csv_import_entries WHERE time_entry_id IS NULL`),
    ).toHaveLength(1)
    await applyCsvImport(sqlite, file(...rows), { sourceId: 'demo' })
    expect(count(sqlite, 'time_entries')).toBe(2)
  })

  it('[container] creates the clients, projects, tasks and assignments the file needs, and people only by mapping', async () => {
    const sqlite = seed()
    const mapping = parseMapping(
      JSON.stringify({
        people: { 'bo@old.example': { create: { firstName: 'Bo', lastName: 'Lee' } } },
      }),
    )
    const result = await applyCsvImport(
      sqlite,
      file('2026-09-03,bo@old.example,Globex,Launch,Design,3,,no'),
      { sourceId: 'demo', mapping },
    )
    expect(result.status).toBe('complete')
    expect(all(sqlite, `SELECT name, currency FROM clients WHERE id > 1`)).toEqual([
      { name: 'Globex', currency: 'USD' },
    ])
    expect(all(sqlite, `SELECT name FROM projects WHERE id > 1`)).toEqual([{ name: 'Launch' }])
    expect(all(sqlite, `SELECT name FROM tasks WHERE id > 1`)).toEqual([{ name: 'Design' }])
    // A person made by import is switched off: nobody gains access by being imported.
    expect(
      all(
        sqlite,
        `SELECT u.first_name, u.is_active, e.address FROM users u JOIN user_emails e ON e.user_id = u.id WHERE u.id > 2`,
      ),
    ).toEqual([{ first_name: 'Bo', is_active: 0, address: 'bo@old.example' }])
    expect(all(sqlite, `SELECT billable FROM time_entries`)).toEqual([{ billable: 0 }])
    expect(count(sqlite, 'user_assignments')).toBe(2)
    expect(count(sqlite, 'task_assignments')).toBe(2)

    // Running it again finds all of that by name and creates none of it twice.
    await applyCsvImport(sqlite, file('2026-09-03,bo@old.example,Globex,Launch,Design,3,,no'), {
      sourceId: 'demo',
    })
    expect(count(sqlite, 'clients')).toBe(2)
    expect(count(sqlite, 'users')).toBe(3)
    expect(count(sqlite, 'time_entries')).toBe(1)
  })

  it('[container] applies a mapping of people, clients, projects and tasks', async () => {
    const sqlite = seed()
    const mapping = parseMapping(
      JSON.stringify({
        people: { 'ann@old.example': 'ann@here.example' },
        clients: { 'Acme Inc': 'acme' },
        projects: { 'Acme Inc': { Web: 'website' } },
        tasks: { Development: 'Dev' },
      }),
    )
    const result = await applyCsvImport(
      sqlite,
      file('2026-09-01,ann@old.example,Acme Inc,Web,Development,1,,'),
      { sourceId: 'demo', mapping },
    )
    expect(result).toMatchObject({ status: 'complete', created: 1 })
    expect(count(sqlite, 'clients')).toBe(1)
    expect(all(sqlite, `SELECT user_id, project_id, task_id FROM time_entries`)).toEqual([
      { user_id: 2, project_id: 1, task_id: 1 },
    ])
  })

  it('[container] keeps the mapping a run began with, and refuses a different one on retry', async () => {
    const sqlite = seed()
    const first = parseMapping(
      JSON.stringify({ people: { 'ann@old.example': 'ann@here.example' } }),
    )
    const data = file('2026-09-01,ann@old.example,Acme,Website,Dev,1,,')
    expect(await applyCsvImport(sqlite, data, { sourceId: 'demo', mapping: first })).toMatchObject({
      status: 'complete',
    })
    const stored = all<{ mapping_json: string }>(
      sqlite,
      `SELECT mapping_json FROM csv_import_runs`,
    )[0]!
    expect(JSON.parse(stored.mapping_json).people).toEqual({
      'ann@old.example': 'ann@here.example',
    })

    const other = parseMapping(
      JSON.stringify({ people: { 'ann@old.example': 'olivia@here.example' } }),
    )
    const refused = await applyCsvImport(sqlite, data, { sourceId: 'demo', mapping: other })
    expect(refused.status).toBe('refused')
    expect(refused.reason).toMatch(/different mapping/)
    // With no mapping given, the retry uses the stored one rather than none.
    expect(await applyCsvImport(sqlite, data, { sourceId: 'demo' })).toMatchObject({
      status: 'complete',
      created: 0,
    })
    expect(count(sqlite, 'time_entries')).toBe(1)
  })

  it('[container] leaves a resumable checkpoint when a row fails, and finishes only the remainder', async () => {
    const sqlite = seed()
    sqlite.exec(`CREATE TRIGGER fail_on_marker BEFORE INSERT ON time_entries
      WHEN NEW.notes = 'boom' BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`)
    const data = file(
      ann('2026-09-01', '1', 'ok-1'),
      ann('2026-09-02', '1', 'boom'),
      ann('2026-09-03', '1', 'ok-3'),
    )
    const partial = await applyCsvImport(sqlite, data, { sourceId: 'demo' })
    expect(partial.status).toBe('partial')
    expect(partial.error).toMatch(/disk on fire/)
    expect(partial.created).toBe(1)
    expect(all(sqlite, `SELECT status, last_error FROM csv_import_runs`)).toEqual([
      { status: 'partial', last_error: expect.stringContaining('disk on fire') },
    ])
    expect(count(sqlite, 'csv_import_entries')).toBe(1)

    sqlite.exec('DROP TRIGGER fail_on_marker')
    const resumed = await applyCsvImport(sqlite, data, { sourceId: 'demo' })
    expect(resumed).toMatchObject({ status: 'complete', created: 2, alreadyImported: 1 })
    expect(count(sqlite, 'time_entries')).toBe(3)
    expect(count(sqlite, 'csv_import_runs')).toBe(1)
  })

  it('[container] aborting stops further rows, rolls nothing back, and a rerun finishes the rest', async () => {
    const sqlite = seed()
    const many = Array.from({ length: 8 }, (_, day) =>
      ann(`2026-09-${String(day + 1).padStart(2, '0')}`, '1', `d${day}`),
    )
    const controller = new AbortController()
    let calls = 0
    const aborted = await applyCsvImport(sqlite, file(...many), {
      sourceId: 'demo',
      signal: controller.signal,
      now: () => {
        calls += 1
        if (calls === 6) controller.abort()
        return new Date(t0)
      },
    })
    expect(aborted.status).toBe('aborted')
    expect(aborted.created).toBeGreaterThan(0)
    expect(aborted.created).toBeLessThan(8)
    expect(count(sqlite, 'time_entries')).toBe(aborted.created)

    const resumed = await applyCsvImport(sqlite, file(...many), { sourceId: 'demo' })
    expect(resumed).toMatchObject({ status: 'complete', created: 8 - aborted.created })
    expect(count(sqlite, 'time_entries')).toBe(8)
  })

  it('[container] refuses a file with rejected rows unless told to skip them, and never writes a locked period', async () => {
    const sqlite = seed()
    sqlite
      .prepare(
        `INSERT INTO timesheet_lock_windows
           (kind, period_start, period_end, locked_by_user_id, locked_at, lock_reason, command_id, input_fingerprint, created_at, updated_at)
         VALUES ('manual_cutoff', NULL, '2026-08-31', 1, ?, 'Closed', 'lock-1', ?, ?, ?)`,
      )
      .run(t0, `sha256:${'b'.repeat(64)}`, t0, t0)
    const data = file(ann('2026-08-20', '1'), ann('2026-09-01', '1'))

    const refused = await applyCsvImport(sqlite, data, { sourceId: 'demo' })
    expect(refused.status).toBe('refused')
    expect(refused.report.rejected.map(({ code }) => code)).toEqual(['period_locked'])
    expect(count(sqlite, 'time_entries')).toBe(0)
    expect(count(sqlite, 'csv_import_runs')).toBe(0)

    const skipped = await applyCsvImport(sqlite, data, { sourceId: 'demo', skipRejected: true })
    expect(skipped).toMatchObject({ status: 'complete', created: 1, rejected: 1 })
    expect(all(sqlite, `SELECT spent_date FROM time_entries`)).toEqual([
      { spent_date: '2026-09-01' },
    ])

    // Once the period is unlocked, the same file brings the row in.
    sqlite
      .prepare(
        `UPDATE timesheet_lock_windows SET unlocked_at = ?, unlocked_by_user_id = 1, unlock_reason = 'reopen', version = 1`,
      )
      .run(t0)
    expect(
      await applyCsvImport(sqlite, data, { sourceId: 'demo', skipRejected: true }),
    ).toMatchObject({ created: 1 })
    expect(count(sqlite, 'time_entries')).toBe(2)
  })

  it('[container] never edits an entry already written, even when a later export changes the row', async () => {
    const sqlite = seed()
    await applyCsvImport(sqlite, file(ann('2026-09-01', '1', 'draft')), { sourceId: 'demo' })
    const before = all(sqlite, `SELECT * FROM time_entries`)
    await applyCsvImport(sqlite, file(ann('2026-09-01', '3', 'draft')), { sourceId: 'demo' })
    expect(all(sqlite, `SELECT * FROM time_entries WHERE id = 1`)).toEqual(before)
    expect(count(sqlite, 'time_entries')).toBe(2)
  })

  it('[container] records start and end times as entered', async () => {
    const sqlite = seed()
    await applyCsvImport(
      sqlite,
      encode(
        'date,person_email,client,project,task,start_time,end_time\n2026-03-08,ann@here.example,Acme,Website,Dev,01:30,03:45\n',
      ),
      { sourceId: 'demo' },
    )
    expect(
      all(sqlite, `SELECT spent_date, started_time, ended_time, seconds FROM time_entries`),
    ).toEqual([
      { spent_date: '2026-03-08', started_time: '01:30', ended_time: '03:45', seconds: 8100 },
    ])
  })

  it('[container] plans the same thing it then does', async () => {
    const sqlite = seed()
    const data = file(...rows, '2026-09-04,ann@here.example,Globex,Launch,Design,1,,')
    const plan = await planCsvImport(createContainerDatabase(sqlite), data, { sourceId: 'demo' })
    const result = await applyCsvImport(sqlite, data, { sourceId: 'demo' })
    expect(result.created).toBe(plan.report.entries.new)
  })
})

describe('CSV import command', () => {
  it('[container] dry-runs, applies and re-applies a file from disk', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'csv-import-'))
    folders.push(folder)
    const databasePath = join(folder, 'instance.db')
    seed({ path: databasePath }).close()
    open.pop()
    const filePath = join(folder, 'time.csv')
    await writeFile(filePath, file(ann('2026-09-01', '1'), ann('2026-09-02', '2')))
    const base = { databasePath, filePath, sourceId: 'demo', skipRejected: false }

    const dry = await runCsvImport({ ...base, dryRun: true })
    expect(dry.exitCode).toBe(0)
    expect(dry.text).toContain('2 to write')
    expect(dry.text).toContain('dry run: nothing written')

    const applied = await runCsvImport({ ...base, dryRun: false })
    expect(applied.exitCode).toBe(0)
    expect(applied.text).toContain('complete: 2 entries written')

    const again = await runCsvImport({ ...base, dryRun: false })
    expect(again.exitCode).toBe(0)
    expect(again.text).toContain('complete: 0 entries written, 2 already imported')

    await writeFile(filePath, file('nonsense'))
    const bad = await runCsvImport({ ...base, dryRun: true })
    expect(bad.exitCode).toBe(1)
  })
})
