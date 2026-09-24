import type { StaffPaymentReport, StaffPaymentRow } from '@ezacto/core'

export const staffPaymentStatus = (row: StaffPaymentRow): string => {
  const status = {
    in_progress: 'In progress',
    pending: 'Pending',
    partial: 'Partially paid',
    paid: 'Paid',
    settled: 'Historically settled',
  }[row.status]
  return row.overdue ? `${status} · overdue` : status
}
export const staffPaymentAmount = (value: string): number => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value))
    throw new Error('Enter an amount with up to two decimal places.')
  const [whole, fraction = ''] = value.split('.')
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents > 9_000_000_000_000n) throw new Error('The amount is too large.')
  return Number(cents)
}
export const staffPaymentMoney = (
  cents: number | bigint | null,
  currency: string | null,
): string => {
  if (cents === null || currency === null) return 'Unspecified'
  const value = BigInt(cents)
  return `${currency} ${(value / 100n).toLocaleString('en-US')}.${(value % 100n).toString().padStart(2, '0')}`
}
const csvCell = (value: unknown): string => {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`
  return `"${text.replace(/"/gu, '""')}"`
}
export const staffPaymentCsv = (report: StaffPaymentReport, audit = false): string => {
  const header = audit
    ? [
        'Person',
        'User ID',
        'Period',
        'Event',
        'Amount cents',
        'Currency',
        'Paid on',
        'Due on',
        'Source',
        'Reference',
        'Note',
        'Actor',
        'Actor ID',
        'Recorded at',
        'Request ID',
        'Event ID',
        'Voids event ID',
      ]
    : [
        'Person',
        'User ID',
        'Period',
        'Status',
        'Overdue',
        'Amount cents',
        'Currency',
        'Paid cents',
        'Balance cents',
        'Due on',
        'Settled through',
        'Wise destination ready',
        'As of',
      ]
  const rows = audit
    ? report.rows.flatMap((row) =>
        row.events.map((event) => [
          row.name,
          row.user_id,
          event.month,
          event.kind,
          event.amount_cents,
          event.currency,
          event.paid_on,
          event.due_on,
          event.source,
          event.reference,
          event.note,
          event.actor_name,
          event.actor_id,
          event.recorded_at,
          event.request_id,
          event.id,
          event.payment_id,
        ]),
      )
    : report.rows.map((row) => [
        row.name,
        row.user_id,
        row.month,
        staffPaymentStatus(row),
        row.overdue,
        row.amount_cents,
        row.currency,
        row.status === 'settled' ? null : row.paid_cents,
        row.balance_cents,
        row.due_on,
        row.settled_through,
        row.wise_ready,
        report.as_of,
      ])
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}
