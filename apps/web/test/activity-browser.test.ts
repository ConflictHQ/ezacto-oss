/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { createActivityController, type ActivityRow } from '../src/activity/browser.js'
import { renderActivityLogPage } from '../src/module-settings/render.js'

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  event_id: 'e-1',
  event_type: 'api_token.created',
  aggregate: { type: 'api_token', id: 7 },
  actor: { type: 'user', id: 4, name: 'Robin Vale' },
  occurred_at: '2026-09-06T09:00:00.000Z',
  recorded_at: '2026-09-06T09:00:01.000Z',
  ...overrides,
})

const mount = (): void => {
  document.body.innerHTML = renderActivityLogPage('settings-activity')
}

const status = (): string =>
  document.querySelector<HTMLElement>('[data-activity-log-status]')?.textContent ?? ''

const table = (): string =>
  document.querySelector<HTMLElement>('[data-activity-log-list]')?.textContent ?? ''

describe('activity log surface', () => {
  it('[browser] draws what happened, and names a system actor as itself', async () => {
    // A system event has no actor id. Rendering it as a person would say the
    // administrator who configured the nightly export ran it at 3am, which is
    // the kind of wrong an audit log cannot afford.
    mount()
    const listActivityLog = vi.fn(async () => ({
      data: [
        row(),
        row({
          event_id: 'e-2',
          event_type: 'backup.exported',
          aggregate: { type: 'backup_run', id: 12 },
          actor: { type: 'system', id: null, name: null },
        }),
      ],
    }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    expect(table()).toContain('Api token created')
    expect(table()).toContain('Robin Vale')
    expect(table()).toContain('Backup exported')
    expect(table()).toContain('System')
    expect(table()).not.toContain('User #null')
    expect(status()).toBe('2 entries.')
  })

  it('[unit] names who acted, keeps the id to hand, and falls back to the id (issue 862)', async () => {
    // The log read as "User #30", which sends an administrator to the Team page
    // to find out who that is. The server names the person now; the id stays
    // on the cell's title, because two people can share a name and an audit
    // has to be able to tell them apart. An id nobody carries any more -- a
    // deleted contact, or a user unknown to this instance -- reads as the id,
    // and an event that names nobody says so rather than guessing.
    mount()
    const listActivityLog = vi.fn(async () => ({
      data: [
        row({ event_id: 'e-user' }),
        row({ event_id: 'e-contact', actor: { type: 'contact', id: 8, name: 'Jordan' } }),
        row({ event_id: 'e-gone-user', actor: { type: 'user', id: 30, name: null } }),
        row({ event_id: 'e-gone-contact', actor: { type: 'contact', id: 9, name: null } }),
        row({ event_id: 'e-system', actor: { type: 'system', id: null, name: null } }),
        row({ event_id: 'e-nobody', actor: null }),
      ],
    }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    const who = (eventId: string) => {
      const cell = document.querySelector<HTMLElement>(
        `[data-row-key="${eventId}"] [data-column="who"]`,
      )!
      return { text: cell.textContent, title: cell.querySelector('[title]')?.getAttribute('title') ?? null }
    }
    expect(who('e-user')).toEqual({ text: 'Robin Vale', title: 'User #4' })
    expect(who('e-contact')).toEqual({ text: 'Jordan', title: 'Contact #8' })
    expect(who('e-gone-user')).toEqual({ text: 'User #30', title: null })
    expect(who('e-gone-contact')).toEqual({ text: 'Contact #9', title: null })
    expect(who('e-system')).toEqual({ text: 'System', title: null })
    expect(who('e-nobody')).toEqual({ text: 'Unknown', title: null })
  })

  it('[browser] omits an untouched filter rather than sending it blank', async () => {
    // The API validates a bound it is given, and "" is not a date. Sending the
    // empty input would turn an untouched filter into a 422 the reader cannot
    // explain.
    mount()
    // Typed through the mock's generic rather than by naming an unused
    // parameter: the assertions read the recorded call below, so the parameter
    // only ever existed to carry a type, and lint rightly called it unused.
    const listActivityLog = vi.fn<
      (query: Record<string, string>) => Promise<{ data: ActivityRow[] }>
    >(async () => ({ data: [] }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    expect(Object.keys(listActivityLog.mock.calls[0]![0] as object)).toEqual([])

    const from = document.querySelector<HTMLInputElement>('[data-activity-from]')!
    from.value = '2026-09-01'
    from.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(2))
    expect(listActivityLog.mock.calls[1]![0]).toEqual({ from: '2026-09-01' })
  })

  it('[browser #852] sorts the loaded entries and says the sort covers only those while more remain', async () => {
    mount()
    const listActivityLog = vi.fn(async () => ({
      data: [
        row({ event_id: 'e-1', occurred_at: '2026-09-06T09:00:00.000Z' }),
        row({ event_id: 'e-2', occurred_at: '2026-09-08T09:00:00.000Z' }),
      ],
      page: { next_cursor: 'more' },
    }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    const times = (): string[] =>
      [...document.querySelectorAll('[data-activity-log-list] tbody tr[data-row] td[data-column="when"]')].map(
        (cell) => cell.textContent ?? '',
      )
    expect(times()).toEqual(['2026-09-06T09:00:00.000Z', '2026-09-08T09:00:00.000Z'])
    expect(status()).toContain('Sorting covers only the rows loaded so far')

    // The table draws itself again on a sort, so the header is found afresh.
    const header = (): HTMLButtonElement =>
      document.querySelector<HTMLButtonElement>(
        '[data-activity-log-list] thead button[data-sort-column="when"]',
      )!
    header().click()
    header().click()
    expect(times()).toEqual(['2026-09-08T09:00:00.000Z', '2026-09-06T09:00:00.000Z'])
  })

  it('[browser] says a read failed rather than drawing an empty log', async () => {
    // An empty table and a failed read look identical, and one of them means
    // "nothing happened" while the other means "you cannot see what happened".
    mount()
    const listActivityLog = vi.fn(async () => {
      throw new Error('Activity is unavailable.')
    })
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    expect(status()).toBe('Activity is unavailable.')
    expect(table()).toBe('')
  })
})
