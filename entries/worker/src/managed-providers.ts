import type { QuickBooksRuntime, ManagedWiseRuntime, ManagedBillRuntime, DeelSyncRuntime } from '@ezacto/integrations'
import { moduleAvailability } from '@ezacto/api'
import { demoDeployment, type AppEnv } from './app.js'

/** Trusted process capability, never a WorkerEnv binding or request value.
 * The host must keep rotating-token/provider effects outside replayable SQL,
 * with durable ownership and recovery. Composition itself performs no I/O.
 */
export interface WorkerManagedQuickBooks {
  /** Side-effect-free app/entitlement availability, including suspension.
   * Scope is the original tenant binding's identity, for trusted WeakMap lookup;
   * its SQL interface is deliberately not part of the composition contract.
   */
  configured(scope: object): boolean
  compose(input: {
    readonly scope: object
    /** The native idempotency-aware database for this invocation. */
    readonly database: D1Database
  }): Promise<QuickBooksRuntime | null>
}

export const managedQuickBooksAvailable = (
  port: WorkerManagedQuickBooks, env: AppEnv, scope: object | undefined,
): boolean => scope !== undefined && !demoDeployment(env) &&
  moduleAvailability(env).accounting && port.configured(scope) === true

/** Managed Wise is a read capability. The factory cannot return a payment
 * provider or webhook and must not perform provider I/O while composing. */
export interface WorkerManagedWise {
  configured(scope: object): boolean
  compose(input: { readonly scope: object; readonly database: D1Database }): Promise<ManagedWiseRuntime | null>
}
export const managedWiseAvailable = (
  port: WorkerManagedWise, env: AppEnv, scope: object | undefined,
): boolean => scope !== undefined && !demoDeployment(env) &&
  moduleAvailability(env).accounting && port.configured(scope) === true

/** Tenant-owned BILL custody over the existing mirror/reconciliation engine.
 * Provider login/effects must stay outside replayable host SQL transactions.
 */
export interface WorkerManagedBill {
  configured(scope: object): boolean
  compose(input: { readonly scope: object; readonly database: D1Database }): Promise<ManagedBillRuntime | null>
}
export const managedBillAvailable = (
  port: WorkerManagedBill, env: AppEnv, scope: object | undefined,
): boolean => scope !== undefined && !demoDeployment(env) &&
  moduleAvailability(env).accounting && port.configured(scope) === true

/** Tenant-owned time sync only. The existing engine owns preview, exact-entry
 * confirmation, durable transfer intents and lifecycle checks. The host must
 * commit those intents outside replayable request transactions before sending.
 * No payment-status/staging or payout capability is supplied by this port.
 */
export interface WorkerManagedDeel {
  configured(scope: object): boolean
  compose(input: {
    readonly scope: object
    readonly database: D1Database
  }): Promise<DeelSyncRuntime | null>
}

export const managedDeelAvailable = (
  port: WorkerManagedDeel, env: AppEnv, scope: object | undefined,
): boolean => scope !== undefined && !demoDeployment(env) &&
  moduleAvailability(env).accounting && port.configured(scope) === true
