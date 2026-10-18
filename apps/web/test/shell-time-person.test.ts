/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  desktopInputs,
  edit,
  identity,
  mountShell,
  renderBrowserShell,
  timeEntry,
  timestamp,
  type GeneralResource,
  type TimeEntry,
  type TimeEntryInput,
  type Whoami,
} from './support/shell-harness.js'

/**
 * Issue 917: an administrator opens a teammate's week on Time, and the same
 * grid and editor read and write that person's time. Nobody else gets the
 * picker. Fictional people throughout.
 */

const person = (id: number, first: string, last: string, active = true): GeneralResource => ({
  id,
  first_name: first,
  last_name: last,
  email: `${first.toLowerCase()}@example.test`,
  is_active: active,
  created_at: timestamp,
  updated_at: timestamp,
})

const roster = [
  person(1, 'Ada', 'Admin'),
  person(7, 'Rosa', 'Teammate'),
  person(8, 'Former', 'Colleague', false),
  person(9, 'Bruno', 'Teammate'),
]

/**
 * The harness api, with a roster and a teammate's week. Entries carry their
 * owner, and the list answers by `user_id` the way the server does: the
 * signed-in person's own when none is named.
 */
const teamApi = (profile: Whoami['profile'] = 'administrator') => {
  const api = browserApi()
  const teammateEntry: TimeEntry = {
    ...timeEntry(70, {
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-26',
      seconds: 5_400,
      notes: 'Teammate work',
    }),
    user_id: 7,
  }
  api.entries.push(teammateEntry)
  const listTimeEntries = vi.fn(
    async (query: {
      readonly from?: string
      readonly to?: string
      readonly is_running?: boolean
      readonly user_id?: number
    }) =>
      api.entries.filter((entry) => {
        if (entry.user_id !== (query.user_id ?? identity.user_id)) return false
        if (query.is_running === true) return entry.is_running
        if (query.from !== undefined && entry.spent_date < query.from) return false
        if (query.to !== undefined && entry.spent_date > query.to) return false
        return true
      }),
  )
  const listTimeEntryOptions = vi.fn(async (_signal?: AbortSignal, userId?: number) =>
    userId === 7
      ? [{ project_id: 1, task_id: 1, minimum_note_length: 0, time_rounding: { mode: 'exact' as const, minutes: 15 as const, source: 'organization' as const } }]
      : [
          { project_id: 1, task_id: 1, minimum_note_length: 0, time_rounding: { mode: 'exact' as const, minutes: 15 as const, source: 'organization' as const } },
          { project_id: 2, task_id: 2, minimum_note_length: 0, time_rounding: { mode: 'exact' as const, minutes: 15 as const, source: 'organization' as const } },
        ],
  )
  const createTimeEntry = vi.fn(async (input: TimeEntryInput) => {
    const created: TimeEntry = {
      ...timeEntry(Math.max(...api.entries.map((entry) => entry.id)) + 1, input),
      user_id: input.user_id ?? identity.user_id,
    }
    api.entries.push(created)
    return created
  })
  return {
    ...api,
    whoami: vi.fn(async () => ({ ...identity, profile })),
    listTimeEntries,
    listTimeEntryOptions,
    createTimeEntry,
    listDirectoryUsers: vi.fn(async () => ({ data: roster, page: { next_cursor: null } })),
  }
}

const picker = (): HTMLSelectElement => document.querySelector<HTMLSelectElement>('[data-time-person]')!
const banner = (): HTMLElement => document.querySelector<HTMLElement>('[data-time-person-banner]')!

const choose = (value: string): void => {
  picker().value = value
  picker().dispatchEvent(new Event('change', { bubbles: true }))
}

/** Hours on screen, by cell, for the week's only row. */
const cellValues = (): string[] => desktopInputs().map((input) => input.value)

describe("an administrator on a teammate's week (issue 917)", () => {
  it('[browser] offers everyone active but yourself, and opens their week under a banner', async () => {
    renderBrowserShell()
    const api = teamApi()
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-time-person-field]')!.hidden).toBe(false),
    )
    expect([...picker().options].map((option) => option.textContent)).toEqual([
      'Yours',
      'Bruno Teammate',
      'Rosa Teammate',
    ])
    expect(picker().value).toBe('')
    expect(banner().hidden).toBe(true)
    // The administrator's own week first: their hour on Friday.
    await vi.waitFor(() => expect(cellValues()).toContain('1'))

    choose('7')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-time-person-banner-text]')!.textContent).toBe(
        "Editing Rosa Teammate's timesheet",
      ),
    )
    expect(banner().hidden).toBe(false)
    expect(api.listTimeEntries).toHaveBeenCalledWith(
      { from: '2026-08-24', to: '2026-08-30', user_id: 7 },
      expect.any(AbortSignal),
    )
    expect(api.listTimeEntryOptions).toHaveBeenLastCalledWith(expect.any(AbortSignal), 7)
    // Her Wednesday, and none of the administrator's own time.
    await vi.waitFor(() => expect(cellValues()).toEqual(['', '', '1.5', '', '', '', '']))
    // The header timer stays the administrator's: the running query never
    // names anybody.
    expect(api.listTimeEntries).not.toHaveBeenCalledWith(
      expect.objectContaining({ is_running: true, user_id: 7 }),
      expect.anything(),
    )
  })

  it('[browser] saves time typed into the teammate\'s grid and editor as theirs, and offers no timer or submission', async () => {
    renderBrowserShell()
    const api = teamApi()
    await mountShell(api)
    await vi.waitFor(() => expect(picker().options).toHaveLength(3))
    choose('7')
    await vi.waitFor(() => expect(cellValues()).toEqual(['', '', '1.5', '', '', '', '']))

    // A timer is its owner's to start, and the week is hers to submit.
    const rowButtons = [...document.querySelectorAll('[data-week-grid-rows] button')].map(
      (button) => button.textContent,
    )
    expect(rowButtons).not.toContain('Start')
    expect(document.querySelector<HTMLElement>('[data-timesheet-status]')!.hidden).toBe(true)
    // The header's Log time logs your own time, so it is not offered here.
    expect(document.querySelector<HTMLElement>('[data-time-log-time]')!.hidden).toBe(true)

    const thursday = desktopInputs()[3]!
    edit(thursday, '2')
    thursday.blur()
    await vi.waitFor(() =>
      expect(api.createTimeEntry).toHaveBeenCalledWith(
        {
          user_id: 7,
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-27',
          seconds: 7_200,
        },
        expect.any(AbortSignal),
      ),
    )

    // The cell editor writes for her too: Friday's pencil, on an empty cell.
    await vi.waitFor(() => expect(cellValues()).toEqual(['', '', '1.5', '2', '', '', '']))
    const addOnFriday = [
      ...desktopInputs()[4]!.closest('td')!.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === '✎')!
    addOnFriday.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    await vi.waitFor(() => expect(dialog.open).toBe(true))
    document.querySelector<HTMLInputElement>('[data-entry-duration-input]')!.value = '0.5'
    document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!.value =
      'Logged for her'
    document
      .querySelector<HTMLFormElement>('[data-entry-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(api.createTimeEntry).toHaveBeenLastCalledWith(
        expect.objectContaining({
          user_id: 7,
          spent_date: '2026-08-28',
          seconds: 1_800,
          notes: 'Logged for her',
        }),
        expect.any(AbortSignal),
      ),
    )
  })

  it('[browser] goes back to your own week, and the header timer will not start from hers', async () => {
    renderBrowserShell()
    const api = teamApi()
    await mountShell(api)
    await vi.waitFor(() => expect(picker().options).toHaveLength(3))
    choose('7')
    await vi.waitFor(() => expect(banner().hidden).toBe(false))
    await vi.waitFor(() => expect(cellValues()).toEqual(['', '', '1.5', '', '', '', '']))

    document.querySelector<HTMLButtonElement>('[data-timer-chip]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-session-message]')!.textContent).toBe(
        'Go back to your own timesheet to start a timer.',
      ),
    )
    expect(document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!.open).toBe(false)

    const before = api.listTimeEntries.mock.calls.length
    document.querySelector<HTMLButtonElement>('[data-time-person-reset]')!.click()
    await vi.waitFor(() => expect(banner().hidden).toBe(true))
    expect(picker().value).toBe('')
    await vi.waitFor(() => expect(cellValues()).toContain('1'))
    // Your own week again: asked for without naming anybody.
    expect(api.listTimeEntries.mock.calls.slice(before).map(([query]) => query)).toContainEqual({
      from: '2026-08-24',
      to: '2026-08-30',
    })
    expect(document.querySelector<HTMLElement>('[data-time-log-time]')!.hidden).toBe(false)
  })

  for (const profile of ['executive_manager', 'project_manager', 'member'] as const) {
    it(`[security] does not offer the picker to ${profile.replace('_', ' ')}s`, async () => {
      renderBrowserShell()
      const api = teamApi(profile)
      await mountShell(api)
      await vi.waitFor(() => expect(cellValues()).toContain('1'))
      expect(document.querySelector<HTMLElement>('[data-time-person-field]')!.hidden).toBe(true)
      expect(picker().disabled).toBe(true)
      expect(api.listDirectoryUsers).not.toHaveBeenCalled()
      expect(api.listTimeEntries).not.toHaveBeenCalledWith(
        expect.objectContaining({ user_id: expect.any(Number) }),
        expect.anything(),
      )
    })
  }
})
