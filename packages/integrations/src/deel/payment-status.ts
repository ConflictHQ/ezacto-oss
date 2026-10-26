import type { DeelStageAuthority } from '@ezacto/core'
import { DeelApiError, DeelClient, type DeelTimesheetStatusReceipt } from './client.js'

export interface DeelPaymentStatusClaim {
  timesheetId: string
  contractIds: readonly string[]
  spentDate: string | null
  seconds: number
  leaseId: string
}
export interface DeelPaymentStatusStore {
  claim(
    month: string | null,
    now: string,
    authority?: DeelStageAuthority,
  ): Promise<readonly DeelPaymentStatusClaim[]>
  complete(
    claim: DeelPaymentStatusClaim,
    outcome: { status: DeelTimesheetStatusReceipt['status'] } | { error: string },
    now: string,
    authority?: DeelStageAuthority,
  ): Promise<void>
  remaining(month: string | null, now: string, authority?: DeelStageAuthority): Promise<number>
}
export interface DeelPaymentStatusResult {
  configured: boolean
  checked: number
  failed: number
  remaining: number
}
export interface DeelPaymentStatusRuntime {
  refresh(month: string | null, authority?: DeelStageAuthority): Promise<DeelPaymentStatusResult>
}
/** Reconcile provider facts only. This never creates a timesheet or writes a payment ledger entry. */
export const createDeelPaymentStatusRuntime = (options: {
  token?: string | undefined
  store: DeelPaymentStatusStore
  fetch: (request: Request) => Promise<Response>
  now: () => Date
  client?: Pick<DeelClient, 'getTimesheet'>
}): DeelPaymentStatusRuntime => {
  const client = options.token?.trim()
    ? (options.client ??
      new DeelClient({
        token: options.token,
        fetch: (request) =>
          options.fetch(new Request(request, { signal: AbortSignal.timeout(8000) })),
      }))
    : null
  return {
    refresh: async (month, authority) => {
      if (!client) return { configured: false, checked: 0, failed: 0, remaining: 0 }
      const claims = await options.store.claim(month, options.now().toISOString(), authority)
      let checked = 0,
        failed = 0
      for (let offset = 0; offset < claims.length; offset += 5) {
        await Promise.all(
          claims.slice(offset, offset + 5).map(async (claim) => {
            let outcome: { status: DeelTimesheetStatusReceipt['status'] } | { error: string }
            try {
              const receipt = await client.getTimesheet(claim.timesheetId)
              if (
                receipt.timesheetId !== claim.timesheetId ||
                claim.contractIds.length !== 1 ||
                receipt.contractId !== claim.contractIds[0]
              )
                outcome = { error: 'contract_mismatch' }
              else if (
                receipt.spentDate !== claim.spentDate ||
                receipt.quantity === null ||
                !Number.isSafeInteger(claim.seconds) ||
                Math.abs(receipt.quantity * 3600 - claim.seconds) > 0.201
              )
                outcome = { error: 'source_mismatch' }
              else if (receipt.status === 'unknown') outcome = { error: 'unknown_status' }
              else outcome = { status: receipt.status }
            } catch (error) {
              outcome = { error: error instanceof DeelApiError && [401, 403].includes(error.status)
                ? 'permission_denied'
                : error instanceof DeelApiError && error.status === 404
                  ? 'timesheet_missing'
                  : error instanceof DeelApiError && error.status === 429
                    ? 'rate_limited'
                    : 'provider_unavailable' }
            }
            await options.store.complete(claim, outcome, options.now().toISOString(), authority)
            if ('error' in outcome) failed++
            else checked++
          }),
        )
      }
      return {
        configured: true,
        checked,
        failed,
        remaining: await options.store.remaining(month, options.now().toISOString(), authority),
      }
    },
  }
}
