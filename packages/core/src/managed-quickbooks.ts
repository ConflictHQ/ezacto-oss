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
