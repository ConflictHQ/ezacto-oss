export interface InvoiceLineTimeRelease {
  commandId: string
  invoiceId: number
  lineId: number
  expectedVersion: number
  hoursVersion: string
  entryIds: readonly number[]
}
export interface InvoiceLineTimeReleaseResult {
  commandId: string
  invoiceId: number
  lineId: number
  expectedVersion: number
  hoursVersion: string
  releasedEntryIds: readonly number[]
  releasedSeconds: number
  recordedAt: string
  replayed: boolean
}
export class InvoiceTimeReleaseError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'InvoiceTimeReleaseError'
  }
}
