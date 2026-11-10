import type { QuickBooksRuntime } from '@ezacto/integrations'
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
