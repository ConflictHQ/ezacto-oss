import type { MyPayments, MyPaymentsStatus, StaffInvoiceReport } from '@ezacto/core'

/**
 * The own-payments screen's pure parts (issue 100, docs/contractor-payments.md).
 * Nothing here names a person: the server answers only for the signed-in user.
 */
export interface MyPaymentsApi {
  getMyStaffInvoices?(month: string, signal?: AbortSignal): Promise<{readonly data: StaffInvoiceReport}>
  getMyPayments(month: string, signal?: AbortSignal): Promise<{ readonly data: MyPayments }>
}

export const myPaymentsStatusText = (status: MyPaymentsStatus): string =>
  ({
    pending_review: 'Pending review',
    in_progress: 'In progress',
    pending: 'Pending',
    partial: 'Partially paid',
    paid: 'Paid',
    settled: 'Settled (historical)',
  })[status]

/** `4h 30m`, from rounded seconds; whole minutes so it never claims more precision than it has. */
export const myPaymentsHours = (seconds: number): string => {
  const minutes = Math.round(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export const myPaymentsMoney = (cents: number, currency: string): string => {
  const magnitude = BigInt(Math.abs(cents))
  return `${currency} ${cents < 0 ? '-' : ''}${(magnitude / 100n).toLocaleString('en-US')}.${(magnitude % 100n).toString().padStart(2, '0')}`
}

export const myUpcomingStatusText = (status: 'scheduled' | 'processing'): string =>
  status === 'scheduled' ? 'Scheduled' : 'Processing'

/** The refusal the server gives, as words the person can act on. */
export const myPaymentsRefusal = (code: string | null): string | null =>
  code === 'own_money_disabled'
    ? 'Your organization has not enabled this view.'
    : code === 'not_a_payee'
      ? 'No payments are recorded for you.'
      : null
