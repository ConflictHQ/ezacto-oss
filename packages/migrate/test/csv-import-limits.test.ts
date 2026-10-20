import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateContainer } from '@ezacto/db'
import { MAX_CSV_BYTES, MAX_CSV_ROWS, parseCsv } from '../src/csv-contract.js'
import { dryRunCsvImport } from '../src/csv-import.js'

/**
 * Issue 1012 hardening: the importer at the edges of its contract. The first
 * block runs a file exactly as large as the limit allows, and one with exactly
 * as many rows, through the reader and a dry run, and bounds the time and heap
 * it takes. The bounds are generous on purpose (the machine running this is
 * often loaded); they exist to catch a quadratic pass or a copy of the file per
 * row, not to benchmark. The second block pins how a weekly-deadline lock
 * resolves around a daylight-saving change, on the importer's own path.
 */

const HEADER = 'date,person_email,client,project,task,hours,notes,billable'
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const t0 = '2026-09-02T12:00:00.000Z'

const open: BetterSqlite3.Database[] = []
afterEach(() => {
  vi.useRealTimers()
  while (open.length > 0) open.pop()!.close()
})

const seed = (): BetterSqlite3.Database => {
  const sqlite = new BetterSqlite3(':memory:')
  open.push(sqlite)
  migrateContainer(sqlite)
  const run = (query: string, ...params: unknown[]) => sqlite.prepare(query).run(...params)
  run(
    `INSERT INTO organizations (name, currency, modules, time_entry_mode, created_at, updated_at)
     VALUES ('Fictional Studio', 'USD', ?, 'duration', ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: true }),
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
  run(`INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Acme', 'USD', ?, ?)`, t0, t0)
  run(`INSERT INTO projects (id, client_id, name, created_at, updated_at) VALUES (1, 1, 'Website', ?, ?)`, t0, t0)
  run(`INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Dev', ?, ?)`, t0, t0)
  run(`INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at) VALUES (1, 1, 2, ?, ?)`, t0, t0)
  run(
    `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
     VALUES (1, 1, 1, 1, ?, ?)`,
    t0,
    t0,
  )
  return sqlite
}

/** Row `index` of a file spread over the days of 2026-09-01 to 2026-12-31. */
const dateOf = (index: number): string =>
  new Date(Date.UTC(2026, 8, 1 + (index % 122))).toISOString().slice(0, 10)
const rowAt = (index: number, notes = '', date = dateOf(index)): string =>
  `${date},ann@here.example,Acme,Website,Dev,1,${notes},`

/**
 * `rows` rows in a file of exactly `bytes` bytes: the difference is spread
 * over the rows' notes, so the file is full by size and by count at once.
 */
const fileOf = (rows: number, bytes: number): Uint8Array => {
  const plain = [HEADER, ...Array.from({ length: rows }, (_, index) => rowAt(index))].join('\n') + '\n'
  const spare = bytes - encode(plain).byteLength
  expect(spare).toBeGreaterThanOrEqual(0)
  const each = Math.floor(spare / rows)
  let extra = spare - each * rows
  const lines = Array.from({ length: rows }, (_, index) => {
    const pad = each + (extra > 0 ? 1 : 0)
    if (extra > 0) extra -= 1
    return rowAt(index, 'n'.repeat(pad))
  })
  const data = encode([HEADER, ...lines].join('\n') + '\n')
  expect(data.byteLength).toBe(bytes)
  return data
}

const measured = async <T>(work: () => Promise<T> | T): Promise<{ value: T; ms: number; heapMb: number }> => {
  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  let peak = before
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed)
  }, 20)
  const started = performance.now()
  try {
    const value = await work()
    peak = Math.max(peak, process.memoryUsage().heapUsed)
    return { value, ms: performance.now() - started, heapMb: (peak - before) / 1024 / 1024 }
  } finally {
    clearInterval(timer)
  }
}

// Quiet-machine figures: a read under a second, a dry run about two seconds,
// about 80 MB of heap. The bounds are several times that.
const READ_MS = 15_000
const DRY_RUN_MS = 30_000
const HEAP_MB = 512

describe('CSV import at its limits (issue 1012)', () => {
  it('[unit] reads a file of exactly the size limit, in time and memory', async () => {
    const rows = MAX_CSV_ROWS - 1_000
    const data = fileOf(rows, MAX_CSV_BYTES)
    expect(data.byteLength).toBe(MAX_CSV_BYTES)
    const { value, ms, heapMb } = await measured(() => parseCsv(data))
    expect(value.fileErrors).toEqual([])
    expect(value.invalid).toEqual([])
    expect(value.rows).toHaveLength(rows)
    expect(ms).toBeLessThan(READ_MS)
    expect(heapMb).toBeLessThan(HEAP_MB)
  })

  it('[unit] reads a file of exactly the row limit, and refuses one row more', async () => {
    const full = fileOf(MAX_CSV_ROWS, 4 * 1024 * 1024)
    const { value, ms, heapMb } = await measured(() => parseCsv(full))
    expect(value.fileErrors).toEqual([])
    expect(value.rows).toHaveLength(MAX_CSV_ROWS)
    expect(ms).toBeLessThan(READ_MS)
    expect(heapMb).toBeLessThan(HEAP_MB)
    const over = parseCsv(fileOf(MAX_CSV_ROWS + 1, 4 * 1024 * 1024))
    expect(over.fileErrors.map(({ code }) => code)).toEqual(['too_many_rows'])
    expect(parseCsv(new Uint8Array(MAX_CSV_BYTES + 1)).fileErrors.map(({ code }) => code)).toEqual([
      'file_too_large',
    ])
  })

  it('[container] dry-runs a full file against the instance without writing, in time and memory', async () => {
    const sqlite = seed()
    const data = fileOf(MAX_CSV_ROWS, 4 * 1024 * 1024)
    const { value, ms, heapMb } = await measured(() => dryRunCsvImport(sqlite, data, { sourceId: 'limit' }))
    expect(value.rejected).toEqual([])
    expect(value.entries).toMatchObject({ new: MAX_CSV_ROWS, rejected: 0 })
    expect((sqlite.prepare(`SELECT count(*) AS n FROM time_entries`).get() as { n: number }).n).toBe(0)
    expect(ms).toBeLessThan(DRY_RUN_MS)
    expect(heapMb).toBeLessThan(HEAP_MB)
  }, 180_000)
})

describe('CSV import against a weekly-deadline lock (issue 1012)', () => {
  /**
   * The organization closes each week at a wall-clock time in its own zone.
   * The importer asks the lock policy on the application's clock, so the
   * clock is the test's: the same file is read one second before the
   * deadline and at it.
   */
  const withDeadline = (
    deadline: { day: string; time: string },
    weekStartDay: string,
  ): BetterSqlite3.Database => {
    const sqlite = seed()
    sqlite
      .prepare(
        `UPDATE organizations SET auto_lock = 1, timesheet_deadline = ?, week_start_day = ?, timezone = 'America/New_York'`,
      )
      .run(JSON.stringify(deadline), weekStartDay)
    return sqlite
  }
  const outcomeAt = async (
    sqlite: BetterSqlite3.Database,
    instant: string,
    date: string,
  ): Promise<string[]> => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    try {
      const report = await dryRunCsvImport(sqlite, encode(`${HEADER}\n${rowAt(0, '', date)}\n`), {
        sourceId: 'lock',
      })
      return report.rejected.map(({ code }) => code)
    } finally {
      vi.useRealTimers()
    }
  }

  it('[container] a deadline in the skipped hour of the spring change locks at the first later wall time', async () => {
    // Sunday 2026-03-08 02:30 does not exist in New York: 02:00 became 03:00.
    const sqlite = withDeadline({ day: 'sunday', time: '02:30' }, 'sunday')
    expect(await outcomeAt(sqlite, '2026-03-08T06:59:59.000Z', '2026-03-02')).toEqual([])
    expect(await outcomeAt(sqlite, '2026-03-08T07:00:00.000Z', '2026-03-02')).toEqual(['period_locked'])
  })

  it('[container] a deadline in the repeated hour of the autumn change locks on its first occurrence', async () => {
    // Sunday 2026-11-01 01:30 happens twice in New York; the first is 05:30Z.
    const sqlite = withDeadline({ day: 'sunday', time: '01:30' }, 'sunday')
    expect(await outcomeAt(sqlite, '2026-11-01T05:29:59.000Z', '2026-10-26')).toEqual([])
    expect(await outcomeAt(sqlite, '2026-11-01T05:30:00.000Z', '2026-10-26')).toEqual(['period_locked'])
  })

  it('[container] a week that is not yet closed stays open, and the week before it is closed', async () => {
    const sqlite = withDeadline({ day: 'monday', time: '09:00' }, 'monday')
    // Monday 2026-08-31 09:00 in New York is 13:00Z; the week of 08-24 closed then.
    const instant = '2026-08-31T13:00:00.000Z'
    expect(await outcomeAt(sqlite, instant, '2026-08-26')).toEqual(['period_locked'])
    expect(await outcomeAt(sqlite, instant, '2026-08-31')).toEqual([])
  })
})
