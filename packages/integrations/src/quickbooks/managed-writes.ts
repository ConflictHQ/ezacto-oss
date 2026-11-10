/** Durable financial write intent. This is separate from token refresh:
 * accounting writes have Intuit's company-scoped requestid replay contract;
 * a rotating OAuth token does not.
 */
export type QuickBooksWriteResource = 'customer' | 'invoice' | 'payment'
export interface QuickBooksWriteSource {
  readonly resource: QuickBooksWriteResource
  readonly nativeId: number
  readonly invoiceId: number
  /** Required by managed native stores; optional only for legacy mirror ports. */
  readonly invoiceVersion?: number | undefined
  /** Current approved native document/customer/payment snapshot, not a clock. */
  readonly sourceHash: string
}
export interface QuickBooksWriteIntent extends QuickBooksWriteSource {
  readonly operation: 'create' | 'update'
}
export interface QuickBooksWriteConnection {
  readonly realmId: string
  readonly connectedAt: string
  readonly connectionGeneration: number
}
export interface QuickBooksStoredWrite {
  readonly path: '/customer' | '/invoice' | '/payment'
  readonly minorVersion: string
  readonly body: string
}
export interface QuickBooksKnownLink {
  readonly quickBooksId: string
  readonly syncToken: string
}
export type QuickBooksWritePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending' | 'unavailable' }
  | { readonly kind: 'completed'; readonly response: string }
  | { readonly kind: 'owned'; readonly effectId: string; readonly requestId: string; readonly request: QuickBooksStoredWrite }

/** Operations commit independently of replayable host/application work. Request
 * and response bodies may be chunked; only a sealed, verified request can begin
 * transport. Headers and credentials are never part of stored financial intent.
 */
export interface QuickBooksPendingWrite { readonly resource: QuickBooksWriteResource; readonly nativeId: number; readonly invoiceId: number }
export interface ManagedQuickBooksWriteStore {
  prepare(input: {
    connection: QuickBooksWriteConnection; intent: QuickBooksWriteIntent; request: QuickBooksStoredWrite
    effectId: string; ownerId: string; now: string; leaseUntil: string
  }): Promise<QuickBooksWritePlan>
  resume(input: {
    connection: QuickBooksWriteConnection; source: QuickBooksWriteSource; ownerId: string; now: string; leaseUntil: string
  }): Promise<QuickBooksWritePlan>
  begin(input: { effectId: string; ownerId: string; now: string }): Promise<boolean>
  /** Only the caller's nonce, and only before it has invoked transport. */
  releaseBeforeTransport(input: { ownerId: string; now: string }): Promise<void>
  unknown(input: { effectId: string; ownerId: string; now: string }): Promise<void>
  complete(input: { effectId: string; ownerId: string; response: string; now: string }): Promise<string | null>
  knownCreatedLink(input: { connection: QuickBooksWriteConnection; resource: QuickBooksWriteResource; nativeId: number }): Promise<QuickBooksKnownLink | null>
  pendingWrites(input: { connection: QuickBooksWriteConnection; limit: number; now: string }): Promise<readonly QuickBooksPendingWrite[]>
  status(): Promise<'ready' | 'pending' | 'unavailable'>
}

export class ManagedQuickBooksWriteUnavailableError extends Error {
  readonly code = 'provider_unavailable'
  constructor() { super('QuickBooks accounting write is pending or requires recovery'); this.name = 'ManagedQuickBooksWriteUnavailableError' }
}

export type QuickBooksWriteTransport = (input: QuickBooksStoredWrite & { readonly requestId: string }) => Promise<Record<string, unknown>>
export interface ManagedQuickBooksWriteSession {
  execute(intent: QuickBooksWriteIntent, request: QuickBooksStoredWrite, transport: QuickBooksWriteTransport): Promise<Record<string, unknown>>
  recover(source: QuickBooksWriteSource, transport: QuickBooksWriteTransport): Promise<void>
  knownCreatedLink(resource: QuickBooksWriteResource, nativeId: number): Promise<QuickBooksKnownLink | null>
}
export interface ManagedQuickBooksWrites {
  session(connection: QuickBooksWriteConnection): ManagedQuickBooksWriteSession
  status(): Promise<'ready' | 'pending' | 'unavailable'>
  pendingWrites(connection: QuickBooksWriteConnection, limit: number): Promise<readonly QuickBooksPendingWrite[]>
}

export const quickBooksWriteSourceHash = async (value: unknown): Promise<string> => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export const createManagedQuickBooksWrites = (input: {
  readonly store: ManagedQuickBooksWriteStore
  /** The actual admitted host effect lifetime, incarnation and grant fence. */
  readonly admitted: (connection: QuickBooksWriteConnection) => boolean | Promise<boolean>
  readonly now: () => Date
}): ManagedQuickBooksWrites => {
  const id = () => crypto.randomUUID()
  const unavailable = (): never => { throw new ManagedQuickBooksWriteUnavailableError() }
  const admitted = async (connection: QuickBooksWriteConnection): Promise<boolean> => {
    try { return await input.admitted(connection) } catch { return false }
  }
  const json = (body: string): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(body)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
    } catch { /* static refusal, never a financial body in an exception */ }
    return unavailable()
  }
  return {
    status: async () => { try { return await input.store.status() } catch { return 'unavailable' } },
    pendingWrites: async (connection, limit) => {
      if (!(await admitted(connection))) return []
      try { return await input.store.pendingWrites({ connection, limit, now: input.now().toISOString() }) } catch { return unavailable() }
    },
    session: connection => {
      const run = async (ownerId: string, makePlan: () => Promise<QuickBooksWritePlan>, transport: QuickBooksWriteTransport): Promise<Record<string, unknown> | null> => {
        if (!(await admitted(connection))) return unavailable()
        let plan: QuickBooksWritePlan
        try { plan = await makePlan() } catch {
          try { await input.store.releaseBeforeTransport({ ownerId, now: input.now().toISOString() }) } catch { /* retain ownership */ }
          return unavailable()
        }
        if (plan.kind === 'none') return null
        if (plan.kind === 'completed') {
          if (!(await admitted(connection))) return unavailable()
          return json(plan.response)
        }
        if (plan.kind !== 'owned') return unavailable()
        let begun: boolean
        try {
          if (!(await admitted(connection))) throw new ManagedQuickBooksWriteUnavailableError()
          begun = await input.store.begin({ effectId: plan.effectId, ownerId, now: input.now().toISOString() })
        } catch {
          try { await input.store.releaseBeforeTransport({ ownerId, now: input.now().toISOString() }) } catch { /* retain ownership */ }
          return unavailable()
        }
        if (!begun || !(await admitted(connection))) {
          try { await input.store.releaseBeforeTransport({ ownerId, now: input.now().toISOString() }) } catch { /* retain the unsent intent */ }
          return unavailable()
        }
        let response: Record<string, unknown>
        try { response = await transport({ ...plan.request, requestId: plan.requestId }) }
        catch {
          try { await input.store.unknown({ effectId: plan.effectId, ownerId, now: input.now().toISOString() }) } catch { /* retain owner */ }
          return unavailable()
        }
        let completed: string | null
        try { completed = await input.store.complete({ effectId: plan.effectId, ownerId, response: JSON.stringify(response), now: input.now().toISOString() }) }
        catch { return unavailable() }
        if (completed === null || !(await admitted(connection))) return unavailable()
        return json(completed)
      }
      return {
        execute: async (intent, request, transport) => {
          const ownerId = id(), now = input.now()
          const result = await run(ownerId, () => input.store.prepare({ connection, intent, request, effectId: id(), ownerId,
            now: now.toISOString(), leaseUntil: new Date(now.getTime() + 30_000).toISOString() }), transport)
          return result ?? unavailable()
        },
        recover: async (source, transport) => {
          const ownerId = id(), now = input.now()
          await run(ownerId, () => input.store.resume({ connection, source, ownerId, now: now.toISOString(),
            leaseUntil: new Date(now.getTime() + 30_000).toISOString() }), transport)
        },
        knownCreatedLink: async (resource, nativeId) => {
          if (!(await admitted(connection))) return unavailable()
          try { return await input.store.knownCreatedLink({ connection, resource, nativeId }) } catch { return unavailable() }
        },
      }
    },
  }
}
