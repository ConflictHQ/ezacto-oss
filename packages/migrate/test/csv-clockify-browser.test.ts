import { describe, expect, it } from 'vitest'
import { MAX_CSV_COLUMNS, parseCsv } from '../src/csv-contract.js'
import {
  CLOCKIFY_ADAPTERS,
  clockifyAdapter,
  createClockifyBrowserAdapter,
} from '../src/csv-clockify.js'

/**
 * Sanitized, invented Clockify "detailed" exports for the browser contract
 * (issue 1179). Fictional Studio, no real people.
 */
const COLUMNS = [
  'Project',
  'Client',
  'Description',
  'Task',
  'User',
  'Email',
  'Tags',
  'Billable',
  'Start Date',
  'Start Time',
  'End Date',
  'End Time',
  'Duration (h)',
  'Billable Rate (USD)',
  'Billable Amount (USD)',
]
const quote = (cells: readonly string[]) => cells.map((cell) => `"${cell}"`).join(',')
const HEADER = quote(COLUMNS)
const row = (
  start: [string, string],
  end: [string, string],
  duration: string,
  description = 'Ship',
) =>
  quote([
    'Website',
    'Acme',
    description,
    'Dev',
    'Ann Member',
    'ann@here.example',
    'urgent',
    'Yes',
    start[0],
    start[1],
    end[0],
    end[1],
    duration,
    '150.00',
    '225.00',
  ])
const file = (...lines: string[]) => new TextEncoder().encode([HEADER, ...lines].join('\n'))
const adapter = createClockifyBrowserAdapter({ exporterZone: 'America/New_York' })
const codes = (issues: readonly { line: number; code: string }[]) =>
  issues.map((issue): [number, string] => [issue.line, issue.code])

describe('Clockify browser adapter', () => {
  it('[unit] has a frozen identity apart from the CLI reader', () => {
    expect(CLOCKIFY_ADAPTERS).toEqual({
      cli: 'clockify-detailed-cli@1',
      browser: 'clockify-detailed-browser@1',
    })
  })

  it('[unit] reads ISO dates on a 12-hour and a 24-hour clock, exact to the second', () => {
    const parsed = parseCsv(
      file(
        row(['2026-09-01', '9:00:00 AM'], ['2026-09-01', '10:30:00 AM'], '01:30:00'),
        row(['2026-09-01', '13:00:00'], ['2026-09-01', '14:00:00'], '01:00:00'),
        row(['2026-09-01', '1:00:15 PM'], ['2026-09-01', '2:00:00 PM'], '00:59:45'),
      ),
      adapter,
    )
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.invalid).toEqual([])
    expect(parsed.rows.map((r) => [r.startedTime, r.endedTime, r.seconds])).toEqual([
      ['09:00', '10:30', 5400],
      ['13:00', '14:00', 3600],
      [null, null, 3585],
    ])
    expect(codes(parsed.warnings.filter((w) => w.line > 1))).toEqual([
      [4, 'clockify_timing_dropped'],
    ])
  })

  it('[unit] refuses slash dates whole, even ones that look valid either way round', () => {
    for (const date of ['03/04/2026', '09/01/2026']) {
      const parsed = parseCsv(
        file(row([date, '9:00:00 AM'], [date, '10:00:00 AM'], '01:00:00')),
        adapter,
      )
      expect(parsed.rows).toEqual([])
      expect(codes(parsed.fileErrors)).toEqual([[2, 'clockify_date_format']])
    }
    // The CLI reader keeps its documented month-first compatibility.
    const cli = parseCsv(
      file(row(['09/01/2026', '9:00:00 AM'], ['09/01/2026', '10:00:00 AM'], '01:00:00')),
      clockifyAdapter,
    )
    expect(cli.rows[0]).toMatchObject({ date: '2026-09-01' })
  })

  it('[unit] rejects an impossible ISO date on its row only', () => {
    const parsed = parseCsv(
      file(
        row(['2026-02-30', '9:00:00 AM'], ['2026-02-30', '10:00:00 AM'], '01:00:00'),
        row(['2026-09-01', '9:00:00 AM'], ['2026-09-01', '10:00:00 AM'], '01:00:00'),
      ),
      adapter,
    )
    expect(codes(parsed.invalid)).toEqual([[2, 'invalid_date']])
    expect(parsed.rows).toHaveLength(1)
  })

  it('[unit] makes a repeated header a file error instead of taking the first', () => {
    const doubled = new TextEncoder().encode(
      [
        `${HEADER},"email"`,
        `${row(['2026-09-01', '9:00:00 AM'], ['2026-09-01', '10:00:00 AM'], '01:00:00')},"bo@old.example"`,
      ].join('\n'),
    )
    expect(codes(parseCsv(doubled, adapter).fileErrors)).toEqual([[1, 'clockify_duplicate_column']])
    // The CLI reader is unchanged: it still reads the first.
    expect(parseCsv(doubled, clockifyAdapter).fileErrors).toEqual([])
  })

  it('[unit] bounds the source header before the adapter projects it', () => {
    const wide = [
      ...COLUMNS,
      ...Array.from({ length: MAX_CSV_COLUMNS }, (_, index) => `Custom ${index}`),
    ]
    const text = `${quote(wide)}\n${quote(wide.map(() => 'x'))}`
    for (const reader of [adapter, clockifyAdapter]) {
      const parsed = parseCsv(new TextEncoder().encode(text), reader)
      expect(codes(parsed.fileErrors)).toEqual([[1, 'too_many_columns']])
    }
  })

  it('[unit] requires all eleven columns and names each missing one', () => {
    const parsed = parseCsv(
      new TextEncoder().encode('"Project","Client"\n"Website","Acme"'),
      adapter,
    )
    expect(parsed.fileErrors).toHaveLength(9)
    expect(new Set(parsed.fileErrors.map((error) => error.code))).toEqual(
      new Set(['clockify_missing_column']),
    )
  })

  it('[unit] reports money, tag and custom columns as ignored with how many rows carry them', () => {
    const header = quote([...COLUMNS, 'Receipt File', 'Cost Centre'])
    const line = `${row(['2026-09-01', '9:00:00 AM'], ['2026-09-01', '10:00:00 AM'], '01:00:00')},"r.pdf",""`
    const parsed = parseCsv(new TextEncoder().encode(`${header}\n${line}`), adapter)
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({ rate: null, currency: null })
    expect(parsed.warnings.filter((w) => w.line === 1).map((w) => [w.code, w.message])).toEqual([
      ['clockify_column_ignored', 'Column user is not read; 1 of 1 rows carry a value.'],
      ['clockify_column_ignored', 'Column tags is not read; 1 of 1 rows carry a value.'],
      [
        'clockify_money_ignored',
        'Column billable rate (usd) is not read; 1 of 1 rows carry a value.',
      ],
      [
        'clockify_money_ignored',
        'Column billable amount (usd) is not read; 1 of 1 rows carry a value.',
      ],
      [
        'clockify_attachment_ignored',
        'Column receipt file is not read; 1 of 1 rows carry a value.',
      ],
      ['clockify_money_ignored', 'Column cost centre is not read; 0 of 1 rows carry a value.'],
    ])
  })

  it('[unit] says when an entry loses its start and end times, and why', () => {
    const parsed = parseCsv(
      file(
        // overnight
        row(['2026-09-02', '10:00:00 PM'], ['2026-09-03', '1:30:00 AM'], '03:30:00'),
        // a rounded export: the duration is not the clock
        row(['2026-09-04', '9:00:00 AM'], ['2026-09-04', '9:50:00 AM'], '01:00:00'),
      ),
      adapter,
    )
    expect(parsed.rows.map((r) => [r.date, r.seconds, r.startedTime])).toEqual([
      ['2026-09-02', 12600, null],
      ['2026-09-04', 3600, null],
    ])
    expect(codes(parsed.warnings.filter((w) => w.line > 1))).toEqual([
      [2, 'clockify_timing_dropped'],
      [3, 'clockify_duration_differs_from_clock'],
      [3, 'clockify_timing_dropped'],
    ])
    expect(parsed.warnings.find((w) => w.line === 2)!.message).toContain('spans midnight')
  })

  it('[unit] refuses a time in a daylight-saving gap and flags a repeated hour', () => {
    const parsed = parseCsv(
      file(
        // 2026-03-08 02:30 does not exist in New York
        row(['2026-03-08', '2:30:00 AM'], ['2026-03-08', '3:30:00 AM'], '00:30:00'),
        // 2026-11-01 01:30 happens twice
        row(['2026-11-01', '1:30:00 AM'], ['2026-11-01', '2:30:00 AM'], '02:00:00'),
        // an ordinary day
        row(['2026-06-01', '2:30:00 AM'], ['2026-06-01', '3:30:00 AM'], '01:00:00'),
      ),
      adapter,
    )
    expect(codes(parsed.invalid)).toEqual([[2, 'clockify_dst_gap']])
    expect(codes(parsed.warnings.filter((w) => w.line > 1))).toEqual([
      [3, 'clockify_dst_repeated_hour'],
      [3, 'clockify_duration_differs_from_clock'],
      [3, 'clockify_timing_dropped'],
    ])
    expect(parsed.rows.map((r) => r.line)).toEqual([3, 4])
    // The same time is fine in a zone without the change.
    const utc = createClockifyBrowserAdapter({ exporterZone: 'UTC' })
    expect(
      parseCsv(
        file(row(['2026-03-08', '2:30:00 AM'], ['2026-03-08', '3:30:00 AM'], '00:30:00')),
        utc,
      ).invalid,
    ).toEqual([])
  })

  it('[unit] throws on an exporter zone the runtime does not know', () => {
    expect(() => createClockifyBrowserAdapter({ exporterZone: 'Mars/Olympus' })).toThrow()
  })

  it('[unit] fails the file on BOM-less bad UTF-8, NUL and formula cells, and strips a BOM', () => {
    const good = row(['2026-09-01', '9:00:00 AM'], ['2026-09-01', '10:00:00 AM'], '01:00:00')
    const bom = new TextEncoder().encode(`﻿${HEADER}\n${good}`)
    expect(parseCsv(bom, adapter).fileErrors).toEqual([])
    expect(parseCsv(new Uint8Array([0xff, 0xfe, 0x41]), adapter).fileErrors[0]!.code).toBe(
      'not_utf8',
    )
    expect(
      parseCsv(new TextEncoder().encode(`${HEADER}\n${good}\u0000`), adapter).fileErrors[0]!.code,
    ).toBe('binary_content')
    const formula = parseCsv(
      file(row(['2026-09-01', '9:00:00 AM'], ['2026-09-01', '10:00:00 AM'], '01:00:00', '=1+1')),
      adapter,
    )
    expect(codes(formula.invalid)).toEqual([[2, 'formula_injection']])
  })

  it('[unit] keeps physical line numbers across a quoted multi-line field', () => {
    const parsed = parseCsv(
      file(
        row(
          ['2026-09-01', '9:00:00 AM'],
          ['2026-09-01', '10:00:00 AM'],
          '01:00:00',
          'Stand-up\nnotes, with comma',
        ),
        row(['2026-09-01', '11:00:00 AM'], ['2026-09-01', 'bad'], '01:00:00'),
      ),
      adapter,
    )
    expect(parsed.rows[0]).toMatchObject({ line: 2, notes: 'Stand-up\nnotes, with comma' })
    expect(codes(parsed.invalid)).toEqual([[4, 'invalid_time']])
  })

  it('[unit] leaves out-of-the-box rows with omitted dimensions to the contract to reject', () => {
    const blank = quote([
      'Website',
      '',
      'Ship',
      'Dev',
      'Ann Member',
      'ann@here.example',
      '',
      'Yes',
      '2026-09-01',
      '9:00:00 AM',
      '2026-09-01',
      '10:00:00 AM',
      '01:00:00',
      '',
      '',
    ])
    expect(codes(parseCsv(file(blank), adapter).invalid)).toEqual([[2, 'missing_value']])
  })
})
