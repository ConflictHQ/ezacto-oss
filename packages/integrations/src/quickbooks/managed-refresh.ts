import type { QuickBooksTokens } from './oauth.js'

export type QuickBooksAuthorizationState = 'ready' | 'pending' | 'unavailable'
export interface QuickBooksRefreshSnapshot extends QuickBooksTokens {
  readonly realmId: string
  readonly connectedAt: string
  /** Canonical native readers supply this; managed stores refuse its absence. */
  readonly connectionGeneration?: number
}

/** Each operation must commit independently of any replayable application work.
 * An attempting/unknown owner never expires into permission to refresh again.
 */
export interface ManagedQuickBooksRefreshStore {
  status(): Promise<QuickBooksAuthorizationState>
  claim(input: { attemptId: string; connection: QuickBooksRefreshSnapshot; now: string }): Promise<boolean>
  unknown(input: { attemptId: string; now: string }): Promise<void>
  /** Only the current owner may use this before invoking exchange at all. */
  cancelBeforeExchange(input: { attemptId: string; now: string }): Promise<void>
  finish(input: { attemptId: string; tokens: QuickBooksTokens; now: string }): Promise<'completed' | 'orphaned' | 'unavailable'>
}

export class ManagedQuickBooksRefreshUnavailableError extends Error {
  readonly code = 'provider_unavailable'
  constructor() { super('QuickBooks authorization requires recovery'); this.name = 'ManagedQuickBooksRefreshUnavailableError' }
}

export interface ManagedQuickBooksRefresh {
  status(): Promise<QuickBooksAuthorizationState>
  refresh(connection: QuickBooksRefreshSnapshot, exchange: (attemptId: string) => Promise<QuickBooksTokens>): Promise<QuickBooksTokens>
}

/** Provider transport runs only after the durable owner is committed. No retry
 * of the exchange is made, including after a timeout, lost reply or restart.
 * A returned replacement that lost its connection is retained by finish for
 * explicit provider cleanup instead of overwriting another connection.
 */
export const createManagedQuickBooksRefresh = (input: {
  readonly store: ManagedQuickBooksRefreshStore
  /** Bound to the host's admitted effect lifetime, current tenant incarnation
   * and grant generation. A deployment/entitlement flag alone is insufficient.
   */
  readonly admitted: () => boolean | Promise<boolean>
  readonly now: () => Date
  readonly newAttemptId?: () => string
}): ManagedQuickBooksRefresh => {
  const unavailable = (): never => { throw new ManagedQuickBooksRefreshUnavailableError() }
  const admitted = async (): Promise<boolean> => { try { return await input.admitted() } catch { return false } }
  return {
    status: async () => {
      try { return await admitted() ? await input.store.status() : 'unavailable' } catch { return 'unavailable' }
    },
    refresh: async (connection, exchange) => {
      if (!(await admitted())) return unavailable()
      const attemptId = (input.newAttemptId ?? (() => crypto.randomUUID()))()
      let owned: boolean
      try { owned = await input.store.claim({ attemptId, connection, now: input.now().toISOString() }) }
      catch {
        // This process has not called exchange. Cancellation is fenced to its
        // own nonce, including when the claim committed but its reply was lost.
        try { await input.store.cancelBeforeExchange({ attemptId, now: input.now().toISOString() }) } catch { /* retain owner */ }
        return unavailable()
      }
      if (!owned) return unavailable()
      if (!(await admitted())) {
        try { await input.store.cancelBeforeExchange({ attemptId, now: input.now().toISOString() }) } catch { /* retain owner */ }
        return unavailable()
      }
      let tokens: QuickBooksTokens
      try {
        const received = await exchange(attemptId)
        tokens = { accessToken: received.accessToken, refreshToken: received.refreshToken,
          accessTokenExpiresAt: received.accessTokenExpiresAt, refreshTokenExpiresAt: received.refreshTokenExpiresAt }
      } catch {
        // A failed disposition still leaves a durable attempting owner. Neither
        // state authorizes a second exchange; no provider details escape here.
        try { await input.store.unknown({ attemptId, now: input.now().toISOString() }) } catch { /* retain owner */ }
        return unavailable()
      }
      let result: Awaited<ReturnType<ManagedQuickBooksRefreshStore['finish']>>
      try { result = await input.store.finish({ attemptId, tokens, now: input.now().toISOString() }) }
      catch { return unavailable() }
      if (result !== 'completed' || !(await admitted())) return unavailable()
      return tokens
    },
  }
}
