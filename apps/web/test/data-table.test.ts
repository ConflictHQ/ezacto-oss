/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { renderDataTable, type DataColumn } from '../src/components/data-table.js'

interface Project {
  id: number
  client: string
  name: string
  spentCents: number
}

const rows: Project[] = [
  { id: 1, client: 'Vantage IT', name: 'Silverpine', spentCents: 105_760 },
  { id: 2, client: 'Vantage IT', name: 'Larkspur Skincare', spentCents: 204_750 },
  { id: 3, client: 'Halcyon Biolabs', name: 'Atlas Phase 1a', spentCents: 47_682 },
]

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`

const columns: readonly DataColumn<Project>[] = [
  { key: 'name', label: 'Project', render: (row) => row.name },
  {
    key: 'spent',
    label: 'Spent',
    numeric: true,
    render: (row) => money(row.spentCents),
    total: (all) => money(all.reduce((sum, row) => sum + row.spentCents, 0)),
  },
]

const table = (overrides: Partial<Parameters<typeof renderDataTable<Project>>[0]> = {}) =>
  renderDataTable<Project>({
    columns,
    rows,
    rowKey: (row) => String(row.id),
    caption: 'Projects',
    ...overrides,
  })

describe('data table', () => {
  it('[unit] right-aligns numeric columns and totals only the columns that can total', () => {
    const element = table()
    const headers = [...element.querySelectorAll('thead th')].map((cell) => cell.textContent)
    expect(headers).toEqual(['Project', 'Spent'])
    expect(element.querySelector('thead th[data-column="spent"]')?.className).toContain(
      'is-numeric',
    )
    const totals = [...element.querySelectorAll('tfoot td')].map((cell) => cell.textContent)
    // The first column has no total of its own, so it names the row instead.
    // 105760 + 204750 + 47682 = 358192 cents
    expect(totals).toEqual(['Total', '$3581.92'])
  })

  it('[unit] bands each run of rows sharing a group, once per run', () => {
    const element = table({ groupBy: (row) => row.client })
    const bands = [...element.querySelectorAll('.data-table-group th')].map(
      (cell) => cell.textContent,
    )
    expect(bands).toEqual(['Vantage IT', 'Halcyon Biolabs'])
    expect(element.querySelectorAll('tbody tr[data-row]')).toHaveLength(3)
  })

  it('[unit] repeats a band when the rows are not sorted by the group, visibly', () => {
    // Grouping deliberately does not reorder. A caller that sorts differently
    // to how it groups should see the fault rather than have it hidden.
    const element = renderDataTable<Project>({
      columns,
      rows: [rows[0]!, rows[2]!, rows[1]!],
      rowKey: (row) => String(row.id),
      groupBy: (row) => row.client,
      caption: 'Projects',
    })
    const bands = [...element.querySelectorAll('.data-table-group th')].map(
      (cell) => cell.textContent,
    )
    expect(bands).toEqual(['Vantage IT', 'Halcyon Biolabs', 'Vantage IT'])
  })

  it('[unit] renders no totals row when no column can total itself', () => {
    const element = renderDataTable<Project>({
      columns: [{ key: 'name', label: 'Project', render: (row) => row.name }],
      rows,
      rowKey: (row) => String(row.id),
      caption: 'Projects',
    })
    expect(element.querySelector('tfoot')).toBeNull()
  })

  it('[unit] shows the empty message across the full width instead of a totals row', () => {
    const element = table({ rows: [], empty: 'No projects yet.' })
    const cell = element.querySelector<HTMLTableCellElement>('.data-table-empty')
    expect(cell?.textContent).toBe('No projects yet.')
    expect(cell?.colSpan).toBe(2)
    expect(element.querySelector('tfoot')).toBeNull()
  })

  it('[unit] puts primary actions inline and the rest behind an overflow', () => {
    const edit = vi.fn()
    const archive = vi.fn()
    const element = table({
      actions: () => [
        { label: 'Edit', primary: true, onSelect: edit },
        { label: 'Archive', onSelect: archive },
      ],
    })
    const first = element.querySelector('tbody tr[data-row]')!
    expect(first.querySelector<HTMLButtonElement>('.data-table-action')?.textContent).toBe('Edit')

    first.querySelector<HTMLButtonElement>('.data-table-action')!.click()
    expect(edit).toHaveBeenCalledOnce()

    const overflow = first.querySelector<HTMLDetailsElement>('.data-table-overflow')!
    overflow.open = true
    overflow.querySelector<HTMLButtonElement>('.data-table-menu button')!.click()
    expect(archive).toHaveBeenCalledOnce()
    // Choosing an item closes the menu behind it.
    expect(overflow.open).toBe(false)

    // The actions column spans the header too, or the row would be short a cell.
    expect(element.querySelectorAll('thead th')).toHaveLength(3)
  })

  it('[unit] disables the control rather than silently ignoring the click', () => {
    // Guarding inside onSelect would leave an enabled-looking button that does
    // nothing, which is worse than the card lists this replaced.
    const edit = vi.fn()
    const archive = vi.fn()
    const element = table({
      actions: () => [
        { label: 'Edit', primary: true, disabled: true, onSelect: edit },
        { label: 'Archive', disabled: true, onSelect: archive },
      ],
    })
    const first = element.querySelector('tbody tr[data-row]')!
    expect(first.querySelector<HTMLButtonElement>('.data-table-action')?.disabled).toBe(true)
    expect(
      first.querySelector<HTMLButtonElement>('.data-table-menu button')?.disabled,
    ).toBe(true)
  })

  it('[unit] keys every row so a re-render can be reconciled', () => {
    const keys = [...table().querySelectorAll('tbody tr[data-row]')].map(
      (row) => (row as HTMLElement).dataset.rowKey,
    )
    expect(keys).toEqual(['1', '2', '3'])
  })
})
