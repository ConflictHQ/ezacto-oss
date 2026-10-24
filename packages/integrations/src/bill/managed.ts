import {
  createBillRuntime,
  type BillMirrorSource,
  type BillRuntime,
} from './runtime.js'
import type { BillLinkStore, BillMirrorOutcome } from './mirror.js'

/**
 * A tenant-owned BILL connection composed from the same runtime a self-hosted
 * deployment uses (issue 1252). Nothing is cloned: this only decides, per call,
 * whether the tenant has a live connection, opens that tenant's own credential,
 * and hands the work to `createBillRuntime`.
 *
 * Structural types on purpose: this package depends on nothing. `@ezacto/db`
 * supplies the store and `@ezacto/core` the vault that opens the envelope.
 *
 * - The developer key is platform owned and arrives as `platformDevKey`; the
 *   tenant's company/login credential is never combined with a shared Conflict
 *   login, and there is no fallback to environment credentials.
 * - Status reads facts only: no decrypt, no login.
 * - A disabled, suspended, disconnected or erased tenant performs no provider
 *   I/O: the decision is made before any credential is opened.
 * - The session cache lives inside this one tenant composition and is dropped
 *   whenever the stored generation changes.
 * - Login and every provider call happen here, outside any database
 *   transaction; the stores only see ordinary single statements.
 */

export interface ManagedBillState {
  readonly generation: number
  readonly status: 'disconnected' | 'configured' | 'connected' | 'unavailable'
  readonly companyId: string | null
  readonly environment: 'sandbox' | 'production'
  readonly canSendFromBill: boolean
}

export interface ManagedBillRuntimeStore {
  state(): Promise<ManagedBillState>
  readSealed(): Promise<(ManagedBillState & { readonly sealed: string }) | null>
  recordHealth(generation: number, healthy: boolean, now: string): Promise<void>
}

export interface ManagedBillOpenedCredentials {
  readonly companyId: string
  readonly username: string
  readonly password: string
  readonly replyToUserId: string | null
  readonly environment: 'sandbox' | 'production'
}

export interface ManagedBillRuntimeOptions {
  /** Provider-approved platform developer key; undefined until the platform has one. */
  readonly platformDevKey: string | undefined
  readonly store: ManagedBillRuntimeStore
  readonly open: (sealed: string, generation: number) => Promise<ManagedBillOpenedCredentials>
  /** False while the capability is disabled or the tenant is suspended or closing. */
  readonly isEnabled?: () => Promise<boolean>
  readonly links: BillLinkStore
  readonly source: BillMirrorSource
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => Date
}

export interface ManagedBillStatus extends ManagedBillState {
  readonly enabled: boolean
  /** Whether the platform's own developer key is configured; tenant credentials cannot stand in for it. */
  readonly platformKeyConfigured: boolean
}

export interface ManagedBillRuntime extends Omit<BillRuntime, 'status'> {
  status(): Promise<ManagedBillStatus>
}

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim()
  return text === undefined || text === '' ? null : text
}

export const createManagedBillRuntime = (
  options: Readonly<ManagedBillRuntimeOptions>,
): ManagedBillRuntime => {
  const devKey = trimmed(options.platformDevKey)
  let cached: { generation: number; runtime: BillRuntime } | null = null
  // Counts provider answers that were not errors, so health is only ever
  // recorded from a real exchange with BILL and never from a local refusal.
  let answered = 0
  const fetch = async (request: Request): Promise<Response> => {
    const response = await options.fetch(request)
    if (response.status < 400) answered += 1
    return response
  }
  const enabled = async () => (options.isEnabled ? options.isEnabled() : true)

  const resolve = async (): Promise<{ generation: number; runtime: BillRuntime } | null> => {
    if (devKey === null || !(await enabled())) {
      cached = null
      return null
    }
    const sealed = await options.store.readSealed()
    if (sealed === null) {
      cached = null
      return null
    }
    if (cached?.generation === sealed.generation) return cached
    cached = null
    let credentials: ManagedBillOpenedCredentials
    try {
      credentials = await options.open(sealed.sealed, sealed.generation)
    } catch {
      await health(sealed.generation, false)
      return null
    }
    cached = {
      generation: sealed.generation,
      runtime: createBillRuntime({
        config: {
          devKey,
          companyId: credentials.companyId,
          username: credentials.username,
          password: credentials.password,
          replyToUserId: credentials.replyToUserId ?? undefined,
          environment: credentials.environment,
        },
        links: options.links,
        source: options.source,
        fetch,
        now: options.now,
      }),
    }
    return cached
  }

  const health = async (generation: number, healthy: boolean) => {
    try {
      await options.store.recordHealth(generation, healthy, options.now().toISOString())
    } catch {
      // Health is advisory; it never changes the outcome of the work itself.
    }
  }

  const run = async <T>(
    fallback: T,
    work: (runtime: BillRuntime) => Promise<T>,
  ): Promise<T> => {
    const live = await resolve()
    if (live === null) return fallback
    const before = answered
    try {
      const result = await work(live.runtime)
      if (answered > before) await health(live.generation, true)
      return result
    } catch (error) {
      if (answered === before) await health(live.generation, false)
      throw error
    }
  }

  return {
    status: async () => {
      const state = await options.store.state()
      return { ...state, enabled: await enabled(), platformKeyConfigured: devKey !== null }
    },
    mirror: (invoiceId: number): Promise<BillMirrorOutcome> =>
      run<BillMirrorOutcome>(
        { kind: 'refused', reason: 'BILL is not connected for this tenant' },
        (runtime) => runtime.mirror(invoiceId),
      ),
    paymentLinkForSend: (invoiceId: number) =>
      run<string | null>(null, (runtime) => runtime.paymentLinkForSend(invoiceId)),
    paymentLink: async (invoiceId: number) =>
      (await options.links.readLink('invoice', invoiceId))?.paymentLink ?? null,
    reconcilePayments: () => run(0, (runtime) => runtime.reconcilePayments()),
  }
}
