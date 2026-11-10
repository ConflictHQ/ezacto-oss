import { ManagedWiseUnavailableError } from '@ezacto/core'
import type {
  ManagedWiseConnectionStore,
  ManagedWiseVault,
  ManagedWiseConnectionState,
} from '@ezacto/core'
import {
  createWiseRuntime,
  WiseReadOnlyError,
  type WiseRuntime,
  type WiseRuntimeOptions,
  type WiseConnectionStatus,
} from './runtime.js'

export interface ManagedWiseRuntimeOptions {
  store: ManagedWiseConnectionStore
  open: ManagedWiseVault['open']
  accounts: Pick<
    WiseRuntimeOptions['accounts'],
    'listForUser' | 'listForProvider' | 'awaitingDestination'
  >
  /** Trusted tenant/incarnation availability, including suspension and erasure. */
  isEnabled(): boolean
  /** Fresh host admission before and after each provider exchange. No SQL transaction may enclose the exchange. */
  assertAdmission(): Promise<void>
  fetch?: typeof fetch
  now(): Date
}

/** Existing native read-only Wise service with tenant-owned, generation-bound
 * custody. No environment token, payment provider, webhook or token cache.
 * Every read reconstructs the native service after current custody/admission.
 */
export const createManagedWiseRuntime = async (
  options: ManagedWiseRuntimeOptions,
): Promise<{
  service: WiseRuntime['service']
  status(): Promise<ManagedWiseConnectionState & { enabled: boolean; canExecute: false }>
}> => {
  let configured = options.isEnabled() && (await options.store.state()).status !== 'disconnected'
  const unavailable = (): never => {
    throw new ManagedWiseUnavailableError()
  }
  const admit = async () => {
    try {
      await options.assertAdmission()
    } catch {
      return unavailable()
    }
  }
  const read = async <T>(
    work: (service: WiseRuntime['service'], status: WiseConnectionStatus) => Promise<T>,
    absent: T,
  ): Promise<T> => {
    if (!options.isEnabled()) {
      configured = false
      return absent
    }
    await admit()
    const connection = await options.store.readSealed()
    configured = connection !== null
    if (connection === null) return absent
    const current = async () => {
      if (!options.isEnabled()) return unavailable()
      await admit()
      const state = await options.store.state()
      if (
        state.status === 'disconnected' ||
        state.generation !== connection.generation ||
        state.profileId !== connection.profileId
      )
        return unavailable()
    }
    try {
      const credentials = await options.open(connection.sealed, connection.generation)
      if (credentials.profileId !== connection.profileId)
        throw new Error('Wise credential binding changed')
      const runtime = createWiseRuntime({
        mode: 'read_only',
        config: {
          token: credentials.token,
          profileId: credentials.profileId,
          webhookPublicKey: undefined,
        },
        accounts: { ...options.accounts, link: denied, markVerified: denied, detach: denied },
        now: options.now,
        fetch: async (input, init) => {
          await current()
          const request = new Request(input, init)
          // The existing service owns the parser. This last boundary makes an
          // accidental future write impossible in the managed read capability.
          if (request.method !== 'GET' || request.headers.has('content-type')) return unavailable()
          const response = await (options.fetch ?? fetch)(request)
          await current()
          return response
        },
      })
      const verified = await runtime.service.readStatus()
      if (verified === null) throw new Error('Wise profile is unavailable')
      const result = await work(runtime.service, verified)
      await current()
      await options.store.recordHealth(connection.generation, true, options.now().toISOString())
      return result
    } catch (error) {
      if (!(error instanceof ManagedWiseUnavailableError)) {
        try {
          await options.store.recordHealth(
            connection.generation,
            false,
            options.now().toISOString(),
          )
        } catch {
          /* Remains unconfirmed; never return provider data on storage failure. */
        }
      }
      return unavailable()
    }
  }
  // Denials are a supported capability boundary, not unimplemented write paths.
  const denied = async (): Promise<never> => {
    throw new WiseReadOnlyError()
  }
  return {
    status: async () => ({
      ...(await options.store.state()),
      enabled: options.isEnabled(),
      canExecute: false,
    }),
    service: {
      configured: () => options.isEnabled() && configured,
      writable: () => false,
      readStatus: () => read(async (_service, status) => status, null),
      listRecipients: () => read((service) => service.listRecipients(), []),
      proposeDestinations: () => read((service) => service.proposeDestinations(), []),
      readDestination: (userId) => read((service) => service.readDestination(userId), null),
      linkRecipient: denied,
      onboardRecipient: denied,
      shareWiseProfile: denied,
      detachFor: denied,
      unlink: denied,
    },
  }
}
