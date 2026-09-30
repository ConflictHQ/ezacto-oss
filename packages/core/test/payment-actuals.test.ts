import { expect, it } from 'vitest'
import {
  previousPaymentMonth,
  paymentActualsTotal,
  validateActualsMonth,
  type PaymentActualEntry,
} from '../src/payment-actuals.js'
const entry: PaymentActualEntry = {
  entry_id: 1,
  project_id: 1,
  project_name: 'Project',
  spent_date: '2026-08-01',
  rounded_seconds: 7200,
  cost_rate_cents: 1050,
  selected_seconds: 3600,
}
it('defaults to the previous work month including January and leap years', () => {
  expect(previousPaymentMonth('2026-09-30')).toBe('2026-08')
  expect(previousPaymentMonth('2026-10-01')).toBe('2026-09')
  expect(previousPaymentMonth('2026-01-01')).toBe('2025-12')
  expect(() => validateActualsMonth('2024-02', '2024-02-29')).toThrow(/completed/)
  expect(() => validateActualsMonth('2024-02', '2024-03-01')).not.toThrow()
})
it('prices partial seconds with report rounding and retains signed corrections', () => {
  expect(paymentActualsTotal([entry])).toBe(1050)
  expect(paymentActualsTotal([{ ...entry, selected_seconds: 1 }])).toBe(0)
  expect(
    paymentActualsTotal([
      entry,
      {
        ...entry,
        entry_id: 2,
        rounded_seconds: -1800,
        selected_seconds: -1800,
      },
    ]),
  ).toBe(525)
  expect(() => paymentActualsTotal([entry, entry])).toThrow(/once/)
  expect(() => paymentActualsTotal([{ ...entry, selected_seconds: 7201 }])).toThrow(/within/)
  expect(() => paymentActualsTotal([{ ...entry, cost_rate_cents: null }])).toThrow(/missing/)
  expect(paymentActualsTotal([{ ...entry, cost_rate_cents: null, selected_seconds: 0 }])).toBe(
    0,
  )
})
