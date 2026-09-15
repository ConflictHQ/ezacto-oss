import { describe, expect, it } from 'vitest'
import {
  layoutDetailedReportDocument,
  renderDetailedReportCsv,
  renderDetailedReportDocument,
  wrapDetailedReportText,
  type DetailedReportFileInput,
} from '../src/report-document.js'

const input = (): DetailedReportFileInput => ({
  title: 'Detailed time',
  period: '2026-08-01 through 2026-08-31',
  brandName: 'Kestrel Studio',
  columns: [
    { key: 'date', label: 'Date' },
    { key: 'hours', label: 'Hours' },
  ],
  rows: Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    values: { date: `2026-08-${String(index + 1).padStart(2, '0')}`, hours: '7.50' },
    notes: `${index === 0 ? '=PR ' : ''}${'A client note with https://example.test/pull/417 and every character intact. '.repeat(8)}`,
  })),
  runningTotals: ['Hours 135.00', 'Billable USD 27,000.00'],
})

describe('detailed report file targets', () => {
  it('paginates long notes in full with final page counts and deterministic bytes', () => {
    const report = input()
    const layout = layoutDetailedReportDocument(report)
    expect(layout.pages.length).toBeGreaterThan(2)
    expect(layout.pages.at(-1)?.operations).toContainEqual(
      expect.objectContaining({ text: `Page ${layout.pages.length} of ${layout.pages.length}` }),
    )
    const note = report.rows[0]!.notes!
    expect(wrapDetailedReportText(note).join('').replaceAll(' ', '')).toBe(
      note.replaceAll(' ', ''),
    )
    expect(renderDetailedReportDocument(report)).toEqual(renderDetailedReportDocument(report))
  })

  it('exports the same ordered rows and defuses spreadsheet formulas without truncating notes', () => {
    const report = input()
    const csv = renderDetailedReportCsv(report)
    expect(csv.split('\r\n')).toHaveLength(report.rows.length + 2)
    expect(csv).toContain("'=")
    expect(csv).toContain(report.rows[0]!.notes!)
  })
})
