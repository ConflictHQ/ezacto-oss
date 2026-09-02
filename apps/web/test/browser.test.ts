/** @vitest-environment happy-dom */

import {
  EzactoApiError,
  type AuthPrincipal,
  type GeneralResource,
  type Invoice,
  type InvoiceMessage,
  type InvoicePayment,
  type InvoicePaymentInput,
  type InvoicePaymentUpdateInput,
  type InvoiceTransitionInput,
  type Session,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryPatch,
  type TimesheetSubmission,
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

const invoice = (id: number, overrides: Partial<Invoice> = {}): Invoice => ({
  id,
  client_id: 11,
  created_by_user_id: 1,
  number: `INV-${id}`,
  subject: 'August services',
  purchase_order: 'PO-2048',
  notes: 'Thank you for your business.\nPayment is due within 30 days.',
  currency: 'USD',
  issue_date: '2026-08-31',
  due_date: '2026-09-30',
  payment_terms: 'net_30',
  state: 'draft',
  version: 1,
  close_reason: null,
  close_write_off_cents: 0,
  sent_at: null,
  paid_at: null,
  paid_date: null,
  closed_at: null,
  period_start: '2026-08-01',
  period_end: '2026-08-31',
  project_id: null,
  retainer_id: null,
  recurring_invoice_id: null,
  estimate_id: null,
  reminder_policy: null,
  tax_rate_ppm: 100_000,
  tax2_rate_ppm: null,
  discount_rate_ppm: null,
  amount_cents: 8_250,
  due_amount_cents: 6_250,
  tax_amount_cents: 750,
  tax2_amount_cents: 0,
  discount_amount_cents: 0,
  written_off_cents: 0,
  payment_options: [],
  reference_token: null,
  created_at: timestamp,
  updated_at: timestamp,
  line_items: [
    {
      id: 100 + id,
      invoice_id: id,
      position: 1,
      kind: 'time',
      description: 'Implementation',
      quantity: 5,
      unit_price_cents: 1_500,
      amount_cents: 7_500,
      taxed: true,
      taxed2: false,
      project_id: 1,
      created_at: timestamp,
      updated_at: timestamp,
    },
  ],
  ...overrides,
})

const invoiceMessage = (invoiceId: number): InvoiceMessage => ({
  id: 1,
  invoice_id: invoiceId,
  sent_by: 'Owner',
  sent_by_email: 'owner@example.test',
  sent_from: 'Owner',
  sent_from_email: 'owner@example.test',
  recipients: [{ name: 'Accounts payable', email: 'ap@example.test' }],
  subject: 'Invoice available',
  body: 'Persisted message body',
  attach_pdf: false,
  send_me_a_copy: false,
  thank_you: false,
  reminder: false,
  send_reminder_on: null,
  event_type: 'draft',
  delivery_status: null,
  provider_message_id: null,
  created_at: timestamp,
  updated_at: timestamp,
})

const invoicePayment = (invoiceId: number): InvoicePayment => ({
  id: 1,
  invoice_id: invoiceId,
  currency: 'USD',
  amount_cents: 2_000,
  paid_at: '2026-08-28T12:00:00.000Z',
  paid_date: '2026-08-28',
  notes: 'ACH deposit',
  recorded_by_user_id: 1,
  provider: 'manual',
  provider_shape: 'manual',
  provider_account_id: null,
  provider_transaction_id: null,
  bank_deposit_id: null,
  created_at: timestamp,
  updated_at: timestamp,
})

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
      week_start_day: 'monday' as const,
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
  options: {
    preserveStorage?: boolean
    view?:
      | 'time'
      | 'timesheet-approvals'
      | 'invoice-generation'
      | 'invoice-list'
      | 'invoice-detail'
    sessionCookiePresent?: boolean
  } = {},
): void => {
  const path =
    options.view === 'invoice-generation'
      ? '/invoices/new?week=2026-08-28'
      : options.view === 'invoice-list'
        ? '/invoices?week=2026-08-28'
        : options.view === 'invoice-detail'
          ? '/invoices/7?week=2026-08-28'
          : options.view === 'timesheet-approvals'
            ? '/approvals?week=2026-08-28'
            : '/?week=2026-08-28'
  window.history.replaceState(
    null,
    '',
    path,
  )
  if (options.preserveStorage !== true) globalThis.localStorage.clear()
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'browser-test',
      ...(options.view === undefined ? {} : { view: options.view }),
      ...(options.sessionCookiePresent === undefined
        ? {}
        : { sessionCookiePresent: options.sessionCookiePresent }),
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

describe('invoice browse browser behavior', () => {
  it('[acceptance] loads a cursor page and appends the next invoice page', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi
      .fn()
      .mockResolvedValueOnce({
        data: [invoice(7)],
        page: { next_cursor: 'next-page' },
      })
      .mockResolvedValueOnce({
        data: [invoice(8, { state: 'open' })],
        page: { next_cursor: null },
      })
    const api: ShellApi = { ...base, listInvoices }

    await mountShell(api)

    const first = document.querySelector<HTMLElement>('[data-invoice-id="7"]')!
    expect(first.textContent).toContain('Invoice INV-7')
    expect(first.textContent).toContain('$82.50')
    expect(first.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(
      '/invoices/7',
    )
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '1 invoice loaded; more are available.',
    )

    document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')!.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-id="8"]')?.textContent).toContain(
        'Invoice INV-8',
      ),
    )
    expect(listInvoices).toHaveBeenNthCalledWith(1, undefined, expect.anything())
    expect(listInvoices).toHaveBeenNthCalledWith(2, 'next-page', expect.anything())
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '2 invoices loaded.',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')?.hidden).toBe(
      true,
    )
  })

  it('[security] blocks a member before requesting invoice data', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi.fn()
    const api: ShellApi = {
      ...base,
      whoami: vi.fn(async () => secondIdentity),
      listInvoices,
    }

    await mountShell(api)

    expect(listInvoices).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      'Your profile does not have access to invoices.',
    )
  })

  it('[security] blocks an invoice list token without read scope before requesting data', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi.fn()
    const scopedIdentity: Whoami = {
      ...identity,
      authentication: { kind: 'token', token_id: 10, scopes: ['expenses:read'] },
    }
    const api: ShellApi = {
      ...base,
      whoami: vi.fn(async () => scopedIdentity),
      listInvoices,
    }

    await mountShell(api)

    expect(listInvoices).not.toHaveBeenCalled()
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      'This API token does not grant invoice read access.',
    )
  })

  it('[acceptance] renders persisted invoice lines, notes, payments, and history', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => invoice(7)),
      listInvoiceMessages: vi.fn(async () => [invoiceMessage(7)]),
      listInvoicePayments: vi.fn(async () => [
        {
          ...invoicePayment(7),
          provider: 'wise',
          provider_shape: 'reconciliation',
          provider_account_id: 3,
          provider_transaction_id: 'wise-transfer-42',
          bank_deposit_id: 4,
        },
      ]),
    }

    await mountShell(api)

    const documentShell = document.querySelector<HTMLElement>('[data-invoice-document]')!
    expect(documentShell.hidden).toBe(false)
    expect(document.title).toBe('ezacto — Invoice INV-7')
    expect(documentShell.textContent).toContain('August services')
    expect(documentShell.textContent).toContain('Implementation')
    expect(documentShell.textContent).toContain('$75.00')
    expect(documentShell.textContent).toContain('Thank you for your business.')
    expect(documentShell.textContent).toContain('$20.00')
    expect(documentShell.textContent).toContain('ACH deposit')
    expect(documentShell.textContent).toContain('Method: Wise')
    expect(documentShell.textContent).toContain('Reference: wise-transfer-42')
    expect(documentShell.textContent).toContain('Invoice available')
    expect(documentShell.textContent).toContain('Accounts payable')
    expect(documentShell.textContent).toContain('Persisted message body')
    expect(documentShell.textContent).not.toMatch(/Download PDF|Send reminder/u)
  })

  it('[e2e:invoice-cycle] sends a draft through the composer and shows its scheduled reminder', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    let attempts = 0
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        attempts += 1
        if (attempts === 1) throw new Error('network unavailable')
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: 2,
          sent_at: timestamp,
        }
        messages = [
          {
            ...invoiceMessage(7),
            event_type: 'send',
            recipients: input.recipients ?? [],
            subject: input.subject ?? null,
            body: input.body ?? null,
            attach_pdf: input.attach_pdf ?? false,
            send_me_a_copy: input.send_me_a_copy ?? false,
            reminder: input.reminder ?? false,
            send_reminder_on: input.send_reminder_on ?? null,
          },
        ]
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      transitionInvoice,
    }

    await mountShell(api)
    const send = document.querySelector<HTMLButtonElement>('[data-invoice-send]')!
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    expect(send.hidden).toBe(false)
    expect(send.textContent).toBe('Mark sent')

    send.click()
    expect(dialog.open).toBe(true)
    expect(dialog.textContent).toContain('%invoice_number%')
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(dialog.open).toBe(false)
    expect(transitionInvoice).not.toHaveBeenCalled()
    send.click()
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close][aria-label]')!.click()
    expect(dialog.open).toBe(false)
    expect(transitionInvoice).not.toHaveBeenCalled()

    send.click()
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    const subject = document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!
    const body = document.querySelector<HTMLTextAreaElement>('[data-invoice-composer-body]')!
    recipients.value = 'Accounts Payable <ap@example.test>\nap@example.test'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    subject.value = 'Invoice %invoice_number%'
    body.value = 'Invoice #%invoice_id% totals %invoice_amount% and is due %invoice_due_date%.'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'network unavailable',
      ),
    )
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))

    expect(transitionInvoice).toHaveBeenCalledTimes(2)
    expect(transitionInvoice.mock.calls[0]?.[1]).toBe(transitionInvoice.mock.calls[1]?.[1])
    expect(transitionInvoice.mock.calls[1]?.[2]).toEqual({
      command: 'send',
      expected_version: 1,
      recipients: [{ name: 'Accounts Payable', email: 'ap@example.test' }],
      subject: 'Invoice INV-7',
      body: 'Invoice #7 totals $82.50 and is due 2099-09-30.',
      attach_pdf: false,
      send_me_a_copy: false,
      thank_you: false,
      reminder: true,
      send_reminder_on: '2099-09-30',
    })
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open')
    expect(document.querySelector('[data-invoice-reminder-line]')?.textContent).toContain(
      'Sep 30, 2099',
    )
    expect(document.querySelector('[data-invoice-detail-messages]')?.textContent).toContain(
      'Invoice #7 totals $82.50',
    )
    expect(send.textContent).toBe('Record another sent message')
  })

  it('[reliability] never reissues a committed send when its detail refresh fails', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    let failNextRefresh = false
    const getInvoice = vi.fn(async () => {
      if (failNextRefresh) {
        failNextRefresh = false
        throw new Error('refresh offline')
      }
      return currentInvoice
    })
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = { ...currentInvoice, state: 'open', version: 2, sent_at: timestamp }
        messages = [
          {
            ...invoiceMessage(7),
            event_type: 'send',
            recipients: input.recipients ?? [],
            send_reminder_on: input.send_reminder_on ?? null,
          },
        ]
        failNextRefresh = true
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice,
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      transitionInvoice,
    }

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'ap@example.test'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    const retry = document.querySelector<HTMLButtonElement>('[data-invoice-detail-retry]')!
    await vi.waitFor(() => expect(retry.hidden).toBe(false))
    expect(dialog.open).toBe(false)
    expect(document.querySelector('[data-invoice-detail-status]')?.textContent).toBe(
      'refresh offline',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-send]')?.disabled).toBe(true)
    expect(transitionInvoice).toHaveBeenCalledTimes(1)

    retry.click()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open'),
    )
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
  })

  it('[e2e:invoice-cycle] retries, records, edits, and deletes an exact manual payment', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, {
      state: 'open',
      version: 1,
      amount_cents: 6_250,
      due_amount_cents: 6_250,
    })
    let effectivePayments: InvoicePayment[] = []
    let recordAttempts = 0
    const recordInvoicePayment = vi.fn(
      async (_id: number, _commandId: string, input: InvoicePaymentInput) => {
        recordAttempts += 1
        if (recordAttempts === 1) throw new Error('network unavailable')
        currentInvoice = {
          ...currentInvoice,
          state: 'paid',
          version: 2,
          due_amount_cents: 0,
          paid_date: 'paid_date' in input ? input.paid_date : null,
          paid_at: 'paid_at' in input ? input.paid_at : null,
        }
        effectivePayments = [
          invoicePayment(7),
        ].map((payment) => ({
          ...payment,
          amount_cents: input.amount_cents,
          paid_at: 'paid_at' in input ? input.paid_at : null,
          paid_date: 'paid_date' in input ? input.paid_date : null,
          notes: input.notes ?? null,
        }))
        return currentInvoice
      },
    )
    const updateInvoicePayment = vi.fn(
      async (
        _id: number,
        _paymentId: number,
        _commandId: string,
        input: InvoicePaymentUpdateInput,
      ) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: 3,
          due_amount_cents: 1_000,
          paid_at: null,
          paid_date: null,
        }
        effectivePayments = effectivePayments.map((payment) => ({
          ...payment,
          amount_cents: input.amount_cents,
          paid_at: 'paid_at' in input ? input.paid_at : null,
          paid_date: 'paid_date' in input ? input.paid_date : null,
          notes: input.notes ?? null,
          updated_at: '2026-08-29T12:00:00.000Z',
        }))
        return currentInvoice
      },
    )
    const deleteInvoicePayment = vi.fn(
      async () => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: 4,
          due_amount_cents: 6_250,
          paid_at: null,
          paid_date: null,
        }
        effectivePayments = []
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => effectivePayments),
      recordInvoicePayment,
      updateInvoicePayment,
      deleteInvoicePayment,
    }

    await mountShell(api)
    const record = document.querySelector<HTMLButtonElement>(
      '[data-invoice-payment-record]',
    )!
    expect(record.disabled).toBe(false)
    record.click()
    const paymentDialog = document.querySelector<HTMLDialogElement>(
      '[data-invoice-payment-dialog]',
    )!
    const paymentForm = document.querySelector<HTMLFormElement>(
      '[data-invoice-payment-form]',
    )!
    const amount = document.querySelector<HTMLInputElement>(
      '[data-invoice-payment-amount]',
    )!
    const paymentNotes = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-payment-notes]',
    )!
    const paidDate = document.querySelector<HTMLInputElement>(
      '[data-invoice-payment-date]',
    )!
    expect(paymentDialog.open).toBe(true)
    expect(amount.value).toBe('62.50')
    expect(paymentDialog.textContent).toContain('No email or thank-you message will be sent.')
    paidDate.value = '2026-08-28'
    paymentNotes.value = 'Final ACH receipt'
    paymentNotes.dispatchEvent(new Event('input', { bubbles: true }))
    paymentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-payment-result]')?.textContent).toBe(
        'network unavailable',
      ),
    )
    expect(amount.disabled).toBe(false)
    paymentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(paymentDialog.open).toBe(false))
    expect(recordInvoicePayment).toHaveBeenCalledTimes(2)
    expect(recordInvoicePayment.mock.calls[0]?.[1]).toBe(
      recordInvoicePayment.mock.calls[1]?.[1],
    )
    expect(recordInvoicePayment.mock.calls[1]?.[2]).toEqual({
      expected_version: 1,
      amount_cents: 6_250,
      currency: 'USD',
      paid_date: '2026-08-28',
      notes: 'Final ACH receipt',
    })
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Paid')
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$0.00')
    expect(document.querySelector('[data-invoice-detail-payments]')?.textContent).toContain(
      'Final ACH receipt',
    )

    document.querySelector<HTMLButtonElement>('[data-invoice-payment-edit="1"]')!.click()
    amount.value = '52.50'
    amount.dispatchEvent(new Event('input', { bubbles: true }))
    const precision = document.querySelector<HTMLSelectElement>(
      '[data-invoice-payment-precision]',
    )!
    const paidAt = document.querySelector<HTMLInputElement>(
      '[data-invoice-payment-instant]',
    )!
    precision.value = 'timestamp'
    precision.dispatchEvent(new Event('change', { bubbles: true }))
    paidAt.value = '2026-08-29T09:30'
    paymentForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(paymentDialog.open).toBe(false))
    expect(updateInvoicePayment).toHaveBeenCalledWith(
      7,
      1,
      expect.stringMatching(/^web\.invoice\.payment\.update:/u),
      expect.objectContaining({
        expected_version: 2,
        expected_updated_at: timestamp,
        amount_cents: 5_250,
        paid_at: new Date(2026, 7, 29, 9, 30).toISOString(),
      }),
      expect.any(AbortSignal),
    )
    expect(vi.mocked(updateInvoicePayment).mock.lastCall?.[3]).not.toHaveProperty('paid_date')
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open')
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$10.00')

    const openDelete = (): void =>
      document.querySelector<HTMLButtonElement>('[data-invoice-payment-delete="1"]')!.click()
    openDelete()
    const deleteDialog = document.querySelector<HTMLDialogElement>(
      '[data-invoice-payment-delete-dialog]',
    )!
    deleteDialog.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(deleteDialog.open).toBe(false)
    expect(deleteInvoicePayment).not.toHaveBeenCalled()
    openDelete()
    deleteDialog
      .querySelector<HTMLButtonElement>('[data-dialog-close][aria-label]')!
      .click()
    expect(deleteDialog.open).toBe(false)
    expect(deleteInvoicePayment).not.toHaveBeenCalled()
    openDelete()
    deleteDialog
      .querySelector<HTMLFormElement>('[data-invoice-payment-delete-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(deleteDialog.open).toBe(false))
    expect(deleteInvoicePayment).toHaveBeenCalledWith(
      7,
      1,
      expect.stringMatching(/^web\.invoice\.payment\.delete:/u),
      { expected_version: 3, expected_updated_at: '2026-08-29T12:00:00.000Z' },
      expect.any(AbortSignal),
    )
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Open')
    expect(document.querySelector('[data-invoice-detail-due]')?.textContent).toBe('$62.50')
    expect(document.querySelector('[data-invoice-detail-payments]')?.textContent).toContain(
      'No payments recorded.',
    )
  })

  it('[security] renders invoice payments read-only for a read-scoped token', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    const readIdentity: Whoami = {
      ...identity,
      authentication: { kind: 'token', token_id: 9, scopes: ['invoices:read'] },
    }
    const recordInvoicePayment = vi.fn()
    const api: ShellApi = {
      ...base,
      whoami: vi.fn(async () => readIdentity),
      getInvoice: vi.fn(async () => invoice(7, { state: 'open' })),
      listInvoiceMessages: vi.fn(async () => []),
      listInvoicePayments: vi.fn(async () => [invoicePayment(7)]),
      recordInvoicePayment,
    }

    await mountShell(api)

    expect(document.querySelector<HTMLButtonElement>('[data-invoice-payment-record]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-invoice-payment-readonly]')?.textContent).toContain(
      'read-only',
    )
    expect(document.querySelector('[data-invoice-payment-edit]')).toBeNull()
    expect(document.querySelector('[data-invoice-payment-delete]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-send]')?.hidden).toBe(true)
    expect(recordInvoicePayment).not.toHaveBeenCalled()
  })

  it('[security] returns to sign-in when invoice browsing loses its session', async () => {
    renderBrowserShell({ view: 'invoice-list', sessionCookiePresent: true })
    const base = browserApi()
    const api: ShellApi = {
      ...base,
      listInvoices: vi.fn(async () => {
        throw authenticationError(401, 'authentication_required')
      }),
    }

    await mountShell(api)

    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
    expect(document.title).toBe('ezacto — Sign in')
  })
})

describe('native browser authentication', () => {
  it('[security] keeps the hinted shell inert under an overlay until whoami succeeds', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    const base = browserApi()
    const identityCheck = deferred<Whoami>()
    const api = { ...base, whoami: vi.fn(() => identityCheck.promise) }

    const mounted = mountShell(api)
    const gateway = document.querySelector<HTMLElement>('[data-auth-gateway]')!
    const overlay = document.querySelector<HTMLElement>('[data-session-check-overlay]')!
    const shell = document.querySelector<HTMLElement>('[data-authenticated-shell]')!

    expect(gateway.hidden).toBe(true)
    expect(overlay.hidden).toBe(false)
    expect(shell.hidden).toBe(false)
    expect(shell.inert).toBe(true)
    expect(shell.getAttribute('aria-busy')).toBe('true')
    expect(base.listProjects).not.toHaveBeenCalled()
    expect(base.listTimeEntries).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-auth-action]:not([disabled])')).toHaveLength(0)

    identityCheck.resolve(identity)
    await mounted

    expect(overlay.hidden).toBe(true)
    expect(shell.hidden).toBe(false)
    expect(shell.inert).toBe(false)
    expect(shell.getAttribute('aria-busy')).toBe('false')
    expect(gateway.hidden).toBe(true)
    expect(base.listProjects).toHaveBeenCalledTimes(1)
  })

  it('[security] replaces a hinted shell with sign-in when the cookie is expired', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    const base = browserApi()
    const api = {
      ...base,
      whoami: vi.fn(async () => {
        throw authenticationError(401, 'authentication_required')
      }),
    }

    await mountShell(api)

    expect(document.querySelector<HTMLElement>('[data-session-check-overlay]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-auth-gateway]')?.hidden).toBe(false)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.hidden).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-authenticated-shell]')?.inert).toBe(true)
    expect(document.querySelector<HTMLInputElement>('[name="email"]')).toBe(document.activeElement)
    expect(base.listProjects).not.toHaveBeenCalled()
    expect(base.listTimeEntries).not.toHaveBeenCalled()
  })

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

  it('[browser][lock-policy] manages organization deadline and manual locks', async () => {
    renderBrowserShell({ view: 'timesheet-approvals' })
    const base = browserApi()
    let policy = {
      auto_lock: true,
      timesheet_deadline: { day: 'monday' as const, time: '17:00' },
      timezone: 'America/New_York',
      week_start_day: 'monday' as const,
      updated_at: timestamp,
    }
    const locks = [
      {
        id: 9,
        kind: 'manual' as const,
        period_start: null,
        period_end: '2026-08-31',
        reason: 'Month-end close',
        locked_by_user_id: 1,
        locked_at: timestamp,
        unlocked_by_user_id: null,
        unlocked_at: null,
        unlock_reason: null,
        active: true,
      },
    ]
    const updateTimesheetLockPolicy = vi.fn(async (input) => {
      policy = {
        ...policy,
        auto_lock: input.auto_lock ?? policy.auto_lock,
        timesheet_deadline: input.timesheet_deadline ?? policy.timesheet_deadline,
        timezone: input.timezone ?? policy.timezone,
        updated_at: timestamp,
      }
      return policy
    })
    const unlockTimesheetLock = vi.fn(async (id, input) => {
      const lock = locks.find((candidate) => candidate.id === id)!
      Object.assign(lock, {
        active: false,
        unlocked_by_user_id: 1,
        unlocked_at: timestamp,
        unlock_reason: input.reason,
      })
      return lock
    })
    const createTimesheetManualLock = vi.fn(async (_commandId, input) => {
      const created = {
        id: 10,
        kind: 'manual' as const,
        period_start: null,
        period_end: input.locked_through,
        reason: input.reason,
        locked_by_user_id: 1,
        locked_at: timestamp,
        unlocked_by_user_id: null,
        unlocked_at: null,
        unlock_reason: null,
        active: true,
      }
      locks.push(created)
      return created
    })
    const api: ShellApi = {
      ...base,
      listTimesheetSubmissions: vi.fn(async () => []),
      listPendingTimesheetSubmissions: vi.fn(async () => []),
      getTimesheetLockPolicy: vi.fn(async () => policy),
      listTimesheetLocks: vi.fn(async () => locks.filter((lock) => lock.active)),
      updateTimesheetLockPolicy,
      unlockTimesheetLock,
      createTimesheetManualLock,
    }

    await mountShell(api)
    const panel = document.querySelector<HTMLElement>('[data-lock-policy-panel]')!
    expect(panel.hidden).toBe(false)
    expect(document.querySelector<HTMLInputElement>('[data-lock-policy-auto]')?.checked).toBe(
      true,
    )
    expect(panel.textContent).toContain('Month-end close')

    const unlockReason = document.querySelector<HTMLInputElement>(
      '[data-lock-unlock-reason="9"]',
    )!
    unlockReason.value = 'Books reopened'
    document.querySelector<HTMLButtonElement>('[data-lock-id="9"] button')!.click()
    await vi.waitFor(() =>
      expect(unlockTimesheetLock).toHaveBeenCalledWith(
        9,
        { reason: 'Books reopened' },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() => expect(panel.textContent).not.toContain('Month-end close'))

    const automatic = document.querySelector<HTMLInputElement>('[data-lock-policy-auto]')!
    automatic.checked = false
    document.querySelector<HTMLInputElement>('[data-lock-policy-timezone]')!.value = 'UTC'
    document
      .querySelector<HTMLFormElement>('[data-lock-policy-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(updateTimesheetLockPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ auto_lock: false, timezone: 'UTC' }),
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-lock-policy-result]')?.textContent).toContain(
        'Automatic locking disabled',
      ),
    )

    document.querySelector<HTMLInputElement>('[data-manual-lock-through]')!.value =
      '2026-09-30'
    document.querySelector<HTMLTextAreaElement>('[data-manual-lock-reason]')!.value =
      'Quarter close'
    document
      .querySelector<HTMLFormElement>('[data-manual-lock-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(createTimesheetManualLock).toHaveBeenCalledWith(
        expect.any(String),
        { locked_through: '2026-09-30', reason: 'Quarter close' },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() => expect(panel.textContent).toContain('Quarter close'))
  })

  it('[browser][lock-policy] explicitly reopens an approved timesheet with a reason', async () => {
    renderBrowserShell()
    const base = browserApi()
    let submission: TimesheetSubmission = {
      id: 21,
      user_id: 1,
      user_name: 'Ada Admin',
      period_start: '2026-08-24',
      period_end: '2026-08-30',
      status: 'approved',
      origin: 'native',
      source_status: null,
      source_observed_at: null,
      submitted_by_user_id: 1,
      submitted_at: timestamp,
      reviewed_by_user_id: 1,
      reviewed_at: timestamp,
      rejection_reason: null,
      version: 2,
      entry_count: 1,
      expense_count: 0,
      total_seconds: 3_600,
      billable_seconds: 3_600,
      nonbillable_seconds: 0,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const withdrawTimesheetSubmission = vi.fn(async (_id, input) => {
      submission = {
        ...submission,
        status: 'unsubmitted',
        rejection_reason: input.reason,
        version: submission.version + 1,
      }
      return submission
    })
    const api: ShellApi = {
      ...base,
      listTimesheetSubmissions: vi.fn(async () => [submission]),
      listPendingTimesheetSubmissions: vi.fn(async () => []),
      withdrawTimesheetSubmission,
    }

    await mountShell(api)
    const reopen = document.querySelector<HTMLButtonElement>('[data-withdraw-timesheet]')!
    expect(reopen.hidden).toBe(false)
    reopen.click()
    expect(document.querySelector<HTMLDialogElement>('[data-withdrawal-dialog]')?.open).toBe(
      true,
    )
    document.querySelector<HTMLTextAreaElement>('[data-withdrawal-reason]')!.value =
      'Correct a late expense'
    document
      .querySelector<HTMLFormElement>('[data-withdrawal-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(withdrawTimesheetSubmission).toHaveBeenCalledWith(
        21,
        { reason: 'Correct a late expense' },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-timesheet-result]')?.textContent).toContain(
        'Approval withdrawn',
      ),
    )
    expect(reopen.hidden).toBe(true)
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
