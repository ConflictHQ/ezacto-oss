/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  summarizeStaffPayments,
  type StaffPaymentCommand,
  type StaffPaymentReport,
  type StaffPaymentEvent,
  type StaffPaymentRow,
} from '@ezacto/core'
import { renderStaffPayments } from '../src/staff-payments/render.js'
import { createStaffPaymentsController } from '../src/staff-payments/browser.js'
import {
  staffPaymentAmount,
  staffPaymentCsv,
  staffPaymentMoney,
} from '../src/staff-payments/model.js'
const person = {
  user_id: 2,
  name: 'Fixture Person',
  active: true,
  wise_ready: false,
}
const event: StaffPaymentEvent = {
  id: 'amount-1',
  user_id: 2,
  month: '2026-08',
  kind: 'amount',
  amount_cents: 10000,
  currency: 'USD',
  expected_version: 0,
  version: 1,
  paid_on: null,
  due_on: null,
  reference: '',
  note: 'Amount agreed',
  payment_id: null,
  source: 'historical',
  actor_id: 1,
  actor_name: 'Administrator',
  recorded_at: '2026-09-24T00:00:00Z',
  request_id: 'request-1',
}
const report = (events: StaffPaymentEvent[] = [event]): StaffPaymentReport => ({
  provider_settings: { default_provider: 'wise', version: 0, events: [] },
  month: '2026-08',
  as_of: '2026-09-24',
  rows: [summarizeStaffPayments(person, '2026-08', events, '2026-09-24')],
})
const stagingProgress = (
  overrides: Partial<NonNullable<StaffPaymentRow['deel_staging']>> = {},
): NonNullable<StaffPaymentRow['deel_staging']> => ({
  status: 'partially_staged',
  staged_entries: 1,
  unstaged_entries: 1,
  unresolved_entries: 0,
  changed_entries: 0,
  unsyncable_entries: 0,
  zero_duration_entries: 1,
  staged_seconds: 3600,
  unstaged_seconds: 7200,
  last_staged_at: '2026-09-24T10:00:00Z',
  paid_entries: 0,
  paid_seconds: 0,
  approved_entries: 0,
  processing_entries: 0,
  pending_entries: 0,
  rejected_entries: 0,
  unchecked_entries: 0,
  status_checked_at: null,
  status_check_failed: false,
  ...overrides,
})
const form = (): HTMLFormElement => document.querySelector('[data-payment-entry-form]')!
const field = (name: string): HTMLInputElement =>
  form().elements.namedItem(name) as HTMLInputElement
const submit = () =>
  form().dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
beforeEach(() => {
  document.body.innerHTML = renderStaffPayments('staff-payments')
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
describe('monthly payment register', () => {
  it('automatically moves staged hours through processing, partial and full Deel payment without clearing edits', async () => {
    vi.useFakeTimers()
    const active = new AbortController()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    try {
      const value = report()
      const row = value.rows[0]!
      row.payout_provider = 'deel'
      row.deel_staging = stagingProgress({ status: 'staged', staged_entries: 2, staged_seconds: 10800, unstaged_entries: 0, unstaged_seconds: 0 })
      let checks = 0
      const refreshDeelPaymentStatus = vi.fn(async () => {
        checks += 1
        row.deel_staging = stagingProgress({
          status: checks === 1 ? 'processing' : checks === 2 ? 'partially_paid' : 'paid',
          staged_entries: 2, staged_seconds: 10800, unstaged_entries: 0, unstaged_seconds: 0,
          paid_entries: checks === 1 ? 0 : checks === 2 ? 1 : 2,
          paid_seconds: checks === 1 ? 0 : checks === 2 ? 3600 : 10800,
          processing_entries: checks === 1 ? 2 : checks === 2 ? 1 : 0,
          status_checked_at: '2026-09-24T12:00:00Z',
        })
        return { data: { configured: true, checked: 2, failed: 0, remaining: 0, retry_after_ms: 0 } }
      })
      await createStaffPaymentsController({
        getStaffPaymentReport: async () => structuredClone(value),
        recordStaffPaymentEvent: vi.fn(),
        refreshDeelPaymentStatus,
      }).activate({ profile: 'administrator' }, active.signal)
      const progress = () => document.querySelector('[data-payment-list] [data-deel-staging-status="2"]')!
      expect(progress().textContent).toContain('Staged in Deel')
      document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
      field('kind').value = 'payment'
      field('kind').dispatchEvent(new Event('change'))
      field('amount').value = '123.45'
      field('note').value = 'Keep this unsaved note'
      await vi.advanceTimersByTimeAsync(0)
      expect(progress().textContent).toContain('Payment processing in Deel')
      expect(progress().textContent).toContain('2 payment processing in Deel')
      expect(progress().textContent).not.toContain('paid in Deel')
      expect(field('amount').value).toBe('123.45')
      expect(field('note').value).toBe('Keep this unsaved note')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(progress().textContent).toContain('Partially paid in Deel')
      expect(progress().textContent).toContain('1.00 h paid in Deel')
      expect(document.querySelector('[data-payment-person-deel]')!.textContent).toContain('Partially paid in Deel')
      expect(field('amount').value).toBe('123.45')
      expect(field('note').value).toBe('Keep this unsaved note')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(progress().textContent).toContain('Paid in Deel')
      expect(progress().textContent).toContain('3.00 h paid in Deel')
      expect(field('amount').value).toBe('123.45')
      expect(field('note').value).toBe('Keep this unsaved note')
      expect(refreshDeelPaymentStatus).toHaveBeenCalledTimes(3)
      expect(row.paid_cents).toBe(0)
      expect(row.status).toBe('pending')
    } finally {
      active.abort()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
  it('shows the last confirmed Deel payment and stale warning when a provider refresh failed', async () => {
    const value = report()
    value.rows[0]!.deel_staging = stagingProgress({
      status: 'partially_paid', paid_entries: 1, paid_seconds: 3600, approved_entries: 1,
      processing_entries: 1, pending_entries: 1,
      unchecked_entries: 1, status_check_failed: true, status_checked_at: '2026-09-24T12:00:00Z',
    })
    const active = new AbortController()
    await createStaffPaymentsController({ getStaffPaymentReport: async () => value, recordStaffPaymentEvent: vi.fn() }).activate({ profile: 'administrator' }, active.signal)
    const progress = document.querySelector('[data-payment-list] [data-deel-staging-status="2"]')!
    expect(progress.textContent).toContain('Partially paid in Deel')
    expect(progress.textContent).toContain('1.00 h paid in Deel')
    expect(progress.textContent).toContain('approved in Deel, awaiting payment')
    expect(progress.textContent).toContain('1 payment processing in Deel')
    expect(progress.textContent).toContain('1 awaiting approval in Deel')
    expect(progress.textContent).toContain('Showing the last confirmed status')
    expect(progress.textContent).toContain('2026-09-24T12:00:00Z')
    active.abort()
  })
  it('refreshes staged batches in the ledger and restores saved progress when Payments is reopened', async () => {
    const value = report()
    const row = value.rows[0]!
    row.payout_provider = 'deel'
    row.deel_staging = stagingProgress()
    const read = vi.fn(async () => structuredClone(value))
    const stage = vi.fn(async () => {
      row.deel_staging = stagingProgress({ status: 'staged', staged_entries: 2, unstaged_entries: 0, staged_seconds: 10800, unstaged_seconds: 0 })
      return { data: { status: 'staged' as const, command_id: 'saved', run_id: 1, timesheets_staged: 1, entries_staged: 1, already_staged: 1, unresolved_entry_ids: [], code: null } }
    })
    const api = {
      getStaffPaymentReport: read,
      recordStaffPaymentEvent: vi.fn(),
      getDeelStaging: async () => ({ data: { configured: true, reason: null, start_date: '2026-08-01', last_complete_date: '2026-09-30' } }),
      previewDeelStaging: async () => ({ data: { status: 'ready' as const, from: '2026-08-01', to: '2026-08-31', user_ids: [2], preview_fingerprint: 'a'.repeat(64), entry_ids: [42], seconds: 7200, timesheets: 1, already_staged: 1, already_staged_entry_ids: [41], people: [{ user_id: 2, contract_id: 'contract', seconds: 7200, entries: 1 }], conflict_entry_ids: [], unsyncable_entry_ids: [], zero_duration_entry_ids: [43], unmatched: [], unresolved_entry_ids: [] } }),
      stageDeelHours: stage,
      getDeelStageStatus: stage,
    }
    const active = new AbortController()
    await createStaffPaymentsController(api).activate({ profile: 'administrator' }, active.signal)
    const month = document.querySelector<HTMLInputElement>('[data-payment-month]')!.value
    const status = () => document.querySelector('[data-payment-list] [data-deel-staging-status="2"]')!
    expect(status().textContent).toContain('Partially staged')
    expect(status().textContent).toContain('1.00 h staged')
    expect(status().textContent).toContain('2.00 h remaining')
    expect(status().textContent).toContain('1 zero-hour entries skipped')
    document.querySelector<HTMLButtonElement>('[aria-label="Stage hours in Deel: Fixture Person"]')!.click()
    document.querySelector<HTMLFormElement>('[data-deel-stage-form]')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.querySelector('[data-deel-stage-preview]')!.textContent).toContain('7200 seconds'))
    const reviewed = document.querySelector<HTMLInputElement>('[data-deel-stage-reviewed]')!
    reviewed.checked = true
    reviewed.dispatchEvent(new Event('change'))
    document.querySelector<HTMLButtonElement>('[data-deel-stage-send]')!.click()
    await vi.waitFor(() => expect(status().textContent).toContain('Staged in Deel'))
    expect(status().textContent).toContain('3.00 h staged')
    expect(status().textContent).toContain('0.00 h remaining')
    expect(document.querySelector('[data-deel-stage-message]')!.textContent).toContain('not marked paid here')
    expect(document.querySelector<HTMLInputElement>('[data-payment-month]')!.value).toBe(month)
    expect(row.paid_cents).toBe(0)
    expect(row.status).toBe('pending')
    active.abort()
    document.body.innerHTML = renderStaffPayments('staff-payments')
    const reopened = new AbortController()
    await createStaffPaymentsController(api).activate({ profile: 'administrator' }, reopened.signal)
    expect(status().textContent).toContain('Staged in Deel')
    expect(status().textContent).toContain('3.00 h staged')
    expect(stage).toHaveBeenCalledOnce()
    reopened.abort()
  })
  it('shows unresolved and changed Deel entries beside their saved staging totals', async () => {
    const value = report([])
    value.rows[0]!.payout_provider = 'deel'
    value.rows[0]!.has_hours = false
    value.rows[0]!.deel_staging = stagingProgress({ status: 'attention', unresolved_entries: 2, changed_entries: 1, unsyncable_entries: 1 })
    const active = new AbortController()
    await createStaffPaymentsController({ getStaffPaymentReport: async () => value, recordStaffPaymentEvent: vi.fn() }).activate({ profile: 'administrator' }, active.signal)
    const progress = document.querySelector('[data-payment-list] [data-deel-staging-status="2"]')!
    expect(progress.textContent).toContain('Needs attention')
    expect(progress.textContent).toContain('2 awaiting reconciliation')
    expect(progress.textContent).toContain('1 changed since staging')
    expect(progress.textContent).toContain('1 invalid entries need review')
    document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
    expect(document.querySelector('[data-payment-person-deel]')!.textContent).toBe(progress.textContent)
    active.abort()
  })
  it('requires administrator access before loading payroll', async () => {
    const read = vi.fn(async () => report())
    const controller = createStaffPaymentsController({
      getStaffPaymentReport: read,
      recordStaffPaymentEvent: vi.fn(),
    })
    await controller.activate({ profile: 'member' }, new AbortController().signal)
    expect(read).not.toHaveBeenCalled()
    expect(document.querySelector('[data-staff-payment-status]')?.textContent).toContain(
      'Only administrators',
    )
  })
  it('records Wise payments and preserves the command on retry after an unknown network result', async () => {
    const save = vi
      .fn<(command: StaffPaymentCommand, signal?: AbortSignal) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce()
    const controller = createStaffPaymentsController({
      getStaffPaymentReport: vi.fn(async () => report()),
      recordStaffPaymentEvent: save,
    })
    const active = new AbortController()
    await controller.activate({ profile: 'administrator' }, active.signal)
    document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
    field('kind').value = 'payment'
    field('kind').dispatchEvent(new Event('change'))
    expect(field('amount').value).toBe('100.00')
    expect(field('source').value).toBe('wise')
    field('paid_on').value = '2026-09-23'
    field('reference').value = 'wise-123'
    field('note').value = 'Receipt confirmed'
    submit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-payment-entry-result]')?.textContent).toContain(
        'Connection lost',
      ),
    )
    submit()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[0]![0]).toEqual(save.mock.calls[1]![0])
    expect(save.mock.calls[0]![0]).toMatchObject({
      source: 'wise',
      kind: 'payment',
      amount_cents: 10000,
      paid_on: '2026-09-23',
      expected_version: 1,
    })
    active.abort()
    expect(document.querySelector('[data-payment-history]')?.textContent).toBe('')
    expect(document.querySelector<HTMLElement>('[data-staff-payment-content]')!.hidden).toBe(true)
  })
  it('on the public demo, withholds the payment provider choice and says why', async () => {
    // Issue 931: which provider pays a person is refused on the demo, so the
    // two forms that choose it give way to the note.
    document.documentElement.setAttribute('data-demo-deployment', '')
    try {
      const configure = vi.fn(async () => undefined)
      const controller = createStaffPaymentsController({
        getStaffPaymentReport: vi.fn(async () => report()),
        recordStaffPaymentEvent: vi.fn(async () => undefined),
        configureStaffPaymentProvider: configure,
      })
      await controller.activate({ profile: 'administrator' }, new AbortController().signal)
      document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
      expect(
        document.querySelector<HTMLElement>('[data-payment-provider-form="person"]')!.hidden,
      ).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-payment-provider-settings]')!.hidden).toBe(
        true,
      )
      const notes = [...document.querySelectorAll<HTMLElement>('[data-payment-provider-demo]')]
      expect(notes).toHaveLength(2)
      expect(notes.every((note) => !note.hidden)).toBe(true)
      expect(notes[0]!.textContent).toBe(
        'Choosing a payment provider: not available on the public demo.',
      )
    } finally {
      document.documentElement.removeAttribute('data-demo-deployment')
    }

    // Anywhere else the forms are there and the notes are not.
    document.body.innerHTML = renderStaffPayments('staff-payments')
    const controller = createStaffPaymentsController({
      getStaffPaymentReport: vi.fn(async () => report()),
      recordStaffPaymentEvent: vi.fn(async () => undefined),
      configureStaffPaymentProvider: vi.fn(async () => undefined),
    })
    await controller.activate({ profile: 'administrator' }, new AbortController().signal)
    document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
    expect(
      document.querySelector<HTMLElement>('[data-payment-provider-form="person"]')!.hidden,
    ).toBe(false)
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-payment-provider-demo]')].every(
        (note) => note.hidden,
      ),
    ).toBe(true)
  })
  it('settles only explicitly selected people with unspecified historical amounts', async () => {
    const read = vi.fn(async () => report([]))
    const save = vi.fn<(command: StaffPaymentCommand, signal?: AbortSignal) => Promise<void>>(
      async () => {},
    )
    const controller = createStaffPaymentsController({
      getStaffPaymentReport: read,
      recordStaffPaymentEvent: save,
    })
    await controller.activate({ profile: 'administrator' }, new AbortController().signal)
    const opening = document.querySelector<HTMLFormElement>('[data-payment-opening-form]')!
    expect(opening.querySelector<HTMLInputElement>('[name=person]')!.checked).toBe(false)
    opening.querySelector<HTMLInputElement>('[name=person]')!.checked = true
    opening.querySelector<HTMLTextAreaElement>('[name=note]')!.value =
      'Historical payments confirmed from prior provider'
    opening.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]![0]).toMatchObject({
      user_id: 2,
      month: '2026-08',
      kind: 'opening',
      amount_cents: null,
      paid_on: null,
      source: 'historical',
    })
  })
  it('ignores an old monthly request that completes after a newer selection', async () => {
    let finish!: (value: StaffPaymentReport) => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<StaffPaymentReport>((resolve) => {
            finish = resolve
          }),
      )
      .mockResolvedValueOnce({
        month: '2026-09',
        as_of: '2026-09-24',
        rows: [],
        provider_settings: { default_provider: 'wise', version: 0, events: [] },
      })
    const controller = createStaffPaymentsController({
      getStaffPaymentReport: read,
      recordStaffPaymentEvent: vi.fn(),
    })
    const loading = controller.activate({ profile: 'administrator' }, new AbortController().signal)
    const month = document.querySelector<HTMLInputElement>('[data-payment-month]')!
    month.value = '2026-09'
    month.dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    finish(report())
    await loading
    expect(document.querySelector('[data-payment-list]')!.textContent).not.toContain(person.name)
  })
  it('clears the previous report when the month is emptied and refuses stale writes', async () => {
    const read = vi.fn(async () => report())
    const save = vi.fn()
    const controller = createStaffPaymentsController({
      getStaffPaymentReport: read,
      recordStaffPaymentEvent: save,
    })
    await controller.activate({ profile: 'administrator' }, new AbortController().signal)
    document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
    const month = document.querySelector<HTMLInputElement>('[data-payment-month]')!
    month.value = ''
    month.dispatchEvent(new Event('change'))
    submit()
    expect(save).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-payment-list]')!.textContent).toBe('')
    expect(document.querySelector('[data-payment-history]')!.textContent).toBe('')
    expect(document.querySelector('[data-payment-opening-people]')!.textContent).toBe('')
    expect(document.querySelector<HTMLElement>('[data-payment-person]')!.hidden).toBe(true)
    expect(document.querySelector('[data-staff-payment-status]')!.textContent).toBe(
      'Choose a valid month.',
    )
  })
})
describe('payment report exports', () => {
  it('keeps unknown historical totals blank and neutralizes spreadsheet formulas', () => {
    const opening = {
      ...event,
      kind: 'opening' as const,
      amount_cents: null,
      currency: null,
      due_on: null,
      note: '=CMD()',
    }
    const value = report([opening])
    value.rows[0]!.name = '+unsafe'
    expect(staffPaymentCsv(value)).toContain('"\'+unsafe"')
    expect(staffPaymentCsv(value, true)).toContain('"\'=CMD()"')
    expect(staffPaymentCsv(value)).toContain('"Historically settled","false","","","",""')
  })
  it('parses exact cents and rejects rounding or non-decimal input', () => {
    expect(staffPaymentAmount('100.01')).toBe(10001)
    expect(() => staffPaymentAmount('1.001')).toThrow()
    expect(() => staffPaymentAmount('1e3')).toThrow()
  })
})

it('shows historical contractor costs without inventing receipts or enabling Pay now', async () => {
  const value = report([{ ...event, kind: 'opening', amount_cents: null, currency: null }])
  Object.assign(value.rows[0]!, {
    amount_cents: 529870,
    currency: 'USD',
    amount_basis: 'contractor_cost',
  })
  const controller = createStaffPaymentsController({
    getStaffPaymentReport: async () => value,
    recordStaffPaymentEvent: vi.fn(),
  })
  await controller.activate({ profile: 'administrator' }, new AbortController().signal)
  const list = document.querySelector('[data-payment-list]')!
  expect(list.textContent).toContain('USD 5,298.70 · contractor cost')
  expect(list.textContent).toContain('Historically settled')
  expect(list.textContent).not.toContain('Pay now')
  expect(staffPaymentCsv(value)).toContain('"529870","USD","",""')
  expect(staffPaymentCsv(value)).toContain('"contractor_cost"')
  expect(staffPaymentCsv(value, true)).not.toContain('529870')
  document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
  expect(document.querySelector('[data-payment-person-summary]')!.textContent).toContain(
    'payment receipts and dates are unspecified',
  )
})
it('formats negative contractor cost corrections without corrupting cents', () => {
  expect(staffPaymentMoney(-50, 'USD')).toBe('USD -0.50')
  expect(staffPaymentMoney(-105050, 'USD')).toBe('USD -1,050.50')
})

it('hides empty people by default while keeping unrated hours, balances and payment history visible', async () => {
  const empty = { ...report([]).rows[0]!, user_id: 10, name: 'Empty Person' }
  const cutoff = { ...empty, user_id: 11, name: 'Empty Cutoff', status: 'settled' as const, events: [{ ...event, kind: 'opening' as const, amount_cents: null, currency: null }] }
  const unrated = { ...empty, user_id: 12, name: 'Unrated Hours', has_hours: true }
  const payment = { ...empty, user_id: 13, name: 'Payment History', events: [{ ...event, kind: 'payment' as const }] }
  const value = { ...report(), rows: [report().rows[0]!, empty, cutoff, unrated, payment] }
  const controller = createStaffPaymentsController({ getStaffPaymentReport: async () => value, recordStaffPaymentEvent: vi.fn() })
  await controller.activate({ profile: 'administrator' }, new AbortController().signal)
  const list = document.querySelector('[data-payment-list]')!
  const checkbox = document.querySelector<HTMLInputElement>('[data-payment-show-empty]')!
  expect(checkbox.checked).toBe(false)
  expect(list.textContent).not.toContain('Empty Person')
  expect(list.textContent).not.toContain('Empty Cutoff')
  expect(list.textContent).toContain('Unrated Hours')
  expect(list.textContent).toContain('Payment History')
  expect(list.textContent).toContain('Fixture Person')
  document.querySelector<HTMLButtonElement>('[data-payment-list] tbody button')!.click()
  field('amount').value = '123.45'
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change'))
  expect(field('amount').value).toBe('123.45')
  expect(list.textContent).toContain('Empty Person')
  expect(list.textContent).toContain('Empty Cutoff')
  checkbox.checked = false
  checkbox.dispatchEvent(new Event('change'))
  expect(list.textContent).not.toContain('Empty Person')
})
