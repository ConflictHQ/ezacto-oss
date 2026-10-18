/**
 * Sorting a report table that draws itself (issue 852).
 *
 * The report tables are built row by row from the report, so they are not a
 * `renderDataTable`. This puts the shared sortable header on one that is
 * already built and reorders its rows in place: the row elements move and are
 * not redrawn, so anything attached to them -- a selection checkbox, a focused
 * link -- survives a sort.
 *
 * Rows sort inside their bands (a band row heads a run of rows and stays in
 * front of it), and rows that belong together -- a project's second currency
 * under a project name that is printed once -- move as one unit.
 */

import {
  focusSortHeader,
  rememberedSort,
  rememberSort,
  resolveSort,
  sortableHeader,
  sortRows,
  type SortValue,
  type TableSort,
} from './table-sort.js'

export interface ReportSortColumn {
  /** The column's key; it is what `sort=` in the report's address names. */
  readonly key: string
  /** The sortable value of the nth data row (its position among the table's rows as drawn). */
  readonly value: (index: number) => SortValue
}

export interface ReportSortSpec {
  /** Names the table for the sort it remembers per person: `report-<name>`. */
  readonly table: string
  /** The header text of each sortable column, mapped to how it sorts. */
  readonly columns: Readonly<Record<string, ReportSortColumn>>
  /** The order the rows arrive in, said as a sort so the table always shows one. */
  readonly defaultSort: TableSort | null
  /** Data rows that move together: the same unit key, next to each other. */
  readonly unit?: (index: number) => string | number
  /** The sort the address asks for, which comes before the remembered one. */
  readonly address: TableSort | null
  /** Called with a sort the person chose, to write it to the address. */
  readonly onSort: (sort: TableSort) => void
  /** Rows that head a run of rows. Defaults to the detailed and time reports' band rows. */
  readonly bandSelector?: string
}

interface Entry {
  readonly row: HTMLTableRowElement
  readonly index: number
}

interface Segment {
  readonly band: HTMLTableRowElement | null
  readonly entries: Entry[]
  /** Rows after the data rows, such as a band's subtotal, that stay at the end. */
  readonly tail: HTMLTableRowElement[]
}

/**
 * Puts sortable headers on `table` and orders its rows. Returns the sort in
 * force, or null when the table has none.
 */
export const sortReportTable = (
  table: HTMLTableElement,
  spec: Readonly<ReportSortSpec>,
): TableSort | null => {
  const body = table.querySelector('tbody')
  const headerRow = table.querySelector('thead tr')
  if (body === null || headerRow === null) return null
  const bandSelector = spec.bandSelector ?? '.report-band-row, .report-group-row'
  const sortable = (key: string): boolean =>
    Object.values(spec.columns).some((column) => column.key === key)
  const memory = `report-${spec.table}`

  const segments: Segment[] = []
  let current: Segment = { band: null, entries: [], tail: [] }
  segments.push(current)
  let index = 0
  for (const row of body.querySelectorAll<HTMLTableRowElement>(':scope > tr')) {
    if (row.matches(bandSelector)) {
      current = { band: row, entries: [], tail: [] }
      segments.push(current)
    } else if (row.dataset['reportRow'] === 'tail') {
      current.tail.push(row)
    } else {
      current.entries.push({ row, index })
      index += 1
    }
  }

  const headers = [...headerRow.querySelectorAll<HTMLTableCellElement>(':scope > th, :scope > td')].flatMap((cell) => {
    const column = spec.columns[cell.textContent?.trim() ?? '']
    return column === undefined ? [] : [{ cell, label: cell.textContent!.trim(), column }]
  })

  const apply = (sort: TableSort | null): void => {
    const column = headers.find((header) => header.column.key === sort?.column)?.column
    for (const segment of segments) {
      let ordered = segment.entries
      if (sort !== null && column !== undefined) {
        if (spec.unit === undefined) {
          ordered = sortRows(segment.entries, (entry) => column.value(entry.index), sort.direction)
        } else {
          const units: Entry[][] = []
          for (const entry of segment.entries) {
            const last = units.at(-1)
            if (last !== undefined && spec.unit(last[0]!.index) === spec.unit(entry.index)) {
              last.push(entry)
            } else {
              units.push([entry])
            }
          }
          ordered = sortRows(units, (unit) => column.value(unit[0]!.index), sort.direction).flat()
        }
      }
      // Appending moves an element, so the body ends up in exactly this order.
      if (segment.band !== null) body.append(segment.band)
      for (const entry of ordered) body.append(entry.row)
      for (const row of segment.tail) body.append(row)
    }
  }

  const header = (sort: TableSort | null): void => {
    for (const { cell, label, column } of headers) {
      sortableHeader(cell, {
        column: column.key,
        label,
        sort,
        onSort: (next) => {
          rememberSort(memory, next)
          spec.onSort(next)
          apply(next)
          header(next)
          focusSortHeader(table, next.column)
        },
      })
    }
  }

  const sort = resolveSort([spec.address, rememberedSort(memory)], sortable, spec.defaultSort)
  header(sort)
  if (sort !== null) apply(sort)
  return sort
}
