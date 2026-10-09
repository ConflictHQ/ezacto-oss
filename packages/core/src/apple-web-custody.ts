import type { AppleCleanupStatus } from './apple-lifecycle.js'

export interface AppleWebConnection {
  id: string
  subjectDigest: string
  browserHash: string
  userId: number | null
  serviceIssuer: string
  instanceOrigin: string
  clientId: string
  grantId: string
  generation: number
  sealedCapability: string | null
  sealedReceipt: string | null
  cleanupRequestId: string | null
  status: 'active' | 'pending' | 'revoked' | 'manual_required'
  createdAt: string
  updatedAt: string
}

export interface AppleWebCustodyStore {
  save(input: AppleWebConnection): Promise<AppleWebConnection | null>
  browser(hash: string): Promise<AppleWebConnection | null>
  begin(userId: number, requestId: string, now: string): Promise<void>
  obligations(requestId: string): Promise<AppleWebConnection[]>
  status(requestId: string): Promise<AppleCleanupStatus>
  requestExists(requestId: string): Promise<boolean>
  pending(id: string, requestId: string, now: string): Promise<boolean>
  manual(id: string, now: string): Promise<void>
  complete(input: { id: string; requestId: string; grantId: string; generation: number; sealedReceipt: string; now: string }): Promise<boolean>
}
