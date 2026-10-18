/**
 * The one table.
 *
 * Old Harvest was a single table system wearing nine sets of columns — a grey
 * header band, hairline row rules, no zebra, grouping by a full-width
 * sub-header, numerics right-aligned on tabular figures, a bold unruled total
 * row, and row actions that appear on hover. Every list screen was that system.
 *
 * ezacto had built it once, in the week grid, and hand-rolled a different card
 * list everywhere else — which is why density, hover, group bands and numeric
 * alignment were missing eight times over. This is that system, extracted, so
 * a list screen is a set of columns rather than a fresh pile of divs.
 *
 * See screens/HRVST10/OLD-UI-ANALYSIS.md §2 (design language), §4 (information
 * density) and §6 (rows and actions).
 */

import { icon } from './icons.js'
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

/** A cell's content. Strings are text; nodes are appended as given. */
export type CellContent = string | Node
export type DataSortValue = SortValue
export type DataTableSort = TableSort

export interface DataColumn<Row> {
  /** Stable identifier, used for the cell's `data-column`. */
  readonly key: string
  /** Header text. Empty renders an unlabelled column, e.g. the actions slot. */
  readonly label: string
  /**
   * Right-align on tabular figures. Money, hours and counts are numeric;
   * identifiers and dates are not, however many digits they contain.
   */
  readonly numeric?: boolean
  /**
   * Shrink to the content, so the free-text column takes the slack. A status,
   * a date or an invoice number needs its own width and no more; without this
   * every column shares the width equally and the name is the one that gets
   * clipped while its neighbours sit half empty. Numeric columns do this already.
   */
  readonly fit?: boolean
  /**
   * Let a long free-text column wrap onto further lines instead of ending in an
   * ellipsis the person cannot read past. Use sparingly: it gives up the
   * one-line row.
   */
  readonly wrap?: boolean
  readonly render: (row: Row) => CellContent
  /** Enables sorting by underlying values. Nulls stay last in both directions. */
  readonly sortValue?: (row: Row) => DataSortValue
  readonly sortDescription?: string
  /**
   * Contributes this column's total. Columns without one leave the cell blank
   * in the totals row, which is why the row only appears when at least one
   * column defines it.
   */
  readonly total?: (rows: readonly Row[]) => CellContent
}

export interface RowAction {
  readonly label: string
  /** Rendered inline on hover. Others fall into the overflow menu. */
  readonly primary?: boolean
  /**
   * Renders the control disabled. Guarding inside `onSelect` instead leaves an
   * enabled-looking button that silently does nothing, which is worse than the
   * card lists this replaced — they disabled the button itself.
   */
  readonly disabled?: boolean
  /**
   * Dataset keys to set on the rendered control. Callers that re-enable their
   * own buttons by sweeping a marker attribute need the control to carry it,
   * or it is disabled once and never restored.
   */
  readonly dataset?: Readonly<Record<string, string>>
  readonly onSelect: () => void
}

export interface DataTableOptions<Row> {
  readonly columns: readonly DataColumn<Row>[]
  readonly rows: readonly Row[]
  /**
   * The sort the table shows, when the caller keeps it (in its address, say).
   * Without one the table falls back to the sort this person last chose for
   * `table`, then to `defaultSort`.
   */
  readonly sort?: DataTableSort
  /** Retain the selected sort across caller-driven refreshes and filtering. */
  readonly onSort?: (sort: DataTableSort) => void
  /**
   * Names the table for the sort it remembers per person. Without a name the
   * sort lasts as long as the page.
   */
  readonly table?: string
  /**
   * The order the rows arrive in, said as a sort, so the table always shows
   * which column it is ordered by (issue 852).
   */
  readonly defaultSort?: DataTableSort
  /**
   * The rows arrive already in the order `sort` names, because the server put
   * them there. The headers still ask for a sort; the table does not reorder,
   * and `onSort` is what fetches the rows again. A page of a longer list sorted
   * in the browser would claim an order the rest of the list does not have.
   */
  readonly serverSort?: boolean
  /** Distinguishes rows for `data-row-key`; must be stable across renders. */
  readonly rowKey: (row: Row) => string
  /**
   * Full-width grey sub-header above each run of rows sharing a label. Rows
   * must already be sorted by it — grouping does not reorder, so a caller that
   * sorts differently to how it groups gets repeated bands, which is a visible
   * bug rather than a silent one.
   */
  readonly groupBy?: (row: Row) => string
  /**
   * Fills the band. `groupBy` still decides where one starts, so a band that
   * links to the thing it names does not change how rows are grouped.
   */
  readonly renderGroup?: (row: Row) => CellContent
  readonly actions?: (row: Row) => readonly RowAction[]
  /** Accessible name. */
  readonly caption: string
  /** Shown in place of the body when there are no rows. */
  readonly empty?: string
}

const put = (cell: HTMLElement, content: CellContent): void => {
  if (typeof content === 'string') cell.textContent = content
  else cell.appendChild(content)
}

const applyDataset = (element: HTMLElement, action: RowAction): void => {
  if (action.dataset === undefined) return
  for (const [key, value] of Object.entries(action.dataset)) element.dataset[key] = value
}

const actionsCell = (actions: readonly RowAction[]): HTMLTableCellElement => {
  const cell = document.createElement('td')
  cell.className = 'data-table-actions'
  const inline = actions.filter((action) => action.primary === true)
  const overflow = actions.filter((action) => action.primary !== true)
  for (const action of inline) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'data-table-action'
    button.textContent = action.label
    button.disabled = action.disabled === true
    applyDataset(button, action)
    button.addEventListener('click', action.onSelect)
    cell.appendChild(button)
  }
  if (overflow.length > 0) {
    const details = document.createElement('details')
    details.className = 'data-table-overflow'
    const summary = document.createElement('summary')
    // The control names itself, so the mark inside it is hidden: a reader that
    // announced both would say "More actions, image" on every row.
    summary.setAttribute('aria-label', 'More actions')
    summary.appendChild(icon('overflow'))
    const menu = document.createElement('div')
    menu.className = 'data-table-menu'
    for (const action of overflow) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = action.label
      button.disabled = action.disabled === true
      applyDataset(button, action)
      button.addEventListener('click', () => {
        details.open = false
        action.onSelect()
      })
      menu.appendChild(button)
    }
    details.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && details.open) {
        event.preventDefault()
        event.stopPropagation()
        details.open = false
        summary.focus()
      }
    })
    details.appendChild(summary)
    details.appendChild(menu)
    cell.appendChild(details)
  }
  return cell
}

export const renderDataTable = <Row>(options: DataTableOptions<Row>): HTMLElement => {
  const { columns, rowKey, groupBy, renderGroup, actions, caption, empty } = options
  const sort = resolveSort(
    [options.sort, options.table === undefined ? null : rememberedSort(options.table)],
    (key) => columns.some((column) => column.key === key && column.sortValue !== undefined),
    options.defaultSort ?? null,
  )
  const sortValue = columns.find((column) => column.key === sort?.column)?.sortValue
  let rows: readonly Row[] = options.rows
  if (sort !== null && sortValue !== undefined && options.serverSort !== true) {
    if (groupBy === undefined) {
      rows = sortRows(options.rows, sortValue, sort.direction)
    } else {
      // Rows sort inside their bands. The bands keep the order they first
      // appeared in, so a band's total still closes the band it belongs to.
      const bands = new Map<string, Row[]>()
      for (const row of options.rows) {
        const band = groupBy(row)
        bands.set(band, [...(bands.get(band) ?? []), row])
      }
      rows = [...bands.values()].flatMap((members) => sortRows(members, sortValue, sort.direction))
    }
  }
  const table = document.createElement('table')
  table.className = columns.length > 4 ? 'data-table data-table-wide' : 'data-table'

  const captionElement = document.createElement('caption')
  captionElement.className = 'visually-hidden'
  captionElement.textContent = caption
  table.appendChild(captionElement)

  const span = columns.length + (actions === undefined ? 0 : 1)

  const head = document.createElement('thead')
  const headRow = document.createElement('tr')
  for (const column of columns) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.textContent = column.label
    cell.dataset.column = column.key
    if (column.sortValue !== undefined) {
      sortableHeader(cell, {
        column: column.key,
        label: column.label,
        sort,
        ...(column.sortDescription === undefined ? {} : { description: column.sortDescription }),
        onSort: (next) => {
          if (options.table !== undefined) rememberSort(options.table, next)
          options.onSort?.(next)
          // Rows the server ordered are drawn again by whoever fetches them.
          if (options.serverSort === true) return
          const replacement = renderDataTable({ ...options, sort: next })
          const scrollLeft = scroll.scrollLeft
          const scrollTop = scroll.scrollTop
          scroll.replaceWith(replacement)
          replacement.scrollLeft = scrollLeft
          replacement.scrollTop = scrollTop
          focusSortHeader(replacement, next.column)
        },
      })
    }
    if (column.numeric === true) cell.classList.add('is-numeric')
    if (column.fit === true) cell.classList.add('is-fit')
    if (column.wrap === true) cell.classList.add('is-wrap')
    headRow.appendChild(cell)
  }
  if (actions !== undefined) {
    const cell = document.createElement('th')
    cell.scope = 'col'
    cell.className = 'data-table-actions'
    // Unlabelled visually — the buttons name themselves — but not to a reader.
    const label = document.createElement('span')
    label.className = 'visually-hidden'
    label.textContent = 'Actions'
    cell.appendChild(label)
    headRow.appendChild(cell)
  }
  head.appendChild(headRow)
  table.appendChild(head)

  const body = document.createElement('tbody')
  if (rows.length === 0) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = span
    cell.className = 'data-table-empty'
    cell.textContent = empty ?? 'Nothing to show.'
    row.appendChild(cell)
    body.appendChild(row)
  }

  // A grouped table closes each run with the same totals its footer carries.
  // The old expenses list ends every week with a right-aligned `Total:`, which
  // is what makes a band a section rather than a label.
  const totalled = columns.some((column) => column.total !== undefined)
  const groupTotalRow = (members: Row[]): HTMLTableRowElement => {
    const row = document.createElement('tr')
    row.className = 'data-table-group-total'
    for (const [index, column] of columns.entries()) {
      const cell = document.createElement('td')
      cell.dataset.column = column.key
      if (column.numeric === true) cell.classList.add('is-numeric')
      if (column.fit === true) cell.classList.add('is-fit')
      if (column.wrap === true) cell.classList.add('is-wrap')
      if (column.total !== undefined) put(cell, column.total(members))
      else if (index === 0) cell.textContent = 'Total'
      row.appendChild(cell)
    }
    if (actions !== undefined) row.appendChild(document.createElement('td'))
    return row
  }

  let currentGroup: string | undefined
  let groupMembers: Row[] = []
  for (const row of rows) {
    if (groupBy !== undefined) {
      const group = groupBy(row)
      if (group !== currentGroup) {
        if (totalled && groupMembers.length > 0) body.appendChild(groupTotalRow(groupMembers))
        groupMembers = []
        currentGroup = group
        const bandRow = document.createElement('tr')
        bandRow.className = 'data-table-group'
        const bandCell = document.createElement('th')
        bandCell.scope = 'colgroup'
        bandCell.colSpan = span
        put(bandCell, renderGroup === undefined ? group : renderGroup(row))
        bandRow.appendChild(bandCell)
        body.appendChild(bandRow)
      }
    }
    const element = document.createElement('tr')
    element.dataset.row = ''
    element.dataset.rowKey = rowKey(row)
    for (const column of columns) {
      const cell = document.createElement('td')
      cell.dataset.column = column.key
      if (column.numeric === true) cell.classList.add('is-numeric')
      if (column.fit === true) cell.classList.add('is-fit')
      if (column.wrap === true) cell.classList.add('is-wrap')
      put(cell, column.render(row))
      element.appendChild(cell)
    }
    if (actions !== undefined) element.appendChild(actionsCell(actions(row)))
    body.appendChild(element)
    groupMembers.push(row)
  }
  if (groupBy !== undefined && totalled && groupMembers.length > 0) {
    body.appendChild(groupTotalRow(groupMembers))
  }
  table.appendChild(body)

  // A totals row only earns its place when a column knows how to total itself.
  if (rows.length > 0 && columns.some((column) => column.total !== undefined)) {
    const foot = document.createElement('tfoot')
    const totalRow = document.createElement('tr')
    for (const [index, column] of columns.entries()) {
      const cell = document.createElement('td')
      cell.dataset.column = column.key
      if (column.numeric === true) cell.classList.add('is-numeric')
      if (column.fit === true) cell.classList.add('is-fit')
      if (column.wrap === true) cell.classList.add('is-wrap')
      if (column.total !== undefined) put(cell, column.total(rows))
      else if (index === 0) cell.textContent = 'Total'
      totalRow.appendChild(cell)
    }
    if (actions !== undefined) totalRow.appendChild(document.createElement('td'))
    foot.appendChild(totalRow)
    table.appendChild(foot)
  }

  // A table narrower than its columns scrolls inside its own container; the
  // page itself must not scroll sideways on a phone.
  const scroll = document.createElement('div')
  scroll.className = 'data-table-scroll'
  scroll.tabIndex = 0
  scroll.setAttribute('role', 'region')
  scroll.setAttribute('aria-label', caption)
  if (columns.length > 4 && rows.length > 0) {
    const hint = document.createElement('p')
    hint.className = 'data-table-scroll-hint'
    hint.textContent = 'Scroll horizontally to see all columns and actions.'
    scroll.appendChild(hint)
  }
  scroll.appendChild(table)
  return scroll
}
