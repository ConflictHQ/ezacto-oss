/**
 * Sorting a table by one of its columns (issue 852).
 *
 * One header, one comparison and one memory, shared by the data table and by
 * the report tables, which are drawn by hand. Sorting existed on the payment
 * tables alone, and every other list had a fixed order -- which is why sorting
 * invoices by date or by number, the two things an operator reaches for most,
 * was not possible anywhere.
 *
 * The header follows the sortable-table pattern of the WAI-ARIA Authoring
 * Practices: the column's own name is a button, the sorted column's header
 * cell carries `aria-sort`, and no other header claims one. The mark beside
 * the name is drawn, not read, because `aria-sort` already says it.
 */

import { icon } from './icons.js'

export type SortDirection = 'ascending' | 'descending'

export interface TableSort {
  readonly column: string
  readonly direction: SortDirection
}

/**
 * What a column sorts by. A list compares element by element, which is how a
 * money column sorts by currency and then amount without adding two
 * currencies together. `null` is a row with no value; it sorts last whichever
 * way the column runs, because "nothing" is not the smallest amount or the
 * earliest date.
 */
export type SortValue = string | number | readonly (string | number)[] | null

/**
 * Natural order: digits compare as numbers, so invoice 9 comes before 10 and
 * 1315, and "INV-9" before "INV-10". Base sensitivity, because a list that put
 * every lower-case name after every capitalised one would read as unsorted.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

const compareParts = (left: string | number, right: string | number): number =>
  typeof left === 'number' && typeof right === 'number'
    ? left - right
    : collator.compare(String(left), String(right))

/** Negative when `left` sorts first in ascending order. Neither may be null. */
export const compareSortValues = (
  left: Exclude<SortValue, null>,
  right: Exclude<SortValue, null>,
): number => {
  const first: readonly (string | number)[] = typeof left === 'object' ? left : [left]
  const second: readonly (string | number)[] = typeof right === 'object' ? right : [right]
  for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
    const x = first[index]
    const y = second[index]
    if (x === undefined) return y === undefined ? 0 : -1
    if (y === undefined) return 1
    const order = compareParts(x, y)
    if (order !== 0) return order
  }
  return 0
}

/**
 * The rows in the order a sort asks for, as a new array.
 *
 * Stable: rows the sort cannot tell apart keep the order they arrived in,
 * which is the server's, so two rows that tie never trade places between one
 * render and the next. Reversing the direction reverses the comparison, not
 * the list, for the same reason.
 */
export const sortRows = <Row>(
  rows: readonly Row[],
  valueOf: (row: Row) => SortValue,
  direction: SortDirection,
): Row[] =>
  rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((left, right) => {
      if (left.value === null || right.value === null) {
        if (left.value !== null) return -1
        if (right.value !== null) return 1
        return left.index - right.index
      }
      const order = compareSortValues(left.value, right.value)
      if (order !== 0) return direction === 'descending' ? -order : order
      return left.index - right.index
    })
    .map(({ row }) => row)

/** The other way round. */
export const reverseDirection = (direction: SortDirection): SortDirection =>
  direction === 'ascending' ? 'descending' : 'ascending'

/**
 * What activating a column's header asks for: the sorted column turns round,
 * any other column starts ascending.
 */
export const nextSort = (column: string, current: TableSort | null): TableSort => ({
  column,
  direction:
    current?.column === column && current.direction === 'ascending' ? 'descending' : 'ascending',
})

/**
 * A sort as one word -- `hours` ascending, `-hours` descending -- which is how
 * it travels in a report's address and how it is remembered. The column is a
 * table's own key, so the pattern is narrow on purpose: anything else read back
 * from an address or from storage is not a sort this code wrote.
 */
export const sortToken = (sort: TableSort): string =>
  `${sort.direction === 'descending' ? '-' : ''}${sort.column}`

const tokenPattern = /^(-?)([A-Za-z][A-Za-z0-9_-]{0,63})$/u

export const parseSortToken = (token: string | null | undefined): TableSort | null => {
  if (typeof token !== 'string') return null
  const match = tokenPattern.exec(token)
  if (match === null) return null
  return { column: match[2]!, direction: match[1] === '-' ? 'descending' : 'ascending' }
}

/**
 * The first sort the table can carry out, else its default.
 *
 * The candidates are in order of authority -- typically an address, then the
 * remembered choice -- and each is checked against the columns the table has
 * now, so a column that was renamed or that this viewer cannot see falls back
 * rather than leaving a table sorted by nothing in particular.
 */
export const resolveSort = (
  candidates: readonly (TableSort | null | undefined)[],
  sortable: (column: string) => boolean,
  fallback: TableSort | null,
): TableSort | null => candidates.find((sort) => sort != null && sortable(sort.column)) ?? fallback

/**
 * Whose choices are remembered. Set by the shell when somebody signs in and
 * cleared when they sign out, so a shared browser keeps one person's sort
 * order away from the next person's lists. Without an owner nothing is read or
 * written: a table still sorts, it just starts from its default next time.
 */
let preferenceOwner: number | null = null

export const setSortPreferenceOwner = (userId: number | null): void => {
  preferenceOwner = userId !== null && Number.isSafeInteger(userId) && userId > 0 ? userId : null
}

/**
 * `ezacto:user:<id>:…` is the shape the week grid's remembered rows already
 * use, so one person's browser state reads as one family of keys.
 */
const storageKey = (table: string): string | null =>
  preferenceOwner === null ? null : `ezacto:user:${preferenceOwner}:table-sort:${table}`

/** The sort this person last chose for a table, or null. */
export const rememberedSort = (table: string): TableSort | null => {
  const key = storageKey(table)
  if (key === null) return null
  try {
    return parseSortToken(localStorage.getItem(key))
  } catch {
    // Disabled or unavailable storage: the default order applies.
    return null
  }
}

export const rememberSort = (table: string, sort: TableSort): void => {
  const key = storageKey(table)
  if (key === null) return
  try {
    localStorage.setItem(key, sortToken(sort))
  } catch {
    // Private mode or a full quota. The sort still applies on this page; it is
    // only not remembered, which is not worth an error in somebody's face.
  }
}

/**
 * What a Load-more list adds to its status line while more pages remain: the
 * browser sorts the rows it has, and the rest are not in them (issue 852).
 * Their search says the same of itself.
 */
export const loadedRowsSortNotice = ' Sorting covers only the rows loaded so far; load more to include the rest.'

export interface SortHeaderOptions {
  /** The column's key, carried as `data-sort-column` on the button. */
  readonly column: string
  /** The header's text, which is also the button's accessible name. */
  readonly label: string
  /** The table's current sort, or null for a table in server order. */
  readonly sort: TableSort | null
  readonly onSort: (next: TableSort) => void
  /** A tooltip for a column whose sort is not obvious from its name. */
  readonly description?: string
}

/**
 * Puts a column's sort button into its header cell.
 *
 * `aria-sort` goes on the sorted column only; the attribute is removed from a
 * cell that is not sorted, so a header redrawn after a sort never carries a
 * stale direction.
 */
export const sortableHeader = (
  cell: HTMLTableCellElement,
  options: SortHeaderOptions,
): HTMLButtonElement => {
  const active = options.sort?.column === options.column ? options.sort : null
  if (active === null) cell.removeAttribute('aria-sort')
  else cell.setAttribute('aria-sort', active.direction)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'table-sort'
  button.dataset.sortColumn = options.column
  if (options.description !== undefined) button.title = options.description
  const label = document.createElement('span')
  label.className = 'table-sort-label'
  label.textContent = options.label
  // appendChild, not append: see icons.ts on the worker tsconfig.
  button.appendChild(label)
  button.appendChild(icon('sort'))
  button.addEventListener('click', () => {
    options.onSort(nextSort(options.column, options.sort))
  })
  cell.replaceChildren(button)
  return button
}

/**
 * Moves focus back to a column's sort button after the table it sat in was
 * drawn again. The old button left the document with the old table, so
 * without this a keyboard user is dropped to the top of the page every time
 * they sort.
 */
export const focusSortHeader = (container: HTMLElement, column: string): void => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button[data-sort-column]')].find(
    (candidate) => candidate.dataset.sortColumn === column,
  )
  button?.focus({ preventScroll: true })
}
