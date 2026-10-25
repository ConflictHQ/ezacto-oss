import { describe, expect, it } from 'vitest'
import { MAX_CSV_BYTES, MAX_CSV_ROWS, nameKey, parseCsv, sourceKeys } from '../src/csv-contract.js'
import { CsvMappingError, canonicalMapping, parseMapping } from '../src/csv-mapping.js'

const HEADER = 'date,person_email,client,project,task,hours,notes,billable,rate,currency'
const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const csv = (...rows: string[]): Uint8Array => encode([HEADER, ...rows].join('\n') + '\n')
const codes = (parsed: ReturnType<typeof parseCsv>): string[] =>
  parsed.invalid.map((issue) => issue.code)

describe('CSV time contract', () => {
  it('[unit] reads a well-formed file into rows with their line numbers', () => {
    const parsed = parseCsv(
      csv(
        '2026-09-01,Ann@Example.com,Acme,Web,Dev,1.5,"Fix, then ship",yes,,',
        '2026-09-02,ann@example.com,Acme,Web,Dev,2:15,,false,,',
      ),
    )
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.invalid).toEqual([])
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]).toMatchObject({
      line: 2,
      date: '2026-09-01',
      personEmail: 'ann@example.com',
      seconds: 5400,
      notes: 'Fix, then ship',
      billable: true,
    })
    expect(parsed.rows[1]).toMatchObject({ line: 3, seconds: 8100, notes: null, billable: false })
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('[unit] takes start and end times as wall-clock time, with no conversion', () => {
    const parsed = parseCsv(
      encode(
        'date,person_email,client,project,task,start_time,end_time\n' +
          '2026-03-08,a@example.com,C,P,T,01:30,03:45\n',
      ),
    )
    expect(parsed.rows[0]).toMatchObject({
      date: '2026-03-08',
      startedTime: '01:30',
      endedTime: '03:45',
      seconds: 8100,
    })
  })

  it('[unit] decimal hours need a dot, are bounded, and are exact to the second', () => {
    const parsed = parseCsv(
      csv(
        '2026-09-01,a@example.com,C,P,T,0.0833,,,,',
        '2026-09-01,a@example.com,C,P,T,"1,5",,,,',
        '2026-09-01,a@example.com,C,P,T,0,,,,',
        '2026-09-01,a@example.com,C,P,T,24.5,,,,',
        '2026-09-01,a@example.com,C,P,T,-1,,,,',
        '2026-09-01,a@example.com,C,P,T,1:75,,,,',
      ),
    )
    expect(parsed.rows.map((row) => row.seconds)).toEqual([300])
    expect(parsed.invalid.map(({ line, code }) => [line, code])).toEqual([
      [3, 'invalid_hours'],
      [4, 'invalid_hours'],
      [5, 'invalid_hours'],
      [6, 'invalid_hours'],
      [7, 'invalid_hours'],
    ])
  })

  it('[unit] refuses times that carry an offset, or an end that is not after the start', () => {
    const parsed = parseCsv(
      encode(
        'date,person_email,client,project,task,start_time,end_time\n' +
          '2026-09-01,a@example.com,C,P,T,09:00Z,10:00\n' +
          '2026-09-01,a@example.com,C,P,T,10:00,10:00\n' +
          '2026-09-01,a@example.com,C,P,T,23:00,01:00\n' +
          '2026-09-01,a@example.com,C,P,T,09:00,\n',
      ),
    )
    expect(codes(parsed)).toEqual([
      'invalid_time',
      'end_not_after_start',
      'end_not_after_start',
      'invalid_time',
    ])
  })

  it('[unit] names the code of each row-level violation with its line', () => {
    const parsed = parseCsv(
      csv(
        '2026-02-30,a@example.com,C,P,T,1,,,,',
        '2026-09-01T09:00:00Z,a@example.com,C,P,T,1,,,,',
        '2026-09-01,not-an-email,C,P,T,1,,,,',
        '2026-09-01,a@example.com,,P,T,1,,,,',
        '2026-09-01,a@example.com,C,P,T,,,,,',
        '2026-09-01,a@example.com,C,P,T,1,,maybe,,',
        '2026-09-01,a@example.com,C,P,T,1,,,abc,',
        '2026-09-01,a@example.com,C,P,T,1,,,5,ZZZ',
        '2026-09-01,a@example.com,C,P,T,1,,,5,USD',
        '2026-09-01,a@example.com,C,P',
      ),
    )
    expect(parsed.invalid.map(({ line, code }) => [line, code])).toEqual([
      [2, 'invalid_date'],
      [3, 'invalid_date'],
      [4, 'invalid_email'],
      [5, 'missing_value'],
      [6, 'missing_duration'],
      [7, 'invalid_billable'],
      [8, 'invalid_rate'],
      [9, 'unknown_currency'],
      [11, 'column_count'],
    ])
    // A valid rate is read, never written, and says so.
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({ line: 10, code: 'rate_not_applied' }),
    )
  })

  it('[unit] refuses hours together with times', () => {
    const parsed = parseCsv(
      encode(
        'date,person_email,client,project,task,hours,start_time,end_time\n' +
          '2026-09-01,a@example.com,C,P,T,1,09:00,10:00\n',
      ),
    )
    expect(codes(parsed)).toEqual(['duration_ambiguous'])
  })

  it.each(['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx'])(
    '[unit] rejects the formula-injection cell %j in a text column',
    (cell) => {
      const quoted = `"${cell}"`
      const parsed = parseCsv(
        csv(
          `2026-09-01,a@example.com,${quoted},P,T,1,,,,`,
          `2026-09-01,a@example.com,C,P,T,1,${quoted},,,`,
        ),
      )
      expect(codes(parsed)).toEqual(['formula_injection', 'formula_injection'])
      expect(parsed.rows).toEqual([])
    },
  )

  it('[unit] keeps a hyphen inside a name, and a minus only matters at the start', () => {
    const parsed = parseCsv(csv('2026-09-01,a@example.com,Acme-Corp,P-1,T,1,re-test,,,'))
    expect(parsed.invalid).toEqual([])
  })

  it('[unit] reports malformed quoting as a file error, not a crash', () => {
    for (const body of [
      `${HEADER}\n2026-09-01,a@example.com,"Acme,P,T,1,,,,\n`,
      `${HEADER}\n2026-09-01,a@example.com,Ac"me,P,T,1,,,,\n`,
      `${HEADER}\n2026-09-01,a@example.com,"Acme"x,P,T,1,,,,\n`,
    ]) {
      const parsed = parseCsv(encode(body))
      expect(parsed.fileErrors).toHaveLength(1)
      expect(['unterminated_quote', 'malformed_quote']).toContain(parsed.fileErrors[0]!.code)
      expect(parsed.rows).toEqual([])
    }
  })

  it('[unit] reports non-UTF-8 and binary input as file errors', () => {
    expect(parseCsv(Uint8Array.from([0xff, 0xfe, 0x41, 0x80])).fileErrors[0]?.code).toBe('not_utf8')
    expect(
      parseCsv(encode(`${HEADER}\n2026-09-01,a@example.com,C\u0000,P,T,1,,,,\n`)).fileErrors[0]
        ?.code,
    ).toBe('binary_content')
    expect(parseCsv(new Uint8Array(0)).fileErrors[0]?.code).toBe('empty_file')
  })

  it('[unit] refuses an oversize file before reading it, and too many rows', () => {
    const oversize = parseCsv(new Uint8Array(MAX_CSV_BYTES + 1))
    expect(oversize.fileErrors.map(({ code }) => code)).toEqual(['file_too_large'])
    const many = parseCsv(
      encode(`${HEADER}\n${'2026-09-01,a@example.com,C,P,T,1,,,,\n'.repeat(MAX_CSV_ROWS + 1)}`),
    )
    expect(many.fileErrors.map(({ code }) => code)).toEqual(['too_many_rows'])
  })

  it('[unit] checks the header: required, duration and duplicate columns, unknown ones warn', () => {
    expect(parseCsv(encode('date,client\n')).fileErrors.map(({ code }) => code)).toEqual([
      'missing_column',
      'missing_column',
      'missing_column',
      'missing_duration_column',
    ])
    expect(
      parseCsv(encode('date,date,person_email,client,project,task,hours\n')).fileErrors.map(
        ({ code }) => code,
      ),
    ).toEqual(['duplicate_column'])
    const parsed = parseCsv(
      encode(
        'Date, Person_Email ,client,project,task,hours,extra\n2026-09-01,a@example.com,C,P,T,1,x\n',
      ),
    )
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.warnings).toEqual([expect.objectContaining({ line: 1, code: 'unknown_column' })])
  })

  it('[unit] handles CRLF, a BOM, blank lines and quoted line breaks, counting physical lines', () => {
    const parsed = parseCsv(
      encode(
        `﻿${HEADER}\r\n\r\n2026-09-01,a@example.com,C,P,T,1,"two\r\nlines ""quoted""",,,\r\n2026-09-02,a@example.com,C,P,T,0,,,,\r\n`,
      ),
    )
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({ line: 3, notes: 'two\r\nlines "quoted"' })
    expect(parsed.invalid).toEqual([expect.objectContaining({ line: 5, code: 'invalid_hours' })])
  })

  it.each(['\n', '\r\n', '\r'])('[#1179] counts quoted physical line breaks without changing notes: %j', (newline) => {
    const notes = `first${newline}second`
    const parsed = parseCsv(encode([
      HEADER,
      `2026-09-01,a@example.com,C,P,T,1,"${notes}",,,`,
      '2026-09-02,a@example.com,C,P,T,0,,,,',
    ].join(newline)))
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]).toMatchObject({ line: 2, notes })
    expect(parsed.invalid).toEqual([expect.objectContaining({ line: 4, code: 'invalid_hours' })])
  })

  it('[unit] gives a row the same source key however the file is ordered, and tells twins apart', () => {
    const a = '2026-09-01,a@example.com,C,P,T,1,,,,'
    const b = '2026-09-02,a@example.com,C,P,T,2,,,,'
    const first = sourceKeys(parseCsv(csv(a, b, a)).rows)
    const reordered = sourceKeys(parseCsv(csv(b, a, a)).rows)
    expect(new Set(first).size).toBe(3)
    expect(new Set([...first].sort())).toEqual(new Set([...reordered].sort()))
    expect(first[0]).toMatch(/^[0-9a-f]{64}#0$/)
    expect(first[2]).toMatch(/#1$/)
    // Rate and currency are not written, so they are not identity.
    expect(sourceKeys(parseCsv(csv('2026-09-01,a@example.com,C,P,T,1,,,5,USD')).rows)).toEqual([
      first[0],
    ])
  })

  it('[unit] compares names without case or surplus space', () => {
    expect(nameKey('  Acme   INC ')).toBe(nameKey('acme inc'))
  })
})

describe('CSV mapping', () => {
  it('[unit] normalizes keys so the same mapping has the same hash', () => {
    const one = parseMapping(
      JSON.stringify({
        people: { 'Ann@Old.example': 'ANN@here.example' },
        clients: { 'Acme  Inc': 'Acme' },
        projects: { 'Acme Inc': { Web: 'Website' } },
      }),
    )
    const two = parseMapping(
      JSON.stringify({
        projects: { 'acme inc': { web: 'Website' } },
        clients: { 'acme inc': 'Acme' },
        people: { 'ann@old.example': 'ann@here.example' },
      }),
    )
    expect(canonicalMapping(one).sha256).toBe(canonicalMapping(two).sha256)
    expect(parseMapping(canonicalMapping(one).json)).toEqual(one)
  })

  it('[unit] refuses unknown sections, bad shapes and broken JSON', () => {
    for (const bad of [
      '{',
      '[]',
      '{"orgs":{}}',
      '{"people":{"a@x.example":{"create":{"firstName":"A"}}}}',
      '{"people":{"a@x.example":{"create":{"firstName":"A","lastName":"B","profile":"administrator"}}}}',
      '{"clients":{"A":""}}',
      '{"projects":{"A":"B"}}',
    ]) {
      expect(() => parseMapping(bad)).toThrow(CsvMappingError)
    }
  })

  it('[unit] does not let a __proto__ key reach the prototype', () => {
    const mapping = parseMapping('{"clients":{"__proto__":"Evil"}}')
    expect(Object.getPrototypeOf(mapping.clients)).toBeNull()
    expect(({} as Record<string, unknown>).Evil).toBeUndefined()
  })
})
