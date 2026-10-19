import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer } from '@ezacto/db'
import { parseCsv } from '../src/csv-contract.js'
import { applyCsvImport, dryRunCsvImport } from '../src/csv-import.js'
import { runCsvImport } from '../src/csv-run.js'
import { togglAdapter } from '../src/csv-toggl.js'

/**
 * An invented Toggl "detailed time entries" export. Fictional Studio, no real
 * people. Lines 8 and 9 are one record (a description with a line break), so the
 * rows after it check that line numbers still point at the file as exported.
 */
const HEADER =
  'User,Email,Client,Project,Task,Description,Billable,Start date,Start time,End date,End time,Duration,Tags,Amount (USD)'
const EXPORT = [
  HEADER,
  'Ann Member,ann@here.example,Acme,Website,Dev,"Fix, then ship",Yes,2026-09-01,09:00:00,2026-09-01,10:30:00,01:30:00,"billing, urgent",225.00',
  'Ann Member,ann@here.example,Acme,Website,Dev,Review,No,2026-09-01,13:00:15,2026-09-01,14:00:00,00:59:45,,0.00',
  'Ann Member,ann@here.example,Acme,Website,Dev,Late deploy,Yes,2026-09-02,22:00:00,2026-09-03,01:30:00,03:30:00,,525.00',
  'Ann Member,ann@here.example,Acme,Website,Dev,"Fix, then ship",Yes,2026-09-01,09:00:00,2026-09-01,10:30:00,01:30:00,"billing, urgent",225.00',
  'Bo Lee,bo@old.example,Acme,Website,Dev,Design pass,Yes,2026-09-02,10:00:00,2026-09-02,11:00:00,01:00:00,,150.00',
  'Ann Member,ann@here.example,Acme,Website,Dev,=1+1,Yes,2026-09-02,10:00:00,2026-09-02,11:00:00,01:00:00,,150.00',
  'Ann Member,ann@here.example,Acme,Website,Dev,"Standup',
  'planning",No,2026-09-04,09:00:00,2026-09-04,09:30:00,00:30:00,,0.00',
  'Ann Member,ann@here.example,,Website,Dev,No client,Yes,2026-09-04,10:00:00,2026-09-04,11:00:00,01:00:00,,150.00',
  'Ann Member,ann@here.example,Acme,Website,Dev,Bad duration,Yes,2026-09-04,11:00:00,2026-09-04,12:00:00,1.5,,225.00',
].join('\n')
// Lines 2, 3, 4, 5 and 8 are good rows; the export's own Duration column says:
const EXPORT_SECONDS = 5400 + 3585 + 12600 + 5400 + 1800

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const t0 = '2026-09-02T12:00:00.000Z'

const open: BetterSqlite3.Database[] = []
const folders: string[] = []
afterEach(async () => {
  while (open.length > 0) open.pop()!.close()
  while (folders.length > 0) await rm(folders.pop()!, { recursive: true, force: true })
})

const seed = (options: { mode?: 'duration' | 'start_end'; path?: string } = {}) => {
  const sqlite = new BetterSqlite3(options.path ?? ':memory:')
  open.push(sqlite)
  migrateContainer(sqlite)
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

const entries = (sqlite: BetterSqlite3.Database) =>
  sqlite.prepare(`SELECT spent_date, seconds, notes FROM time_entries ORDER BY id`).all() as {
    spent_date: string
    seconds: number
    notes: string | null
  }[]

const byLine = (issues: readonly { line: number; code: string }[]): [number, string][] =>
  issues.map((issue): [number, string] => [issue.line, issue.code]).sort((a, b) => a[0] - b[0])

describe('Toggl adapter', () => {
  it('[unit] reads a detailed export onto the contract, keeping the file lines', () => {
    const parsed = parseCsv(encode(EXPORT), togglAdapter)
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.dataRows).toBe(9)
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 3, 4, 5, 6, 8])
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-09-01',
      personEmail: 'ann@here.example',
      client: 'Acme',
      project: 'Website',
      task: 'Dev',
      seconds: 5400,
      startedTime: '09:00',
      endedTime: '10:30',
      notes: 'Fix, then ship',
      billable: true,
      rate: null,
      currency: null,
    })
    // Seconds on the clock, or past midnight: hours, exact to the second, on the start date.
    expect(parsed.rows[1]).toMatchObject({ seconds: 3585, startedTime: null, billable: false })
    expect(parsed.rows[2]).toMatchObject({ date: '2026-09-02', seconds: 12600, startedTime: null })
    expect(parsed.rows[5]).toMatchObject({ line: 8, notes: 'Standup\nplanning' })
    expect(byLine(parsed.invalid)).toEqual([
      [7, 'formula_injection'],
      [10, 'missing_value'],
      [11, 'invalid_duration'],
    ])
  })

  it('[unit] never reads money and says which columns it left out', () => {
    const parsed = parseCsv(encode(EXPORT), togglAdapter)
    expect(parsed.rows.every((row) => row.rate === null && row.currency === null)).toBe(true)
    expect(parsed.warnings.map((warning) => warning.message)).toEqual([
      'Column user is not read.',
      'Column tags is not read.',
      'Column amount (usd) is not read.',
    ])
  })

  it('[unit] is a file error, not a guess, when this is not the detailed export', () => {
    const summary = parseCsv(
      encode('User,Email,Project,Duration\nAnn,ann@here.example,Website,01:00:00\n'),
      togglAdapter,
    )
    expect(summary.rows).toEqual([])
    expect(summary.fileErrors.length).toBeGreaterThan(0)
    expect(summary.fileErrors.every((error) => error.code === 'toggl_missing_column')).toBe(true)
    // The generic contract still refuses a Toggl file read without the adapter.
    expect(parseCsv(encode(EXPORT)).fileErrors.length).toBeGreaterThan(0)
  })
})

describe('Toggl import', () => {
  it('[container] dry-runs without writing, then applies once and reconciles to the export', async () => {
    const sqlite = seed()
    const data = encode(EXPORT)
    const input = { sourceId: 'toggl', adapter: togglAdapter }

    const report = await dryRunCsvImport(sqlite, data, input)
    expect(report.entries).toEqual({ total: 9, new: 5, alreadyImported: 0, rejected: 4 })
    expect(byLine(report.rejected)).toEqual([
      [6, 'person_unmapped'],
      [7, 'formula_injection'],
      [10, 'missing_value'],
      [11, 'invalid_duration'],
    ])
    expect(entries(sqlite)).toEqual([])

    expect((await applyCsvImport(sqlite, data, input)).status).toBe('refused')
    const applied = await applyCsvImport(sqlite, data, { ...input, skipRejected: true })
    expect(applied).toMatchObject({ status: 'complete', created: 5 })
    expect(applied.report.rejected).toHaveLength(4)
    // The hours match the export's own Duration column to the second.
    expect(entries(sqlite).reduce((sum, entry) => sum + entry.seconds, 0)).toBe(EXPORT_SECONDS)
    expect(entries(sqlite).map((entry) => entry.spent_date)).toEqual([
      '2026-09-01',
      '2026-09-01',
      '2026-09-02',
      '2026-09-01',
      '2026-09-04',
    ])
    // The two genuinely identical rows are two entries.
    expect(entries(sqlite).filter((entry) => entry.notes === 'Fix, then ship')).toHaveLength(2)
    // Nothing but time: no invoice or expense row exists.
    for (const table of ['invoices', 'expenses']) {
      expect((sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(
        0,
      )
    }

    const again = await applyCsvImport(sqlite, data, { ...input, skipRejected: true })
    expect(again).toMatchObject({ status: 'complete', created: 0, alreadyImported: 5 })
    expect(entries(sqlite)).toHaveLength(5)
  })

  it('[container] an organization that records start and end times takes only the timed rows', async () => {
    const sqlite = seed({ mode: 'start_end' })
    const report = await dryRunCsvImport(sqlite, encode(EXPORT), {
      sourceId: 'toggl',
      adapter: togglAdapter,
    })
    expect(report.entries.new).toBe(3)
    expect(
      report.rejected.filter((row) => row.code === 'hours_not_accepted').map((row) => row.line),
    ).toEqual([3, 4])
  })

  it('[container] runs from the command with --format toggl and is idempotent', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'csv-toggl-'))
    folders.push(folder)
    const databasePath = join(folder, 'instance.db')
    seed({ path: databasePath }).close()
    open.pop()
    const filePath = join(folder, 'toggl.csv')
    await writeFile(filePath, EXPORT)
    const base = {
      databasePath,
      filePath,
      sourceId: 'toggl',
      format: 'toggl' as const,
      skipRejected: true,
    }

    const dry = await runCsvImport({ ...base, dryRun: true })
    expect(dry.text).toContain('5 to write')
    expect(dry.text).toContain('line 6: unsupported person_unmapped')
    expect(dry.exitCode).toBe(1)
    const applied = await runCsvImport({ ...base, dryRun: false })
    expect(applied.text).toContain('complete: 5 entries written')
    const again = await runCsvImport({ ...base, dryRun: false })
    expect(again.text).toContain('complete: 0 entries written, 5 already imported')
  })
})
