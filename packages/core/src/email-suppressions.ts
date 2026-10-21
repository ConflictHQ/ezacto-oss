export type EmailSuppressionReason = 'bounce' | 'complaint'
export interface EmailSuppressionRecord {
  id: number
  address: string
  reason: EmailSuppressionReason
  firstSeenAt: string
  lastSeenAt: string
  events: number
}
export interface EmailSuppressionLift {
  id: number
  address: string
  throughEventId: number
  actorId: number
  note: string
  complaintAcknowledged: boolean
  liftedAt: string
}
export interface EmailSuppressionStore {
  snapshot(): Promise<number>
  list(input: { snapshot: number; after?: number; take: number }): Promise<EmailSuppressionRecord[]>
  lookup(recipients: readonly string[]): Promise<EmailSuppressionReason | null>
  lift(
    input: { eventId: number; actorId: number; note: string; confirmation: string },
    now: string,
  ): Promise<EmailSuppressionLift>
}
export class EmailSuppressionError extends Error {
  constructor(
    readonly code:
      'not_found' | 'state_conflict' | 'confirmation_required' | 'profile_forbidden' | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'EmailSuppressionError'
  }
}
