/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  summarizeStaffPayments,
  type AllocatePayment,
  type PaymentAllocationPreview,
  type PaymentAllocationReport,
  type ReversePaymentAllocation,
  type StaffPaymentReport,
} from '@ezacto/core'
import { renderStaffPayments } from '../src/staff-payments/render.js'
import { createAllocationsController } from '../src/staff-payments/allocations-browser.js'

const ledger: StaffPaymentReport = {
  month: '2026-09',
  as_of: '2026-10-01',
  provider_settings: { default_provider: 'wise', version: 0, events: [] },
  rows: [
    summarizeStaffPayments({ user_id: 2, name: 'Person Two', active: true, wise_ready: true }, '2026-09', [], '2026-10-01'),
  ],
}
const report: PaymentAllocationReport = {
  month: '2026-09',
  people: [
    {
      user_id: 2,
      name: 'Person Two',
      currency: 'USD',
      earned_cents: 20000,
      paid_cents: 10000,
      reserved_cents: 0,
      allocated_applied_cents: 0,
      allocated_reserved_cents: 0,
      remaining_cents: 10000,
      projects: [
        {
          project_id: 7,
          project_name: 'Atlas',
          earned_cents: 20000,
          applied_cents: 0,
          reserved_cents: 0,
          remaining_cents: 20000,
          entries: [
            {
              entry_id: 31,
              spent_date: '2026-09-04',
              selected_seconds: 14400,
              rate_cents: 5000,
              reviewed_rounded_seconds: 14400,
              current_rounded_seconds: 14400,
              current_rate_cents: 5000,
              earned_cents: 20000,
              applied_cents: 0,
              reserved_cents: 0,
              applied_seconds: 0,
              reserved_seconds: 0,
              remaining_cents: 20000,
              remaining_seconds: 14400,
              source_changed: true,
              over_allocated: false,
            },
          ],
        },
      ],
      unallocated_payments: [
        { payment_kind: 'event', payment_id: 'pay-1', amount_cents: 10000, allocated_cents: 0, unallocated_cents: 10000, state: 'applied' },
      ],
      allocations: [],
    },
  ],
}
const preview: PaymentAllocationPreview = {
  scope: 'entry',
  currency: 'USD',
  seconds: 7200,
  rate_cents: 5000,
  amount_cents: 10000,
  payment_cents: 10000,
  payment_allocated_cents: 0,
  payment_remaining_cents: 0,
  earning_cents: 20000,
  earning_allocated_cents: 0,
  earning_remaining_cents: 10000,
  earning_remaining_seconds: 7200,
}
const text = () => document.body.textContent ?? ''
const set = (selector: string, value: string): void => {
  const control = document.querySelector<HTMLInputElement>(selector)!
  control.value = value
  control.dispatchEvent(new Event('input', { bubbles: true }))
}
const mount = async (api: Parameters<typeof createAllocationsController>[1]) => {
  document.body.innerHTML = renderStaffPayments('staff-payments')
  const page = document.querySelector<HTMLElement>('[data-staff-payments-page]')!
  const controller = createAllocationsController(page, api, (error) => (error as Error).message)
  const active = new AbortController().signal
  controller.activate(active)
  controller.ledger(ledger, active)
  document.querySelector<HTMLButtonElement>('[data-allocations-load]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-allocation-form]')).not.toBeNull())
  return controller
}
beforeEach(() => {
  document.body.innerHTML = ''
})

describe('payment allocation review', () => {
  it('shows hours, rate, amount and what remains before confirming, then records the reviewed command', async () => {
    const api = {
      getPaymentAllocationReport: vi.fn(async () => report),
      previewPaymentAllocation: vi.fn<(command: AllocatePayment) => Promise<PaymentAllocationPreview>>(async () => preview),
      allocatePayment: vi.fn<(command: AllocatePayment) => Promise<void>>(async () => {}),
    }
    await mount(api)
    expect(text()).toContain('Source time changed: reverse and re-review')
    const scope = document.querySelector<HTMLSelectElement>('[aria-label="Allocate to"]')!
    scope.value = 'entry'
    scope.dispatchEvent(new Event('change'))
    set('[aria-label="Hours paid"]', '2')
    set('[aria-label="Allocation reason"]', 'Paid for two hours')
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm allocation')!
    expect(confirm.hidden).toBe(true)
    document.querySelector<HTMLFormElement>('[data-allocation-form]')!.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
    await vi.waitFor(() => expect(confirm.hidden).toBe(false))
    const sent = api.previewPaymentAllocation.mock.calls[0]![0]
    expect(sent).toMatchObject({ payment_kind: 'event', payment_id: 'pay-1', scope: 'entry', project_id: 7, entry_id: 31, seconds: 7200, amount_cents: null })
    for (const expected of ['Selected hours2.0000', 'Captured rateUSD 50.00', 'This allocationUSD 100.00', 'Earnings remaining after thisUSD 100.00', 'Hours remaining after this2.0000'])
      expect(text()).toContain(expected)
    expect(api.allocatePayment).not.toHaveBeenCalled()
    confirm.click()
    await vi.waitFor(() => expect(api.allocatePayment).toHaveBeenCalledTimes(1))
    expect(api.allocatePayment.mock.calls[0]![0]).toEqual(sent)
    await vi.waitFor(() => expect(document.querySelector('[data-allocations-status]')!.textContent).toContain('No money has been sent'))
    expect(api.getPaymentAllocationReport).toHaveBeenCalledTimes(2)
  })

  it('withdraws the review when an input changes, so only a reviewed command can be confirmed', async () => {
    const api = {
      getPaymentAllocationReport: async () => report,
      previewPaymentAllocation: async () => preview,
      allocatePayment: vi.fn<(command: AllocatePayment) => Promise<void>>(async () => {}),
    }
    await mount(api)
    set('[aria-label="Allocation reason"]', 'Because')
    set('[aria-label="Exact amount"]', '10')
    document.querySelector<HTMLFormElement>('[data-allocation-form]')!.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm allocation')!
    await vi.waitFor(() => expect(confirm.hidden).toBe(false))
    set('[aria-label="Exact amount"]', '12')
    expect(confirm.hidden).toBe(true)
    expect(text()).not.toContain('Allocation review')
  })

  it('reconciles an existing payment to the month with the whole unallocated amount and no hours', async () => {
    const api = {
      getPaymentAllocationReport: async () => report,
      previewPaymentAllocation: vi.fn<(command: AllocatePayment) => Promise<PaymentAllocationPreview>>(async () => ({ ...preview, scope: 'month' as const, seconds: null, rate_cents: null })),
      allocatePayment: vi.fn<(command: AllocatePayment) => Promise<void>>(async () => {}),
    }
    await mount(api)
    document.querySelector<HTMLButtonElement>('[aria-label="Reconcile payment pay-1 to the work month"]')!.click()
    document.querySelector<HTMLFormElement>('[data-allocation-form]')!.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
    await vi.waitFor(() => expect(api.previewPaymentAllocation).toHaveBeenCalledTimes(1))
    expect(api.previewPaymentAllocation.mock.calls[0]![0]).toMatchObject({
      scope: 'month',
      project_id: null,
      entry_id: null,
      seconds: null,
      amount_cents: 10000,
      payment_id: 'pay-1',
    })
    expect(api.previewPaymentAllocation.mock.calls[0]![0].reason).toContain('Reconciled existing 2026-09 payment pay-1')
  })

  it('shows the server refusal and keeps nothing confirmable', async () => {
    const api = {
      getPaymentAllocationReport: async () => report,
      previewPaymentAllocation: async (): Promise<PaymentAllocationPreview> => {
        throw new Error('This allocation exceeds the unallocated part of the payment.')
      },
      allocatePayment: vi.fn<(command: AllocatePayment) => Promise<void>>(async () => {}),
    }
    await mount(api)
    set('[aria-label="Exact amount"]', '999')
    set('[aria-label="Allocation reason"]', 'Too much')
    document.querySelector<HTMLFormElement>('[data-allocation-form]')!.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
    await vi.waitFor(() => expect(text()).toContain('exceeds the unallocated part'))
    expect([...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm allocation')!.hidden).toBe(true)
  })

  it('reverses an allocation only with a reason, keeps the row and reloads the report', async () => {
    const recorded = {
      id: 'a1', user_id: 2, payment_kind: 'event' as const, payment_id: 'pay-1', month: '2026-09', scope: 'month' as const,
      project_id: null, project_name: null, entry_id: null, seconds: null, rate_cents: null, amount_cents: 10000,
      currency: 'USD', state: 'applied' as const, reason: 'Reconciled', actor_id: 1, recorded_at: '2026-10-01T00:00:00.000Z',
    }
    const done = { ...recorded, id: 'a0', state: 'reversed' as const }
    const withRows: PaymentAllocationReport = {
      ...report,
      people: [{ ...report.people[0]!, allocations: [recorded, done] }],
    }
    const api = {
      getPaymentAllocationReport: vi.fn(async () => withRows),
      reversePaymentAllocation: vi.fn<(command: ReversePaymentAllocation) => Promise<void>>(async () => {}),
    }
    await mount(api)
    expect(document.querySelector('[aria-label="Reverse allocation a0"]')).toBeNull()
    document.querySelector<HTMLButtonElement>('[aria-label="Reverse allocation a1"]')!.click()
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Confirm reversal')!
    confirm.click()
    expect(api.reversePaymentAllocation).not.toHaveBeenCalled()
    expect(text()).toContain('Explain the reversal.')
    set('[aria-label="Reversal reason for a1"]', '  Wrong entry  ')
    confirm.click()
    await vi.waitFor(() => expect(api.reversePaymentAllocation).toHaveBeenCalledTimes(1))
    expect(api.reversePaymentAllocation.mock.calls[0]![0]).toMatchObject({ allocation_id: 'a1', reason: 'Wrong entry' })
    await vi.waitFor(() => expect(document.querySelector('[data-allocations-status]')!.textContent).toContain('Allocation reversed'))
    expect(api.getPaymentAllocationReport).toHaveBeenCalledTimes(2)
  })

  it('clears drawn allocations on reset', async () => {
    const controller = await mount({ getPaymentAllocationReport: async () => report })
    expect(document.querySelector('[data-allocations-content]')!.childElementCount).toBeGreaterThan(0)
    controller.reset()
    expect(document.querySelector('[data-allocations-content]')!.childElementCount).toBe(0)
  })
})
