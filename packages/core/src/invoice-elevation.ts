import { canManageTeammateTime, type UserProfile } from './api-authorization.js'
/** The same administrator ceiling as correcting someone else's recorded time. */
export const canElevateInvoiceEdits = (profile: UserProfile): boolean =>
  canManageTeammateTime(profile)
export const invoiceElevationLifetimeSeconds = 15 * 60
export const invoiceElevationHeader = 'X-Ezacto-Invoice-Elevation'
export const invoiceElevationScope = 'invoice_drafts:write' as const
export interface InvoiceEditElevation {
  id: string
  userId: number
  tokenId: number
  invoiceId: number
  credentialVersion: number
  expiresAt: string
}
export interface InvoiceElevationBinding {
  userId: number
  tokenId: number
  invoiceId: number
  credentialVersion: number
}
export interface InvoiceElevationPending extends InvoiceElevationBinding {
  challengeExpiresAt: string
}
export class InvoiceElevationError extends Error {
  constructor(
    readonly code:
      | 'invoice_elevation_required'
      | 'invoice_elevation_unavailable'
      | 'invoice_draft_required'
      | 'invoice_time_conflict'
      | 'invalid_invoice_time_selection',
    message: string,
  ) {
    super(message)
    this.name = 'InvoiceElevationError'
  }
}
export interface ElevatedInvoiceTimeUnlink {
  invoiceId: number
  commandId: string
  expectedVersion: number
  entryIds: readonly number[]
}
export interface ElevatedInvoiceTimeUnlinkResult {
  invoiceId: number
  commandId: string
  elevationId: string
  releasedEntryIds: number[]
  recordedAt: string
  replayed: boolean
}
