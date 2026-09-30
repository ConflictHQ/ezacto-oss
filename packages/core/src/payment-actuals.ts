import { StaffPaymentError, validPaymentMonth, paymentMonthEnd } from './staff-payments.js'
import { trackedAmountCents } from './reports.js'

export interface PaymentActualEntry {
  entry_id: number
  project_id: number
  project_name: string
  spent_date: string
  rounded_seconds: number
  cost_rate_cents: number | null
  selected_seconds: number
}
export interface PaymentActualPerson {
  user_id: number
  name: string
  entries: PaymentActualEntry[]
}
export interface PaymentActuals {
  month: string
  currency: string
  completed: boolean
  people: PaymentActualPerson[]
}
export interface ConfirmPaymentActuals {
  id: string
  user_id: number
  month: string
  expected_version: number
  currency: string
  entries: PaymentActualEntry[]
  note: string
}
export const previousPaymentMonth = (today: string): string => {
  const [year, month] = today.slice(0, 7).split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 2, 1)).toISOString().slice(0, 7)
}
export const paymentActualsTotal = (entries: readonly PaymentActualEntry[]): number => {
  let total = 0
  const seen = new Set<number>()
  for (const entry of entries) {
    if (
      !Number.isSafeInteger(entry.entry_id) ||
      entry.entry_id <= 0 ||
      seen.has(entry.entry_id) ||
      !Number.isSafeInteger(entry.selected_seconds) ||
      entry.selected_seconds < Math.min(0, entry.rounded_seconds) ||
      !Number.isSafeInteger(entry.rounded_seconds) ||
      entry.selected_seconds > Math.max(0, entry.rounded_seconds)
    )
      throw new StaffPaymentError(
        'invalid',
        'Choose each time entry once and hours within its actual total.',
      )
    seen.add(entry.entry_id)
    if (entry.selected_seconds === 0) continue
    if (
      entry.cost_rate_cents === null ||
      !Number.isSafeInteger(entry.cost_rate_cents) ||
      entry.cost_rate_cents < 0
    )
      throw new StaffPaymentError(
        'invalid',
        'Resolve missing cost rates before confirming selected hours.',
      )
    total += trackedAmountCents(entry.selected_seconds, entry.cost_rate_cents)
  }
  if (!Number.isSafeInteger(total) || total < 0 || total > 9_000_000_000_000)
    throw new StaffPaymentError('invalid', 'The reviewed amount exceeds the supported range.')
  return total
}
export const validateActualsMonth = (month: string, today: string): void => {
  if (!validPaymentMonth(month) || paymentMonthEnd(month) >= today)
    throw new StaffPaymentError(
      'invalid',
      'Review a completed work month. September earnings are paid from October onward.',
    )
}
