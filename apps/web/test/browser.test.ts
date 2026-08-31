/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type AuthPrincipal,
  type GeneralResource,
  type Session,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryPatch,
  type Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { mountShell } from '../src/shell/browser.js'
import { renderAppShell, type ShellApi } from '../src/index.js'

const timestamp = '2026-08-28T12:00:00.000Z'

const identity: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}

const principal: AuthPrincipal = {
  status: 'authenticated',
  user_id: identity.user_id,
  profile: identity.profile,
  manager_grants: [],
}

const secondIdentity: Whoami = {
  user_id: 2,
  profile: 'member',
  manager_grants: [],
  authentication: { kind: 'session' },
}

const secondPrincipal: AuthPrincipal = {
  status: 'authenticated',
  user_id: 2,
  profile: 'member',
  manager_grants: [],
}

const currentSession: Session = {
  id: 7,
  created_at: timestamp,
  last_seen_at: timestamp,
  idle_expires_at: timestamp,
  absolute_expires_at: timestamp,
  revoked_at: null,
  revocation_reason: null,
  current: true,
}

const resource = (id: number, name: string): GeneralResource => ({
  id,
  name,
  created_at: timestamp,
  updated_at: timestamp,
})

const timeEntry = (
  id: number,
  input: TimeEntryInput,
  minimumNoteLength = 0,
): TimeEntry => {
  const running =
    input.seconds === undefined &&
    input.started_time === undefined &&
    input.ended_time === undefined
  const clockSeconds = (value: string): number => {
    const [hours, minutes] = value.split(':').map(Number)
    return hours! * 3_600 + minutes! * 60
  }
  const elapsed =
    input.started_time === undefined || input.ended_time === undefined
      ? 0
      : (clockSeconds(input.ended_time) - clockSeconds(input.started_time) + 86_400) %
        86_400
  return {
    id,
    user_id: 1,
    project_id: input.project_id,
    task_id: input.task_id,
    spent_date: input.spent_date ?? '2026-08-28',
    seconds: input.seconds ?? elapsed,
    is_running: running,
    timer_started_at: running ? timestamp : null,
    started_time: input.started_time ?? null,
    ended_time: input.ended_time ?? null,
    notes: input.notes ?? null,
    billable: true,
    budgeted: false,
    approval_status: 'unsubmitted',
    is_billed: false,
    is_locked: false,
    minimum_note_length: minimumNoteLength,
    created_at: timestamp,
    updated_at: timestamp,
  }
}

const browserApi = (
  minimumNoteLength = 0,
): ShellApi & {
  readonly entries: TimeEntry[]
  failNextCreate: boolean
  minimumNoteLength: number
  staleMinimumOnNextCreate: number | null
  timeEntryMode: 'duration' | 'start_end'
  timeFormat: 'decimal' | 'hours_minutes'
  clock: '12h' | '24h'
} => {
  const entries = [
    timeEntry(1, {
      project_id: 1,
      task_id: 1,
      spent_date: '2026-08-28',
      seconds: 3_600,
    }, minimumNoteLength),
    timeEntry(2, {
      project_id: 2,
      task_id: 2,
      spent_date: '2026-08-21',
      seconds: 99_999,
    }, minimumNoteLength),
  ]
  const api = {
    entries,
    failNextCreate: false,
    minimumNoteLength,
    staleMinimumOnNextCreate: null,
    timeEntryMode: 'duration' as const,
    timeFormat: 'decimal' as const,
    clock: '12h' as const,
    whoami: vi.fn(async () => identity),
    signIn: vi.fn(async () => principal),
    logoutCurrentSession: vi.fn(async () => ({
      ...currentSession,
      current: false,
      revoked_at: timestamp,
      revocation_reason: 'user_revoked' as const,
    })),
    listProjects: vi.fn(async () => ({
      data: [resource(1, 'Northpeak'), resource(2, 'Acme')],
      page: { next_cursor: null },
    })),
    listTasks: vi.fn(async () => ({
      data: [resource(1, 'Development'), resource(2, 'Design')],
      page: { next_cursor: null },
    })),
    listTimeEntryOptions: vi.fn(async () => [
      { project_id: 1, task_id: 1, minimum_note_length: api.minimumNoteLength },
      { project_id: 2, task_id: 2, minimum_note_length: api.minimumNoteLength },
    ]),
    getTimeEntrySettings: vi.fn(async () => ({
      time_entry_mode: api.timeEntryMode,
      time_format: api.timeFormat,
      clock: api.clock,
    })),
    listTimeEntries: vi.fn(async (query) =>
      entries.filter((entry) => {
        if (query.is_running === true) return entry.is_running
        if (query.from !== undefined && entry.spent_date < query.from) return false
        if (query.to !== undefined && entry.spent_date > query.to) return false
        return true
      }),
    ),
    createTimeEntry: vi.fn(async (input: TimeEntryInput) => {
      if (api.failNextCreate) {
        api.failNextCreate = false
        throw new Error('network unavailable')
      }
      if (api.staleMinimumOnNextCreate !== null) {
        const changedMinimum = api.staleMinimumOnNextCreate
        api.staleMinimumOnNextCreate = null
        api.minimumNoteLength = changedMinimum
        throw new EzactoApiError(
          422,
          {
            error: {
              code: 'validation_failed',
              message: 'The request contains invalid fields.',
              fields: [
                {
                  field: 'notes',
                  code: 'minimum_length',
                  message: 'Time entry notes are too short.',
                  minimum_length: changedMinimum,
                },
              ],
            },
          },
          null,
        )
      }
      const created = timeEntry(
        Math.max(...entries.map((entry) => entry.id)) + 1,
        input,
        api.minimumNoteLength,
      )
      entries.push(created)
      return created
    }),
    updateTimeEntry: vi.fn(async (id: number, patch: TimeEntryPatch) => {
      const current = entries.find((entry) => entry.id === id)
      if (current === undefined) throw new Error('entry not found')
      const updated = { ...current, ...patch, updated_at: timestamp }
      entries.splice(entries.indexOf(current), 1, updated)
      return updated
    }),
    deleteTimeEntry: vi.fn(async (id: number) => {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index === -1) throw new Error('entry not found')
      entries.splice(index, 1)
    }),
    stopTimeEntry: vi.fn(async (id: number) => {
      const current = entries.find((entry) => entry.id === id)
      if (current === undefined) throw new Error('entry not found')
      const stopped = { ...current, is_running: false, timer_started_at: null }
      entries.splice(entries.indexOf(current), 1, stopped)
      return stopped
    }),
  }
  return api
}

const desktopInputs = (): HTMLInputElement[] => [
  ...document.querySelectorAll<HTMLInputElement>('[data-week-grid] input[data-cell-key]'),
]

const edit = (input: HTMLInputElement, value: string): void => {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const renderBrowserShell = (
  options: { preserveStorage?: boolean; view?: 'time' | 'invoice-generation' } = {},
): void => {
  window.history.replaceState(
    null,
    '',
    options.view === 'invoice-generation' ? '/invoices/new?week=2026-08-28' : '/?week=2026-08-28',
  )
  if (options.preserveStorage !== true) globalThis.localStorage.clear()
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'browser-test',
      ...(options.view === undefined ? {} : { view: options.view }),
    })
      .replace(
        / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
        '',
      )
      .replace(
        '  <script type="module" src="/assets/ezacto.js"></script>\n',
        '',
      ),
  )
  document.close()
}

const authenticationError = (status: number, code: string): EzactoApiError =>
  new EzactoApiError(
    status,
    { error: { code, message: 'server detail is not rendered', fields: [] } },
    null,
  )

const deferred = <Value>() => {
  let resolve: ((value: Value) => void) | undefined
  let reject: ((error: unknown) => void) | undefined
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {
    promise,
    resolve: (value: Value) => resolve?.(value),
    reject: (error: unknown) => reject?.(error),
  }
}

const submitSignIn = (email: string, password: string): void => {
  const emailInput = document.querySelector<HTMLInputElement>('[name="email"]')!
  const passwordInput = document.querySelector<HTMLInputElement>('[name="password"]')!
  emailInput.value = email
  passwordInput.value = password
  document
    .querySelector<HTMLFormElement>('[data-sign-in-form]')!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

describe('week-grid browser behavior', () => {
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
    const timerProject = document.querySelector<HTMLInputElement>(
      '[data-timer-form] [name="project"]',
    )!
    const timerTask = document.querySelector<HTMLInputElement>(
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
    timerProject.value = 'northpeak'
    timerTask.value = 'design'
    timerNote.value = 'enough detail'
    submitTimer()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-timer-result]')?.textContent).toContain(
        'combination is not available',
      ),
    )
    expect(api.createTimeEntry).toHaveBeenCalledTimes(1)

    timerTask.value = 'development'
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
})

describe('invoice generation browser behavior', () => {
  it('[unit] loads and operates the global running timer on the invoice page', async () => {
    renderBrowserShell({ view: 'invoice-generation' })
    const api = browserApi()
    api.entries.push(
      timeEntry(3, {
        project_id: 1,
        task_id: 1,
        spent_date: '2026-08-28',
        notes: 'Running from the invoice workspace',
      }),
    )

    await mountShell(api)

    const timerChip = document.querySelector<HTMLButtonElement>('[data-timer-chip]')!
    await vi.waitFor(() => expect(timerChip.textContent).toContain('Northpeak / Development'))
    timerChip.click()
    document.querySelector<HTMLButtonElement>('[data-stop-timer]')!.click()
    await vi.waitFor(() => expect(api.stopTimeEntry).toHaveBeenCalledWith(3, expect.anything()))
  })
})

describe('native browser authentication', () => {
  it.each([
    [401, 'invalid_credentials', 'Email or password is incorrect.'],
    [403, 'email_verification_required', 'Verify your email before signing in.'],
    [429, 'rate_limit_exceeded', 'Too many sign-in attempts. Wait a moment and try again.'],
  ])(
    '[unit] keeps signed-out data closed and renders the safe %s outcome',
    async (status, code, expected) => {
      renderBrowserShell()
      const base = browserApi()
      const api = {
        ...base,
        whoami: vi.fn(async () => {
          throw authenticationError(401, 'authentication_required')
        }),
        signIn: vi.fn(async () => {
          throw authenticationError(status, code)
        }),
      }

      await mountShell(api)

      expect(base.listProjects).not.toHaveBeenCalled()
      expect(base.listTasks).not.toHaveBeenCalled()
      expect(base.listTimeEntries).not.toHaveBeenCalled()
      expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
      expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(true)
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false)
      expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
        true,
      )

      submitSignIn('owner@example.test', 'do not persist me')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-sign-in-result]')?.textContent).toBe(expected),
      )
      expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe('')
      expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.disabled).toBe(
        false,
      )
      expect(document.body.textContent).not.toContain('server detail is not rendered')
      expect(globalThis.location.href).not.toContain('do%20not%20persist%20me')
      expect(document.documentElement.outerHTML).not.toContain('do not persist me')
    },
  )

  it('[unit] clears the password and blocks a second submit while sign-in is pending', async () => {
    renderBrowserShell()
    const base = browserApi()
    let rejectSignIn: ((error: unknown) => void) | undefined
    const pending = new Promise<AuthPrincipal>((_resolve, reject) => {
      rejectSignIn = reject
    })
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        throw authenticationError(401, 'authentication_required')
      }),
      signIn: vi.fn(() => pending),
    }
    await mountShell(api)

    submitSignIn('owner@example.test', 'one request only')
    submitSignIn('owner@example.test', 'one request only')
    expect(api.signIn).toHaveBeenCalledTimes(1)
    expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.disabled).toBe(
      true,
    )
    expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.textContent).toBe(
      'Signing in…',
    )
    expect(
      document
        .querySelector<HTMLFormElement>('[data-sign-in-form]')
        ?.getAttribute('aria-busy'),
    ).toBe('true')

    rejectSignIn?.(authenticationError(401, 'invalid_credentials'))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe(''),
    )
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.textContent).toBe(
        'Sign in',
      ),
    )
  })

  it('[security] clears the password before a post-sign-in identity check settles', async () => {
    renderBrowserShell()
    const base = browserApi()
    const identityCheck = deferred<Whoami>()
    let signedIn = false
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        if (!signedIn) throw authenticationError(401, 'authentication_required')
        return identityCheck.promise
      }),
      signIn: vi.fn(async () => {
        signedIn = true
        return principal
      }),
    }
    await mountShell(api)

    submitSignIn('owner@example.test', 'clear before whoami')
    await vi.waitFor(() => expect(api.whoami).toHaveBeenCalledTimes(2))
    expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('[data-sign-in-submit]')?.disabled).toBe(
      true,
    )

    identityCheck.resolve(identity)
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1'),
    )
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(false)
  })

  it('[security] sends a cell retry 401 through the shared signed-out transition', async () => {
    renderBrowserShell()
    const base = browserApi()
    let creates = 0
    const api = {
      ...base,
      createTimeEntry: vi.fn(async () => {
        creates += 1
        if (creates === 1) throw new Error('temporary network failure')
        throw authenticationError(401, 'authentication_required')
      }),
    }
    await mountShell(api)

    const monday = desktopInputs()[0]!
    edit(monday, '0.5')
    monday.blur()
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('.cell-retry')).not.toBeNull(),
    )
    document.querySelector<HTMLButtonElement>('.cell-retry')!.click()

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.querySelector('[data-session-status]')?.textContent).toContain(
      'session ended',
    )
    expect(document.querySelector('[data-sign-in-result]')?.textContent).toContain(
      'session ended',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    expect(desktopInputs()).toHaveLength(0)
  })

  it('[security] sends a command 401 through the shared signed-out transition', async () => {
    renderBrowserShell()
    const base = browserApi()
    let projectLoads = 0
    const api = {
      ...base,
      listProjects: vi.fn(async (cursor?: string) => {
        projectLoads += 1
        if (projectLoads > 1) {
          throw authenticationError(401, 'authentication_required')
        }
        return base.listProjects(cursor)
      }),
    }
    await mountShell(api)

    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    const input = document.querySelector<HTMLInputElement>('[name="command"]')!
    input.value = 'log 1h northpeak development'
    document
      .querySelector<HTMLFormElement>('[data-command-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.querySelector('[data-session-status]')?.textContent).toContain(
      'session ended',
    )
    expect(document.querySelector('[data-sign-in-result]')?.textContent).toContain(
      'session ended',
    )
    expect(input.value).toBe('')
  })

  it('[e2e:browser-auth] keeps a valid initial session signed in when week loading fails', async () => {
    renderBrowserShell()
    const base = browserApi()
    let failWeek = true
    const api = {
      ...base,
      listProjects: vi.fn(async (cursor?: string) => {
        if (failWeek) throw new Error('catalog offline')
        return base.listProjects(cursor)
      }),
    }

    await mountShell(api)

    expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1')
    expect(document.querySelector<HTMLElement>('[data-current-identity]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(true)
    expect(document.querySelector('[data-session-status]')?.textContent).toContain(
      'Signed in, but your week could not load',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-retry-week]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      false,
    )

    failWeek = false
    document.querySelector<HTMLButtonElement>('[data-retry-week]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-session-status]')?.textContent).toContain('Connected'),
    )
    expect(document.querySelector<HTMLButtonElement>('[data-retry-week]')?.hidden).toBe(true)
  })

  it('[e2e:browser-auth] keeps a new session signed in when its first week load fails', async () => {
    renderBrowserShell()
    const base = browserApi()
    let authenticated = false
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        if (!authenticated) throw authenticationError(401, 'authentication_required')
        return identity
      }),
      signIn: vi.fn(async () => {
        authenticated = true
        return principal
      }),
      listProjects: vi.fn(async () => {
        throw new Error('catalog offline')
      }),
    }

    await mountShell(api)
    submitSignIn('owner@example.test', 'correct horse battery staple')

    await vi.waitFor(() =>
      expect(document.querySelector('[data-session-status]')?.textContent).toContain(
        'Signed in, but your week could not load',
      ),
    )
    expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1')
    expect(document.querySelector<HTMLElement>('[data-current-identity]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(true)
    expect(document.querySelector('[data-sign-in-result]')?.textContent).toBe('')
  })

  it('[e2e:browser-auth] signs in, shows credential-safe identity, loads the week, and logs out', async () => {
    renderBrowserShell()
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const href = globalThis.location.href
    const base = browserApi()
    let authenticated = false
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        if (!authenticated) throw authenticationError(401, 'authentication_required')
        return identity
      }),
      signIn: vi.fn(async () => {
        authenticated = true
        return principal
      }),
      logoutCurrentSession: vi.fn(async () => {
        authenticated = false
        return {
          ...currentSession,
          current: false,
          revoked_at: timestamp,
          revocation_reason: 'user_revoked' as const,
        }
      }),
    }

    await mountShell(api)
    expect(base.listProjects).not.toHaveBeenCalled()
    const email = document.querySelector<HTMLInputElement>('[name="email"]')!
    email.focus()
    expect(document.activeElement).toBe(email)

    submitSignIn('owner@example.test', 'correct horse battery staple')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('1'),
    )
    expect(document.querySelector('[data-current-profile]')?.textContent).toBe('administrator')
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-current-identity]')?.hidden).toBe(false)
    expect(base.listProjects).toHaveBeenCalledTimes(1)
    expect(base.listTasks).toHaveBeenCalledTimes(1)
    expect(base.listTimeEntries).toHaveBeenCalled()
    expect(document.querySelector<HTMLInputElement>('[name="password"]')?.value).toBe('')
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      false,
    )
    expect(globalThis.location.href).toBe(href)
    expect(storage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('correct horse battery staple'),
    )
    expect(document.body.textContent).not.toContain('correct horse battery staple')

    const logout = document.querySelector<HTMLButtonElement>('[data-logout]')!
    logout.focus()
    expect(document.activeElement).toBe(logout)
    logout.click()
    await vi.waitFor(() => expect(api.logoutCurrentSession).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(true)
    expect(document.querySelector('[data-session-status]')?.textContent).toContain('Signed out')
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    storage.mockRestore()
  })

  it('[security] aborts and ignores prior-account work across logout and a different sign-in', async () => {
    renderBrowserShell()
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => stored.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => void stored.set(key, value)),
    })
    const base = browserApi()
    const priorAccountProjects = deferred<{
      data: GeneralResource[]
      page: { next_cursor: null }
    }>()
    let account = 1
    let projectLoads = 0
    let priorSignal: AbortSignal | undefined
    const api = {
      ...base,
      whoami: vi.fn(async () => (account === 1 ? identity : secondIdentity)),
      signIn: vi.fn(async () => {
        account = 2
        return secondPrincipal
      }),
      logoutCurrentSession: vi.fn(async () => ({
        ...currentSession,
        current: false,
        revoked_at: timestamp,
        revocation_reason: 'user_revoked' as const,
      })),
      listProjects: vi.fn(async (_cursor?: string, signal?: AbortSignal) => {
        projectLoads += 1
        if (projectLoads === 2) {
          priorSignal = signal
          return priorAccountProjects.promise
        }
        return {
          data: [
            resource(
              1,
              account === 1 ? 'First Account Project' : 'Second Account Project',
            ),
            resource(2, account === 1 ? 'Private First Row' : 'Second Extra Row'),
          ],
          page: { next_cursor: null as null },
        }
      }),
    }

    await mountShell(api)
    expect(document.body.textContent).toContain('First Account Project')

    document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
    const project = document.querySelector<HTMLSelectElement>('[data-row-project]')!
    const task = document.querySelector<HTMLSelectElement>('[data-row-task]')!
    project.value = '2'
    project.dispatchEvent(new Event('change', { bubbles: true }))
    task.value = '2'
    document
      .querySelector<HTMLFormElement>('[data-row-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect([...stored.keys()]).toContain(
      'ezacto:user:1:week-rows:2026-08-24',
    )

    const command = document.querySelector<HTMLInputElement>('[name="command"]')!
    command.value = 'private first command'
    document.querySelector<HTMLInputElement>('[name="email"]')!.value =
      'first-private@example.test'
    const timerProject = document.querySelector<HTMLInputElement>(
      '[data-timer-form] [name="project"]',
    )!
    timerProject.value = 'private first timer'
    const oldNote = document.querySelector<HTMLButtonElement>('[data-note-cell]')!
    oldNote.click()
    document.querySelector<HTMLTextAreaElement>('[data-note-input]')!.value =
      'private first note'

    document.querySelector<HTMLButtonElement>('[data-week-previous]')!.click()
    await vi.waitFor(() => expect(api.listProjects).toHaveBeenCalledTimes(2))
    const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]')!
    logoutButton.click()
    expect(document.querySelector<HTMLButtonElement>('[data-command-trigger]')?.disabled).toBe(
      true,
    )
    expect(priorSignal?.aborted).toBe(true)

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLFormElement>('[data-sign-in-form]')?.hidden).toBe(false),
    )
    expect(document.body.textContent).not.toContain('First Account Project')
    expect(command.value).toBe('')
    expect(timerProject.value).toBe('')
    expect(document.querySelector<HTMLTextAreaElement>('[data-note-input]')?.value).toBe('')
    expect(document.querySelectorAll('[data-row-project] option')).toHaveLength(0)
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0)
    expect(document.querySelector<HTMLInputElement>('[name="email"]')?.value).toBe('')

    submitSignIn('second@example.test', 'second account password')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('2'),
    )
    expect(document.body.textContent).toContain('Second Account Project')
    expect(document.body.textContent).not.toContain('Private First Row')
    expect(desktopInputs()).toHaveLength(7)

    priorAccountProjects.resolve({
      data: [resource(1, 'Late First Account Project')],
      page: { next_cursor: null },
    })
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    expect(document.querySelector('[data-current-user-id]')?.textContent).toBe('2')
    expect(document.body.textContent).not.toContain('Late First Account Project')

    document.querySelector<HTMLTextAreaElement>('[data-note-input]')!.value = 'must not save'
    document
      .querySelector<HTMLFormElement>('[data-note-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(base.updateTimeEntry).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
