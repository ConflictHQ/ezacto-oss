/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  summarizeStaffPayments,
  type StaffPaymentCommand,
  type StaffPaymentReport,
  type StaffPaymentEvent,
} from '@ezacto/core'
import { renderStaffPayments } from '../src/staff-payments/render.js'
import { createStaffPaymentsController } from '../src/staff-payments/browser.js'
import { staffPaymentAmount, staffPaymentCsv } from '../src/staff-payments/model.js'
const person = { user_id: 2, name: 'Fixture Person', active: true, wise_ready: false }
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
      .mockResolvedValueOnce({ month: '2026-09', as_of: '2026-09-24', rows: [], provider_settings: { default_provider: 'wise', version: 0, events: [] } })
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
