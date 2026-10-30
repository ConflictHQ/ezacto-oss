/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  createActivityController,
  subjectHref,
  type ActivityQuery,
  type ActivityRow,
} from '../src/activity/browser.js'
import { renderActivityLogPage } from '../src/module-settings/render.js'

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  event_id: 'e-1',
  event_type: 'timesheet.approved',
  aggregate: { type: 'timesheet_submission', id: 7 },
  actor: { type: 'user', id: 10, name: 'Ada Admin' },
  occurred_at: '2026-09-06T09:00:00.000Z',
  recorded_at: '2026-09-06T09:00:01.000Z',
  ...overrides,
})

const mount = (): void => {
  document.body.innerHTML = renderActivityLogPage('settings-activity')
}

const control = <Element extends HTMLElement>(name: string): Element =>
  document.querySelector<Element>(`[data-activity-${name}]`)!

const change = (element: HTMLElement, value: string): void => {
  ;(element as HTMLInputElement).value = value
  element.dispatchEvent(new Event('change'))
}

type ListCall = (query: ActivityQuery) => Promise<{
  data: ActivityRow[]
  page?: { next_cursor: string | null }
}>

describe('activity log filters and links', () => {
  it('[e2e] filters by actor, event type, entity and period, and clearing returns the default view', async () => {
    mount()
    const listActivityLog = vi.fn<ListCall>(async () => ({ data: [row()] }))
    await createActivityController({
      listActivityLog,
      listActors: async () => [
        { id: 3, name: 'Evan Executive' },
        { id: 10, name: 'Ada Admin' },
      ],
    }).activate(new AbortController().signal, { administrator: true })

    expect(listActivityLog.mock.calls[0]![0]).toEqual({})
    const actors = [...control('actor').querySelectorAll('option')].map((option) => option.textContent)
    expect(actors).toEqual(['Anyone', 'Evan Executive', 'Ada Admin'])

    change(control('actor'), '10')
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(2))
    expect(listActivityLog.mock.calls[1]![0]).toEqual({ actor_id: 10 })

    change(control('type'), 'timesheet.approved')
    change(control('from'), '2026-09-01')
    change(control('to'), '2026-09-30')
    change(control('entity'), 'timesheet_submission')
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(6))
    expect(listActivityLog.mock.calls[5]![0]).toEqual({
      actor_id: 10,
      event_type: 'timesheet.approved',
      from: '2026-09-01',
      to: '2026-09-30',
      aggregate_type: 'timesheet_submission',
    })

    change(control('entity-id'), '7')
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(7))
    expect(listActivityLog.mock.calls[6]![0]).toMatchObject({
      aggregate_type: 'timesheet_submission',
      aggregate_id: 7,
    })

    control<HTMLButtonElement>('clear').click()
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(8))
    expect(listActivityLog.mock.calls[7]![0]).toEqual({})
    expect(control<HTMLInputElement>('actor').value).toBe('')
    expect(control<HTMLInputElement>('type').value).toBe('')
  })

  it('[unit] never sends a record number without the kind of record it numbers', async () => {
    mount()
    const listActivityLog = vi.fn<ListCall>(async () => ({ data: [] }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)
    change(control('entity-id'), '7')
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(2))
    expect(listActivityLog.mock.calls[1]![0]).toEqual({})
  })

  it('[browser] continues a long log with the cursor and appends the next page', async () => {
    mount()
    const listActivityLog = vi
      .fn<ListCall>()
      .mockResolvedValueOnce({ data: [row({ event_id: 'e-2' })], page: { next_cursor: 'c-1' } })
      .mockResolvedValueOnce({ data: [row({ event_id: 'e-1' })], page: { next_cursor: null } })
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)
    const more = control<HTMLButtonElement>('more')
    expect(more.hidden).toBe(false)

    more.click()
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(2))
    expect(listActivityLog.mock.calls[1]![0]).toEqual({ cursor: 'c-1' })
    await vi.waitFor(() => expect(control('log-status').textContent).toBe('2 entries.'))
    expect(more.hidden).toBe(true)
  })

  it('[unit] links a subject only for a viewer who can open it', async () => {
    const rows = [
      row(),
      row({ event_id: 'e-2', aggregate: { type: 'invoice', id: 41 } }),
      row({ event_id: 'e-3', aggregate: { type: 'timesheet_lock', id: 2 } }),
    ]
    const linksFor = async (administrator: boolean): Promise<string[]> => {
      mount()
      await createActivityController({
        listActivityLog: async () => ({ data: rows }),
      }).activate(new AbortController().signal, { administrator })
      return [...control('log-list').querySelectorAll('a')].map((a) => a.getAttribute('href')!)
    }
    // A lock has no page of its own, so it is named and not linked.
    expect(await linksFor(true)).toEqual(['/approvals', '/invoices/by-id/41'])
    expect(await linksFor(false)).toEqual([])
    expect(subjectHref({ type: 'api_token', id: 1 })).toBeNull()
    expect(subjectHref({ type: 'scheduled_run', id: 17 })).toBe('/scheduled-runs/17')
  })
})
