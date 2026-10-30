import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer } from '@ezacto/db'
import { parseCsv } from '../src/csv-contract.js'
import { applyCsvImport, dryRunCsvImport } from '../src/csv-import.js'
import { runCsvImport } from '../src/csv-run.js'
import { clockifyAdapter } from '../src/csv-clockify.js'

/**
 * An invented Clockify "detailed" time report export (default MM/DD/YYYY dates,
 * 12-hour clock). Fictional Studio, no real people. Lines 8 and 9 are one record
 * (a description with a line break), so the rows after it check that line
 * numbers still point at the file as exported.
 */
const HEADER =
  '"Project","Client","Description","Task","User","Group","Email","Tags","Billable","Start Date","Start Time","End Date","End Time","Duration (h)","Duration (decimal)","Billable Rate (USD)","Billable Amount (USD)"'
const EXPORT = [
  HEADER,
  '"Website","Acme","Fix, then ship","Dev","Ann Member","","ann@here.example","billing, urgent","Yes","09/01/2026","9:00:00 AM","09/01/2026","10:30:00 AM","01:30:00","1.50","150.00","225.00"',
  '"Website","Acme","Review","Dev","Ann Member","","ann@here.example","","No","09/01/2026","1:00:15 PM","09/01/2026","2:00:00 PM","00:59:45","1.00","0.00","0.00"',
  '"Website","Acme","Late deploy","Dev","Ann Member","","ann@here.example","","Yes","09/02/2026","10:00:00 PM","09/03/2026","1:30:00 AM","03:30:00","3.50","150.00","525.00"',
  '"Website","Acme","Fix, then ship","Dev","Ann Member","","ann@here.example","billing, urgent","Yes","09/01/2026","9:00:00 AM","09/01/2026","10:30:00 AM","01:30:00","1.50","150.00","225.00"',
  '"Website","Acme","Design pass","Dev","Bo Lee","","bo@old.example","","Yes","09/02/2026","10:00:00 AM","09/02/2026","11:00:00 AM","01:00:00","1.00","150.00","150.00"',
  '"Website","Acme","=1+1","Dev","Ann Member","","ann@here.example","","Yes","09/02/2026","10:00:00 AM","09/02/2026","11:00:00 AM","01:00:00","1.00","150.00","150.00"',
  '"Website","Acme","Standup',
  'planning","Dev","Ann Member","","ann@here.example","","No","09/04/2026","9:00:00 AM","09/04/2026","9:30:00 AM","00:30:00","0.50","0.00","0.00"',
  '"Website","","No client","Dev","Ann Member","","ann@here.example","","Yes","09/04/2026","10:00:00 AM","09/04/2026","11:00:00 AM","01:00:00","1.00","150.00","150.00"',
  '"Website","Acme","Bad duration","Dev","Ann Member","","ann@here.example","","Yes","09/04/2026","11:00:00 AM","09/04/2026","12:00:00 PM","1.5","1.50","150.00","225.00"',
].join('\n')
// Lines 2, 3, 4, 5 and 8 are good rows; the export's own Duration (h) column says:
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

describe('Clockify adapter', () => {
  it('[unit] reads a detailed report onto the contract, keeping the file lines', () => {
    const parsed = parseCsv(encode(EXPORT), clockifyAdapter)
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

  it('[unit] reads ISO dates and a 24-hour clock too', () => {
    const parsed = parseCsv(
      encode(
        [
          HEADER,
          '"Website","Acme","Ship","Dev","Ann Member","","ann@here.example","","Yes","2026-09-01","13:00:00","2026-09-01","14:30:00","01:30:00","1.50","",""',
        ].join('\n'),
      ),
      clockifyAdapter,
    )
    expect(parsed.invalid).toEqual([])
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-09-01',
      seconds: 5400,
      startedTime: '13:00',
      endedTime: '14:30',
    })
  })

  it('[unit] never reads money and says which columns it left out', () => {
    const parsed = parseCsv(encode(EXPORT), clockifyAdapter)
    expect(parsed.rows.every((row) => row.rate === null && row.currency === null)).toBe(true)
    expect(parsed.warnings.map((warning) => warning.message)).toEqual([
      'Column user is not read.',
      'Column group is not read.',
      'Column tags is not read.',
      'Column duration (decimal) is not read.',
      'Column billable rate (usd) is not read.',
      'Column billable amount (usd) is not read.',
    ])
  })

  it('[unit] is a file error, not a guess, when this is not the detailed report', () => {
    const summary = parseCsv(
      encode('"Project","Client","Duration (h)"\n"Website","Acme","01:00:00"\n'),
      clockifyAdapter,
    )
    expect(summary.rows).toEqual([])
    expect(summary.fileErrors.length).toBeGreaterThan(0)
    expect(summary.fileErrors.every((error) => error.code === 'clockify_missing_column')).toBe(true)
    // The generic contract still refuses a Clockify file read without the adapter.
    expect(parseCsv(encode(EXPORT)).fileErrors.length).toBeGreaterThan(0)
  })

  it('[unit] refuses a day-first file whole instead of reading the dates the wrong way round', () => {
    const parsed = parseCsv(
      encode(
        [
          HEADER,
          '"Website","Acme","Ship","Dev","Ann Member","","ann@here.example","","Yes","03/09/2026","9:00:00 AM","03/09/2026","10:00:00 AM","01:00:00","1.00","",""',
          '"Website","Acme","Ship","Dev","Ann Member","","ann@here.example","","Yes","25/09/2026","9:00:00 AM","25/09/2026","10:00:00 AM","01:00:00","1.00","",""',
        ].join('\n'),
      ),
      clockifyAdapter,
    )
    expect(parsed.rows).toEqual([])
    expect(parsed.fileErrors.map((error) => [error.line, error.code])).toEqual([
      [3, 'clockify_date_format'],
    ])
  })
})

describe('Clockify import', () => {
  it('[container] dry-runs without writing, then applies once and reconciles to the export', async () => {
    const sqlite = seed()
    const data = encode(EXPORT)
    const input = { sourceId: 'clockify', adapter: clockifyAdapter }

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
    // The hours match the export's own Duration (h) column to the second.
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
      sourceId: 'clockify',
      adapter: clockifyAdapter,
    })
    expect(report.entries.new).toBe(3)
    expect(
      report.rejected.filter((row) => row.code === 'hours_not_accepted').map((row) => row.line),
    ).toEqual([3, 4])
  })

  it('[container] runs from the command with --format clockify and is idempotent', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'csv-clockify-'))
    folders.push(folder)
    const databasePath = join(folder, 'instance.db')
    seed({ path: databasePath }).close()
    open.pop()
    const filePath = join(folder, 'clockify.csv')
    await writeFile(filePath, EXPORT)
    const base = {
      databasePath,
      filePath,
      sourceId: 'clockify',
      format: 'clockify' as const,
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
