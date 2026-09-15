/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  desktopInputs,
  edit,
  mountShell,
  renderBrowserShell,
  timeEntry,
  timestamp,
} from './support/shell-harness.js'

describe('week-grid browser behavior', () => {
  it('[browser] offers Start on a week-grid row, from its most recent entry', async () => {
    // The day list has carried this since the timesheet work. On a desktop the
    // grid is the screen you are actually on, and it offered nothing: the only
    // way to start a timer was to retype the project and task into the top bar
    // as exact strings.
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    const restarted: number[] = []
    const api = browserApi()
    const withRestart = {
      ...api,
      restartTimeEntry: async (id: number) => {
        restarted.push(id)
        return api.entries[0]!
      },
    }

    await mountShell(withRestart)

    const start = await vi.waitFor(() => {
      const control = document.querySelector<HTMLButtonElement>(
        '[data-week-grid-rows] tr th .grid-row-start',
      )
      expect(control).not.toBeNull()
      return control!
    })
    // The most recent entry on the row, not the first: a new timer should
    // inherit the notes and rate of the work last done, not of the week's
    // opening row.
    expect(start.dataset.startEntry).toBe('1')
    expect(start.getAttribute('aria-label')).toContain('Start a timer on')

    start.click()
    await vi.waitFor(() => expect(restarted).toEqual([1]))
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

  it('[e2e:track-week] adds and focuses a row with explicit duplicate and invalid outcomes', async () => {
    renderBrowserShell()
    window.history.replaceState(null, '', '/?week=2026-08-28')
    const api = browserApi()

    await mountShell(api)
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

    renderBrowserShell({ preserveStorage: true })
    window.history.replaceState(null, '', '/?week=2026-08-28')
    await mountShell(api)
    expect(
      document.querySelector('[data-week-grid] input[data-cell-key="2:2:2026-08-24"]'),
    ).not.toBeNull()

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
    expect(document.activeElement).toBe(existing)
    expect(document.querySelector('[data-session-message]')?.textContent).toContain(
      'already exists',
    )

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
    expect(document.activeElement?.getAttribute('data-cell-key')).toBe(
      '1:1:2026-08-24:entry:1',
    )
  })

  it.each([
    ['locked', { spent_date: '2026-08-24', is_locked: true }],
    ['running', { spent_date: '2026-08-24', is_running: true, timer_started_at: timestamp }],
  ])('[e2e:track-week] focuses the %s cell wrapper for an existing row', async (_state, patch) => {
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
    expect(document.activeElement).toBe(wrapper)
    expect(document.querySelector('[data-session-message]')?.textContent).toContain(
      'focused now',
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
})
