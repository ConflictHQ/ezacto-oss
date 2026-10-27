import {
  CalendarConnectionError,
  createCalendarGrantVault,
  type CalendarConnectionAuthority,
  type CalendarConnectionStore,
  type CalendarOAuthStore,
  type CalendarProvider,
} from '@ezacto/core'
import type { CalendarOAuthClient } from './oauth.js'
import type { CalendarSyncService } from '../calendar-sync.js'

const bytes = () => crypto.getRandomValues(new Uint8Array(32))
const encode = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
const hex = (value: Uint8Array) => [...value].map((b) => b.toString(16).padStart(2, '0')).join('')
const opaque = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)

export const createCalendarAuthorizationService = async (options: {
  store: CalendarOAuthStore
  connections: CalendarConnectionStore
  sync: CalendarSyncService
  clients: Readonly<Partial<Record<CalendarProvider, CalendarOAuthClient>>>
  deploymentKey: Uint8Array
  appOrigin: string
  now?: () => Date
}) => {
  const origin = new URL(options.appOrigin)
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new CalendarConnectionError('invalid')
  const vault = await createCalendarGrantVault(options.deploymentKey)
  const now = options.now ?? (() => new Date())
  const client = (provider: CalendarProvider) =>
    options.clients[provider] ??
    (() => {
      throw new CalendarConnectionError('not_configured')
    })()
  const redirectUri = (provider: CalendarProvider) =>
    `${origin.origin}/api/v1/calendar-connections/${provider}/callback`
  return {
    async manualCleanup(authority: CalendarConnectionAuthority) {
      await options.connections.authorize(authority, now().toISOString())
      return options.store.manualCleanup(authority)
    },
    async confirmManualCleanup(
      authority: CalendarConnectionAuthority,
      input: { id: string; generation: number; credentialRevision: number },
    ) {
      await options.connections.authorize(authority, now().toISOString())
      await options.store.confirmManualCleanup(authority, input, now().toISOString())
    },
    async begin(
      authority: CalendarConnectionAuthority,
      provider: CalendarProvider,
      generation: number,
      requestOrigin: string,
    ) {
      if (requestOrigin !== origin.origin || !Number.isSafeInteger(generation) || generation < 0)
        throw new CalendarConnectionError('invalid')
      await options.connections.authorize(authority, now().toISOString())
      const providerClient = client(provider),
        state = encode(bytes()),
        requester = encode(bytes())
      const challenge = encode(await digest(requester))
      await options.store.begin(
        {
          authority,
          provider,
          generation,
          instance: await options.connections.instance(),
          stateHash: hex(await digest(state)),
          requesterHash: hex(await digest(requester)),
        },
        new Date(now().getTime() + 600000).toISOString(),
      )
      return {
        requester,
        authorizationUrl: providerClient.authorizationUrl({
          state,
          challenge,
          redirectUri: redirectUri(provider),
        }),
      }
    },
    async complete(
      authority: CalendarConnectionAuthority,
      provider: CalendarProvider,
      input: {
        state: string
        requester: string
        code?: string
        denied: boolean
        requestOrigin: string
      },
    ) {
      if (input.requestOrigin !== origin.origin || !opaque(input.state) || !opaque(input.requester))
        throw new CalendarConnectionError('invalid')
      await options.connections.authorize(authority, now().toISOString())
      const providerClient = client(provider)
      const attempt = await options.store.consume(
        authority,
        provider,
        hex(await digest(input.state)),
        hex(await digest(input.requester)),
      )
      if (
        !attempt ||
        input.denied ||
        !input.code ||
        input.code.length > 4096 ||
        /\p{Cc}/u.test(input.code)
      )
        throw new CalendarConnectionError('invalid')
      await options.connections.authorize(authority, now().toISOString())
      const grant = await providerClient.exchange({
        code: input.code,
        verifier: input.requester,
        redirectUri: redirectUri(provider),
      })
      try {
        // Native session, account, generation and cleanup fences are rechecked at commit.
        await options.sync.completeOAuth(authority, provider, attempt.generation, grant)
      } catch (error) {
        // A provider may have issued a grant before logout/closure/disconnect won.
        // Keep that credential encrypted for revocation instead of abandoning it.
        const random = crypto.getRandomValues(new Uint32Array(1))[0]!
        const identity = {
          instance: attempt.instance,
          userId: authority.userId,
          provider,
          generation: attempt.generation + 1,
          credentialRevision: random + 2,
        }
        await options.store.orphan(
          attempt,
          { ...identity, keyId: vault.keyId, sealedGrant: await vault.sealGrant(grant, identity) },
          now().toISOString(),
        )
        throw error
      }
    },
    async processDue() {
      if (Object.keys(options.clients).length === 0) return
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 25000)
      try {
        const stamp = now().toISOString()
        for (const claim of await options.store.claimCleanup(
          vault.keyId,
          crypto.randomUUID(),
          stamp,
        )) {
          if (controller.signal.aborted) break
          let result: 'revoked' | 'manual_required' | 'retry' = 'retry'
          try {
            const configured = options.clients[claim.provider]
            if (configured)
              result = await configured.revoke(
                await vault.openGrant(claim.sealedGrant, claim),
                controller.signal,
              )
          } catch {
            /* The encrypted obligation survives transient provider failure. */
          }
          await options.store.finishCleanup(claim, result, now().toISOString())
        }
        for (const due of await options.store.dueConnections(stamp)) {
          if (controller.signal.aborted) break
          if (!options.clients[due.provider]) continue
          try {
            await options.sync.refreshConnected(due.userId, due.provider, controller.signal)
          } catch {
            /* Per-connection status records the bounded failure. */
          }
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
export type CalendarAuthorizationService = Awaited<
  ReturnType<typeof createCalendarAuthorizationService>
>
