// Provenance: ezacto-pvt #899 (parent #891). Payments allocated to the earnings
// they pay. An additive layer over the monthly register: nothing here changes a
// monthly total, and a payment nobody allocates stays unallocated.
import { StaffPaymentError, validPaymentMonth } from './staff-payments.js'
import { trackedAmountCents } from './reports.js'

export type PaymentAllocationScope = 'month' | 'project' | 'entry'
/** A recorded payment event, or a payment run item that reserves and later settles. */
export type PaymentAllocationPaymentKind = 'event' | 'run_item'
/** applied: settled; reserved: scheduled or processing; released: voided, failed or cancelled; reversed: explicit. */
export type PaymentAllocationState = 'applied' | 'reserved' | 'released' | 'reversed'

export interface AllocatePayment {
  id: string
  payment_kind: PaymentAllocationPaymentKind
  payment_id: string
  user_id: number
  month: string
  scope: PaymentAllocationScope
  project_id: number | null
  entry_id: number | null
  /** Hours paid on an entry. The amount follows from the captured rate unless `amount_cents` overrides it. */
  seconds: number | null
  /** Required unless `seconds` is given. */
  amount_cents: number | null
  reason: string
}
export interface ReversePaymentAllocation {
  id: string
  allocation_id: string
  reason: string
}
export interface PaymentAllocation {
  id: string
  payment_kind: PaymentAllocationPaymentKind
  payment_id: string
  user_id: number
  month: string
  currency: string
  scope: PaymentAllocationScope
  project_id: number | null
  project_name: string | null
  entry_id: number | null
  seconds: number | null
  rate_cents: number | null
  amount_cents: number
  state: PaymentAllocationState
  reason: string
  actor_id: number
  recorded_at: string
}
/** What an allocation would record, and what each side has left before it is confirmed. */
export interface PaymentAllocationPreview {
  scope: PaymentAllocationScope
  currency: string
  seconds: number | null
  rate_cents: number | null
  amount_cents: number
  payment_cents: number
  payment_allocated_cents: number
  payment_remaining_cents: number
  earning_cents: number
  earning_allocated_cents: number
  earning_remaining_cents: number
  earning_remaining_seconds: number | null
}
export interface PaymentAllocationEntry {
  entry_id: number
  spent_date: string
  selected_seconds: number
  rate_cents: number | null
  earned_cents: number
  applied_cents: number
  reserved_cents: number
  applied_seconds: number
  reserved_seconds: number
  remaining_cents: number
  remaining_seconds: number
  /** The source time entry no longer matches the confirmed review: reverse and re-review. */
  source_changed: boolean
  /** More is allocated than the latest confirmed review earns. */
  over_allocated: boolean
}
export interface PaymentAllocationProject {
  project_id: number
  project_name: string
  earned_cents: number
  applied_cents: number
  reserved_cents: number
  remaining_cents: number
  entries: PaymentAllocationEntry[]
}
export interface UnallocatedPayment {
  payment_kind: PaymentAllocationPaymentKind
  payment_id: string
  amount_cents: number
  allocated_cents: number
  unallocated_cents: number
  state: 'applied' | 'reserved'
}
export interface PaymentAllocationPerson {
  user_id: number
  name: string
  currency: string | null
  earned_cents: number
  paid_cents: number
  reserved_cents: number
  allocated_applied_cents: number
  allocated_reserved_cents: number
  /** Monthly earnings neither paid nor reserved. */
  remaining_cents: number
  projects: PaymentAllocationProject[]
  unallocated_payments: UnallocatedPayment[]
  allocations: PaymentAllocation[]
}
export interface PaymentAllocationReport {
  month: string
  people: PaymentAllocationPerson[]
}

const ID = /^[a-zA-Z0-9._-]{1,100}$/u
const MAX_CENTS = 9_000_000_000_000
const integer = (value: unknown): value is number => Number.isSafeInteger(value)

export const validateAllocatePayment = (command: AllocatePayment): void => {
  const fail = (message: string): never => {
    throw new StaffPaymentError('invalid', message)
  }
  if (!ID.test(command.id)) fail('Provide a command identifier.')
  if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(command.payment_id)) fail('Choose a payment.')
  if (command.payment_kind !== 'event' && command.payment_kind !== 'run_item')
    fail('Choose a recorded payment or a scheduled payment.')
  if (command.payment_kind === 'event' && command.payment_id.startsWith('run-payment:'))
    fail('Allocate a provider payment through its payment run item.')
  if (!integer(command.user_id) || command.user_id <= 0) fail('Choose a person.')
  if (!validPaymentMonth(command.month)) fail('Choose a valid month (YYYY-MM).')
  if (command.reason.trim().length === 0 || command.reason.length > 2000)
    fail('Explain this allocation in up to 2,000 characters.')
  if (command.scope === 'month') {
    if (command.project_id !== null || command.entry_id !== null || command.seconds !== null)
      fail('A month allocation takes an amount only.')
  } else if (command.scope === 'project') {
    if (!integer(command.project_id) || command.project_id <= 0) fail('Choose a project.')
    if (command.entry_id !== null || command.seconds !== null)
      fail('A project allocation takes an amount only.')
  } else if (command.scope === 'entry') {
    if (!integer(command.project_id) || command.project_id <= 0) fail('Choose a project.')
    if (!integer(command.entry_id) || command.entry_id <= 0) fail('Choose a time entry.')
    if (command.seconds !== null && (!integer(command.seconds) || command.seconds <= 0))
      fail('Hours must be a positive whole number of seconds.')
  } else fail('Choose the month, a project or a time entry.')
  if (command.amount_cents === null) {
    if (command.seconds === null) fail('Enter hours or an exact amount.')
  } else if (!integer(command.amount_cents) || command.amount_cents <= 0 || command.amount_cents > MAX_CENTS)
    fail('Enter an exact amount within the supported range.')
}

/**
 * The cents paid for hours on an entry. Partial hours are valued at the captured
 * rate; the allocation that takes the last hours takes whatever cents remain, so
 * rounding never leaves a cent unallocatable nor lets the parts exceed the whole.
 */
export const allocationHoursCents = (
  seconds: number,
  rateCents: number,
  remainingSeconds: number,
  remainingCents: number,
): number =>
  seconds === remainingSeconds
    ? remainingCents
    : Math.min(trackedAmountCents(seconds, rateCents), remainingCents)
