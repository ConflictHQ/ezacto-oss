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
  type SenderIdentity,
  type Session,
  type SsoDomain,
  type TimeEntry,
  type TimeEntryInput,
  type TimeEntryPatch,
  type TimesheetSubmission,
  type TimesheetSubmissionDetail,
  type Whoami,
} from '@ezacto/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModuleSettingsController } from '../src/module-settings/browser.js'
import { mountShell } from '../src/shell/browser.js'
import { invoiceTabs, renderAppShell, webAssets, type ShellApi } from '../src/index.js'

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

const pendingSubmission = (id: number, userName: string): TimesheetSubmissionDetail => ({
  id,
  user_id: id,
  user_name: userName,
  period_start: '2026-08-24',
  period_end: '2026-08-30',
  status: 'submitted',
  origin: 'native',
  source_status: null,
  source_observed_at: null,
  submitted_by_user_id: id,
  submitted_at: timestamp,
  reviewed_by_user_id: null,
  reviewed_at: null,
  rejection_reason: null,
  version: 0,
  entry_count: 1,
  expense_count: 0,
  total_seconds: 3_600,
  billable_seconds: 3_600,
  nonbillable_seconds: 0,
  created_at: timestamp,
  updated_at: timestamp,
  entries: [
    {
      id,
      spent_date: '2026-08-25',
      project_id: 1,
      project_name: 'Northpeak',
      task_id: 1,
      task_name: 'Development',
      seconds: 3_600,
      notes: 'Submitted work',
    },
  ],
  expenses: [],
})

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
      | 'settings-company'
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
            : options.view === 'settings-company'
              ? '/settings/company'
              : '/?week=2026-08-28'
  window.history.replaceState(
    null,
    '',
    path,
  )
  if (options.preserveStorage !== true) {
    globalThis.localStorage.clear()
    globalThis.sessionStorage.clear()
  }
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
  it('[acceptance] opens on what is outstanding and asks the server for it', async () => {
    // 739 invoices, 9 of them open. The list opened on all 739 newest-first,
    // and the endpoint had no state parameter, so narrowing it on the client
    // would have narrowed the loaded page only -- 50 of 739 -- and reported a
    // count over that slice as if it were the account.
    renderBrowserShell({ view: 'invoice-list' })
    const listInvoices = vi.fn(async (_cursor, _signal, _perPage, states) => ({
      data: (states as readonly string[] | undefined)?.includes('paid')
        ? [invoice(9, { state: 'paid' })]
        : [invoice(7, { state: 'open' })],
      page: { next_cursor: null },
    }))
    const api: ShellApi = { ...browserApi(), listInvoices }

    await mountShell(api)

    // Outstanding is draft plus open. Paid is settled; closed is written off
    // or cancelled, which is settled by another name.
    expect(listInvoices).toHaveBeenNthCalledWith(1, undefined, expect.anything(), undefined, [
      'draft',
      'open',
    ])
    expect(
      document.querySelector('[data-invoice-filter="outstanding"]')?.getAttribute('aria-pressed'),
    ).toBe('true')

    document.querySelector<HTMLButtonElement>('[data-invoice-filter="paid"]')!.click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(2))
    expect(listInvoices).toHaveBeenNthCalledWith(2, undefined, expect.anything(), undefined, [
      'paid',
    ])
    await vi.waitFor(() =>
      expect(document.querySelector('tbody tr[data-row-key="9"]')).not.toBeNull(),
    )
    // A different question is a different traversal: the rows that answered
    // the old one do not stay on the page beside the new ones.
    expect(document.querySelector('tbody tr[data-row-key="7"]')).toBeNull()

    // All sends no state at all, which is the absent parameter.
    document.querySelector<HTMLButtonElement>('[data-invoice-filter="all"]')!.click()
    await vi.waitFor(() => expect(listInvoices).toHaveBeenCalledTimes(3))
    expect(listInvoices).toHaveBeenNthCalledWith(
      3,
      undefined,
      expect.anything(),
      undefined,
      undefined,
    )
  })

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
    // "Client #11" is an internal identifier on a page a client can be sent.
    const listClients: ShellApi['listClients'] = async () => ({
      data: [resource(11, 'Northwind Freight')],
      page: { next_cursor: null },
    })
    const api: ShellApi = { ...base, listInvoices, listClients }

    await mountShell(api)

    const first = document.querySelector<HTMLElement>('tbody tr[data-row-key="7"]')!
    expect(first.textContent).toContain('Invoice INV-7')
    await vi.waitFor(() =>
      expect(
        document.querySelector('tbody tr[data-row-key="7"] td[data-column="client"]')
          ?.textContent,
      ).toBe('Northwind Freight'),
    )
    expect(first.textContent).toContain('$82.50')
    expect(first.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe(
      '/invoices/7',
    )
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '1 invoice loaded; more are available.',
    )

    document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')!.click()
    await vi.waitFor(() =>
      expect(
        document.querySelector('tbody tr[data-row-key="8"]')?.textContent,
      ).toContain('Invoice INV-8'),
    )
    expect(listInvoices).toHaveBeenNthCalledWith(1, undefined, expect.anything(), undefined, [
      'draft',
      'open',
    ])
    expect(listInvoices).toHaveBeenNthCalledWith(2, 'next-page', expect.anything(), undefined, [
      'draft',
      'open',
    ])
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '2 invoices loaded.',
    )
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-load-more]')?.hidden).toBe(
      true,
    )
  })


  it('[acceptance] searches the loaded invoices by number and by client', async () => {
    renderBrowserShell({ view: 'invoice-list' })
    const base = browserApi()
    const listInvoices = vi.fn(async () => ({
      data: [invoice(7), invoice(8, { number: 'INV-2048', client_id: 12 })],
      page: { next_cursor: null },
    }))
    const listClients: ShellApi['listClients'] = async () => ({
      data: [resource(11, 'Northwind Freight'), resource(12, 'Acme Supply')],
      page: { next_cursor: null },
    })
    const api: ShellApi = { ...base, listInvoices, listClients }

    await mountShell(api)
    await vi.waitFor(() =>
      expect(
        document.querySelector('tbody tr[data-row-key="7"] td[data-column="client"]')
          ?.textContent,
      ).toBe('Northwind Freight'),
    )

    const rows = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('tbody tr[data-row-key]')].map(
        (row) => row.dataset.rowKey ?? '',
      )
    const search = document.querySelector<HTMLInputElement>('[data-invoice-search]')!
    expect(rows()).toEqual(['7', '8'])

    search.value = '2048'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toEqual(['8'])
    expect(document.querySelector('[data-invoice-list-status]')?.textContent).toBe(
      '1 of 2 loaded invoices match.',
    )

    // The client name is the column a reader is looking at, so it is the one
    // the search reads too.
    search.value = 'northwind'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toEqual(['7'])

    search.value = 'no such invoice'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(rows()).toEqual([])
    expect(document.querySelector('[data-invoice-list]')?.textContent).toContain(
      'No loaded invoices match that search.',
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
    expect(send.textContent).toBe('Send invoice')
    // One Send control now, not a Send/Mark sent pair with contradictory hints.
    expect(document.querySelector('[data-invoice-deliver]')).toBeNull()
    expect(document.querySelector('[data-invoice-delivery-dialog]')).toBeNull()

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
    // sent_at is stamped, so the document says Sent rather than Open: the
    // difference between an invoice still to send and one being waited on.
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent')
    expect(document.querySelector('[data-invoice-reminder-line]')?.textContent).toContain(
      'Sep 30, 2099',
    )
    expect(document.querySelector('[data-invoice-detail-messages]')?.textContent).toContain(
      'Invoice #7 totals $82.50',
    )
    expect(send.textContent).toBe('Send invoice again')
  })

  it('[e2e:invoice-email] sends and delivers from one dialog and retries the email alone', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          {
            ...invoiceMessage(7),
            event_type: 'send',
            recipients: input.recipients ?? [],
            subject: input.subject ?? null,
            body: input.body ?? null,
          },
        ]
        return currentInvoice
      },
    )
    let deliveries = 0
    const deliverInvoiceEmail = vi.fn(
      async (_id: number, _commandId: string, input: { expected_version: number }) => {
        deliveries += 1
        if (deliveries === 1) throw new Error('network unavailable')
        currentInvoice = { ...currentInvoice, version: input.expected_version + 1 }
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      deliverInvoiceEmail,
      transitionInvoice,
    }

    await mountShell(api)
    const send = document.querySelector<HTMLButtonElement>('[data-invoice-send]')!
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    send.click()
    expect(dialog.open).toBe(true)
    // The dialog says the two things are separate and which order they run in.
    expect(dialog.textContent).toContain('Also deliver by email')
    expect(dialog.textContent).toContain("It lists this invoice's line items; no PDF is attached")
    expect(dialog.textContent).toContain('%invoice_number%')

    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    const deliverToggle = document.querySelector<HTMLInputElement>(
      '[data-invoice-composer-deliver-toggle]',
    )!
    const confirmLabel = document.querySelector<HTMLElement>(
      '[data-invoice-composer-confirm-label]',
    )!
    // The confirmation only exists while the irreversible half is being asked for.
    expect(confirmLabel.hidden).toBe(true)
    deliverToggle.click()
    expect(confirmLabel.hidden).toBe(false)
    expect(document.querySelector('[data-invoice-composer-submit]')?.textContent).toBe(
      'Send and deliver',
    )

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
      'Confirm the recipients before sending this invoice email.',
    )
    expect(transitionInvoice).not.toHaveBeenCalled()
    expect(deliverInvoiceEmail).not.toHaveBeenCalled()

    document.querySelector<HTMLInputElement>('[data-invoice-composer-confirm]')!.click()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toContain(
        'submit again to retry the email alone',
      ),
    )
    // The sent status committed before the email failed. Submitting again must
    // retry the email at the version the transition returned -- not record a
    // second sent message on an invoice that is already sent.
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(transitionInvoice.mock.calls[0]?.[2]).toMatchObject({
      command: 'send',
      expected_version: 1,
      recipients: [{ name: 'Accounts Payable', email: 'AP@Example.Test' }],
    })

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    // Both attempts carry the version the transition returned, not the one the
    // page was showing when the dialog opened.
    for (const call of deliverInvoiceEmail.mock.calls) {
      expect(call[2]).toEqual({
        expected_version: 2,
        recipients: [{ name: 'Accounts Payable', email: 'AP@Example.Test' }],
        confirmed: true,
      })
    }
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toContain(
      'Invoice marked sent and the email queued for the confirmed recipients.',
    )
  })

  /**
   * The three ways back into a send that has already committed. Each one used
   * to rearm the transition, and a second `send` is a second sent message in
   * the client's inbox -- POST /deliveries issues its own send on top.
   */
  const sendAndFailTheEmail = async (
    failure: unknown,
  ): Promise<{
    readonly dialog: HTMLDialogElement
    readonly form: HTMLFormElement
    readonly transitionInvoice: ReturnType<typeof vi.fn>
    readonly deliverInvoiceEmail: ReturnType<typeof vi.fn>
    readonly sentMessages: () => number
  }> => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          ...messages,
          {
            ...invoiceMessage(7),
            id: messages.length + 1,
            event_type: 'send',
            recipients: input.recipients ?? [],
          },
        ]
        return currentInvoice
      },
    )
    let deliveries = 0
    const deliverInvoiceEmail = vi.fn(
      async (_id: number, _commandId: string, input: { expected_version: number }) => {
        deliveries += 1
        if (deliveries === 1) throw failure
        // The delivery route runs its own `send` once the mail is accepted.
        currentInvoice = { ...currentInvoice, version: input.expected_version + 1 }
        messages = [
          ...messages,
          { ...invoiceMessage(7), id: messages.length + 1, event_type: 'send' },
        ]
        return currentInvoice
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      deliverInvoiceEmail,
      transitionInvoice,
    }

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLInputElement>('[data-invoice-composer-deliver-toggle]')!.click()
    document.querySelector<HTMLInputElement>('[data-invoice-composer-confirm]')!.click()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    // Settle on the controls coming back, not on any particular wording: what
    // each test is here to measure is the requests the next submit makes.
    await vi.waitFor(() => {
      expect(deliverInvoiceEmail).toHaveBeenCalledTimes(1)
      expect(
        document.querySelector<HTMLButtonElement>('[data-invoice-composer-submit]')?.disabled,
      ).toBe(false)
    })
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    return {
      dialog,
      form,
      transitionInvoice,
      deliverInvoiceEmail,
      sentMessages: () => messages.filter((message) => message.event_type === 'send').length,
    }
  }

  it('[reliability] retries the email alone after the delivery loses a version race', async () => {
    // The one error class most likely to land between two sequential versioned
    // writes: another operator, a payment, or the cron writing in between.
    const { dialog, form, transitionInvoice, deliverInvoiceEmail, sentMessages } =
      await sendAndFailTheEmail(
        new EzactoApiError(
          409,
          { error: { code: 'invoice_version_conflict', message: 'server conflict', fields: [] } },
          null,
        ),
      )
    // The conflict reloaded the invoice, so the composer is back under the
    // operator's hand with both boxes ticked -- and the sent status is on the
    // invoice already.
    expect(dialog.open).toBe(true)
    expect(sentMessages()).toBe(1)
    const reported = document.querySelector('[data-invoice-composer-result]')?.textContent

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    // One operator intent, one `send` transition. The retry is the email alone,
    // under the command id the first attempt used.
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(transitionInvoice.mock.calls[0]?.[2]).toMatchObject({ expected_version: 1 })
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    // The retry goes out at the version the reload found, not the stale one.
    expect(deliverInvoiceEmail.mock.calls[1]?.[2]).toEqual({
      expected_version: 2,
      recipients: [{ name: 'Accounts Payable', email: 'AP@Example.Test' }],
      confirmed: true,
    })
    // Two sent messages in the history is the whole budget: the operator's and
    // the one POST /deliveries issues. A third would be the reissued transition.
    expect(sentMessages()).toBe(2)
    // The conflict's own message said the invoice moved; the attempt added what
    // is left, which is the line the cleared flag used to swallow.
    expect(reported).toContain('Latest values are loaded')
    expect(reported).toContain('submit again to retry the email alone')
  })

  it('[reliability] reports an owed email taken off the submit instead of claiming a send', async () => {
    const { dialog, form, transitionInvoice, deliverInvoiceEmail, sentMessages } =
      await sendAndFailTheEmail(new Error('network unavailable'))
    const deliverToggle = document.querySelector<HTMLInputElement>(
      '[data-invoice-composer-deliver-toggle]',
    )!
    deliverToggle.click()
    const submitLabel = document.querySelector('[data-invoice-composer-submit]')?.textContent

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(1)
    expect(sentMessages()).toBe(1)
    const status = document.querySelector('[data-invoice-payment-status]')?.textContent
    expect(status).toBe('The sent status was already recorded. The email was not sent.')
    // No success sentence for zero API calls, and no repeat of the previous
    // attempt's reminder claim.
    expect(status).not.toContain('Planned reminder date saved')
    expect(status).not.toContain('marked sent and the email queued')
    // The button named the request this submit would make, and with the send
    // already recorded and the email taken off there was none.
    expect(submitLabel).toBe('Skip the email')
  })

  it('[reliability] resumes the owed email when the composer is closed and reopened', async () => {
    const { dialog, form, transitionInvoice, deliverInvoiceEmail, sentMessages } =
      await sendAndFailTheEmail(new Error('network unavailable'))
    // Cancel, the x and Escape are all offered and nothing warns against them.
    dialog.querySelector<HTMLButtonElement>('[data-dialog-close]:not([aria-label])')!.click()
    expect(dialog.open).toBe(false)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    expect(dialog.open).toBe(true)
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    const reopened = {
      title: document.querySelector('[data-invoice-composer-title]')?.textContent,
      notice: document.querySelector<HTMLElement>('[data-invoice-composer-owed]')?.hidden,
      submit: document.querySelector('[data-invoice-composer-submit]')?.textContent,
      recipients: recipients.value,
      frozen: recipients.disabled,
      delivering: document.querySelector<HTMLInputElement>(
        '[data-invoice-composer-deliver-toggle]',
      )?.checked,
    }
    // The operator fills the dialog in again the way a fresh send would need.
    // Nothing typed here may turn the owed email back into a second send.
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    expect(sentMessages()).toBe(2)
    // Reopening resumed the attempt rather than arming a fresh send, and said
    // so: the confirmed recipients restored past the form reset and frozen,
    // because they are what the retry delivers to under the first command id.
    expect(reopened).toEqual({
      title: 'Finish sending invoice',
      notice: false,
      submit: 'Retry the email',
      recipients: 'Accounts Payable <AP@Example.Test>',
      frozen: true,
      delivering: true,
    })
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
      expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent'),
    )
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
  })

  it('[reliability] retires a send key the ledger says already committed', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    // A command ledger, because the whole question is what a spent key does.
    // A row is written only when the command commits, an identical retry is
    // replayed off it, and a changed one is refused as `command_id_reused` --
    // so that code is the server saying this key's command did commit.
    const ledger = new Map<string, string>()
    const transitionInvoice = vi.fn(
      async (_id: number, commandId: string, input: InvoiceTransitionInput) => {
        const fingerprint = JSON.stringify(input)
        const recorded = ledger.get(commandId)
        if (recorded !== undefined) {
          if (recorded !== fingerprint) {
            throw new EzactoApiError(
              409,
              {
                error: {
                  code: 'command_id_reused',
                  message: 'the idempotency key was already used for different input',
                  fields: [],
                },
              },
              null,
            )
          }
          return currentInvoice
        }
        ledger.set(commandId, fingerprint)
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          ...messages,
          {
            ...invoiceMessage(7),
            id: messages.length + 1,
            event_type: 'send',
            recipients: input.recipients ?? [],
          },
        ]
        // The first send commits and its response never arrives.
        if (ledger.size === 1) throw new Error('connection dropped')
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
    const sentMessages = (): number =>
      messages.filter((message) => message.event_type === 'send').length

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    const subject = document.querySelector<HTMLInputElement>('[data-invoice-composer-subject]')!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'connection dropped',
      ),
    )
    // Committed server-side, unknown to the page: it is still showing the draft.
    expect(sentMessages()).toBe(1)
    expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Draft')

    // The operator does the obvious thing and corrects the subject.
    subject.value = 'Invoice %invoice_number% (corrected)'
    subject.dispatchEvent(new Event('input', { bubbles: true }))
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-detail-state]')?.textContent).toBe('Sent'),
    )
    const refused = document.querySelector('[data-invoice-composer-result]')?.textContent ?? ''
    // The spent key was refused, and the truth is that the invoice went out --
    // not that somebody else moved it, which is what the conflict line claims.
    expect(refused).toContain('already recorded as sent')
    expect(refused).not.toContain('changed elsewhere')
    expect(transitionInvoice).toHaveBeenCalledTimes(2)
    expect(sentMessages()).toBe(1)
    // The dialog is a working control again, not a repeat of the same refusal.
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-invoice-composer-title]')?.textContent).toBe(
      'Send invoice again',
    )
    expect(recipients.disabled).toBe(false)

    // A deliberate second send is now reachable, under a key of its own.
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    expect(transitionInvoice).toHaveBeenCalledTimes(3)
    expect(transitionInvoice.mock.calls[2]?.[1]).not.toBe(transitionInvoice.mock.calls[0]?.[1])
    expect(transitionInvoice.mock.calls[2]?.[2]).toMatchObject({
      command: 'send',
      expected_version: 2,
      subject: 'Invoice INV-7 (corrected)',
    })
    expect(sentMessages()).toBe(2)
  })

  it('[reliability] retires a delivery key the ledger says already committed', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    const transitionInvoice = vi.fn(
      async (_id: number, _commandId: string, input: InvoiceTransitionInput) => {
        currentInvoice = {
          ...currentInvoice,
          state: 'open',
          version: input.expected_version + 1,
          sent_at: timestamp,
        }
        messages = [
          ...messages,
          {
            ...invoiceMessage(7),
            id: messages.length + 1,
            event_type: 'send',
            recipients: input.recipients ?? [],
          },
        ]
        return currentInvoice
      },
    )
    const deliveryLedger = new Map<string, string>()
    const deliverInvoiceEmail = vi.fn(
      async (_id: number, commandId: string, input: { expected_version: number }) => {
        const fingerprint = JSON.stringify(input)
        const recorded = deliveryLedger.get(commandId)
        if (recorded !== undefined) {
          if (recorded !== fingerprint) {
            throw new EzactoApiError(
              409,
              {
                error: {
                  code: 'command_id_reused',
                  message: 'the idempotency key was already used for different input',
                  fields: [],
                },
              },
              null,
            )
          }
          return currentInvoice
        }
        deliveryLedger.set(commandId, fingerprint)
        // The delivery route runs its own `send` once the mail is accepted, so
        // the invoice moves on -- and then the response is lost.
        currentInvoice = { ...currentInvoice, version: input.expected_version + 1 }
        messages = [
          ...messages,
          { ...invoiceMessage(7), id: messages.length + 1, event_type: 'send' },
        ]
        throw new Error('connection dropped')
      },
    )
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
      listInvoiceMessages: vi.fn(async () => messages),
      listInvoicePayments: vi.fn(async () => []),
      deliverInvoiceEmail,
      transitionInvoice,
    }
    const sentMessages = (): number =>
      messages.filter((message) => message.event_type === 'send').length

    await mountShell(api)
    document.querySelector<HTMLButtonElement>('[data-invoice-send]')!.click()
    const dialog = document.querySelector<HTMLDialogElement>('[data-invoice-composer-dialog]')!
    const form = document.querySelector<HTMLFormElement>('[data-invoice-composer-form]')!
    const recipients = document.querySelector<HTMLTextAreaElement>(
      '[data-invoice-composer-recipients]',
    )!
    recipients.value = 'Accounts Payable <AP@Example.Test>'
    recipients.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLInputElement>('[data-invoice-composer-deliver-toggle]')!.click()
    document.querySelector<HTMLInputElement>('[data-invoice-composer-confirm]')!.click()
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toContain(
        'submit again to retry the email alone',
      ),
    )
    // The email committed too; only its response went missing. The reload moved
    // the page to the version the delivery's own send left behind, so the retry
    // will not match the fingerprint the ledger holds.
    expect(sentMessages()).toBe(2)

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toContain(
        'already queued',
      ),
    )
    const refused = document.querySelector('[data-invoice-composer-result]')?.textContent ?? ''
    expect(refused).not.toContain('changed elsewhere')
    // Neither half runs again on the refusal, and the owed-email line is gone
    // with the key it belonged to.
    expect(transitionInvoice).toHaveBeenCalledTimes(1)
    expect(deliverInvoiceEmail).toHaveBeenCalledTimes(2)
    expect(deliverInvoiceEmail.mock.calls[0]?.[1]).toBe(deliverInvoiceEmail.mock.calls[1]?.[1])
    expect(refused).not.toContain('retry the email alone')
    expect(sentMessages()).toBe(2)
    // The dialog is a send dialog again rather than a frozen retry of an email
    // that already went.
    expect(dialog.open).toBe(true)
    expect(document.querySelector('[data-invoice-composer-title]')?.textContent).toBe(
      'Send invoice again',
    )
    expect(document.querySelector('[data-invoice-composer-submit]')?.textContent).toBe(
      'Send and deliver',
    )
    expect(recipients.disabled).toBe(false)
  })

  it('[reliability] keeps the spent key on the page when the reload closes the dialog', async () => {
    renderBrowserShell({ view: 'invoice-detail' })
    const base = browserApi()
    let currentInvoice = invoice(7, { due_date: '2099-09-30' })
    let messages: InvoiceMessage[] = []
    let attempts = 0
    const transitionInvoice = vi.fn(async () => {
      attempts += 1
      if (attempts > 1) {
        throw new EzactoApiError(
          409,
          {
            error: {
              code: 'command_id_reused',
              message: 'the idempotency key was already used for different input',
              fields: [],
            },
          },
          null,
        )
      }
      // The send commits, and while its lost response is being retried the
      // invoice is paid in full -- a state that takes no send at all.
      currentInvoice = { ...currentInvoice, state: 'paid', version: 3, sent_at: timestamp }
      messages = [{ ...invoiceMessage(7), event_type: 'send' }]
      throw new Error('connection dropped')
    })
    const api: ShellApi = {
      ...base,
      getInvoice: vi.fn(async () => currentInvoice),
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
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-composer-result]')?.textContent).toBe(
        'connection dropped',
      ),
    )

    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.open).toBe(false))
    // The dialog it was written into is gone; the sentence the operator has to
    // read -- their invoice went out -- may not go with it.
    expect(document.querySelector('[data-invoice-payment-status]')?.textContent).toContain(
      'already recorded as sent',
    )
    expect(transitionInvoice).toHaveBeenCalledTimes(2)
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
    expect(document.querySelector<HTMLButtonElement>('[data-invoice-line-add]')?.hidden).toBe(true)
    expect(document.querySelector('[data-invoice-line-edit]')).toBeNull()
    expect(document.querySelector('[data-invoice-line-delete]')).toBeNull()
    expect(document.querySelector('[data-invoice-line-readonly]')?.textContent).toContain(
      'read-only',
    )
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
  it('[perf] paints from the cached identity instead of waiting on whoami', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    await mountShell(browserApi())

    // Second navigation: the cache survives it, so nothing waits on whoami.
    renderBrowserShell({ sessionCookiePresent: true, preserveStorage: true })
    const api = browserApi()
    const identityCheck = deferred<Whoami>()
    const revalidating = { ...api, whoami: vi.fn(() => identityCheck.promise) }

    const mounted = mountShell(revalidating)
    await Promise.resolve()

    // Painted before whoami settled, rather than waiting behind the overlay.
    expect(
      document.querySelector<HTMLElement>('[data-current-user-id]')!.textContent,
    ).toBe(String(identity.user_id))

    identityCheck.resolve(identity)
    await mounted
    // Still reconciled against the server.
    expect(revalidating.whoami).toHaveBeenCalled()
  })

  it('[security] drops the cached identity on sign-out', async () => {
    renderBrowserShell({ sessionCookiePresent: true })
    await mountShell(browserApi())
    expect(globalThis.sessionStorage.getItem('ezacto.identity')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('[data-logout]')!.click()
    await vi.waitFor(() => {
      expect(globalThis.sessionStorage.getItem('ezacto.identity')).toBeNull()
    })
  })

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
      listPendingTimesheetSubmissions: vi.fn(async () => ({ submissions: [], nextCursor: null })),
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
      listPendingTimesheetSubmissions: vi.fn(async () => ({ submissions: [], nextCursor: null })),
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

  it('[e2e][approvals] confirms a bulk count and keeps a refused selection ticked', async () => {
    renderBrowserShell({ view: 'timesheet-approvals' })
    const base = browserApi()
    let pending = [pendingSubmission(31, 'Maya Member'), pendingSubmission(32, 'Noor Newton')]
    let attempts = 0
    const bulkApproveTimesheetSubmissions = vi.fn(
      async (_commandId: string, input: { submissions: readonly { id: number }[] }) => {
        attempts += 1
        if (attempts === 1) {
          throw new EzactoApiError(
            409,
            {
              error: {
                code: 'state_conflict',
                message: 'A selected timesheet submission changed before it could be approved.',
                fields: [
                  {
                    field: 'submissions[1].id',
                    code: 'state_conflict',
                    message: 'A selected timesheet submission changed before it could be approved.',
                  },
                ],
              },
            },
            null,
          )
        }
        const approved = new Set(input.submissions.map((selection) => selection.id))
        pending = pending.filter((submission) => !approved.has(submission.id))
        return []
      },
    )
    const api: ShellApi = {
      ...base,
      listTimesheetSubmissions: vi.fn(async () => []),
      listPendingTimesheetSubmissions: vi.fn(async () => ({
        submissions: pending,
        nextCursor: null,
      })),
      getTimesheetSubmission: vi.fn(async (id: number) =>
        pending.find((submission) => submission.id === id)!,
      ),
      bulkApproveTimesheetSubmissions,
    }

    await mountShell(api)
    const bulkCount = () => document.querySelector<HTMLElement>('[data-approval-bulk-count]')!
    const confirm = () =>
      document.querySelector<HTMLButtonElement>('[data-approval-bulk-approve]')!
    const select = (id: number) =>
      document.querySelector<HTMLInputElement>(`[data-approval-select="${id}"]`)!

    await vi.waitFor(() => expect(select(31)).not.toBeNull())
    expect(bulkCount().dataset.approvalBulkCount).toBe('0')
    expect(confirm().disabled).toBe(true)

    select(31).click()
    select(32).click()
    expect(bulkCount().dataset.approvalBulkCount).toBe('2')
    expect(confirm().textContent).toBe('Approve 2 selected')

    confirm().click()
    await vi.waitFor(() =>
      expect(bulkApproveTimesheetSubmissions).toHaveBeenCalledWith(
        expect.stringContaining('web.timesheet.bulk-approve:'),
        {
          submissions: [
            { id: 31, expected_version: 0 },
            { id: 32, expected_version: 0 },
          ],
        },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-approval-queue-result]')?.textContent).toContain(
        'Nothing was approved',
      ),
    )
    expect(bulkCount().dataset.approvalBulkCount).toBe('1')
    expect(select(31).checked).toBe(false)
    expect(select(32).checked).toBe(true)

    confirm().click()
    await vi.waitFor(() =>
      expect(bulkApproveTimesheetSubmissions).toHaveBeenLastCalledWith(
        expect.any(String),
        { submissions: [{ id: 32, expected_version: 0 }] },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-approval-queue-result]')?.textContent).toContain(
        '1 timesheet is approved',
      ),
    )
    expect(document.querySelector('[data-approval-select="32"]')).toBeNull()
  })
})

describe('shell chrome visibility', () => {
  const renderStyledShell = (section?: 'client-list'): void => {
    document.open()
    document.write(
      renderAppShell({
        environment: 'test',
        release: 'browser-test',
        ...(section === undefined
          ? {}
          : { activeSection: 'Clients' as const, view: section }),
        sessionCookiePresent: true,
      })
        .replace(
          / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
          '',
        )
        .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
    )
    document.close()
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)
  }

  it('[unit] serves a stylesheet in which the hidden attribute actually hides', () => {
    // `hidden` is only a presentational default, so `.tabstrip { display: flex }`
    // beat it and Time's Week/Day strip painted on Clients, Projects, Invoices
    // and Reports, while `.primary-nav a { display: grid }` did the same to the
    // Approvals and Team items module gating had switched off. Assert what a
    // browser computes from the stylesheet the worker serves: a test that
    // matched the text of the rule would pass on a rule the cascade ignores.
    renderStyledShell('client-list')

    const strip = document.querySelector<HTMLElement>('.tabstrip')!
    const approvals = document.querySelector<HTMLElement>(
      '.primary-nav [data-approvals-nav]',
    )!
    expect(strip.hidden).toBe(true)
    expect(approvals.hidden).toBe(true)
    expect(window.getComputedStyle(strip).display).toBe('none')
    expect(window.getComputedStyle(approvals).display).toBe('none')

    // And still lays both out when they are not hidden, so the assertions above
    // are about `hidden` and not about a selector that matches nothing.
    renderStyledShell()
    const timeStrip = document.querySelector<HTMLElement>('.tabstrip')!
    const timeNav = document.querySelector<HTMLElement>('.primary-nav a')!
    expect(timeStrip.hidden).toBe(false)
    expect(window.getComputedStyle(timeStrip).display).toBe('flex')
    expect(window.getComputedStyle(timeNav).display).toBe('grid')
  })
})

describe('level-2 signal', () => {
  const renderStyled = (options: Parameters<typeof renderAppShell>[0]): void => {
    document.open()
    document.write(
      renderAppShell(options)
        .replace(
          / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
          '',
        )
        .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
    )
    document.close()
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)
  }

  it('[acceptance] paints Time\'s view modes as a segmented control and leaves the underline to real tabs', () => {
    // Week and Day are two ways of looking at one screen; Invoices' four
    // destinations are four parts of the app. Both wore the same 3px orange
    // underline, so the strongest signal in the chrome said "section" in one
    // place and "view mode" in the other. Assert what a browser computes from
    // the stylesheet the worker serves, because the rule that has to lose here
    // is `.tabstrip a[aria-current="page"]`, which still matches.
    renderStyled({
      environment: 'test',
      release: 'browser-test',
      sessionCookiePresent: true,
    })
    const strip = document.querySelector<HTMLElement>('[data-time-views]')!
    const [week, day] = [...strip.querySelectorAll<HTMLAnchorElement>('a')]

    // Still a tab strip, not a widget: a nav of real links, keyboard reachable,
    // with aria-current on the view you are looking at.
    expect(strip.tagName).toBe('NAV')
    expect(strip.getAttribute('aria-label')).toBe('Time views')
    expect(week!.getAttribute('href')).toBe('/')
    expect(day!.getAttribute('href')).toBe('/?view=day')
    expect(week!.getAttribute('aria-current')).toBe('page')
    expect(day!.hasAttribute('aria-current')).toBe(false)

    const activeMode = window.getComputedStyle(week!)
    const idleMode = window.getComputedStyle(day!)
    expect(activeMode.backgroundColor).toBe('#FDEDE3')
    expect(activeMode.borderTopColor).toBe('#E8590C')
    expect(activeMode.boxShadow).toBe('none')
    expect(idleMode.backgroundColor).not.toBe('#FDEDE3')
    expect(idleMode.borderTopColor).toBe('#E3E5E8')

    // And the underline it gave up is still the mark of a level-2 tab.
    renderStyled({
      environment: 'test',
      release: 'browser-test',
      activeSection: 'Invoices',
      view: 'invoice-list',
      tabs: invoiceTabs('invoice-list'),
      sessionCookiePresent: true,
    })
    const overview = document.querySelector<HTMLAnchorElement>(
      '.tabstrip a[aria-current="page"]',
    )!
    expect(overview.textContent).toBe('Overview')
    const currentTab = window.getComputedStyle(overview)
    expect(currentTab.boxShadow).toBe('inset 0 -3px #E8590C')
    expect(currentTab.backgroundColor).not.toBe('#FDEDE3')
  })
})


describe('company settings', () => {
  // The modules list predates the shell api and still fetches for itself, so a
  // company page that never resolves it leaves every section behind a spinner.
  const stubModulesEndpoint = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ module: 'expenses', enabled: true }] }),
        text: async () => '',
      })),
    )
  }

  const senderIdentity = (overrides: Partial<SenderIdentity> = {}): SenderIdentity => ({
    id: 3,
    email: 'billing@northpeak.test',
    display_name: 'Northpeak Billing',
    reply_to_email: null,
    provider: 'mailgun',
    provider_identity: 'billing@northpeak.test',
    is_default: true,
    version: 1,
    archived_at: null,
    evidence: {
      version: 1,
      source: 'deployment_config',
      identity_kind: 'email_address',
      verification_status: 'operator_configured',
      dkim_status: 'not_applicable',
      mail_from_domain: null,
      mail_from_status: 'not_configured',
      observed_at: timestamp,
    },
    created_by_user_id: 1,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  })

  const ssoDomain = (overrides: Partial<SsoDomain> = {}): SsoDomain => ({
    id: 11,
    domain: 'northpeak.test',
    verified: false,
    verified_at: null,
    last_checked_at: null,
    record_name: '_ezacto-challenge.northpeak.test',
    record_type: 'TXT',
    record_value: 'ezacto-verification=zLp7c4Qk',
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  })

  const companyApi = (
    identities: readonly SenderIdentity[] = [senderIdentity()],
    domains: readonly SsoDomain[] = [],
  ) => ({
    ...browserApi(),
    getTimeEntryNoteSettings: vi.fn(async () => ({ required: true, minimum_length: 12 })),
    updateTimeEntryNoteSettings: vi.fn(async (patch: { required?: boolean; minimum_length?: number }) => ({
      required: patch.required ?? true,
      minimum_length: patch.minimum_length ?? 12,
    })),
    listSenderIdentities: vi.fn(async () => identities),
    listSsoDomains: vi.fn(async () => domains),
    addSsoDomain: vi.fn(async (domain: string) =>
      ssoDomain({
        id: 12,
        domain,
        record_name: `_ezacto-challenge.${domain}`,
        record_value: 'ezacto-verification=8mQd2Rh1',
      }),
    ),
    verifySsoDomain: vi.fn(async (id: number) => ({
      ...ssoDomain({ id, verified: true, verified_at: timestamp, last_checked_at: timestamp }),
      dnssec_validated: false,
    })),
    removeSsoDomain: vi.fn(async () => undefined),
    getEmailHealth: vi.fn(async () => ({
      reputation: {
        sent: 412,
        bounced: 3,
        complained: 1,
        failed: 0,
        bounce_rate_ppm: 7_200,
        complaint_rate_ppm: 2_400,
      },
    })),
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('[unit] shows the instance configuration the endpoints already served', async () => {
    // Every setting on this page had an endpoint and no reader: the notes
    // policy, the tracking mode, the address this instance sends as and how
    // that mail lands were all reachable only with a token and a terminal.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([
      senderIdentity(),
      senderIdentity({ id: 4, email: 'noreply@northpeak.test', is_default: false, evidence: null }),
    ])
    await mountShell(api)

    const facts = document.querySelector<HTMLElement>('[data-settings-time-facts]')!
    await vi.waitFor(() => expect(facts.hidden).toBe(false))
    expect(facts.textContent).toContain('Entry method')
    expect(facts.textContent).toContain('Duration')
    expect(facts.textContent).toContain('Monday')

    const noteRequired = document.querySelector<HTMLInputElement>('[data-note-settings-required]')!
    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    expect(noteRequired.checked).toBe(true)
    expect(noteMinimum.value).toBe('12')
    expect(document.querySelector<HTMLElement>('[data-note-settings-form]')!.hidden).toBe(false)

    const senders = document.querySelector<HTMLElement>('[data-settings-sender-identities]')!
    await vi.waitFor(() => expect(senders.hidden).toBe(false))
    expect(senders.querySelectorAll('tbody [data-row]')).toHaveLength(2)
    expect(senders.textContent).toContain('billing@northpeak.test')
    expect(senders.textContent).toContain('Operator configured')
    // A sender nothing has checked is not a verified one, and must not read as
    // one: an empty verification cell would say the transport approved it.
    expect(senders.textContent).toContain('Not verified yet')

    const reputation = document.querySelector<HTMLElement>('[data-settings-email-reputation]')!
    expect(reputation.textContent).toContain('412')
    // The API reports parts per million; 7_200 ppm is 0.72% of mail bouncing,
    // and an operator who reads it as 7,200 bounces panics for nothing.
    expect(reputation.textContent).toContain('0.72%')
    expect(reputation.textContent).toContain('0.24%')
  })

  it('[security] clears an administrator\'s email data when a lesser profile signs in', async () => {
    // The page outlives the session: signing out and back in as someone else
    // happens in the same document. The non-privileged branch only rewrote
    // three status strings, so the previous administrator's sender identities
    // and reputation figures stayed rendered above the notice saying they were
    // administrators-only.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([senderIdentity()], [ssoDomain()])
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    const senders = document.querySelector<HTMLElement>('[data-settings-sender-identities]')!
    await vi.waitFor(() => expect(senders.hidden).toBe(false))
    expect(document.body.textContent).toContain('billing@northpeak.test')

    // The same tab, a different person.
    await controller.activate(secondIdentity, new AbortController().signal, () => false)

    expect(
      document.querySelector<HTMLElement>('[data-module-settings-status]')?.textContent,
    ).toBe('Only administrators can manage module settings.')
    expect(document.body.textContent).not.toContain('billing@northpeak.test')
    expect(senders.hidden).toBe(true)
    expect(
      document.querySelector<HTMLElement>('[data-settings-email-reputation]')!.textContent,
    ).toBe('')
    // A challenge token is the instance's proof it owns the domain. Leaving it
    // rendered hands the next person at the keyboard everything they need to
    // claim the domain themselves.
    expect(document.body.textContent).not.toContain('ezacto-verification=zLp7c4Qk')
    expect(document.querySelector<HTMLElement>('[data-settings-sso-domains]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!.hidden).toBe(true)
  })

  it('[unit] saves the notes policy the page loaded', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    const noteRequired = document.querySelector<HTMLInputElement>('[data-note-settings-required]')!
    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    await vi.waitFor(() => expect(noteMinimum.value).toBe('12'))
    noteRequired.checked = false
    noteMinimum.value = '25'
    document
      .querySelector<HTMLFormElement>('[data-note-settings-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(api.updateTimeEntryNoteSettings).toHaveBeenCalledWith(
        { required: false, minimum_length: 25 },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-note-settings-result]')?.textContent).toBe('Saved.'),
    )
  })

  it('[unit] refuses a minimum length that is not a whole number of characters', async () => {
    // The API answers 422 for this. Spending a round trip to be told so leaves
    // the form looking broken rather than wrong.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    await vi.waitFor(() => expect(noteMinimum.value).toBe('12'))
    noteMinimum.value = '-4'
    document
      .querySelector<HTMLFormElement>('[data-note-settings-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(document.querySelector('[data-note-settings-result]')?.textContent).toContain(
        'whole number of characters',
      ),
    )
    expect(api.updateTimeEntryNoteSettings).not.toHaveBeenCalled()
  })

  it('[security] does not ask for email delivery as an executive manager', async () => {
    // Both email endpoints are administrator-only. An executive manager who
    // opens the page gets told so, rather than two 403s dressed as a failure.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi(),
      whoami: vi.fn(async () => ({
        ...identity,
        user_id: 5,
        profile: 'executive_manager' as const,
      })),
    }
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-email-status]')?.textContent).toBe(
        'Email delivery is visible to administrators only.',
      ),
    )
    expect(api.listSenderIdentities).not.toHaveBeenCalled()
    expect(api.getEmailHealth).not.toHaveBeenCalled()
    // The notes policy is theirs to set, so that half of the page still loads.
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-note-settings-form]')!.hidden).toBe(false),
    )
  })

  const ssoTable = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-settings-sso-domains]')!

  const ssoStatuses = (): readonly (string | null)[] =>
    [...ssoTable().querySelectorAll('tbody [data-row] [data-column="status"]')].map(
      (cell) => cell.textContent,
    )

  const ssoAction = (row: number, label: string): HTMLButtonElement => {
    const rows = ssoTable().querySelectorAll<HTMLElement>('tbody [data-row]')
    const button = [...rows[row]!.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === label,
    )
    if (button === undefined) throw new Error(`no ${label} action on row ${row}`)
    return button
  }

  const ssoResult = (): string | null =>
    document.querySelector<HTMLElement>('[data-sso-domain-result]')!.textContent

  it('[unit] shows the challenge record, and never checked is not the same as not found', async () => {
    // Migration 0039 creates the table empty and the provisioning gate is live,
    // so before this screen an instance had no in-product path from off to on:
    // recovery meant hand-writing a D1 row with a valid challenge token.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi(
      [senderIdentity()],
      [
        ssoDomain(),
        ssoDomain({
          id: 12,
          domain: 'acme.test',
          record_name: '_ezacto-challenge.acme.test',
          last_checked_at: timestamp,
        }),
        ssoDomain({
          id: 13,
          domain: 'verified.test',
          record_name: '_ezacto-challenge.verified.test',
          verified: true,
          verified_at: timestamp,
          last_checked_at: timestamp,
        }),
      ],
    )
    await mountShell(api)

    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    // A domain nobody has looked up and a domain whose record was looked for
    // and not found are both unverified, and one label for both is how an
    // operator who has not published the record yet concludes SSO is broken.
    expect(ssoStatuses()).toEqual(['Awaiting first check', 'Record not found', 'Verified'])
    expect(ssoTable().textContent).toContain('_ezacto-challenge.northpeak.test')
    expect(ssoTable().textContent).toContain('ezacto-verification=zLp7c4Qk')
  })

  it('[unit] adds a domain and says it provisions nobody until the record is published', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    document.querySelector<HTMLInputElement>('[data-sso-domain-input]')!.value = ' acme.test '
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(api.addSsoDomain).toHaveBeenCalledWith('acme.test', expect.any(AbortSignal)),
    )
    await vi.waitFor(() => expect(ssoResult()).toContain('Publish the TXT record shown'))
    expect(ssoTable().textContent).toContain('_ezacto-challenge.acme.test')
    expect(ssoTable().textContent).toContain('ezacto-verification=8mQd2Rh1')
    expect(ssoStatuses()).toEqual(['Awaiting first check'])
  })

  it('[unit] reports a check that ran and found nothing as not verified yet', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => ({
        ...ssoDomain({ last_checked_at: timestamp }),
        dnssec_validated: false,
      })),
    }
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Verify').click()

    await vi.waitFor(() => expect(ssoResult()).toContain('is not verified yet'))
    expect(ssoResult()).toContain('_ezacto-challenge.northpeak.test')
    expect(ssoStatuses()).toEqual(['Record not found'])
  })

  it('[unit] separates a lookup that could not run from a record that is not there', async () => {
    // 503 is the resolvers failing to answer, not the domain failing the check:
    // the record may be published and perfect. A page that reads the two the
    // same way sends an operator to pull a record that was never the problem.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => {
        throw new EzactoApiError(
          503,
          {
            error: {
              code: 'dns_lookup_failed',
              message: 'The DNS challenge could not be looked up. Try again.',
              fields: [],
            },
          },
          null,
        )
      }),
    }
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Verify').click()

    await vi.waitFor(() =>
      expect(ssoResult()).toBe('The DNS challenge could not be looked up. Try again.'),
    )
    expect(ssoResult()).not.toContain('not verified yet')
    // Nothing was checked, so the row must not claim the record is missing.
    expect(ssoStatuses()).toEqual(['Awaiting first check'])
  })

  it('[unit] verifies a domain and says so', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([senderIdentity()], [ssoDomain()])
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Verify').click()

    await vi.waitFor(() => expect(ssoResult()).toBe('northpeak.test is verified.'))
    expect(api.verifySsoDomain).toHaveBeenCalledWith(11, expect.any(AbortSignal))
    expect(ssoStatuses()).toEqual(['Verified'])
  })

  it('[unit] removes a domain from the list it provisions from', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([senderIdentity()], [ssoDomain()])
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Remove').click()

    await vi.waitFor(() =>
      expect(api.removeSsoDomain).toHaveBeenCalledWith(11, expect.any(AbortSignal)),
    )
    await vi.waitFor(() => expect(ssoResult()).toBe('northpeak.test no longer provisions anyone.'))
    expect(ssoTable().querySelectorAll('tbody [data-row]')).toHaveLength(0)
    expect(ssoTable().textContent).toContain('No domain is provisioned')
  })

  it('[security] does not ask for provisioning domains as an executive manager', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      whoami: vi.fn(async () => ({
        ...identity,
        user_id: 5,
        profile: 'executive_manager' as const,
      })),
    }
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-sso-status]')?.textContent).toBe(
        'SSO provisioning domains are visible to administrators only.',
      ),
    )
    expect(api.listSsoDomains).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!.hidden).toBe(true)
  })

  const settled = async (): Promise<void> => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  }

  const moduleStatus = (): string | null | undefined =>
    document.querySelector<HTMLElement>('[data-module-settings-status]')?.textContent

  // Each in-flight writer, driven the way the shell drives it: an operation
  // started by an administrator, a sign-out and a sign-in by someone lesser in
  // the same document, and only then the answer. #372 fixed the sections that
  // load on activation; nothing stopped a request that was already out from
  // painting into the page it came back to.
  it('[security] does not paint an add that answers after the next person signs in', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const added = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], []),
      addSsoDomain: vi.fn(async () => added.promise),
    }
    const controller = createModuleSettingsController(api as never)

    // No abort here: the guard cannot rest on the shell remembering to abort,
    // and a session that was merely replaced has left the page just the same.
    await controller.activate(identity, new AbortController().signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    document.querySelector<HTMLInputElement>('[data-sso-domain-input]')!.value = 'acme.test'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.addSsoDomain).toHaveBeenCalled())

    // The same tab, a different person, while the POST is still out.
    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    added.resolve(
      ssoDomain({
        id: 12,
        domain: 'acme.test',
        record_name: '_ezacto-challenge.acme.test',
        record_value: 'ezacto-verification=8mQd2Rh1',
      }),
    )
    await settled()

    // The challenge token is the instance's proof it owns the domain, and this
    // is the one path that puts a brand new one on screen.
    expect(document.body.textContent).not.toContain('ezacto-verification=8mQd2Rh1')
    expect(document.body.textContent).not.toContain('_ezacto-challenge.acme.test')
    expect(document.body.textContent).not.toContain('acme.test')
    expect(ssoTable().hidden).toBe(true)
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not paint a verify that answers after the next person signs in', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const checked = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => checked.promise),
    }
    const controller = createModuleSettingsController(api as never)

    // The shell aborts on every sign-in and sign-out, so this is the path a
    // real verify takes. However the request ends, the finally that re-shows
    // the table runs.
    const first = new AbortController()
    await controller.activate(identity, first.signal, () => false)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Verify').click()
    await vi.waitFor(() => expect(api.verifySsoDomain).toHaveBeenCalled())

    first.abort()
    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    checked.resolve(ssoDomain({ verified: true, verified_at: timestamp, last_checked_at: timestamp }))
    await settled()

    expect(document.body.textContent).not.toContain('northpeak.test')
    expect(document.body.textContent).not.toContain('ezacto-verification=zLp7c4Qk')
    expect(ssoTable().hidden).toBe(true)
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not answer a verify that lands after the operator signed out', async () => {
    // Signing out does not activate the page again, so nothing clears it: all
    // that stops the check from reporting on a session that has ended is the
    // aborted signal the shell hands every controller on the way out.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const checked = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => checked.promise),
    }
    const controller = createModuleSettingsController(api as never)

    const operator = new AbortController()
    await controller.activate(identity, operator.signal, () => false)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Verify').click()
    await vi.waitFor(() => expect(api.verifySsoDomain).toHaveBeenCalled())

    operator.abort()
    checked.resolve(ssoDomain({ verified: true, verified_at: timestamp, last_checked_at: timestamp }))
    await settled()

    expect(ssoResult()).not.toContain('is verified')
    expect(ssoStatuses()).toEqual(['Awaiting first check'])
  })

  it('[security] does not paint a remove that answers after the next person signs in', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const removed = deferred<undefined>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      removeSsoDomain: vi.fn(async () => removed.promise),
    }
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Remove').click()
    await vi.waitFor(() => expect(api.removeSsoDomain).toHaveBeenCalled())

    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    removed.resolve(undefined)
    await settled()

    // Even an empty table is the previous session's section: re-showing it
    // under "administrators only" says the notice is about someone else.
    expect(document.body.textContent).not.toContain('northpeak.test')
    expect(ssoTable().hidden).toBe(true)
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not paint a notes policy that saves after the next person signs in', async () => {
    // The notes form is the only writable setting on the page, and its handler
    // was written with the same shape as the three SSO ones.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const saved = deferred<{ required: boolean; minimum_length: number }>()
    const api = {
      ...companyApi(),
      updateTimeEntryNoteSettings: vi.fn(async () => saved.promise),
    }
    const controller = createModuleSettingsController(api as never)

    const noteForm = document.querySelector<HTMLFormElement>('[data-note-settings-form]')!
    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    await controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(noteForm.hidden).toBe(false))
    noteMinimum.value = '25'
    noteForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.updateTimeEntryNoteSettings).toHaveBeenCalled())

    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    saved.resolve({ required: false, minimum_length: 25 })
    await settled()

    expect(noteForm.hidden).toBe(true)
    expect(document.querySelector('[data-note-settings-result]')?.textContent).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not report an ended session\u2019s failure to the shell at all', async () => {
    // The paint half of every handler here was guarded; the report half was
    // not, so a 401 from a session that had already gone was still handed to
    // onSessionFailure. Nothing worse happened only because the shell checks
    // currency a second time -- a guarantee this controller was borrowing
    // rather than holding, and the borrowed one is what six earlier sites had.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const checked = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => checked.promise),
    }
    const controller = createModuleSettingsController(api as never)

    const operator = new AbortController()
    const operatorSessionFailure = vi.fn(() => false)
    await controller.activate(identity, operator.signal, operatorSessionFailure)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Verify').click()
    await vi.waitFor(() => expect(api.verifySsoDomain).toHaveBeenCalled())

    operator.abort()
    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    checked.reject(authenticationError(401, 'unauthorized'))
    await settled()

    expect(operatorSessionFailure).not.toHaveBeenCalled()
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[unit] gives the next administrator controls that are not still disabled', async () => {
    // The finally that re-enables a control belongs to the session that
    // disabled it, so the reset has to happen where the next session's page is
    // built. Without it, guarding the finally strands the button.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const added = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], []),
      addSsoDomain: vi.fn(async () => added.promise),
    }
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    document.querySelector<HTMLInputElement>('[data-sso-domain-input]')!.value = 'acme.test'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('[data-sso-domain-submit]')!.disabled).toBe(
        true,
      ),
    )

    await controller.activate(identity, new AbortController().signal, () => false)
    added.resolve(ssoDomain({ id: 12, domain: 'acme.test' }))
    await settled()

    expect(document.querySelector<HTMLButtonElement>('[data-sso-domain-submit]')!.disabled).toBe(
      false,
    )
  })
})

describe('command palette browser behavior', () => {
  // Approvals answers only when the module is there and the profile may review;
  // Team only when the module reports itself enabled. Both APIs are present for
  // every mount below, so what separates the two people in these tests is the
  // profile alone.
  const paletteApi = (whoami: Whoami): ShellApi => ({
    ...browserApi(),
    whoami: vi.fn(async () => whoami),
    listTimesheetSubmissions: vi.fn(async () => []),
    listPendingTimesheetSubmissions: vi.fn(async () => ({
      submissions: [],
      nextCursor: null,
    })),
    getTeamStatus: vi.fn(async () => ({ enabled: true })),
  })

  const openPalette = (): HTMLInputElement => {
    document.querySelector<HTMLButtonElement>('[data-command-trigger]')!.click()
    return document.querySelector<HTMLInputElement>('[name="command"]')!
  }

  const paletteLabels = (): string[] =>
    [...document.querySelectorAll<HTMLAnchorElement>('[data-command-option]')].map(
      (option) => option.textContent ?? '',
    )

  const navHidden = (href: string): boolean =>
    document.querySelector<HTMLElement>(`.primary-nav a[href="${href}"]`)!.hidden

  it('[e2e] groups every destination the nav offers an administrator', async () => {
    renderBrowserShell()
    await mountShell(paletteApi(identity))
    await vi.waitFor(() => expect(navHidden('/approvals')).toBe(false))
    await vi.waitFor(() => expect(navHidden('/team')).toBe(false))

    const command = openPalette()
    expect(paletteLabels()).toContain('Approvals')
    expect(paletteLabels()).toContain('Team')
    expect(paletteLabels()).toContain('Company settings')
    // Grouped by what you came to do, and only groups with results are drawn.
    expect(
      [...document.querySelectorAll<HTMLElement>('.command-group')].map((group) =>
        group.getAttribute('aria-label'),
      ),
    ).toEqual(['Track', 'Organize', 'Bill', 'Review'])
    // Nothing is highlighted before the query says something, so Enter still
    // belongs to the form.
    expect(document.querySelector('[data-command-option][aria-selected="true"]')).toBeNull()

    edit(command, 'invo')
    expect(paletteLabels()).toEqual(['Invoices', 'Generate invoice'])
    expect(
      document.querySelector<HTMLElement>('[data-command-option][aria-selected="true"]')
        ?.textContent,
    ).toBe('Invoices')

    command.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )
    expect(
      document.querySelector<HTMLElement>('[data-command-option][aria-selected="true"]')
        ?.textContent,
    ).toBe('Generate invoice')
    expect(command.getAttribute('aria-activedescendant')).toBe(
      document.querySelector<HTMLElement>('[data-command-option][aria-selected="true"]')?.id,
    )

    const assign = vi.spyOn(globalThis.location, 'assign').mockImplementation(() => {})
    try {
      command.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      expect(assign).toHaveBeenCalledWith('/invoices/new')
    } finally {
      assign.mockRestore()
    }
  })

  it('[security] withholds from a member the destinations the nav hides', async () => {
    renderBrowserShell()
    await mountShell(paletteApi(secondIdentity))
    // The premise: the same three guards that hide these from the nav are what
    // the palette is being asked about. Without this the test could pass on a
    // palette that lists nothing at all.
    await vi.waitFor(() =>
      expect(document.querySelector('[data-current-profile]')?.textContent).toBe('member'),
    )
    expect(navHidden('/approvals')).toBe(true)
    expect(navHidden('/team')).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-settings-company-tab]')!.hidden).toBe(true)

    openPalette()
    const labels = paletteLabels()
    expect(labels).not.toContain('Approvals')
    expect(labels).not.toContain('Team')
    expect(labels).not.toContain('Company settings')
    // And it is a filtered list rather than an empty one.
    expect(labels).toContain('Projects')
    expect(labels).toContain('Your settings')
  })

  it('[unit] leaves log and go to the command grammar they had', async () => {
    renderBrowserShell()
    const api = paletteApi(identity)
    await mountShell(api)

    const command = openPalette()
    edit(command, 'log 1h northpeak development')
    expect(paletteLabels()).toEqual([])
    expect(document.querySelector('[data-command-empty]')).not.toBeNull()

    document
      .querySelector<HTMLFormElement>('[data-command-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    const entryDialog = document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!
    await vi.waitFor(() => expect(entryDialog.open).toBe(true))
    expect(entryDialog.dataset.entryContext).toBe('quick-add')
  })
})
