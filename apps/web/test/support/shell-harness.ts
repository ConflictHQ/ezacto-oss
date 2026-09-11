/**
 * Fixtures and DOM helpers shared by the shell browser suites.
 *
 * These lived at the top of a single 4,939-line `browser.test.ts`. They are a
 * module now because that file had to be split: happy-dom retains roughly 25 MB
 * for every parse of the shell markup and frees it only when the Window is
 * dropped, which vitest does once per *file* -- so 93 tests in one file needed
 * ~2.2 GB and OOMed a CI fork. Splitting on the `describe` boundaries gives each
 * group its own Window (issue 456).
 */

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
import { vi } from 'vitest'
import { createModuleSettingsController } from '../../src/module-settings/browser.js'
import { mountShell } from '../../src/shell/browser.js'
import {
  defaultTheme,
  invoiceTabs,
  renderAppShell,
  themeManifest,
  webAssets,
  type ShellApi,
} from '../../src/index.js'

export const timestamp = '2026-08-28T12:00:00.000Z'

export const identity: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}

export const principal: AuthPrincipal = {
  status: 'authenticated',
  user_id: identity.user_id,
  profile: identity.profile,
  manager_grants: [],
}

export const secondIdentity: Whoami = {
  user_id: 2,
  profile: 'member',
  manager_grants: [],
  authentication: { kind: 'session' },
}

export const secondPrincipal: AuthPrincipal = {
  status: 'authenticated',
  user_id: 2,
  profile: 'member',
  manager_grants: [],
}

export const currentSession: Session = {
  id: 7,
  created_at: timestamp,
  last_seen_at: timestamp,
  idle_expires_at: timestamp,
  absolute_expires_at: timestamp,
  revoked_at: null,
  revocation_reason: null,
  current: true,
}

export const resource = (id: number, name: string): GeneralResource => ({
  id,
  name,
  created_at: timestamp,
  updated_at: timestamp,
})

export const timeEntry = (
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

export const invoice = (id: number, overrides: Partial<Invoice> = {}): Invoice => ({
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

export const invoiceMessage = (invoiceId: number): InvoiceMessage => ({
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

export const invoicePayment = (invoiceId: number): InvoicePayment => ({
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

export const browserApi = (
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

export const pendingSubmission = (id: number, userName: string): TimesheetSubmissionDetail => ({
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

export const desktopInputs = (): HTMLInputElement[] => [
  ...document.querySelectorAll<HTMLInputElement>('[data-week-grid] input[data-cell-key]'),
]

export const edit = (input: HTMLInputElement, value: string): void => {
  input.focus()
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export const renderBrowserShell = (
  options: {
    preserveStorage?: boolean
    view?:
      | 'time'
      | 'timesheet-approvals'
      | 'invoice-generation'
      | 'invoice-list'
      | 'invoice-detail'
      | 'settings-company'
      | 'settings-user'
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

export const authenticationError = (status: number, code: string): EzactoApiError =>
  new EzactoApiError(
    status,
    { error: { code, message: 'server detail is not rendered', fields: [] } },
    null,
  )

export const deferred = <Value>() => {
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

export const submitSignIn = (email: string, password: string): void => {
  const emailInput = document.querySelector<HTMLInputElement>('[name="email"]')!
  const passwordInput = document.querySelector<HTMLInputElement>('[name="password"]')!
  emailInput.value = email
  passwordInput.value = password
  document
    .querySelector<HTMLFormElement>('[data-sign-in-form]')!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}


export {
  createModuleSettingsController,
  mountShell,
  defaultTheme,
  invoiceTabs,
  renderAppShell,
  themeManifest,
  webAssets,
}
export type {
  AuthPrincipal,
  GeneralResource,
  Invoice,
  InvoiceMessage,
  InvoicePayment,
  InvoicePaymentInput,
  InvoicePaymentUpdateInput,
  InvoiceTransitionInput,
  SenderIdentity,
  Session,
  ShellApi,
  SsoDomain,
  TimeEntry,
  TimeEntryInput,
  TimeEntryPatch,
  TimesheetSubmission,
  TimesheetSubmissionDetail,
  Whoami,
}
export { EzactoApiError }
