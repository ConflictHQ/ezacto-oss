/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest'
import { summarizeStaffPayments, type PaymentActuals, type StaffPaymentReport } from '@ezacto/core'
import { createActualsController } from '../src/staff-payments/actuals-browser.js'
import { renderStaffPayments } from '../src/staff-payments/render.js'

it('announces earnings confirmation, restores feedback on failure, and keeps the retry command', async () => {
  document.body.innerHTML = renderStaffPayments('staff-payments')
  const actuals: PaymentActuals = {
    month: '2026-09', currency: 'USD', completed: true,
    people: [{ user_id: 2, name: 'Contractor', entries: [{ entry_id: 1, project_id: 1, project_name: 'Project', spent_date: '2026-09-01', rounded_seconds: 3600, selected_seconds: 3600, cost_rate_cents: 1000 }] }],
  }
  const ledger: StaffPaymentReport = {
    month: '2026-09', as_of: '2026-10-01', provider_settings: { default_provider: 'wise', version: 0, events: [] },
    rows: [summarizeStaffPayments({ user_id: 2, name: 'Contractor', active: true, wise_ready: false }, '2026-09', [], '2026-10-01')],
  }
  let reject!: (error: Error) => void
  let resolve!: () => void
  const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
    .mockImplementationOnce(() => new Promise<void>(done => { resolve = done }))
  const reload = vi.fn(async () => {})
  const controller = createActualsController(document.querySelector('[data-staff-payments-page]')!, {
    getPaymentActuals: async () => actuals, confirmPaymentActuals: save,
  }, reload, vi.fn(), error => (error as Error).message)
  const active = new AbortController()
  controller.activate(active.signal)
  controller.ledger(ledger, active.signal)
  document.querySelector<HTMLButtonElement>('[data-actuals-load]')!.click()
  await vi.waitFor(() => expect(document.querySelector('[data-actuals-form]')).not.toBeNull())
  const form = document.querySelector<HTMLFormElement>('[data-actuals-form]')!
  const status = document.querySelector<HTMLElement>('[data-actuals-status]')!
  form.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
  expect(status.textContent).toBe('Confirming earnings…')
  expect(status.getAttribute('aria-busy')).toBe('true')
  reject(new Error('Earnings service unavailable'))
  await vi.waitFor(() => expect(status.textContent).toBe('Earnings service unavailable'))
  expect(status.getAttribute('aria-busy')).toBe('false')
  form.dispatchEvent(new SubmitEvent('submit', { cancelable: true }))
  expect(save.mock.calls[1]![0]).toEqual(save.mock.calls[0]![0])
  expect(status.getAttribute('aria-busy')).toBe('true')
  resolve()
  await vi.waitFor(() => expect(status.textContent).toBe('Earnings saved. No money has been sent.'))
  expect(status.getAttribute('aria-busy')).toBe('false')
  expect(reload).toHaveBeenCalledOnce()
  active.abort()
})
