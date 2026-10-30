/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderDataTable, type DataColumn } from '../src/components/data-table.js'
import {
  compareSortValues,
  nextSort,
  parseSortToken,
  rememberedSort,
  rememberSort,
  resolveSort,
  setSortPreferenceOwner,
  sortRows,
  sortToken,
} from '../src/components/table-sort.js'

/**
 * Issue 852. One sortable header, one comparison and one memory, shared by the
 * data table and by the tables that draw themselves.
 */

afterEach(() => {
  setSortPreferenceOwner(null)
  localStorage.clear()
})

describe('comparing values', () => {
  it('[unit] sorts invoice numbers as numbers, so 9 comes before 10 and 1315', () => {
    const numbers = ['1315', '10', '9', '100']
    expect(sortRows(numbers, (value) => value, 'ascending')).toEqual(['9', '10', '100', '1315'])
    expect(sortRows(['INV-10', 'INV-9', 'inv-2'], (value) => value, 'ascending')).toEqual([
      'inv-2',
      'INV-9',
      'INV-10',
    ])
  })

  it('[unit] compares a list element by element, so money sorts by currency and then amount', () => {
    const money = [
      { id: 'a', value: ['USD', 5_000] },
      { id: 'b', value: ['EUR', 90_000] },
      { id: 'c', value: ['USD', 1_000] },
    ]
    expect(sortRows(money, (row) => row.value, 'ascending').map((row) => row.id)).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(compareSortValues(['USD'], ['USD', 1])).toBeLessThan(0)
  })

  it('[unit] puts empty values last whichever way the column runs', () => {
    const rows = [
      { id: 'none', value: null },
      { id: 'one', value: 1 },
      { id: 'three', value: 3 },
    ]
    expect(sortRows(rows, (row) => row.value, 'ascending').map((row) => row.id)).toEqual([
      'one',
      'three',
      'none',
    ])
    expect(sortRows(rows, (row) => row.value, 'descending').map((row) => row.id)).toEqual([
      'three',
      'one',
      'none',
    ])
  })

  it('[unit] keeps rows it cannot tell apart in the order they arrived, in both directions', () => {
    const rows = [
      { id: 1, day: 'a' },
      { id: 2, day: 'b' },
      { id: 3, day: 'a' },
      { id: 4, day: 'b' },
    ]
    expect(sortRows(rows, (row) => row.day, 'ascending').map((row) => row.id)).toEqual([1, 3, 2, 4])
    // Reversing the direction reverses the comparison, not the list.
    expect(sortRows(rows, (row) => row.day, 'descending').map((row) => row.id)).toEqual([2, 4, 1, 3])
  })

  it('[unit] does not reorder the rows it was given', () => {
    const rows = ['b', 'a']
    sortRows(rows, (value) => value, 'ascending')
    expect(rows).toEqual(['b', 'a'])
  })
})

describe('choosing the sort', () => {
  it('[unit] turns a sorted column round and starts any other ascending', () => {
    const ascending = { column: 'hours', direction: 'ascending' } as const
    expect(nextSort('hours', ascending)).toEqual({ column: 'hours', direction: 'descending' })
    expect(nextSort('hours', nextSort('hours', ascending))).toEqual(ascending)
    expect(nextSort('client', ascending)).toEqual({ column: 'client', direction: 'ascending' })
    expect(nextSort('client', null)).toEqual({ column: 'client', direction: 'ascending' })
  })

  it('[unit] writes a sort as one word and reads back only what it wrote', () => {
    expect(sortToken({ column: 'hours', direction: 'ascending' })).toBe('hours')
    expect(sortToken({ column: 'hours', direction: 'descending' })).toBe('-hours')
    expect(parseSortToken('-hours')).toEqual({ column: 'hours', direction: 'descending' })
    expect(parseSortToken('hours')).toEqual({ column: 'hours', direction: 'ascending' })
    for (const foreign of ['', '-', '--hours', 'hours desc', '<script>', '1abc', null, undefined]) {
      expect(parseSortToken(foreign)).toBeNull()
    }
  })

  it('[unit] takes the first candidate the table can carry out, else its default', () => {
    const sortable = (column: string): boolean => column === 'hours' || column === 'client'
    const fallback = { column: 'client', direction: 'ascending' } as const
    expect(
      resolveSort(
        [{ column: 'gone', direction: 'ascending' }, { column: 'hours', direction: 'descending' }],
        sortable,
        fallback,
      ),
    ).toEqual({ column: 'hours', direction: 'descending' })
    // A remembered column that no longer exists falls back rather than
    // leaving the table sorted by nothing in particular.
    expect(resolveSort([{ column: 'gone', direction: 'ascending' }, null], sortable, fallback)).toBe(
      fallback,
    )
  })
})

describe('remembering a sort', () => {
  it('[unit] remembers per person and per table', () => {
    setSortPreferenceOwner(7)
    rememberSort('invoices', { column: 'amount', direction: 'descending' })
    expect(rememberedSort('invoices')).toEqual({ column: 'amount', direction: 'descending' })
    expect(rememberedSort('estimates')).toBeNull()
    expect(localStorage.getItem('ezacto:user:7:table-sort:invoices')).toBe('-amount')

    // The next person on the same browser starts from the default.
    setSortPreferenceOwner(8)
    expect(rememberedSort('invoices')).toBeNull()
    setSortPreferenceOwner(7)
    expect(rememberedSort('invoices')).not.toBeNull()
  })

  it('[unit] remembers nothing for nobody', () => {
    rememberSort('invoices', { column: 'amount', direction: 'descending' })
    expect(localStorage.length).toBe(0)
    expect(rememberedSort('invoices')).toBeNull()
  })

  it('[unit] ignores a stored value it did not write, and survives storage that throws', () => {
    setSortPreferenceOwner(7)
    localStorage.setItem('ezacto:user:7:table-sort:invoices', '{"column":"x"}')
    expect(rememberedSort('invoices')).toBeNull()

    const broken = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const refused = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(rememberedSort('invoices')).toBeNull()
    expect(() => {
      rememberSort('invoices', { column: 'amount', direction: 'ascending' })
    }).not.toThrow()
    broken.mockRestore()
    refused.mockRestore()
  })
})

interface Invoice {
  readonly id: number
  readonly number: string
  readonly client: string
  readonly balance: number | null
}

const invoices: readonly Invoice[] = [
  { id: 1, number: '1315', client: 'Kestrel', balance: 500 },
  { id: 2, number: '9', client: 'Halcyon', balance: null },
  { id: 3, number: '10', client: 'Northwind', balance: 1_200 },
]

const columns: readonly DataColumn<Invoice>[] = [
  { key: 'number', label: 'Number', render: (row) => row.number, sortValue: (row) => row.number },
  { key: 'client', label: 'Client', render: (row) => row.client, sortValue: (row) => row.client },
  {
    key: 'balance',
    label: 'Balance',
    numeric: true,
    render: (row) => String(row.balance ?? ''),
    sortValue: (row) => row.balance,
  },
  { key: 'note', label: 'Note', render: () => '' },
]

const draw = (overrides: Partial<Parameters<typeof renderDataTable<Invoice>>[0]> = {}) => {
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  host.appendChild(
    renderDataTable<Invoice>({
      columns,
      rows: invoices,
      rowKey: (row) => String(row.id),
      caption: 'Invoices',
      ...overrides,
    }),
  )
  return host
}

const order = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('tbody tr[data-row]')].map((row) => row.getAttribute('data-row-key')!)

const header = (host: HTMLElement, column: string): HTMLElement =>
  host.querySelector<HTMLElement>(`th[data-column="${column}"]`)!

const sortButton = (host: HTMLElement, column: string): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>(`button[data-sort-column="${column}"]`)!

describe('a sortable table', () => {
  it('[browser] names each sortable column by a button and leaves an unsortable one a plain header', () => {
    const host = draw()
    expect(sortButton(host, 'number').textContent).toBe('Number')
    expect(sortButton(host, 'number').type).toBe('button')
    expect(sortButton(host, 'note')).toBeNull()
    expect(header(host, 'note').textContent).toBe('Note')
  })

  it('[browser] marks the sorted column alone, and its mark is hidden from a reader', () => {
    const host = draw({ defaultSort: { column: 'number', direction: 'ascending' } })
    expect(header(host, 'number').getAttribute('aria-sort')).toBe('ascending')
    expect(header(host, 'client').hasAttribute('aria-sort')).toBe(false)
    expect(header(host, 'balance').hasAttribute('aria-sort')).toBe(false)
    expect(sortButton(host, 'number').querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('[browser] starts in the order the rows arrive when it has no sort', () => {
    const host = draw()
    expect(order(host)).toEqual(['1', '2', '3'])
    expect(host.querySelector('[aria-sort]')).toBeNull()
  })

  it('[browser] sorts by activating a header, turns round on the second, and lists numbers naturally', () => {
    const host = draw()
    sortButton(host, 'number').click()
    expect(order(document.body)).toEqual(['2', '3', '1'])
    expect(header(document.body, 'number').getAttribute('aria-sort')).toBe('ascending')
    sortButton(document.body, 'number').click()
    expect(order(document.body)).toEqual(['1', '3', '2'])
    expect(header(document.body, 'number').getAttribute('aria-sort')).toBe('descending')
    // Moving to another column leaves no stale direction behind.
    sortButton(document.body, 'client').click()
    expect(header(document.body, 'number').hasAttribute('aria-sort')).toBe(false)
    expect(order(document.body)).toEqual(['2', '1', '3'])
  })

  it('[browser] gives focus back to the same header after a sort', () => {
    const host = draw()
    sortButton(host, 'client').focus()
    sortButton(host, 'client').click()
    expect(document.activeElement).toBe(sortButton(document.body, 'client'))
    expect(document.activeElement?.getAttribute('data-sort-column')).toBe('client')
  })

  it('[browser] puts empty values last in both directions', () => {
    const host = draw()
    sortButton(host, 'balance').click()
    expect(order(document.body)).toEqual(['1', '3', '2'])
    sortButton(document.body, 'balance').click()
    expect(order(document.body)).toEqual(['3', '1', '2'])
    expect(host).toBeTruthy()
  })

  it('[browser] reports the sort it was asked for', () => {
    const onSort = vi.fn()
    const host = draw({ onSort })
    sortButton(host, 'client').click()
    expect(onSort).toHaveBeenCalledWith({ column: 'client', direction: 'ascending' })
  })

  it('[browser] sorts inside its bands and keeps the bands where they were', () => {
    const rows: readonly Invoice[] = [
      { id: 1, number: '5', client: 'Kestrel', balance: 1 },
      { id: 2, number: '3', client: 'Kestrel', balance: 2 },
      { id: 3, number: '4', client: 'Halcyon', balance: 3 },
      { id: 4, number: '1', client: 'Halcyon', balance: 4 },
    ]
    const host = draw({
      rows,
      groupBy: (row) => row.client,
      defaultSort: { column: 'number', direction: 'ascending' },
    })
    expect(order(host)).toEqual(['2', '1', '4', '3'])
    expect([...host.querySelectorAll('tr.data-table-group')].map((band) => band.textContent)).toEqual([
      'Kestrel',
      'Halcyon',
    ])
  })

  it('[browser] does not reorder rows the server ordered, and leaves the fetch to the caller', () => {
    const onSort = vi.fn()
    const host = draw({
      serverSort: true,
      sort: { column: 'number', direction: 'descending' },
      onSort,
    })
    expect(order(host)).toEqual(['1', '2', '3'])
    expect(header(host, 'number').getAttribute('aria-sort')).toBe('descending')
    const before = host.querySelector('table')
    sortButton(host, 'number').click()
    expect(onSort).toHaveBeenCalledWith({ column: 'number', direction: 'ascending' })
    expect(host.querySelector('table')).toBe(before)
  })

  it('[browser] remembers the choice for a named table, per person', () => {
    setSortPreferenceOwner(3)
    const host = draw({ table: 'invoices' })
    sortButton(host, 'client').click()
    expect(rememberedSort('invoices')).toEqual({ column: 'client', direction: 'ascending' })

    const again = draw({ table: 'invoices' })
    expect(order(again)).toEqual(['2', '1', '3'])
    expect(header(again, 'client').getAttribute('aria-sort')).toBe('ascending')

    // An address's sort wins over the remembered one.
    const linked = draw({ table: 'invoices', sort: { column: 'number', direction: 'ascending' } })
    expect(header(linked, 'number').getAttribute('aria-sort')).toBe('ascending')

    // And a remembered column the table no longer has falls back to its default.
    localStorage.setItem('ezacto:user:3:table-sort:invoices', 'retired')
    const fallen = draw({
      table: 'invoices',
      defaultSort: { column: 'number', direction: 'descending' },
    })
    expect(header(fallen, 'number').getAttribute('aria-sort')).toBe('descending')
  })
})


it('[browser #745 #852] preserves a named header through a caller refresh without stealing focus from another control', async () => {
  setSortPreferenceOwner(1)
  const options = { columns, rows: invoices, rowKey: (row: Invoice) => String(row.id), caption: 'Invoices', table: 'refreshing-invoices' }
  const host = draw(options)
  sortButton(host, 'client').focus()
  sortButton(host, 'client').click()
  expect(document.activeElement === sortButton(host, 'client')).toBe(true)
  host.replaceChildren(renderDataTable(options))
  await Promise.resolve()
  expect(document.activeElement === sortButton(host, 'client')).toBe(true)
  expect(header(host, 'client').getAttribute('aria-sort')).toBe('ascending')
  const search = document.createElement('input')
  document.body.append(search)
  host.replaceChildren(renderDataTable(options))
  search.focus()
  await Promise.resolve()
  expect(document.activeElement === search).toBe(true)
})
