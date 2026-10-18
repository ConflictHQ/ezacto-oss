/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { sortReportTable, type ReportSortSpec } from '../src/components/report-table-sort.js'
import { setSortPreferenceOwner, type TableSort } from '../src/components/table-sort.js'

/**
 * Issue 852. A report table that draws itself gets the shared sortable header,
 * and its rows are reordered in place.
 */

afterEach(() => {
  setSortPreferenceOwner(null)
  localStorage.clear()
  document.body.replaceChildren()
})

interface Line {
  readonly name: string
  readonly hours: number
  readonly band?: string
}

const cell = (tag: 'th' | 'td', text: string): HTMLTableCellElement => {
  const element = document.createElement(tag)
  element.textContent = text
  return element
}

const draw = (lines: readonly Line[], withBands = false): HTMLTableElement => {
  const table = document.createElement('table')
  const head = document.createElement('thead')
  const headerRow = document.createElement('tr')
  for (const label of ['Name', 'Hours', 'Notes']) headerRow.append(cell('th', label))
  head.append(headerRow)
  const body = document.createElement('tbody')
  let band: string | undefined
  for (const line of lines) {
    if (withBands && line.band !== band) {
      band = line.band
      const bandRow = document.createElement('tr')
      bandRow.className = 'report-band-row'
      bandRow.append(cell('th', band ?? ''))
      body.append(bandRow)
    }
    const row = document.createElement('tr')
    row.dataset['name'] = line.name
    row.append(cell('td', line.name), cell('td', String(line.hours)), cell('td', ''))
    body.append(row)
  }
  table.append(head, body)
  document.body.append(table)
  return table
}

const spec = (
  lines: readonly Line[],
  overrides: Partial<ReportSortSpec> = {},
): ReportSortSpec => ({
  table: 'test',
  columns: {
    Name: { key: 'name', value: (index) => lines[index]!.name },
    Hours: { key: 'hours', value: (index) => lines[index]!.hours },
    Notes: { key: 'notes', value: () => null },
  },
  defaultSort: null,
  address: null,
  onSort: () => undefined,
  ...overrides,
})

const bodyRows = (table: HTMLTableElement): HTMLTableRowElement[] => [
  ...table.querySelectorAll<HTMLTableRowElement>('tbody > tr'),
]

const names = (table: HTMLTableElement): string[] =>
  bodyRows(table).map((row) => row.dataset['name'] ?? `[${row.textContent}]`)

const button = (table: HTMLTableElement, column: string): HTMLButtonElement =>
  table.querySelector<HTMLButtonElement>(`button[data-sort-column="${column}"]`)!

describe('sorting a report table', () => {
  const lines: Line[] = [
    { name: 'Gamma', hours: 2 },
    { name: 'Alpha', hours: 10 },
    { name: 'Beta', hours: 9 },
  ]

  it('[a11y] names each sortable column with a button and marks only the sorted one', () => {
    const table = draw(lines)
    sortReportTable(table, spec(lines, { defaultSort: { column: 'hours', direction: 'descending' } }))
    expect(names(table)).toEqual(['Alpha', 'Beta', 'Gamma'])
    const [name, hours] = [...table.querySelectorAll<HTMLTableCellElement>('thead th')]
    expect(name!.hasAttribute('aria-sort')).toBe(false)
    expect(hours!.getAttribute('aria-sort')).toBe('descending')
    expect(button(table, 'hours').textContent).toContain('Hours')
  })

  it('[unit] sorts on a click, reverses on the next, and tells the caller', () => {
    const table = draw(lines)
    const chosen: TableSort[] = []
    sortReportTable(table, spec(lines, { onSort: (sort) => chosen.push(sort) }))
    button(table, 'name').click()
    expect(names(table)).toEqual(['Alpha', 'Beta', 'Gamma'])
    button(table, 'name').click()
    expect(names(table)).toEqual(['Gamma', 'Beta', 'Alpha'])
    // Numbers sort as numbers: 9 comes before 10.
    button(table, 'hours').click()
    expect(names(table)).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(chosen).toEqual([
      { column: 'name', direction: 'ascending' },
      { column: 'name', direction: 'descending' },
      { column: 'hours', direction: 'ascending' },
    ])
    // Focus stays on the header that was used, though the header was redrawn.
    expect(document.activeElement).toBe(button(table, 'hours'))
  })

  it('[unit] moves the row elements rather than redrawing them, so state on a row survives', () => {
    const table = draw(lines)
    sortReportTable(table, spec(lines))
    const gamma = bodyRows(table)[0]!
    gamma.dataset['ticked'] = 'yes'
    button(table, 'name').click()
    expect(bodyRows(table)[2]).toBe(gamma)
    expect(gamma.dataset['ticked']).toBe('yes')
  })

  it('[unit] keeps empty values last in both directions and leaves unsortable headers alone', () => {
    const withBlank: Line[] = [{ name: 'B', hours: 1 }, { name: 'A', hours: 2 }]
    const table = draw(withBlank)
    sortReportTable(
      table,
      spec(withBlank, {
        columns: { Name: { key: 'name', value: (index) => (index === 0 ? null : withBlank[index]!.name) } },
      }),
    )
    button(table, 'name').click()
    expect(names(table)).toEqual(['A', 'B'])
    button(table, 'name').click()
    expect(names(table)).toEqual(['A', 'B'])
    expect(table.querySelector('button[data-sort-column="hours"]')).toBeNull()
  })

  it('[unit] sorts inside each band and keeps the band in front of its rows', () => {
    const banded: Line[] = [
      { name: 'Zed', hours: 1, band: 'North' },
      { name: 'Amy', hours: 2, band: 'North' },
      { name: 'Yan', hours: 3, band: 'South' },
      { name: 'Bob', hours: 4, band: 'South' },
    ]
    const table = draw(banded, true)
    sortReportTable(table, spec(banded))
    button(table, 'name').click()
    expect(names(table)).toEqual(['[North]', 'Amy', 'Zed', '[South]', 'Bob', 'Yan'])
  })

  it('[unit] moves rows that belong together as one unit', () => {
    // A project's second currency sits under a name printed once.
    const units: Line[] = [
      { name: 'Zed', hours: 1 },
      { name: '', hours: 2 },
      { name: 'Amy', hours: 3 },
    ]
    const table = draw(units)
    sortReportTable(
      table,
      spec(units, {
        columns: { Name: { key: 'name', value: (index) => ['Zed', 'Zed', 'Amy'][index]! } },
        unit: (index) => (index < 2 ? 1 : 2),
      }),
    )
    button(table, 'name').click()
    expect(bodyRows(table).map((row) => row.children[1]!.textContent)).toEqual(['3', '1', '2'])
  })

  it('[unit] starts from the address, then the remembered choice, then the default', () => {
    setSortPreferenceOwner(7)
    const first = draw(lines)
    const onSort = vi.fn()
    sortReportTable(first, spec(lines, { onSort, address: { column: 'name', direction: 'descending' } }))
    expect(names(first)).toEqual(['Gamma', 'Beta', 'Alpha'])
    button(first, 'hours').click()

    // Another visit with no address: this person's last choice.
    document.body.replaceChildren()
    const second = draw(lines)
    sortReportTable(second, spec(lines, { defaultSort: { column: 'name', direction: 'ascending' } }))
    expect(names(second)).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(localStorage.getItem('ezacto:user:7:table-sort:report-test')).toBe('hours')

    // A remembered column the table no longer has falls back to the default.
    document.body.replaceChildren()
    const third = draw(lines)
    sortReportTable(
      third,
      spec(lines, {
        columns: { Name: { key: 'name', value: (index) => lines[index]!.name } },
        defaultSort: { column: 'name', direction: 'ascending' },
      }),
    )
    expect(names(third)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})
