/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderFilterBar, type FilterBarSpec } from '../src/components/filter-bar.js'
import {
  detailedTimeOptionsFromUrl,
  invoicedReportOptionsFromUrl,
  reportFiltersUrl,
  type DetailedTimeOptions,
} from '../src/reports/model.js'

/**
 * Issue 930. The report filter bar: labelled controls, chips for what is on,
 * and a way to take it all off. It narrows nothing itself.
 */

afterEach(() => {
  document.body.replaceChildren()
})

const spec = (overrides: Partial<FilterBarSpec> = {}): FilterBarSpec => ({
  label: 'Test filters',
  controls: [
    {
      kind: 'select',
      id: 'f-status',
      label: 'Status',
      value: 'open',
      neutral: '',
      options: [
        ['', 'All statuses'],
        ['open', 'Sent'],
      ],
    },
    { kind: 'search', id: 'f-notes', label: 'Notes contain', value: 'invoice' },
    { kind: 'toggle', id: 'f-active', label: 'Active projects only', checked: true },
  ],
  onChange: () => undefined,
  onClear: () => undefined,
  ...overrides,
})

describe('the filter bar', () => {
  it('[a11y] labels every control and names the group', () => {
    const bar = renderFilterBar(spec())
    document.body.append(bar)
    expect(bar.getAttribute('role')).toBe('group')
    expect(bar.getAttribute('aria-label')).toBe('Test filters')
    for (const id of ['f-status', 'f-notes', 'f-active']) {
      const control = bar.querySelector<HTMLElement>(`#${id}`)!
      expect(control, id).not.toBeNull()
      expect(bar.querySelector(`label[for="${id}"]`), id).not.toBeNull()
    }
    expect(bar.querySelector<HTMLInputElement>('#f-notes')!.type).toBe('search')
  })

  it('[unit] lists each active filter as a chip that names what it removes', () => {
    const onChange = vi.fn()
    const bar = renderFilterBar(spec({ onChange }))
    document.body.append(bar)
    const chips = [...bar.querySelectorAll<HTMLButtonElement>('.filter-bar-chip')]
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Remove filter Status: Sent',
      'Remove filter Notes contain: invoice',
      'Remove filter Active projects only',
    ])
    chips[0]!.click()
    chips[1]!.click()
    chips[2]!.click()
    expect(onChange.mock.calls).toEqual([
      ['f-status', ''],
      ['f-notes', ''],
      ['f-active', false],
    ])
  })

  it('[unit] draws no chip and no Clear button while nothing is filtered', () => {
    const bar = renderFilterBar(
      spec({
        controls: [
          {
            kind: 'select',
            id: 'f-status',
            label: 'Status',
            value: '',
            neutral: '',
            options: [['', 'All statuses']],
          },
          { kind: 'search', id: 'f-notes', label: 'Notes contain', value: '   ' },
          { kind: 'toggle', id: 'f-active', label: 'Active', checked: false },
        ],
      }),
    )
    expect(bar.querySelector('.filter-bar-chip')).toBeNull()
    expect(bar.querySelector('.filter-bar-clear')).toBeNull()
  })

  it('[unit] hands a changed control back and clears everything through one button', () => {
    const onChange = vi.fn()
    const onClear = vi.fn()
    const bar = renderFilterBar(spec({ onChange, onClear }))
    document.body.append(bar)
    const select = bar.querySelector<HTMLSelectElement>('#f-status')!
    select.value = ''
    select.dispatchEvent(new Event('change'))
    const search = bar.querySelector<HTMLInputElement>('#f-notes')!
    search.value = '  retainer  '
    search.dispatchEvent(new Event('change'))
    const toggle = bar.querySelector<HTMLInputElement>('#f-active')!
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    expect(onChange.mock.calls).toEqual([
      ['f-status', ''],
      ['f-notes', 'retainer'],
      ['f-active', false],
    ])
    bar.querySelector<HTMLButtonElement>('.filter-bar-clear')!.click()
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('[a11y] puts focus back on the control that changed once the bar is redrawn', async () => {
    const first = renderFilterBar(spec())
    document.body.append(first)
    const select = first.querySelector<HTMLSelectElement>('#f-status')!
    select.value = ''
    select.dispatchEvent(new Event('change'))
    const second = renderFilterBar(spec())
    first.replaceWith(second)
    await Promise.resolve()
    expect(document.activeElement?.id).toBe('f-status')
  })
})

describe('the filters in the address', () => {
  const filters = {
    kind: 'detailed-time' as const,
    from: '2026-08-01',
    to: '2026-08-31',
    clientId: null,
    projectId: null,
    tab: 'clients' as const,
  }
  const options: DetailedTimeOptions = {
    hours: 'billable',
    grouping: 'date',
    grain: 'entry',
    activeProjectsOnly: true,
    taskId: 4,
    userId: 2,
    roleId: 3,
    tagId: 7,
    invoiceState: 'uninvoiced',
    notes: 'kickoff call',
  }

  it('[unit] carries the detailed time filters, notes included, through a round trip', () => {
    const address = reportFiltersUrl(filters, options)
    expect(new URL(address, 'https://ezacto.test').searchParams.get('notes')).toBe('kickoff call')
    expect(detailedTimeOptionsFromUrl(new URL(address, 'https://ezacto.test'))).toEqual(options)
  })

  it('[unit] leaves notes out of the address when there are none', () => {
    const address = reportFiltersUrl(filters, { ...options, notes: '' })
    expect(new URL(address, 'https://ezacto.test').searchParams.has('notes')).toBe(false)
  })

  it('[unit] carries the receivables due state and ignores one it does not know', () => {
    const receivables = { ...filters, kind: 'receivables' as const }
    const address = reportFiltersUrl(receivables, undefined, undefined, { status: null, dueState: 'past_due' })
    const url = new URL(address, 'https://ezacto.test')
    expect(url.searchParams.get('due_state')).toBe('past_due')
    expect(invoicedReportOptionsFromUrl(url).dueState).toBe('past_due')
    expect(invoicedReportOptionsFromUrl(new URL('https://ezacto.test/reports?due_state=late')).dueState).toBeNull()
    // Invoiced keeps its own filter and is not handed receivables'.
    const invoiced = reportFiltersUrl({ ...filters, kind: 'invoiced' }, undefined, undefined, {
      status: 'paid',
      dueState: 'past_due',
    })
    const invoicedUrl = new URL(invoiced, 'https://ezacto.test')
    expect(invoicedUrl.searchParams.get('status')).toBe('paid')
    expect(invoicedUrl.searchParams.has('due_state')).toBe(false)
  })
})
