/** Existing canonical QuickBooks connection schema bounds (migration0048). */
export const managedQuickBooksGrantLimits = {
  tokenLength: 4096,
  companyNameLength: 255,
  realmIdLength: 64,
} as const

/** Trusted-process managed grant commands. Provider exchange and tenant/browser
 * proof stay with the host; these commands never expose a network callback. */
export interface ManagedQuickBooksTokens {
  realmId: string
  companyName: string | null
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: string
  refreshTokenExpiresAt: string
  scope: string
}
export interface ManagedQuickBooksGrantProbe {
  grantId: string
  browserHash: string
  credentialHash: string
}
export interface ManagedQuickBooksGrantCommand extends ManagedQuickBooksGrantProbe {
  expectedActorUserId: number
  expectedConnectionGeneration: number
  expiresAt: number
  tokens: ManagedQuickBooksTokens
}
export type ManagedQuickBooksAuthority =
  | { kind: 'native-session'; userId: number; sessionId: number }
  | { kind: 'guarded-session'; userId: number }
export interface ManagedQuickBooksGrantState {
  connectionGeneration: number
  connected: boolean
}
export interface ManagedQuickBooksGrantInspection extends ManagedQuickBooksGrantState {
  replayed: boolean
}
export interface ManagedQuickBooksGrantAcceptance extends ManagedQuickBooksGrantState {
  outcome: 'accepted' | 'replayed'
}
export interface ManagedQuickBooksGrantStore {
  prepare(
    authority: ManagedQuickBooksAuthority,
    now: string,
  ): Promise<ManagedQuickBooksGrantState>
  inspect(
    probe: ManagedQuickBooksGrantProbe,
    authority: ManagedQuickBooksAuthority,
    now: string,
  ): Promise<ManagedQuickBooksGrantInspection>
  accept(
    command: ManagedQuickBooksGrantCommand,
    authority: ManagedQuickBooksAuthority,
    now: string,
  ): Promise<ManagedQuickBooksGrantAcceptance>
}
export class ManagedQuickBooksGrantError extends Error {
  constructor(readonly kind: 'invalid' | 'forbidden' | 'conflict' | 'expired') {
    super(
      'The QuickBooks grant or administrator authority changed. Restart the connection from settings.',
    )
    this.name = 'ManagedQuickBooksGrantError'
  }
}

/** Managed lifecycle fence and revocation custody (issue 1236). The host calls
 * Intuit outside any replayable tenant transaction and reports the outcome here;
 * local disconnection alone never means the provider grant is revoked. */
export type ManagedQuickBooksEnvironment = 'sandbox' | 'production'
export type ManagedQuickBooksFenceReason = 'disconnect' | 'suspension' | 'erasure'
export interface ManagedQuickBooksFenceCommand {
  /** Opaque 64-hex idempotency key for this revocation intent. */
  revocationId: string
  /** The accepted grant receipt this connection came from. */
  grantId: string
  expectedActorUserId: number
  expectedConnectionGeneration: number
  environment: ManagedQuickBooksEnvironment
  reason: ManagedQuickBooksFenceReason
}
/** pending: provider revocation owed. attempting: a call may have been made and
 * its reply is unknown, so the credential is withheld until reconciled. */
export type ManagedQuickBooksRevocationStatus = 'pending' | 'attempting' | 'revoked'
export interface ManagedQuickBooksRevocationReceipt {
  revocationId: string
  grantId: string
  actorUserId: number
  realmId: string
  environment: ManagedQuickBooksEnvironment
  reason: ManagedQuickBooksFenceReason
  fencedGeneration: number
  status: ManagedQuickBooksRevocationStatus
  attempts: number
  /** True only once the provider revocation is recorded. */
  complete: boolean
}
export interface ManagedQuickBooksFenceResult {
  outcome: 'fenced' | 'replayed'
  connectionGeneration: number
  revocation: ManagedQuickBooksRevocationReceipt
}
/** Credential custody, handed only to the trusted host process. */
export interface ManagedQuickBooksRevocationCustody {
  revocationId: string
  realmId: string
  environment: ManagedQuickBooksEnvironment
  refreshToken: string
}
export interface ManagedQuickBooksLifecycleStore {
  fence(
    command: ManagedQuickBooksFenceCommand,
    authority: ManagedQuickBooksAuthority,
    now: string,
  ): Promise<ManagedQuickBooksFenceResult>
  /** Safe status, never a credential. */
  readRevocation(revocationId: string): Promise<ManagedQuickBooksRevocationReceipt | null>
  /** Revocations whose provider outcome is not yet recorded. */
  listUnresolved(): Promise<ManagedQuickBooksRevocationReceipt[]>
  /** Moves pending to attempting and returns the credential once. An attempting
   * revocation returns no credential: reconcile with the provider and settle. */
  beginRevocation(
    revocationId: string,
    now: string,
  ): Promise<{
    revocation: ManagedQuickBooksRevocationReceipt
    custody: ManagedQuickBooksRevocationCustody | null
  }>
  /** Records the observed provider result of an attempting revocation. */
  settleRevocation(
    revocationId: string,
    outcome: 'revoked' | 'not_revoked',
    now: string,
  ): Promise<ManagedQuickBooksRevocationReceipt>
}
