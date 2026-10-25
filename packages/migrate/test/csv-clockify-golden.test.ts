import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseCsv } from '../src/csv-contract.js'
import { CLOCKIFY_ADAPTERS, clockifyAdapter, createClockifyBrowserAdapter } from '../src/csv-clockify.js'

const fixture = (name: string) => new URL(`./fixtures/clockify-browser/${name}`, import.meta.url)
const readJson = <T>(name: string): T => JSON.parse(readFileSync(fixture(name), 'utf8')) as T
const codes = (issues: readonly { line: number; code: string }[]) => issues.map(({ line, code }) => [line, code])
interface Golden {
  adapterId: string
  exporterZone: string
  dataRows: number
  accepted: { line: number; date?: string; seconds: number; startedTime: string | null; endedTime: string | null }[]
  invalid: [number, string][]
  warnings: [number, string][]
  acceptedSourceSeconds?: number
  sha256?: string
}
interface Admission {
  name: string
  encoding: 'hex' | 'utf8' | 'oversized-field'
  text?: string
  header?: string[]
  row?: string[]
  column?: number
  repeat?: string
  count?: number
  fileErrors: [number, string][]
  invalid: [number, string][]
  cliRows?: number
}
const admissions = readJson<{ adapterId: string; cases: Admission[] }>('admission-cases.json')
const csvRow = (cells: readonly string[]) => cells.map(cell => `"${cell.replaceAll('"', '""')}"`).join(',')
const bytesFor = (input: Admission): Uint8Array => {
  if (input.encoding === 'hex') return Uint8Array.from(Buffer.from(input.text!, 'hex'))
  if (input.encoding === 'utf8') return new TextEncoder().encode(input.text!)
  const row = [...input.row!]
  row[input.column!] = input.repeat!.repeat(input.count!)
  return new TextEncoder().encode(`${csvRow(input.header!)}\n${csvRow(row)}\n`)
}

describe('committed invented Clockify browser golden fixtures (#1179)', () => {
  it.each(['detailed-time', 'daylight-saving'])('preserves physical lines and exact seconds for %s', (name) => {
    const expected = readJson<Golden>(`${name}.expected.json`)
    expect(CLOCKIFY_ADAPTERS.browser).toBe(expected.adapterId)
    const bytes = readFileSync(fixture(`${name}.csv`))
    const parsed = parseCsv(bytes, createClockifyBrowserAdapter({ exporterZone: expected.exporterZone }))
    expect(parsed.fileErrors).toEqual([])
    expect(parsed.dataRows).toBe(expected.dataRows)
    expect(parsed.rows).toHaveLength(expected.accepted.length)
    expected.accepted.forEach((row, index) => expect(parsed.rows[index]).toMatchObject(row))
    expect(codes(parsed.invalid)).toEqual(expected.invalid)
    expect(codes(parsed.warnings)).toEqual(expected.warnings)
    if (expected.sha256) expect(parsed.sha256).toBe(expected.sha256)
    if (expected.acceptedSourceSeconds !== undefined) {
      expect(parsed.rows.reduce((seconds, row) => seconds + row.seconds, 0)).toBe(expected.acceptedSourceSeconds)
    }
    expect(parsed.rows.every(row => row.rate === null && row.currency === null)).toBe(true)
  })

  it('keeps HTML and URL-shaped source cells inert and never imports money or attachments', () => {
    expect(CLOCKIFY_ADAPTERS.browser).toBe(readJson<Golden>('detailed-time.expected.json').adapterId)
    const bytes = readFileSync(fixture('detailed-time.csv'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const fetch = vi.fn(() => { throw new Error('CSV parsing must never fetch a source URL') })
    vi.stubGlobal('fetch', fetch)
    try {
      const parsed = parseCsv(bytes, createClockifyBrowserAdapter({ exporterZone: 'UTC' }))
      expect(parsed.rows[0]?.notes).toBe('Quoted, task\nsecond "quoted" line – café')
      expect(parsed.rows[1]?.notes).toBe('<img src="https://fixture.invalid/x" onerror="globalThis.csvFixtureExecuted=true">')
      expect(Reflect.get(globalThis, 'csvFixtureExecuted')).toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
      for (const row of parsed.rows) {
        expect(row.rate).toBeNull()
        expect(row.currency).toBeNull()
        expect(row).not.toHaveProperty('attachments')
        expect(row).not.toHaveProperty('amount')
      }
      expect(parsed.invalid.map(issue => issue.line)).toEqual([7, 8, 9])
      expect(parsed.warnings.filter(issue => issue.code === 'clockify_money_ignored')).toHaveLength(3)
      expect(parsed.warnings.filter(issue => issue.code === 'clockify_attachment_ignored')).toHaveLength(1)
      expect(parsed.warnings.filter(issue => issue.code === 'clockify_column_ignored')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(admissions.cases)('admits no rows for $name', (input) => {
    expect(CLOCKIFY_ADAPTERS.browser).toBe(admissions.adapterId)
    const bytes = bytesFor(input)
    const parsed = parseCsv(bytes, createClockifyBrowserAdapter({ exporterZone: 'UTC' }))
    expect(parsed.rows).toEqual([])
    expect(codes(parsed.fileErrors)).toEqual(input.fileErrors)
    expect(codes(parsed.invalid)).toEqual(input.invalid)
    if (input.cliRows !== undefined) {
      // Browser source admission must not reinterpret the existing CLI identity.
      expect(parseCsv(bytes, clockifyAdapter).rows).toHaveLength(input.cliRows)
    }
  })
})
