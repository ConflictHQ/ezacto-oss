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
  detail(`${hours(progress.staged_seconds)} staged · ${progress.staged_entries} entries`)
  detail(`${hours(progress.unstaged_seconds)} remaining · ${progress.unstaged_entries} entries`)
  if (progress.unresolved_entries) detail(`${progress.unresolved_entries} awaiting reconciliation`)
  if (progress.changed_entries) detail(`${progress.changed_entries} changed since staging`)
  if (progress.unsyncable_entries) detail(`${progress.unsyncable_entries} invalid entries need review`)
  if (progress.zero_duration_entries) detail(`${progress.zero_duration_entries} zero-hour entries skipped`)
  if (progress.last_staged_at) detail(`Last staged: ${progress.last_staged_at}`)
  if (progress.staged_entries) detail('Complete invoice and payment in Deel.')
  return node
}
