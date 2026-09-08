/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import { createActivityController, type ActivityRow } from '../src/activity/browser.js'
import { renderActivityLogPage } from '../src/module-settings/render.js'

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow => ({
  event_id: 'e-1',
  event_type: 'api_token.created',
  aggregate: { type: 'api_token', id: 7 },
  payload: { actor: { type: 'user', id: 4 } },
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
          payload: { actor: { type: 'system', id: null } },
        }),
      ],
    }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    expect(table()).toContain('Api token created')
    expect(table()).toContain('User #4')
    expect(table()).toContain('Backup exported')
    expect(table()).toContain('System')
    expect(table()).not.toContain('User #null')
    expect(status()).toBe('2 entries.')
  })

  it('[browser] omits an untouched filter rather than sending it blank', async () => {
    // The API validates a bound it is given, and "" is not a date. Sending the
    // empty input would turn an untouched filter into a 422 the reader cannot
    // explain.
    mount()
    const listActivityLog = vi.fn(async () => ({ data: [] }))
    await createActivityController({ listActivityLog }).activate(new AbortController().signal)

    expect(Object.keys(listActivityLog.mock.calls[0]![0] as object)).toEqual([])

    const from = document.querySelector<HTMLInputElement>('[data-activity-from]')!
    from.value = '2026-09-01'
    from.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(listActivityLog).toHaveBeenCalledTimes(2))
    expect(listActivityLog.mock.calls[1]![0]).toEqual({ from: '2026-09-01' })
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
