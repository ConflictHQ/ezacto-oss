import {
  createDeelSyncRuntime,
  type DeelSyncClient,
  type DeelSyncRuntime,
  type DeelSyncRuntimeOptions,
} from './runtime.js'

/**
 * The tenant's own Deel credentials (#1238). The host implements this over its
 * canonical store for the one tenant the process is bound to; there is no
 * tenant argument, so a caller cannot name a different one.
 */
export interface ManagedDeelCredentialSource {
  /** Null when absent, disconnected, erased or suspended. */
  current(): Promise<{ token: string; startDate: string; generation: number } | null>
  /** The lifecycle counter now; compared with the one the runtime was built on. */
  generation(): Promise<number>
}

export type ManagedDeelSyncRuntimeOptions = Omit<DeelSyncRuntimeOptions, 'config'> & {
  credentials: ManagedDeelCredentialSource
  /** Tests substitute a fake for the Deel client. */
  client?: DeelSyncClient
  /** Overrides the Deel API base; tests point it at an owned local server. */
  baseUrl?: string
}

const absent = { configured: false, reason: 'no Deel connection is configured' } as const

/**
 * A `DeelSyncRuntime` over the tenant's stored connection. Credentials are read
 * on every call, never cached: after a disconnect, erase or suspension the next
 * call is `unconfigured` and no request leaves the process. A run that began
 * before such a change stops before its next timesheet. The planner, intents,
 * busy/stale rules and reconciliation are the existing runtime's.
 */
export const createManagedDeelSyncRuntime = (
  options: ManagedDeelSyncRuntimeOptions,
): DeelSyncRuntime => {
  const { credentials, client, baseUrl, ...rest } = options
  const bind = async (): Promise<DeelSyncRuntime | null> => {
    const current = await credentials.current()
    if (current === null) return null
    return createDeelSyncRuntime({
      ...rest,
      config: {
        token: current.token,
        startDate: current.startDate,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      },
      ...(client === undefined ? {} : { client }),
      lifecycleCurrent: async () => (await credentials.generation()) === current.generation,
    })
  }
  const unconfigured = { status: 'unconfigured', reason: absent.reason } as const
  return {
    status: async () => (await bind())?.status() ?? absent,
    preview: async (window) => (await (await bind())?.preview(window)) ?? unconfigured,
    run: async (request) => (await (await bind())?.run(request)) ?? unconfigured,
    runAutomaticIfDue: async () => (await (await bind())?.runAutomaticIfDue()) ?? unconfigured,
    reconcile: async () => (await (await bind())?.reconcile()) ?? unconfigured,
  }
}
