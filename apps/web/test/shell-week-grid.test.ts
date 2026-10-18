/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import {
  browserApi,
  deferred,
  desktopInputs,
  edit,
  mountShell,
  renderBrowserShell,
  timeEntry,
  timestamp,
  type ShellApi,
  type TimeEntryInput,
} from './support/shell-harness.js'

/**
 * The Start button on the week row of a named project. Rows sort by label, so
 * an index would move the moment a fixture gains a project.
 */
const rowStart = (projectLabel: string): HTMLButtonElement | null => {
  const row = [
    ...document.querySelectorAll<HTMLTableRowElement>('[data-week-grid-rows] tr'),
  ].find((candidate) => candidate.querySelector('th strong')?.textContent === projectLabel)
  return row?.querySelector<HTMLButtonElement>('.grid-row-start') ?? null
}

/**
 * Records what the row's Start actually asked the server for, and answers the
 * way the server does: a restart keeps the entry it was given, and a created
 * timer is filed on the operator's current date whatever week is on screen.
 */
const recordingTimerApi = (
  api: ReturnType<typeof browserApi>,
  today: string,
): {
  readonly api: ShellApi
  readonly restarted: number[]
  readonly created: TimeEntryInput[]
} => {
  const restarted: number[] = []
  const created: TimeEntryInput[] = []
  return {
    restarted,
    created,
    api: {
      ...api,
      restartTimeEntry: async (id: number) => {
        restarted.push(id)
        const current = api.entries.find((entry) => entry.id === id)!
        const running = { ...current, is_running: true, timer_started_at: timestamp }
        api.entries.splice(api.entries.indexOf(current), 1, running)
        return running
      },
      createTimeEntry: async (input: TimeEntryInput) => {
        created.push(input)
        const started = timeEntry(
          Math.max(...api.entries.map((entry) => entry.id)) + 1,
          { ...input, spent_date: today },
        )
        api.entries.push(started)
        return started
      },
    },
  }
}

describe('week-grid browser behavior', () => {
  afterEach(() => vi.useRealTimers())

  it('[browser] offers Start on a week-grid row, and off this week it starts a new timer on today', async () => {
    // The day list has carried this since the timesheet work. On a desktop the
    // grid is the screen you are actually on, and it offered nothing: the only
    // way to start a timer was to retype the project and task into the top bar
    // as exact strings.
    //
    // The clock is pinned outside the week on screen. There is no today column
    // to start on, and the row used to fall back to restarting its latest
    // entry -- which keeps that entry's spent_date, so from last week's grid the
    // timer ran on last week's date (#797, one navigation away), and in
    // start/end mode the restart moved that entry's logged time to today. A new
    // timer with no date is what the server files on today in either mode.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-16T12:00:00'))
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    const api = browserApi()
    api.entries[0] = timeEntry(1, {
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      seconds: 3_600,
      notes: 'Friday on Northpeak',
    })
    const { api: withTimer, restarted, created } = recordingTimerApi(api, '2026-09-16')

    await mountShell(withTimer)

    const start = await vi.waitFor(() => {
      const control = rowStart('Northpeak')
      expect(control).not.toBeNull()
      return control!
    })
    // Nothing on screen is today, so there is no entry for the button to aim
    // at -- and in particular not Friday's.
    expect(start.dataset.startEntry).toBeUndefined()
    expect(start.getAttribute('aria-label')).toContain('Start a timer on')

    start.click()
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect(restarted).toEqual([])
    // The note rides along from the row's most recent entry, as a restart would
    // have carried it; the date is left to the server.
    expect(created[0]).toEqual({
      project_id: 1,
      task_id: 1,
      notes: 'Friday on Northpeak',
    })
    // Friday's hour stays where it was logged: nothing in the week on screen is
    // running, because the timer is on a day this week does not show.
    await vi.waitFor(() => expect(api.entries.some((entry) => entry.is_running)).toBe(true))
    expect(api.entries.find((entry) => entry.is_running)?.spent_date).toBe('2026-09-16')
    expect(document.querySelector('[data-week-grid-rows] [data-running="true"]')).toBeNull()
  })

  it('[browser #815] loads the week and hides the Expenses link when the module is off', async () => {
    // Switching Expenses off in Company settings answers 403 module_disabled
    // on the expenses route. The week used to fail whole ("your week could
    // not load"), and the strip kept offering Expenses, a page that refuses.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-16T12:00:00'))
    renderBrowserShell()
    const api = browserApi()
    const withoutExpenses = {
      ...api,
      listExpenses: vi.fn(async () => {
        throw new EzactoApiError(
          403,
          { error: { code: 'module_disabled', message: 'The expenses module is not enabled for this organization.', fields: [] } },
          'req-815',
        )
      }),
    }

    await mountShell(withoutExpenses)

    await vi.waitFor(() => {
      expect(document.querySelector('[data-week-grid-rows] tr th')).not.toBeNull()
    })
    expect(document.body.textContent).not.toContain('your week could not load')
    const expensesLink = document.querySelector<HTMLElement>('[data-expenses-nav]')!
    expect(expensesLink.hidden).toBe(true)
    // Approvals and Team already hide when withheld; Time itself never does.
    expect(document.querySelector<HTMLElement>('nav a[href="/"]')!.hidden).toBe(false)
  })


  it('[browser #797] starts a row on today, not on its last day with a value', async () => {
    // Reported setup: a Wednesday, one project holding Monday's entry and
    // another holding Tuesday's, and Start on the first row put the running
    // timer in the Monday cell. The row walked its cells backwards for the last
    // one holding an entry and restarted that, and a restart keeps the entry's
    // own spent_date -- so the timer accrued to a day nobody was working on.
    vi.useFakeTimers({ toFake: ['Date'] })
    // Local rather than UTC: the column the grid paints as today is the
    // browser's own date, so a Z-suffixed noon would be a different Wednesday
    // east of UTC+12 and this would assert the wrong cell there.
    vi.setSystemTime(new Date('2026-08-26T12:00:00'))
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-24',
        seconds: 3_600,
        notes: 'Monday on Northpeak',
      }),
      timeEntry(2, { project_id: 2, task_id: 2, spent_date: '2026-08-25', seconds: 3_600 }),
    )
    const { api: withTimer, restarted, created } = recordingTimerApi(api, '2026-08-26')

    await mountShell(withTimer)

    const start = await vi.waitFor(() => {
      const control = rowStart('Northpeak')
      expect(control).not.toBeNull()
      return control!
    })
    // Today holds nothing on this row, so there is no entry for the button to
    // aim at -- and in particular not Monday's.
    expect(start.dataset.startEntry).toBeUndefined()

    start.click()
    await vi.waitFor(() => expect(created).toHaveLength(1))
    expect(restarted).toEqual([])
    // No spent_date and no seconds is the timer request the entry editor
    // already makes: the date a running timer is filed under belongs to the
    // server, which refuses to be told one that disagrees with the operator's
    // own day. The note rides along from the entry a restart would have taken,
    // because a note-required project cannot start a timer without one.
    expect(created[0]).toEqual({
      project_id: 1,
      task_id: 1,
      notes: 'Monday on Northpeak',
    })
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[data-week-grid-rows] [data-cell-key="1:1:2026-08-26"][data-running="true"]',
        ),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector(
        '[data-week-grid-rows] [data-cell-key="1:1:2026-08-24"][data-running="true"]',
      ),
    ).toBeNull()
  })

  it("[browser #797] continues today's own entry rather than a later day's", async () => {
    // A row can carry time ahead of today -- Friday's travel logged on
    // Wednesday -- and walking backwards would restart that one. Today's entry
    // is continued rather than joined by a second: two entries in one cell is
    // the conflict state the grid then refuses to edit.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T12:00:00'))
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, { project_id: 1, task_id: 1, spent_date: '2026-08-24', seconds: 3_600 }),
      timeEntry(3, { project_id: 1, task_id: 1, spent_date: '2026-08-26', seconds: 1_800 }),
      timeEntry(4, { project_id: 1, task_id: 1, spent_date: '2026-08-28', seconds: 900 }),
    )
    const { api: withTimer, restarted, created } = recordingTimerApi(api, '2026-08-26')

    await mountShell(withTimer)

    const start = await vi.waitFor(() => {
      const control = rowStart('Northpeak')
      expect(control).not.toBeNull()
      return control!
    })
    expect(start.dataset.startEntry).toBe('3')

    start.click()
    await vi.waitFor(() => expect(restarted).toEqual([3]))
    expect(created).toEqual([])
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[data-week-grid-rows] [data-cell-key="1:1:2026-08-26"][data-running="true"]',
        ),
      ).not.toBeNull(),
    )
    expect(
      document.querySelector(
        '[data-week-grid-rows] [data-cell-key="1:1:2026-08-28"][data-running="true"]',
      ),
    ).toBeNull()
  })

  it("[browser #797] marks and starts on the server's today, read from the profile timezone", async () => {
    // A timer is filed on the day it is in the operator's own timezone (then
    // the organization's), never the browser's. The two disagree for a few
    // hours every day whenever the laptop is somewhere else: here the profile
    // says Pacific/Kiritimati (UTC+14), where 11:00Z on Wednesday the 26th is
    // already 01:00 on Thursday the 27th, and the row already holds Thursday's
    // entry. Picking today off the browser's clock found Wednesday's cell
    // empty, asked for a new timer, and the server filed it beside Thursday's
    // entry -- the two-entries-in-a-cell conflict the today branch exists to
    // avoid, in the very case it was written for.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T11:00:00Z'))
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, { project_id: 1, task_id: 1, spent_date: '2026-08-24', seconds: 3_600 }),
      timeEntry(3, { project_id: 1, task_id: 1, spent_date: '2026-08-27', seconds: 1_800 }),
    )
    const { api: withTimer, restarted, created } = recordingTimerApi(api, '2026-08-27')
    const getProfile = vi.fn(async () => ({ user_id: 1, timezone: 'Pacific/Kiritimati' }))

    await mountShell({ ...withTimer, getProfile })

    const start = await vi.waitFor(() => {
      const control = rowStart('Northpeak')
      expect(control).not.toBeNull()
      return control!
    })
    // The column marked today and the cell Start aims at are the same date.
    expect(
      document.querySelector('[data-week-grid-head] th[data-today] [data-date]')?.textContent,
    ).toBe('Aug 27')
    expect(document.querySelector('[data-day-total="2026-08-27"][data-today]')).not.toBeNull()
    expect(start.dataset.startEntry).toBe('3')

    start.click()
    await vi.waitFor(() => expect(restarted).toEqual([3]))
    expect(created).toEqual([])
  })

  it("[browser #797] falls back to the organization timezone when the profile holds none", async () => {
    // 'UTC' in the profile column is "unset", not a zone: the server then files
    // on the organization's zone, which an administrator's session can read
    // from the lock policy. Read as a zone, UTC would mark the 26th here.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T11:00:00Z'))
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(3, { project_id: 1, task_id: 1, spent_date: '2026-08-27', seconds: 1_800 }),
    )
    const { api: withTimer, restarted } = recordingTimerApi(api, '2026-08-27')

    await mountShell({
      ...withTimer,
      getProfile: vi.fn(async () => ({ user_id: 1, timezone: 'UTC' })),
      getTimesheetLockPolicy: vi.fn(async () => ({
        auto_lock: false,
        timesheet_deadline: null,
        timezone: 'Pacific/Kiritimati',
        week_start_day: 'monday' as const,
        updated_at: timestamp,
      })),
    })

    const start = await vi.waitFor(() => {
      const control = rowStart('Northpeak')
      expect(control).not.toBeNull()
      return control!
    })
    expect(start.dataset.startEntry).toBe('3')
    start.click()
    await vi.waitFor(() => expect(restarted).toEqual([3]))
  })

  it('[browser #797] offers no Start on a row whose today is locked', async () => {
    // Nothing can be logged to a locked day, so the row has nothing to start:
    // not today's own entry, which the server would refuse to restart, and not
    // Monday's unlocked one, which would run the timer on Monday.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T12:00:00'))
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, { project_id: 1, task_id: 1, spent_date: '2026-08-24', seconds: 3_600 }),
      timeEntry(2, { project_id: 2, task_id: 2, spent_date: '2026-08-25', seconds: 3_600 }),
      {
        // Spread over the helper, which hardcodes is_locked: false.
        ...timeEntry(3, { project_id: 1, task_id: 1, spent_date: '2026-08-26', seconds: 1_800 }),
        is_locked: true,
        locked_reason_code: 'invoiced',
        locked_reason: 'it is on invoice 4242',
      },
    )
    const { api: withTimer } = recordingTimerApi(api, '2026-08-26')

    await mountShell(withTimer)

    // The other row proves the grid rendered with Start buttons at all.
    await vi.waitFor(() => expect(rowStart('Acme')).not.toBeNull())
    expect(rowStart('Northpeak')).toBeNull()
  })

  it('[browser] moves the week with brackets, and never while a cell is being typed in', async () => {
    // A grid is a keyboard surface, but the thing under the cursor is usually
    // an input. An unmodified binding that fired there would be typed into a
    // cell instead of acted on.
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    await mountShell(browserApi())

    const press = (key: string): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }

    const week = (): string => new URL(globalThis.location.href).searchParams.get('week')!
    const days = (from: string, to: string): number =>
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000

    // The anchor is normalised to the week start on the first move, so measure
    // from a moved position rather than from the raw URL this test set.
    press(']')
    await vi.waitFor(() => expect(week()).not.toBe('2026-08-28'))
    const forward = week()
    press('[')
    await vi.waitFor(() => expect(week()).not.toBe(forward))
    const back = week()
    expect(days(back, forward)).toBe(7)

    // A cell has focus, so the key belongs to the cell and not to the week.
    // The grid is inert while a week loads, so wait for that to finish first.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-week-grid]')?.getAttribute('aria-busy')).toBe('false'),
    )
    desktopInputs()[0]!.focus()
    press(']')
    expect(week()).toBe(back)
  })

  it('[browser] steps the timesheet week from the shared period control', async () => {
    // The toolbar used to hand-roll this: two chevrons, a static
    // "Monday–Sunday" eyebrow and a private `weekLabel`. It is the control the
    // reports card uses, restricted to weeks because the grid below draws seven
    // day columns.
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    await mountShell(browserApi())

    const toolbar = document.querySelector<HTMLElement>('[data-week-period]')!
    // Counted before anything is read off it: a check that finds no arrows
    // passes just as happily against a toolbar that renders none.
    expect(toolbar.querySelectorAll('.period-step')).toHaveLength(2)
    const summary = toolbar.querySelector<HTMLElement>('[data-period-summary]')!
    // 2026-08-28 is a Friday; the organisation's week starts on Monday.
    await vi.waitFor(() => expect(summary.textContent).toBe('24 – 30 Aug 2026'))
    // No kind menu, because there is no month-shaped grid to put one on.
    expect(toolbar.querySelectorAll('[data-period-kind]')).toHaveLength(0)

    const week = (): string | null => new URL(globalThis.location.href).searchParams.get('week')
    toolbar.querySelector<HTMLButtonElement>('[data-period-previous]')!.click()
    await vi.waitFor(() => expect(week()).toBe('2026-08-17'))
    // The label follows the week that loaded, not the one that was asked for.
    expect(summary.textContent).toBe('17 – 23 Aug 2026')

    toolbar.querySelector<HTMLButtonElement>('[data-period-next]')!.click()
    await vi.waitFor(() => expect(week()).toBe('2026-08-24'))
    expect(summary.textContent).toBe('24 – 30 Aug 2026')
  })

  it('[browser] keeps the timesheet period on the organisation week, not on Monday', async () => {
    // The eyebrow this control replaced read "Monday–Sunday" whatever the
    // organisation had set, so the one screen that has always known about
    // `week_start_day` was also the one screen saying the wrong thing about it.
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    const api = browserApi()
    api.getTimeEntrySettings = vi.fn(async () => ({
      time_entry_mode: api.timeEntryMode,
      time_format: api.timeFormat,
      clock: api.clock,
      week_start_day: 'saturday' as const,
    }))
    await mountShell(api)

    const toolbar = document.querySelector<HTMLElement>('[data-week-period]')!
    expect(toolbar.querySelectorAll('.period-step')).toHaveLength(2)
    const summary = toolbar.querySelector<HTMLElement>('[data-period-summary]')!
    // 2026-08-28 is a Friday, so a Saturday week holds it from the 22nd.
    await vi.waitFor(() => expect(summary.textContent).toBe('22 – 28 Aug 2026'))

    toolbar.querySelector<HTMLButtonElement>('[data-period-previous]')!.click()
    await vi.waitFor(() =>
      expect(new URL(globalThis.location.href).searchParams.get('week')).toBe('2026-08-15'),
    )
    expect(summary.textContent).toBe('15 – 21 Aug 2026')
  })

  it('[browser] opens the add-row dialog on Enter with a modifier, from inside a cell', async () => {
    // Adding a row is the one action taken mid-typing, so it keeps a modifier
    // and has to work while a cell has focus.
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    await mountShell(browserApi())

    desktopInputs()[0]!.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
    )

    await vi.waitFor(() =>
      expect(document.querySelector('[data-row-dialog]')?.hasAttribute('open')).toBe(true),
    )
  })


  it('[e2e:track-week] preserves keyboard edits, notes, retry, copy, and phone-day writes', async () => {
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    const api = browserApi()

    await mountShell(api)
    expect(desktopInputs()).toHaveLength(7)
    expect(document.querySelector('[data-session-status]')?.textContent).toContain('Connected')

    const monday = desktopInputs()[0]!
    edit(monday, '1.5')
    monday.blur()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-24', seconds: 5_400 }),
      ),
    )

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note',
        )?.disabled,
      ).toBe(false),
    )
    const mondayNote = document.querySelector<HTMLButtonElement>(
      '[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note',
    )!
    mondayNote.click()
    expect(document.querySelector<HTMLDialogElement>('[data-note-dialog]')?.open).toBe(
      true,
    )
    const note = document.querySelector<HTMLTextAreaElement>('[data-note-input]')!
    expect(note.required).toBe(false)
    expect(note.minLength).toBe(0)
    expect(note.maxLength).toBe(10_000)
    note.value = 'Keyboard-first delivery'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.updateTimeEntry).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({
          spent_date: '2026-08-24',
          notes: 'Keyboard-first delivery',
        }),
      ),
    )
    document.documentElement.dataset.timeView = 'day'
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[data-entry-note]')].map((item) => item.textContent),
      ).toContain('Keyboard-first delivery'),
    )

    const tuesday = desktopInputs()[1]!
    api.failNextCreate = true
    edit(tuesday, '0.75')
    tuesday.blur()
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-week-grid] [data-cell-key="1:1:2026-08-25"] .cell-retry',
        ),
      ).not.toBeNull(),
    )
    document
      .querySelector<HTMLButtonElement>(
        '[data-week-grid] [data-cell-key="1:1:2026-08-25"] .cell-retry',
      )!
      .click()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-25', seconds: 2_700 }),
      ),
    )

    const wednesday = desktopInputs()[2]!
    edit(wednesday, '0.5')
    wednesday.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await vi.waitFor(() => {
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: '2026-08-26', seconds: 1_800 }),
      )
      expect((document.activeElement as HTMLInputElement).dataset.cellKey).toBe('1:1:2026-08-27')
    })

    document.querySelector<HTMLButtonElement>('[data-copy-last-week]')!.click()
    await vi.waitFor(() => expect(desktopInputs()).toHaveLength(14))
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-week-grid] [data-cell-key="2:2:2026-08-28"] input',
      )?.value,
    ).toBe('')

    document.querySelector<HTMLButtonElement>('[data-day-next]')!.click()
    const nextDay = document.querySelector<HTMLInputElement>(
      '[data-day-list] input[data-cell-key^="1:1:"]',
    )!
    const spentDate = nextDay.dataset.cellKey!.split(':').at(-1)!
    edit(nextDay, '0.25')
    nextDay.blur()
    await vi.waitFor(() =>
      expect(api.entries).toContainEqual(
        expect.objectContaining({ spent_date: spentDate, seconds: 900 }),
      ),
    )
  })

  it('[e2e:track-week] preserves a required cell through a stale note-policy correction', async () => {
    renderBrowserShell()
    const api = browserApi(3)
    api.staleMinimumOnNextCreate = 8

    await mountShell(api)
    const tuesday = desktopInputs()[1]!
    edit(tuesday, '0.5')
    tuesday.blur()

    const noteDialog = document.querySelector<HTMLDialogElement>(
      '[data-note-dialog]',
    )!
    const note = document.querySelector<HTMLTextAreaElement>(
      '[data-note-input]',
    )!
    expect(noteDialog.open).toBe(true)
    expect(document.activeElement).toBe(note)
    expect(note.required).toBe(true)
    expect(note.minLength).toBe(3)
    expect(note.getAttribute('aria-describedby')).toBe('note-hint note-result')
    expect(document.querySelector('[data-note-hint]')?.textContent).toContain(
      'at least 3 characters',
    )
    expect(desktopInputs()[1]?.value).toBe('0.5')
    expect(api.createTimeEntry).not.toHaveBeenCalled()

    note.value = 'no'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(api.createTimeEntry).not.toHaveBeenCalled()
    expect(noteDialog.open).toBe(true)
    expect(document.querySelector('[data-note-result]')?.textContent).toContain(
      'at least 3 characters',
    )

    note.value = 'yes'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(note.minLength).toBe(8))
    expect(noteDialog.open).toBe(true)
    expect(document.activeElement).toBe(note)
    expect(note.value).toBe('yes')
    expect(desktopInputs()[1]?.value).toBe('0.5')
    expect(document.querySelector('[data-note-result]')?.textContent).toContain(
      'policy changed',
    )
    expect(document.querySelector('.cell-retry')).toBeNull()

    note.value = 'eight ok'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(noteDialog.open).toBe(false))
    expect(api.createTimeEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spent_date: '2026-08-25',
        seconds: 1_800,
        notes: 'eight ok',
      }),
      expect.any(AbortSignal),
    )
    expect(api.entries).toContainEqual(
      expect.objectContaining({
        spent_date: '2026-08-25',
        minimum_note_length: 8,
        notes: 'eight ok',
      }),
    )
  })

  it('[browser] Shift+Enter logs time against text that names a screen', async () => {
    // Enter navigates and Shift+Enter logs time. The case that decides the
    // design is text that is BOTH: "invoices" is a destination, so plain Enter
    // must go there, and Shift+Enter must not -- otherwise the modifier means
    // "sometimes" and the control cannot be used blind.
    renderBrowserShell()
    const api = browserApi(0)
    await mountShell(api)

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    const command = document.querySelector<HTMLInputElement>('[name="command"]')!
    command.value = 'log 1h northpeak development'
    command.dispatchEvent(new Event('input', { bubbles: true }))
    command.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )

    const entryDialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    await vi.waitFor(() => expect(entryDialog.open).toBe(true))
    expect(entryDialog.dataset.entryContext).toBe('quick-add')
  })

  it('[e2e:track-week] applies exact note policy to quick-add and timer notes', async () => {
    renderBrowserShell()
    const api = browserApi(5)
    await mountShell(api)

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    const command = document.querySelector<HTMLInputElement>('[name="command"]')!
    const submitCommand = (): void => {
      document
        .querySelector<HTMLFormElement>('[data-command-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }
    command.value = 'log 1h northpeak development'
    submitCommand()
    const entryDialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    const entryNote = document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!
    await vi.waitFor(() => expect(entryDialog.open).toBe(true))
    expect(entryDialog.dataset.entryContext).toBe('quick-add')
    expect(entryNote.required).toBe(true)
    expect(entryNote.minLength).toBe(5)
    expect(document.activeElement).toBe(entryNote)
    expect(command.value).toBe('log 1h northpeak development')
    expect(api.createTimeEntry).not.toHaveBeenCalled()
    document
      .querySelector<HTMLFormElement>('[data-entry-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(document.querySelector('[data-entry-result]')?.textContent).toContain(
      'at least 5 characters',
    )
    entryDialog.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click()

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    command.value = 'log 1h northpeak design enough detail'
    submitCommand()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-command-result]')?.textContent).toContain(
        'combination is not available',
      ),
    )
    expect(api.createTimeEntry).not.toHaveBeenCalled()

    command.value = 'log 1h northpeak development shipped'
    command.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('[data-command-result]')?.textContent).toBe('')
    submitCommand()
    await vi.waitFor(() => expect(entryDialog.open).toBe(true))
    document
      .querySelector<HTMLFormElement>('[data-entry-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.createTimeEntry).toHaveBeenCalledTimes(1))

    document.querySelector<HTMLButtonElement>('[data-timer-chip]')!.click()
    const timerDialog = document.querySelector<HTMLDialogElement>(
      '[data-timer-dialog]',
    )!
    expect(timerDialog.open).toBe(true)
    const timerProject = document.querySelector<HTMLSelectElement>(
      '[data-timer-form] [name="project"]',
    )!
    const timerTask = document.querySelector<HTMLSelectElement>(
      '[data-timer-form] [name="task"]',
    )!
    const timerNote = document.querySelector<HTMLTextAreaElement>(
      '[data-timer-note]',
    )!
    const submitTimer = (): void => {
      document
        .querySelector<HTMLFormElement>('[data-timer-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }
    // The assignment controls are selects now, so an unavailable project/task
    // pair cannot be assembled here at all: choosing the project narrows the
    // task list to the tasks that project actually offers. What used to be a
    // refusal after submitting is a combination the form no longer lets you
    // build (issues 497 and 506).
    timerProject.value = 'Northpeak'
    timerProject.dispatchEvent(new Event('change', { bubbles: true }))
    expect([...timerTask.options].map((option) => option.value)).toEqual(['Development'])
    expect(timerTask.value).toBe('Development')
    expect(api.createTimeEntry).toHaveBeenCalledTimes(1)

    timerNote.value = ''
    submitTimer()
    await vi.waitFor(() => expect(timerNote.minLength).toBe(5))
    expect(timerNote.required).toBe(true)
    expect(document.activeElement).toBe(timerNote)
    expect(document.querySelector('[data-timer-result]')?.textContent).toContain(
      'at least 5 characters',
    )
    expect(api.createTimeEntry).toHaveBeenCalledTimes(1)

    timerNote.value = 'timer notes'
    timerNote.dispatchEvent(new Event('input', { bubbles: true }))
    expect(document.querySelector('[data-timer-result]')?.textContent).toBe('')
    submitTimer()
    await vi.waitFor(() => expect(api.createTimeEntry).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(timerDialog.open).toBe(false))
    expect(api.createTimeEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ notes: 'timer notes' }),
      expect.any(AbortSignal),
    )
  })

  it('[browser] clears a task the new project does not offer, rather than refusing the entry', async () => {
    // The reported symptom was "I cannot select a different activity". The task
    // box is a text input with a datalist, so switching project narrowed the
    // list underneath while the old activity stayed in the box -- and the pair
    // check then refused the entry with a message about the combination, which
    // reads as the picker being broken.
    renderBrowserShell()
    const api = browserApi()
    await mountShell(api)

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    const command = document.querySelector<HTMLInputElement>('[name="command"]')!
    command.value = 'log 1h northpeak development notes enough'
    document
      .querySelector<HTMLFormElement>('[data-command-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    const entryDialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    await vi.waitFor(() => expect(entryDialog.open).toBe(true))

    const project = document.querySelector<HTMLSelectElement>('[data-entry-project]')!
    const task = document.querySelector<HTMLSelectElement>('[data-entry-task]')!
    expect(project.value).toBe('Northpeak')
    expect(task.value).toBe('Development')

    // Acme offers Design and nothing else. Development has to go, or it is
    // submitted against a project that never had it.
    project.value = 'Acme'
    project.dispatchEvent(new Event('change', { bubbles: true }))
    expect(task.value).toBe('')
    expect(
      [...document.querySelectorAll('[data-entry-task-options] option')].map(
        (node) => (node as HTMLOptionElement).value,
      ),
    ).toEqual(['Design'])

    // A task the project does offer survives the same keystrokes: this clears
    // what is wrong, not whatever is there.
    task.value = 'Design'
    project.dispatchEvent(new Event('change', { bubbles: true }))
    expect(task.value).toBe('Design')
  })


  it('[browser #494] offers the right activity when the editor reopens on another project', async () => {
    renderBrowserShell()
    const api = browserApi()
    await mountShell(api)

    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    const task = document.querySelector<HTMLSelectElement>('[data-entry-task]')!
    const openVia = async (command: string): Promise<void> => {
      document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
      const box = document.querySelector<HTMLInputElement>('[name="command"]')!
      box.value = command
      document
        .querySelector<HTMLFormElement>('[data-command-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
      await vi.waitFor(() => expect(dialog.open).toBe(true))
    }

    await openVia('log 1h northpeak development notes enough')
    expect(task.value).toBe('Development')
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click()

    // The second entry belongs to a different project. Its activity is the one
    // the editor must show -- a select can only hold a value it offers, and the
    // task list is still narrowed to the previous project.
    await openVia('log 1h acme design notes enough')
    expect(task.value).toBe('Design')
  })

  it('[browser #494] still shows an activity whose assignment has been archived', async () => {
    // 177 of 358 task assignments arrived from the import already archived, so
    // an existing entry can sit on a pair the catalogue no longer offers. The
    // editor has to show what the entry *is*; blanking it would turn opening a
    // week into silently reassigning it.
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 2,
        spent_date: '2026-08-28',
        seconds: 3_600,
        notes: 'On an archived assignment',
      }),
    )
    await mountShell(api)

    const note = document.querySelector<HTMLButtonElement>(
      '[data-week-grid] [data-cell-key="1:2:2026-08-28"] .cell-note',
    )
    // The row exists because the entry does, even though no option offers it.
    expect(note).not.toBeNull()
    note!.click()

    const task = document.querySelector<HTMLSelectElement>('[data-entry-task]')!
    expect(task.value).toBe('Design')
    // Offered, but marked -- so a person can see the pair is no longer current
    // rather than wondering why it is missing from the list.
    expect(
      task.querySelector<HTMLOptionElement>('option[data-entry-unavailable]')?.value,
    ).toBe('Design')
  })

  it('[e2e:track-week] routes week, Day, K-bar, and edit through one editor instance', async () => {
    renderBrowserShell()
    const api = browserApi()
    await mountShell(api)

    const editor = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    expect(document.querySelectorAll('[data-entry-dialog]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-entry-form]')).toHaveLength(1)
    const closeEditor = (): void => {
      editor.querySelector<HTMLButtonElement>('[data-dialog-close]')!.click()
    }

    document
      .querySelector<HTMLButtonElement>(
        '[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note',
      )!
      .click()
    expect(editor.open).toBe(true)
    expect(editor.dataset.entryContext).toBe('week-cell')
    closeEditor()

    document
      .querySelector<HTMLButtonElement>(
        '[data-day-list] [data-cell-key="1:1:2026-08-24"] .cell-note',
      )!
      .click()
    expect(editor).toBe(document.querySelector('[data-entry-dialog]'))
    expect(editor.dataset.entryContext).toBe('day')
    closeEditor()

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    const command = document.querySelector<HTMLInputElement>('[name="command"]')!
    command.value = 'log 1h northpeak development context note'
    document
      .querySelector<HTMLFormElement>('[data-command-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(editor.open).toBe(true))
    expect(editor).toBe(document.querySelector('[data-entry-dialog]'))
    expect(editor.dataset.entryContext).toBe('quick-add')
    closeEditor()

    document
      .querySelector<HTMLButtonElement>(
        '[data-week-grid] [data-cell-key="1:1:2026-08-28"] .cell-note',
      )!
      .click()
    expect(editor).toBe(document.querySelector('[data-entry-dialog]'))
    expect(editor.dataset.entryContext).toBe('edit')
  })

  const durationsOnScreen = (): {
    readonly cell: string
    readonly rowTotal: string
    readonly footTotals: readonly string[]
    readonly weekTotal: string
    readonly dayStrip: string
    readonly timerElapsed: string
  } => {
    const cell = document.querySelector<HTMLInputElement>(
      '[data-week-grid] [data-cell-key="1:1:2026-08-28"] input',
    )!
    return {
      cell: cell.value,
      rowTotal: cell.closest('tr')!.querySelector('.row-total')!.textContent!,
      footTotals: [...document.querySelectorAll('[data-week-grid-totals] td')].map(
        (total) => total.textContent!,
      ),
      weekTotal: document.querySelector('[data-week-total]')!.textContent!,
      dayStrip: document.querySelector(
        '[data-day-totals] li[data-day-total="2026-08-28"] strong',
      )!.textContent!,
      timerElapsed: document.querySelector('[data-timer-elapsed]')!.textContent!,
    }
  }

  it('[browser] renders every total in the decimal format the organisation chose', async () => {
    // A cell rendered through formatCellHours and every total around it through
    // a hardcoded H:MM, so 2.25 in a cell sat beside 2:15 in that cell's own row
    // total. Every total around a cell has to agree with it, and with the rest.
    //
    // 8,130s (2h15m30s) rather than a round 8,100: at 8,100 the cell formatter
    // and the totals formatter happened to print the same string, so the two
    // could disagree in rounding and precision and this test would still pass.
    // Stopping a timer produces seconds like these routinely.
    renderBrowserShell()
    const api = browserApi()
    api.timeFormat = 'decimal'
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, { project_id: 1, task_id: 1, spent_date: '2026-08-28', seconds: 8_130 }),
    )
    await mountShell(api)

    const durations = await vi.waitFor(() => {
      const seen = durationsOnScreen()
      expect(seen.weekTotal).not.toBe('—')
      return seen
    })
    expect(durations.cell).toBe('2.2583')
    expect(durations.rowTotal).toBe(durations.cell)
    expect(durations.weekTotal).toBe(durations.cell)
    expect(durations.dayStrip).toBe(durations.cell)
    // Seven days and the grand total; only the Friday carries time.
    expect(durations.footTotals).toEqual([
      '0',
      '0',
      '0',
      '0',
      '2.2583',
      '0',
      '0',
      '2.2583',
    ])
    // The idle chip is a duration in the same column of numbers as the rest, so
    // its placeholder follows the setting rather than reading 0:00 beside 2.25.
    expect(durations.timerElapsed).toBe('0')
  })

  it('[browser] agrees with itself on the roundest hour a timesheet carries', async () => {
    // One hour exactly. The cell prints an integer as `1`; the totals used to
    // pad it to `1.00`, so the commonest value on a timesheet was also a
    // mismatch — no sub-minute remainder required.
    renderBrowserShell()
    const api = browserApi()
    api.timeFormat = 'decimal'
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, { project_id: 1, task_id: 1, spent_date: '2026-08-28', seconds: 3_600 }),
    )
    await mountShell(api)

    const durations = await vi.waitFor(() => {
      const seen = durationsOnScreen()
      expect(seen.weekTotal).not.toBe('—')
      return seen
    })
    expect(durations.cell).toBe('1')
    expect(durations.rowTotal).toBe(durations.cell)
    expect(durations.weekTotal).toBe(durations.cell)
    expect(durations.dayStrip).toBe(durations.cell)
  })

  it('[browser] renders those same totals as hours and minutes when that is the setting', async () => {
    renderBrowserShell()
    const api = browserApi()
    api.timeFormat = 'hours_minutes'
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, { project_id: 1, task_id: 1, spent_date: '2026-08-28', seconds: 8_130 }),
    )
    await mountShell(api)

    const durations = await vi.waitFor(() => {
      const seen = durationsOnScreen()
      expect(seen.weekTotal).not.toBe('—')
      return seen
    })
    // 2h15m30s is nearer 2:16 than 2:15, and the cell has always said so. The
    // totals floored the same seconds to 2:15 — the screenshot on issue 295.
    expect(durations.cell).toBe('2:16')
    expect(durations.rowTotal).toBe(durations.cell)
    expect(durations.weekTotal).toBe(durations.cell)
    expect(durations.dayStrip).toBe(durations.cell)
    expect(durations.footTotals).toEqual([
      '0:00',
      '0:00',
      '0:00',
      '0:00',
      '2:16',
      '0:00',
      '0:00',
      '2:16',
    ])
    expect(durations.timerElapsed).toBe('0:00')
  })

  it('[e2e:track-week] displays 12-hour times and submits canonical start/end values', async () => {
    renderBrowserShell()
    const api = browserApi()
    api.timeEntryMode = 'start_end'
    api.timeFormat = 'hours_minutes'
    api.clock = '12h'
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        started_time: '09:05',
        ended_time: '17:35',
      }),
    )
    await mountShell(api)

    const existingInput = document.querySelector<HTMLInputElement>(
      '[data-week-grid] [data-cell-key="1:1:2026-08-28"] input',
    )!
    expect(existingInput.disabled).toBe(true)
    expect(existingInput.value).toBe('8:30')
    document
      .querySelector<HTMLButtonElement>(
        '[data-week-grid] [data-cell-key="1:1:2026-08-28"] .cell-note',
      )!
      .click()
    const start = document.querySelector<HTMLInputElement>('[data-entry-start]')!
    const end = document.querySelector<HTMLInputElement>('[data-entry-end]')!
    expect(start.value).toBe('9:05 AM')
    expect(end.value).toBe('5:35 PM')
    start.value = '10:15 PM'
    end.value = '1:45 AM'
    document
      .querySelector<HTMLFormElement>('[data-entry-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.updateTimeEntry).toHaveBeenCalled())
    expect(api.updateTimeEntry).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({
        started_time: '22:15',
        ended_time: '01:45',
      }),
      expect.any(AbortSignal),
    )
    expect(vi.mocked(api.updateTimeEntry).mock.lastCall?.[1]).not.toHaveProperty('seconds')

    document
      .querySelector<HTMLButtonElement>(
        '[data-week-grid] [data-cell-key="1:1:2026-08-24"] .cell-note',
      )!
      .click()
    start.value = '12:05 AM'
    end.value = '12:35 AM'
    document
      .querySelector<HTMLFormElement>('[data-entry-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.createTimeEntry).toHaveBeenCalled())
    expect(api.createTimeEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        spent_date: '2026-08-24',
        started_time: '00:05',
        ended_time: '00:35',
      }),
      expect.any(AbortSignal),
    )
    expect(vi.mocked(api.createTimeEntry).mock.lastCall?.[0]).not.toHaveProperty('seconds')
  })

  it('[e2e:track-week] preserves exact sub-minute duration on note-only and no-op saves', async () => {
    renderBrowserShell()
    const api = browserApi()
    api.timeFormat = 'hours_minutes'
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        seconds: 90,
        notes: 'Exact duration',
      }),
    )
    await mountShell(api)

    const openExisting = (): void => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-week-grid] [data-cell-key="1:1:2026-08-28"] .cell-note',
        )!
        .click()
    }
    const submit = (): void => {
      document
        .querySelector<HTMLFormElement>('[data-entry-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }
    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!

    openExisting()
    expect(document.querySelector<HTMLInputElement>('[data-entry-duration-input]')?.value).toBe(
      '0:02',
    )
    document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!.value =
      'Note-only change'
    submit()
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(vi.mocked(api.updateTimeEntry).mock.lastCall?.[1]).not.toHaveProperty('seconds')
    expect(api.entries[0]).toMatchObject({ seconds: 90, notes: 'Note-only change' })

    openExisting()
    submit()
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(api.updateTimeEntry).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.updateTimeEntry).mock.lastCall?.[1]).not.toHaveProperty('seconds')
    expect(api.entries[0]?.seconds).toBe(90)
  })

  it('[e2e:track-week] edits a running entry note without changing timer fields', async () => {
    renderBrowserShell()
    const api = browserApi()
    api.entries[0] = timeEntry(1, {
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      notes: 'Initial running note',
    })
    await mountShell(api)

    const noteButton = document.querySelector<HTMLButtonElement>(
      '[data-week-grid] [data-cell-key="1:1:2026-08-28"] .cell-note',
    )!
    expect(noteButton.disabled).toBe(false)
    noteButton.click()
    const note = document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!
    expect(note.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-entry-submit]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-stop-timer]')?.hidden).toBe(false)
    note.value = 'Updated while running'
    document
      .querySelector<HTMLFormElement>('[data-entry-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.updateTimeEntry).toHaveBeenCalled())
    expect(api.updateTimeEntry).toHaveBeenLastCalledWith(
      1,
      { notes: 'Updated while running' },
      expect.any(AbortSignal),
    )
  })

  // Keep each outcome within the normal test budget: parsing the full shell is
  // expensive on CI, and a second parse plus all outcomes exceeded five seconds.
  it('[e2e:track-week] adds, focuses and persists a row', async () => {
    renderBrowserShell()
    await mountShell(browserApi())
    const openAddRow = (): void => {
      document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    }
    const submitRow = (): void => {
      document
        .querySelector<HTMLFormElement>('[data-row-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }

    openAddRow()
    document.querySelector<HTMLSelectElement>('[data-row-project]')!.value = '2'
    document
      .querySelector<HTMLSelectElement>('[data-row-project]')!
      .dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector<HTMLSelectElement>('[data-row-task]')!.value = '2'
    submitRow()

    const added = document.querySelector<HTMLInputElement>(
      '[data-week-grid] input[data-cell-key="2:2:2026-08-24"]',
    )
    expect(added).not.toBeNull()
    expect(document.activeElement).toBe(added)
    expect(document.querySelector('[data-session-message]')?.textContent).toContain('row added')

    expect(JSON.parse(globalThis.localStorage.getItem('ezacto:user:1:week-rows:2026-08-24')!)).toEqual([{ projectId: 2, taskId: 2 }])
  })

  it('[e2e:track-week] restores a saved row and reports a duplicate without adding another', async () => {
    renderBrowserShell()
    globalThis.localStorage.setItem('ezacto:user:1:week-rows:2026-08-24', JSON.stringify([{ projectId: 2, taskId: 2 }]))
    await mountShell(browserApi())
    expect(document.querySelectorAll('[data-week-grid] input[data-cell-key="2:2:2026-08-24"]')).toHaveLength(1)
    const openAddRow = (): void => {
      document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    }
    const submitRow = (): void => {
      document
        .querySelector<HTMLFormElement>('[data-row-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }

    openAddRow()
    document.querySelector<HTMLSelectElement>('[data-row-project]')!.value = '2'
    document
      .querySelector<HTMLSelectElement>('[data-row-project]')!
      .dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector<HTMLSelectElement>('[data-row-task]')!.value = '2'
    submitRow()
    const existing = document.querySelector<HTMLInputElement>(
      '[data-week-grid] input[data-cell-key="2:2:2026-08-24"]',
    )
    expect(existing).not.toBeNull()
    expect(document.querySelector('[data-row-result]')?.textContent).toContain(
      'already on this week',
    )

    expect(document.querySelectorAll('[data-week-grid] input[data-cell-key="2:2:2026-08-24"]')).toHaveLength(1)
  })

  it('[e2e:track-week] rejects an invalid row without changing saved rows', async () => {
    renderBrowserShell()
    globalThis.localStorage.setItem('ezacto:user:1:week-rows:2026-08-24', JSON.stringify([{ projectId: 2, taskId: 2 }]))
    await mountShell(browserApi())
    const openAddRow = (): void => {
      document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    }
    const submitRow = (): void => {
      document
        .querySelector<HTMLFormElement>('[data-row-form]')!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }

    openAddRow()
    const storageKey = 'ezacto:user:1:week-rows:2026-08-24'
    const beforeInvalid = globalThis.localStorage.getItem(storageKey)
    const project = document.querySelector<HTMLSelectElement>('[data-row-project]')!
    const unavailable = document.createElement('option')
    unavailable.textContent = 'Northpeak'
    unavailable.value = '1'
    project.append(unavailable)
    project.value = '1'
    const task = document.querySelector<HTMLSelectElement>('[data-row-task]')!
    const mismatched = document.createElement('option')
    mismatched.textContent = 'Design'
    mismatched.value = '2'
    task.append(mismatched)
    task.value = '2'
    submitRow()
    expect(document.querySelector<HTMLDialogElement>('[data-row-dialog]')?.open).toBe(true)
    expect(document.querySelector('[data-row-result]')?.textContent).toContain(
      'available project and task',
    )
    expect(document.querySelector('[data-week-grid] [data-cell-key^="1:2:"]')).toBeNull()
    expect(globalThis.localStorage.getItem(storageKey)).toBe(beforeInvalid)
  })

  it('[e2e:phone-week] renders the full note on each individual day entry', async () => {
    renderBrowserShell()
    window.history.replaceState(null, '', '/?view=day&week=2026-08-28')
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-24',
        seconds: 1_800,
        notes: 'First line\nSecond line with delivery detail',
      }),
      timeEntry(2, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-24',
        seconds: 900,
        notes: 'Separate follow-up',
      }),
      timeEntry(3, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-24',
        seconds: 300,
        notes: null,
      }),
    )

    await mountShell(api)

    const rows = [...document.querySelectorAll<HTMLElement>('[data-day-rows] .day-row')]
    expect(rows).toHaveLength(3)
    expect(rows[0]?.querySelector('[data-entry-note]')?.textContent).toBe(
      'First line\nSecond line with delivery detail',
    )
    expect(rows[1]?.querySelector('[data-entry-note]')?.textContent).toBe('Separate follow-up')
    expect(rows[2]?.querySelector('[data-entry-note]')?.textContent).toBe('No note')
    const noteLabels = rows.map(
      (row) => row.querySelector<HTMLButtonElement>('.cell-note')?.ariaLabel,
    )
    expect(new Set(noteLabels).size).toBe(3)
    expect(noteLabels[0]).toContain('Edit note for Northpeak / Development · entry 1')
    expect(noteLabels[1]).toContain('Edit note for Northpeak / Development · entry 2')
    expect(noteLabels[2]).toContain('Add note for Northpeak / Development · entry 3')
    expect(rows[1]?.querySelector<HTMLInputElement>('input')?.value).toBe('0.25')

    document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    document.querySelector<HTMLSelectElement>('[data-row-project]')!.value = '1'
    document.querySelector<HTMLSelectElement>('[data-row-task]')!.value = '1'
    document
      .querySelector<HTMLFormElement>('[data-row-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(document.querySelector('[data-row-result]')?.textContent).toContain('already on this week')
  })

  describe('a week cell two entries share (issue 904)', () => {
    // Two sessions on one task on one day is ordinary, not a conflict. The cell
    // used to be a disabled input labelled "Split" with its only explanation in
    // a tooltip, and nothing on it led to the Day view that edits them apart.
    const twoSessions = async (): Promise<HTMLElement> => {
      renderBrowserShell()
      window.history.replaceState(null, '', '/?week=2026-08-28')
      const api = browserApi()
      api.entries.splice(
        0,
        api.entries.length,
        timeEntry(1, {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-26',
          seconds: 7_200,
          notes: 'Morning session',
        }),
        timeEntry(2, {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-26',
          seconds: 7_200,
          notes: 'Afternoon session',
        }),
      )
      await mountShell(api)
      return document.querySelector<HTMLElement>(
        '[data-week-grid] .week-cell[data-cell-key="1:1:2026-08-26"]',
      )!
    }

    const expectDayOpened = (): void => {
      expect(document.documentElement.dataset.timeView).toBe('day')
      expect(new URL(globalThis.location.href).searchParams.get('view')).toBe('day')
      expect(new URL(globalThis.location.href).searchParams.get('week')).toBe('2026-08-28')
      expect(document.querySelector('[data-day-label]')?.textContent).toBe('Wednesday, Aug 26')
      const rows = [...document.querySelectorAll<HTMLElement>('[data-day-rows] .day-row')]
      expect(rows.map((row) => row.querySelector('[data-entry-note]')?.textContent)).toEqual([
        'Morning session',
        'Afternoon session',
      ])
      // Ready to edit the first of the two, each with its own value.
      expect(document.activeElement).toBe(rows[0]!.querySelector('input'))
      expect(rows.map((row) => row.querySelector('input')?.value)).toEqual(['2', '2'])
      expect(
        document.querySelector('[data-time-views] a[aria-current="page"]')?.textContent,
      ).toBe('Day')
    }

    it('[browser] says what the cell holds and stays reachable', async () => {
      const cell = await twoSessions()

      expect(cell.dataset.cellState).toBe('conflict')
      expect(cell.querySelector('.cell-status')?.textContent).toBe('2 entries')
      const input = cell.querySelector<HTMLInputElement>('input')!
      expect(input.disabled).toBe(false)
      expect(input.readOnly).toBe(true)
      expect(input.value).toBe('4')
      const open = cell.querySelector<HTMLButtonElement>('.cell-note')!
      expect(open.disabled).toBe(false)
      expect(open.ariaLabel).toBe(
        'Open Day view to edit the 2 entries for Northpeak / Development on Wednesday, Aug 26',
      )
      // The totals still count both sessions.
      expect(document.querySelector('[data-week-total]')?.textContent).toBe('4')
    })

    it('[browser] opens the day that lists them apart from the cell button', async () => {
      const cell = await twoSessions()
      cell.querySelector<HTMLButtonElement>('.cell-note')!.click()
      expectDayOpened()
    })

    it('[browser] opens the same day from a click or Enter on the cell itself', async () => {
      const clicked = await twoSessions()
      clicked.querySelector<HTMLInputElement>('input')!.click()
      expectDayOpened()

      const keyed = await twoSessions()
      const input = keyed.querySelector<HTMLInputElement>('input')!
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      expectDayOpened()
    })
  })

  it.each([
    ['locked', { spent_date: '2026-08-24', is_locked: true }],
    ['running', { spent_date: '2026-08-24', is_running: true, timer_started_at: timestamp }],
  ])('[e2e:track-week] explains an existing %s row inside the dialog', async (_state, patch) => {
    renderBrowserShell()
    const api = browserApi()
    api.entries[0] = { ...api.entries[0]!, ...patch }

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    document.querySelector<HTMLSelectElement>('[data-row-project]')!.value = '1'
    document.querySelector<HTMLSelectElement>('[data-row-task]')!.value = '1'
    document
      .querySelector<HTMLFormElement>('[data-row-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    const wrapper = document.querySelector<HTMLElement>(
      '[data-week-grid] .week-cell[data-cell-key="1:1:2026-08-24"]',
    )
    expect(wrapper).not.toBeNull()
    expect(document.querySelector('[data-row-result]')?.textContent).toContain(
      'already on this week',
    )
  })

  it('[browser #496] deletes an entry from the dialog and refuses a billed one by its own reason', async () => {
    // deleteTimeEntry was wired and reachable only by clearing a cell to zero.
    // The capability existed; the affordance did not, which is what "no way to
    // delete a time entry" actually described.
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        seconds: 3_600,
        notes: 'Deletable',
      }),
    )
    await mountShell(api)

    const openCell = (): void => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-week-grid] [data-cell-key="1:1:2026-08-28"] .cell-note',
        )!
        .click()
    }
    const remove = document.querySelector<HTMLButtonElement>('[data-entry-delete]')!

    openCell()
    expect(remove.hidden).toBe(false)
    remove.click()
    await vi.waitFor(() => expect(api.deleteTimeEntry).toHaveBeenCalledWith(1, expect.anything()))
    expect(api.entries).toHaveLength(0)
  })

  it('[browser #753] opens the editor from the keyboard without costing a tab stop', async () => {
    // #496 gave the dialog a delete button and a note field. Nothing reached it
    // from the keyboard: Enter on a cell commits, and the control that opens it
    // is deliberately outside the tab sequence so a week row is seven stops
    // rather than fourteen. Alt+Enter uses the stop the cell already has.
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        seconds: 3_600,
        notes: 'Reachable by keyboard',
      }),
    )
    await mountShell(api)

    const cell = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>(
        '[data-week-grid] input[data-cell-key="1:1:2026-08-28"]',
      )
      expect(found).not.toBeNull()
      return found!
    })
    cell.focus()
    cell.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }),
    )

    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    expect(dialog.open).toBe(true)
    // The note is there to edit and the entry is there to remove -- the two
    // things the screen appeared not to offer.
    expect(document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!.value).toBe(
      'Reachable by keyboard',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-entry-delete]')!.hidden).toBe(false)
  })

  it('[unit #753] keeps a week row at one tab stop per day', async () => {
    // The property the keyboard path was built around. Putting the opener in
    // the tab sequence would double a row's stops, which is what the grid
    // exists to avoid.
    renderBrowserShell()
    const api = browserApi()
    await mountShell(api)

    const row = await vi.waitFor(() => {
      const found = document.querySelector('[data-week-grid-rows] tr')
      expect(found).not.toBeNull()
      return found!
    })
    const stops = [...row.querySelectorAll<HTMLElement>('input, button, select, a[href]')].filter(
      (element) => element.tabIndex >= 0,
    )
    // Seven days, seven stops. The opener beside each cell is reachable by
    // click and by Alt+Enter, and is deliberately not an eighth through
    // fourteenth stop on the way across a week.
    expect(stops).toHaveLength(7)
  })

  it('[money #753] says what clearing a cell to zero removed', async () => {
    // Typing zero deletes the entry and its note. It stays possible, because
    // it is how a week gets corrected quickly, but it used to report nothing at
    // all -- indistinguishable from having saved a number.
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      timeEntry(1, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        seconds: 3_600,
        notes: 'Worth knowing this went',
      }),
    )
    await mountShell(api)

    const cell = await vi.waitFor(() => {
      const found = document.querySelector<HTMLInputElement>(
        '[data-week-grid] input[data-cell-key="1:1:2026-08-28"]',
      )
      expect(found).not.toBeNull()
      return found!
    })
    edit(cell, '0')
    cell.blur()

    await vi.waitFor(() => expect(api.deleteTimeEntry).toHaveBeenCalled())
    await vi.waitFor(() => {
      // Above the grid, not on the cell: removing the last entry of a row takes
      // the row with it, and a message on a cell that no longer exists is one
      // nobody reads.
      const notice = document.querySelector<HTMLElement>('[data-week-removed]')
      expect(notice?.hidden).toBe(false)
      // Names the note, because losing one silently is the part that costs.
      expect(notice?.textContent).toMatch(/Removed .* and its note/i)
    })
  })

  it('[security #496] opens a billed entry to be read, and offers no way to delete it', async () => {
    renderBrowserShell()
    const api = browserApi()
    api.entries.splice(
      0,
      api.entries.length,
      {
        // Spread over the helper, which hardcodes is_locked: false.
        ...timeEntry(1, {
          project_id: 1,
          task_id: 1,
          spent_date: '2026-08-28',
          seconds: 3_600,
          notes: 'Billed',
        }),
        invoice_id: 4242,
        is_billed: true,
        is_locked: true,
        locked_reason_code: 'invoiced',
        locked_reason: 'it is on invoice 4242',
      },
    )
    await mountShell(api)

    const note = document.querySelector<HTMLButtonElement>(
      '[data-week-grid] [data-cell-key="1:1:2026-08-28"] .cell-note',
    )!
    expect(note.disabled).toBe(false)
    expect(note.ariaLabel).toContain('Show why this is locked')
    note.click()

    const dialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    expect(dialog.open).toBe(true)
    // The reason is stated on arrival rather than after a refused press, and it
    // is the entry's own sentence, not a generic "locked".
    expect(document.querySelector('[data-entry-result]')?.textContent).toContain(
      'it is on invoice 4242',
    )
    // Read-only means read-only: no way in, and no way to remove it either.
    expect(document.querySelector<HTMLTextAreaElement>('[data-entry-note-input]')!.disabled).toBe(
      true,
    )
    expect(document.querySelector<HTMLSelectElement>('[data-entry-project]')!.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-entry-submit]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-entry-delete]')!.hidden).toBe(true)
    expect(api.deleteTimeEntry).not.toHaveBeenCalled()
    expect(api.entries).toHaveLength(1)
  })

  it('[browser oss#4] marks the grid busy and inert while another week loads, and clears it on success and failure', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-08-28T12:00:00'))
    renderBrowserShell()
    const api = browserApi()
    const list = api.listTimeEntries
    await mountShell(api)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-week-grid-rows] tr')).not.toBeNull(),
    )
    const surfaces = () => [
      document.querySelector<HTMLElement>('[data-week-grid]')!,
      document.querySelector<HTMLElement>('[data-day-list]')!,
    ]
    for (const surface of surfaces()) expect(surface.getAttribute('aria-busy')).not.toBe('true')
    const heading = () => document.querySelector('[data-week-grid-head]')!.textContent
    const before = heading()

    // Hold every week read open so the load is observably in flight.
    const gates: ReturnType<typeof deferred<unknown>>[] = []
    api.listTimeEntries = vi.fn(async (query) => {
      const gate = deferred<unknown>()
      gates.push(gate)
      await gate.promise
      return list(query)
    })
    const next = () =>
      document.querySelector<HTMLButtonElement>('[data-week-period] [data-period-next]')!
    next().click()
    next().click()
    next().click()

    // At once: the headings already name the new week, and nothing is editable.
    expect(heading()).not.toBe(before)
    for (const surface of surfaces()) {
      expect(surface.getAttribute('aria-busy')).toBe('true')
      expect(surface.hasAttribute('inert')).toBe(true)
    }
    // Quick answers never flash a skeleton; a slow one swaps the old rows out.
    expect(document.querySelector('.grid-skeleton')).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(document.querySelector('[data-week-grid-rows] .grid-skeleton')).not.toBeNull()
    expect(document.querySelector('[data-day-rows] .grid-skeleton')).not.toBeNull()

    // Rapid clicks: answering the superseded weeks does not end the busy state.
    for (const gate of gates.slice(0, -1)) gate.resolve(undefined)
    await vi.advanceTimersByTimeAsync(0)
    for (const surface of surfaces()) expect(surface.getAttribute('aria-busy')).toBe('true')
    gates.at(-1)!.resolve(undefined)
    await vi.waitFor(() => {
      for (const surface of surfaces()) expect(surface.getAttribute('aria-busy')).toBe('false')
    })
    for (const surface of surfaces()) expect(surface.hasAttribute('inert')).toBe(false)
    expect(document.querySelector('.grid-skeleton')).toBeNull()

    // A failed load hands over to the failure state instead of sticking.
    api.listTimeEntries = vi.fn(async () => {
      throw new Error('offline')
    })
    next().click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-week-grid-rows]')?.textContent).toContain(
        'Your week could not load',
      ),
    )
    for (const surface of surfaces()) {
      expect(surface.getAttribute('aria-busy')).toBe('false')
      expect(surface.hasAttribute('inert')).toBe(false)
    }
  })
})
