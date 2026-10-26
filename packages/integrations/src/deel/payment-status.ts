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
  acquireRefresh(now: string, authority?: DeelStageAuthority): Promise<{ leaseId: string | null; retryAfterMs: number }>
  touchRefresh(leaseId: string, now: string, authority?: DeelStageAuthority): Promise<boolean>
  releaseRefresh(leaseId: string, cooldownMs: number, now: string): Promise<void>
  releaseClaims(claims: readonly DeelPaymentStatusClaim[]): Promise<void>
  claim(month: string | null, now: string, authority?: DeelStageAuthority): Promise<readonly DeelPaymentStatusClaim[]>
  complete(claim: DeelPaymentStatusClaim, outcome: { status: DeelTimesheetStatusReceipt['status'] } | { error: string }, now: string, authority?: DeelStageAuthority): Promise<void>
  remaining(month: string | null, now: string, authority?: DeelStageAuthority): Promise<number>
}
export interface DeelPaymentStatusResult {
  configured: boolean
  checked: number
  failed: number
  remaining: number
  retry_after_ms: number
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
  sleep?: (milliseconds: number) => Promise<void>
}): DeelPaymentStatusRuntime => {
  const client = options.token?.trim()
    ? (options.client ??
      new DeelClient({
        token: options.token,
        fetch: (request) =>
          options.fetch(new Request(request, { signal: AbortSignal.timeout(5000) })),
      }))
    : null
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  return {
    refresh: async (month, authority) => {
      if (!client) return { configured: false, checked: 0, failed: 0, remaining: 0, retry_after_ms: 0 }
      const lease = await options.store.acquireRefresh(options.now().toISOString(), authority)
      if (lease.leaseId === null) return { configured: true, checked: 0, failed: 0, remaining: 0, retry_after_ms: lease.retryAfterMs }
      let checked = 0, failed = 0, cooldownMs = 500, completed = 0
      let claims: readonly DeelPaymentStatusClaim[] = []
      try {
        claims = await options.store.claim(month, options.now().toISOString(), authority)
        for (const claim of claims) {
          if (completed > 0) await sleep(500)
          if (!(await options.store.touchRefresh(lease.leaseId, options.now().toISOString(), authority))) break
          let outcome: { status: DeelTimesheetStatusReceipt['status'] } | { error: string }
          let rateLimited = false
          try {
            const receipt = await client.getTimesheet(claim.timesheetId)
            if (receipt.timesheetId !== claim.timesheetId || claim.contractIds.length !== 1 || receipt.contractId !== claim.contractIds[0])
              outcome = { error: 'contract_mismatch' }
            else if (receipt.spentDate !== claim.spentDate || receipt.quantity === null || !Number.isSafeInteger(claim.seconds) || Math.abs(receipt.quantity * 3600 - claim.seconds) > 0.201)
              outcome = { error: 'source_mismatch' }
            else if (receipt.status === 'unknown') outcome = { error: 'unknown_status' }
            else outcome = { status: receipt.status }
          } catch (error) {
            rateLimited = error instanceof DeelApiError && error.status === 429
            if (error instanceof DeelApiError && rateLimited) {
              const header = error.retryAfter?.trim(), seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : NaN
              const delay = Number.isFinite(seconds) ? seconds : header ? Date.parse(header) - options.now().getTime() : NaN
              const roundedDelay = Math.ceil(delay), deadline = options.now().getTime() + roundedDelay
              cooldownMs = Number.isFinite(delay) && Number.isFinite(deadline) && deadline <= 253402300799999
                ? Math.max(1000, roundedDelay) : 60000
            }
            outcome = { error: error instanceof DeelApiError && [401, 403].includes(error.status) ? 'permission_denied'
              : error instanceof DeelApiError && error.status === 404 ? 'timesheet_missing'
                : rateLimited ? 'rate_limited' : 'provider_unavailable' }
          }
          await options.store.complete(claim, outcome, options.now().toISOString(), authority)
          completed++
          if ('error' in outcome) failed++
          else checked++
          if (rateLimited) break
        }
        return { configured: true, checked, failed,
          remaining: await options.store.remaining(month, options.now().toISOString(), authority) + claims.length - completed, retry_after_ms: cooldownMs }
      } finally {
        // Unsent claims become immediately eligible after the shared cooldown.
        // Do not create a per-item delay merely because another item hit429.
        try {
          // Persist the provider's cooldown even if releasing a per-item claim fails.
          await options.store.releaseRefresh(lease.leaseId, cooldownMs, options.now().toISOString())
        } finally {
          await options.store.releaseClaims(claims.slice(completed))
        }
      }
    },
  }
}
