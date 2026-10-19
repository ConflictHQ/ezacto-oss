import {
  summarizeStaffPayments,
  type StaffPaymentEvent,
  type StaffPaymentRow,
} from './staff-payments.js'

/**
 * The own-subject payment summary (issue 100, docs/contractor-payments.md).
 * Every field here is on the spec's shown list; a ledger row is never spread
 * into it, so a field added to the register later cannot reach a payee.
 */
export type MyPaymentsStatus = 'pending_review' | 'in_progress' | 'pending' | 'partial' | 'paid' | 'settled'
export interface MyPaymentReceipt {
  amount_cents: number
  currency: string
  paid_on: string
}
export interface MyUpcomingPayment {
  amount_cents: number
  currency: string
  scheduled_on: string
  status: 'scheduled' | 'processing'
}
export interface MyPayments {
  month: string
  hours_seconds: number
  status: MyPaymentsStatus
  owed: { amount_cents: number; currency: string } | null
  paid_cents: number
  balance_cents: number | null
  payments: MyPaymentReceipt[]
  upcoming: MyUpcomingPayment[]
}
export interface MyPaymentsStore {
  /**
   * The caller's own summary, or null when they are not a payee (not flagged a
   * contractor and no recorded obligation). The subject is only ever the
   * authenticated user id: there is no way to name anyone else.
   */
  read(userId: number, month: string, today: string): Promise<MyPayments | null>
}

/** The ledger arithmetic is the register's own, so the two always reconcile. */
export const summarizeMyPayments = (
  month: string,
  events: readonly StaffPaymentEvent[],
  hoursSeconds: number,
  upcoming: readonly MyUpcomingPayment[],
  today: string,
): MyPayments => {
  const row: StaffPaymentRow = summarizeStaffPayments(
    { user_id: 0, name: '', active: true, wise_ready: false },
    month,
    events,
    today,
  )
  const voided = new Set(
    events.filter((e) => e.month === month && e.kind === 'void').map((e) => e.payment_id),
  )
  const payments = events
    .filter((e) => e.month === month && e.kind === 'payment' && !voided.has(e.id))
    .sort((a, b) => a.version - b.version)
    .map((e) => ({ amount_cents: e.amount_cents!, currency: e.currency!, paid_on: e.paid_on! }))
  const recorded = row.amount_cents !== null && row.currency !== null
  return {
    month,
    hours_seconds: hoursSeconds,
    status: !recorded && row.status !== 'settled' ? 'pending_review' : row.status,
    owed: recorded ? { amount_cents: row.amount_cents!, currency: row.currency! } : null,
    paid_cents: row.paid_cents,
    balance_cents: row.balance_cents,
    payments,
    upcoming: upcoming.map((u) => ({
      amount_cents: u.amount_cents,
      currency: u.currency,
      scheduled_on: u.scheduled_on,
      status: u.status,
    })),
  }
}
