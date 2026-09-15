/**
 * Deterministic file targets for a detailed report definition (#59).
 *
 * Both targets consume the same ordered columns and rows. The PDF deliberately
 * gives notes their own wrapped lines: client work notes are evidence, not a
 * preview string, so pagination is allowed to grow for as many pages as the
 * population needs and no character is discarded to make a row fit.
 */

import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  renderPdf,
  type PdfDocument,
  type PdfOperation,
  type PdfPage,
} from './pdf.js'

export interface DetailedReportColumn {
  readonly key: string
  readonly label: string
}

export interface DetailedReportFileRow {
  readonly id: number
  readonly values: Readonly<Record<string, string>>
  readonly notes?: string | null
}

export interface DetailedReportFileInput {
  readonly title: string
  readonly period: string
  readonly brandName: string
  readonly columns: readonly DetailedReportColumn[]
  readonly rows: readonly DetailedReportFileRow[]
  /** Repeated on every page so a detached page still states its population. */
  readonly runningTotals: readonly string[]
}

const LEFT = 42
const RIGHT = PDF_PAGE_WIDTH - 42
const TOP = PDF_PAGE_HEIGHT - 88
const BOTTOM = 62
const LINE_HEIGHT = 12
const NOTE_WIDTH = 92

/** Stable CSV escaping, including the spreadsheet formula guard used by the browser. */
const csvCell = (value: string): string => {
  const numeric = /^-?\d+(?:\.\d+)?$/u.test(value)
  const guarded = !numeric && /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value
  return `"${guarded.replaceAll('"', '""')}"`
}

export const renderDetailedReportCsv = (input: Readonly<DetailedReportFileInput>): string => {
  const header = [...input.columns.map((column) => column.label), 'Notes']
  const lines = [header.map(csvCell).join(',')]
  for (const row of input.rows) {
    lines.push(
      [...input.columns.map((column) => row.values[column.key] ?? ''), row.notes ?? '']
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/**
 * Wraps without losing text. Newlines remain hard breaks and overlong tokens
 * are sliced rather than elided, which is what keeps URLs and ticket refs in
 * the client document in full.
 */
export const wrapDetailedReportText = (text: string, width = NOTE_WIDTH): readonly string[] => {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError('report wrap width must be positive')
  const lines: string[] = []
  for (const paragraph of text.replaceAll('\r\n', '\n').split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }
    let remaining = paragraph
    while (remaining.length > width) {
      const candidate = remaining.slice(0, width + 1)
      const breakAt = candidate.lastIndexOf(' ')
      const take = breakAt > 0 ? breakAt : width
      lines.push(remaining.slice(0, take))
      remaining = remaining.slice(take)
      if (remaining.startsWith(' ')) remaining = remaining.slice(1)
    }
    lines.push(remaining)
  }
  return lines.length === 0 ? [''] : lines
}

const rowSummary = (
  row: Readonly<DetailedReportFileRow>,
  columns: readonly DetailedReportColumn[],
): string => columns.map((column) => row.values[column.key] ?? '').join('  |  ')

/** Public layout seam makes pagination and no-truncation assertions independent of PDF parsing. */
export const layoutDetailedReportDocument = (
  input: Readonly<DetailedReportFileInput>,
): PdfDocument => {
  if (input.columns.length === 0) throw new RangeError('a detailed report needs a column')
  let y = TOP
  let operations: PdfOperation[] = []
  const pages: PdfPage[] = []

  const startPage = (): void => {
    y = TOP
    operations = [
      { kind: 'rect', x: 0, y: PDF_PAGE_HEIGHT - 68, width: PDF_PAGE_WIDTH, height: 68, grey: 0.11 },
      { kind: 'text', x: LEFT, y: PDF_PAGE_HEIGHT - 38, size: 15, font: 'bold', text: input.brandName, grey: 1 },
      { kind: 'text', x: RIGHT, y: PDF_PAGE_HEIGHT - 38, size: 10, font: 'mono_bold', text: input.title, align: 'right', grey: 1 },
      { kind: 'text', x: LEFT, y: PDF_PAGE_HEIGHT - 54, size: 8, font: 'regular', text: input.period, grey: 0.8 },
    ]
  }
  const finishPage = (): void => {
    for (const [index, total] of input.runningTotals.entries()) {
      operations.push({
        kind: 'text', x: LEFT, y: 45 - index * 10, size: 7.5, font: 'mono', text: total, grey: 0.45,
      })
    }
    pages.push({ operations })
  }
  const nextPage = (): void => {
    finishPage()
    startPage()
  }
  const ensureLine = (): void => {
    if (y < BOTTOM + Math.max(18, input.runningTotals.length * 10)) nextPage()
  }
  const line = (
    text: string,
    font: 'regular' | 'bold' | 'mono' | 'mono_bold' = 'regular',
    grey = 0,
  ): void => {
    ensureLine()
    operations.push({ kind: 'text', x: LEFT, y, size: 8, font, text, grey })
    y -= LINE_HEIGHT
  }

  startPage()
  line(input.columns.map((column) => column.label.toUpperCase()).join('  |  '), 'mono_bold', 0.35)
  operations.push({ kind: 'line', x1: LEFT, y1: y + 4, x2: RIGHT, y2: y + 4, width: 0.6, grey: 0.75 })
  y -= 4
  for (const row of input.rows) {
    line(rowSummary(row, input.columns), 'mono')
    if (row.notes !== undefined && row.notes !== null) {
      for (const noteLine of wrapDetailedReportText(row.notes)) line(`  ${noteLine}`, 'regular', 0.2)
    }
    y -= 3
  }
  finishPage()

  const totalPages = pages.length
  const numbered = pages.map((page, index): PdfPage => ({
    operations: [
      ...page.operations,
      {
        kind: 'text', x: RIGHT, y: 34, size: 8, font: 'mono',
        text: `Page ${String(index + 1)} of ${String(totalPages)}`, align: 'right', grey: 0.5,
      },
    ],
  }))
  return { pages: numbered, title: input.title }
}

export const renderDetailedReportDocument = (
  input: Readonly<DetailedReportFileInput>,
): Uint8Array => renderPdf(layoutDetailedReportDocument(input))
