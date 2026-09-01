import type {
  Invoice,
  InvoiceMessage,
  InvoicePayment,
  Whoami,
} from '@ezacto/client'

export const invoiceProfileHasAccess = (profile: Whoami['profile']): boolean =>
  profile === 'accounting' ||
  profile === 'executive_manager' ||
  profile === 'administrator'

export const invoiceIdFromPathname = (pathname: string): number | null => {
  const match = /^\/invoices\/([1-9][0-9]*)\/?$/u.exec(pathname)
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

export const invoiceStateLabel = (invoice: Readonly<Invoice>): string => {
  if (invoice.state !== 'closed') {
    return invoice.state[0]!.toLocaleUpperCase('en-US') + invoice.state.slice(1)
  }
  if (invoice.close_reason === 'written_off') return 'Written off'
  if (invoice.close_reason === 'cancelled') return 'Cancelled'
  return 'Closed'
}

export const invoiceMessageLabel = (
  message: Readonly<InvoiceMessage>,
): string => {
  const event = message.event_type?.trim()
  if (event === undefined || event === null || event === '')
    return 'Invoice activity'
  return event.replaceAll('_', ' ').replaceAll('-', ' ')
}

export const invoicePaymentDate = (
  payment: Readonly<InvoicePayment>,
): string | null => payment.paid_date ?? payment.paid_at

export const invoicePeriod = (invoice: Readonly<Invoice>): string | null =>
  invoice.period_start === null || invoice.period_end === null
    ? null
    : `${invoice.period_start} – ${invoice.period_end}`
