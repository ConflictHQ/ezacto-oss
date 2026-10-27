import type { CalendarConnectionAuthority } from './calendar-connection.js'
import type { CalendarProvider } from './calendar-proposal.js'

/** The complete immutable custody identity; user IDs alone never select a grant. */
export interface CalendarOperatorCleanupIdentity {
  id: string
  user_id: number
  provider: CalendarProvider
  instance_nonce: string
  generation: number
  credential_revision: number
  key_id: string
  request_id: string | null
  reason: 'disconnect' | 'closure' | 'reauth' | 'restore' | 'reset'
}
export interface CalendarOperatorCleanupReview extends CalendarOperatorCleanupIdentity {
  review_instance: string
  status: 'pending' | 'manual_required'
  created_at: string
  provider_cleanup_in_progress: boolean
}
export interface CalendarOperatorCleanupConfirmation extends CalendarOperatorCleanupIdentity {
  review_instance: string
  expected_status: 'pending' | 'manual_required'
  evidence_reference: string
  confirm_provider_removed: true
}
export interface CalendarOperatorCleanupReceipt {
  obligation_id: string
  kind: 'operator_attestation'
  provider_verified: false
  attested_at: string
  evidence_sha256: string
}
export interface CalendarOperatorCleanupStore {
  list(
    authority: CalendarConnectionAuthority,
    after?: string,
  ): Promise<{
    data: readonly CalendarOperatorCleanupReview[]
    next_cursor: string | null
  }>
  confirm(
    authority: CalendarConnectionAuthority,
    input: CalendarOperatorCleanupConfirmation,
  ): Promise<CalendarOperatorCleanupReceipt>
}
