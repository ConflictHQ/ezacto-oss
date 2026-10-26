import type { StaffPaymentRow } from '@ezacto/core'

export const deelStagingLabel = (row: StaffPaymentRow): string => {
  const progress = row.deel_staging
  if (!progress) return row.payout_provider === 'deel' ? 'Status unavailable' : '—'
  return {
    not_staged: 'Not staged',
    partially_staged: 'Partially staged',
    staged: 'Staged in Deel',
    attention: 'Needs attention',
    no_hours: 'No hours to stage',
    partially_paid: 'Partially paid in Deel',
    paid: 'Paid in Deel',
    processing: 'Payment processing in Deel',
  }[progress.status]
}

export const renderDeelStagingStatus = (row: StaffPaymentRow): HTMLElement => {
  const node = document.createElement('div')
  node.dataset.deelStagingStatus = String(row.user_id)
  const label = document.createElement('strong')
  label.textContent = deelStagingLabel(row)
  node.appendChild(label)
  const progress = row.deel_staging
  if (!progress) return node
  const detail = (value: string) => {
    const line = document.createElement('div')
    line.textContent = value
    node.appendChild(line)
  }
  const hours = (seconds: number) => `${(seconds / 3600).toFixed(2)} h`
  if (progress.paid_entries) detail(`${hours(progress.paid_seconds)} paid in Deel · ${progress.paid_entries} entries`)
  if (progress.approved_entries) detail(`${progress.approved_entries} approved in Deel, awaiting payment`)
  if (progress.processing_entries) detail(`${progress.processing_entries} payment processing in Deel`)
  if (progress.pending_entries) detail(`${progress.pending_entries} awaiting approval in Deel`)
  if (progress.rejected_entries) detail(`${progress.rejected_entries} declined or not payable in Deel`)
  if (progress.unchecked_entries) detail(`${progress.unchecked_entries} awaiting payment status check`)
  detail(`${hours(progress.staged_seconds)} staged · ${progress.staged_entries} entries`)
  detail(`${hours(progress.unstaged_seconds)} remaining · ${progress.unstaged_entries} entries`)
  if (progress.unresolved_entries) detail(`${progress.unresolved_entries} awaiting reconciliation`)
  if (progress.changed_entries) detail(`${progress.changed_entries} changed since staging`)
  if (progress.unsyncable_entries) detail(`${progress.unsyncable_entries} invalid entries need review`)
  if (progress.zero_duration_entries) detail(`${progress.zero_duration_entries} zero-hour entries skipped`)
  if (progress.last_staged_at) detail(`Last staged: ${progress.last_staged_at}`)
  if (progress.status_checked_at) detail(`Payment status checked: ${progress.status_checked_at}`)
  if (progress.status_check_failed) detail('Could not refresh Deel status. Showing the last confirmed status.')
  if (progress.staged_entries && progress.status !== 'paid') detail('Complete any remaining invoice and payment in Deel.')
  return node
}
