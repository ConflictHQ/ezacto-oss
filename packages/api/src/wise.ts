/**
 * Connecting a contractor's own Wise account (#543), as they meet it: a button
 * that starts an authorization, the callback it comes back to, a status to
 * render, and a way to disconnect.
 *
 * The whole shape of this differs from QuickBooks in one way that decides every
 * authorization rule below. A QuickBooks connection is a grant over the
 * organisation's books, so only an administrator may make one. This is a grant
 * over a *person's own bank*, so only that person may make one -- an
 * administrator connecting somebody else's Wise is the exact thing doing it by
 * OAuth exists to prevent, and the issue says so: the payout method belongs to
 * the person, not to the organisation.
 *
 * Which means there is no route here that acts on another user's behalf, not
 * even for an administrator. Seeing who is connected is a different question,
 * and `/payout-accounts` already answers it.
 *
 * Every dependency is injected. This module knows the shape of the handshake
 * and nothing about where tokens live or how to reach Wise.
 */

import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

export interface WiseConnectionStatus {
  /** Wise's own identifier for the profile that authorised. */
  profileId: string
  profileType: 'personal' | 'business'
  environment: 'sandbox' | 'live'
  grantedAt: string
  /**
   * Whether a payout has something to resolve to. A grant without a linked
   * payout account is a connection that cannot be paid through, and saying so
   * is the difference between the "visible, handled state" the issue asks for
   * and a silent skip on payday.
   */
  payable: boolean
}

/**
 * Why a connection attempt did not produce a grant.
 *
 * Each sends the person somewhere different, which is the only reason to tell
 * them apart: their own stale connection is theirs to replace, somebody else's
 * is not, and a refused exchange is neither.
 */
export type WiseConnectRefusal =
  | 'state_unknown'
  | 'state_expired'
  | 'already_connected'
  | 'profile_taken'
  | 'no_profile'
  | 'exchange_failed'

export type WiseConnectOutcome =
  | { outcome: 'connected'; status: WiseConnectionStatus }
  | { outcome: WiseConnectRefusal }

export interface WiseService {
  clientId(): string | null
  callbackUrl(): string | null
  /** Where the person lands after connecting; a page, not an API route. */
  settingsUrl(): string
  authorizeUrl(input: { state: string; redirectUri: string }): string
  beginAuthorization(input: {
    state: string
    userId: number
    redirectUri: string
  }): Promise<void>
  /**
   * Everything the callback does, in one call: claim the state, exchange the
   * code, read back who authorised, record the grant, and link the payout
   * account. It is one method because it is one transaction's worth of meaning
   * -- a grant recorded without its payout account is a credential for an
   * account nothing will ever pay into.
   */
  completeAuthorization(input: { state: string; code: string }): Promise<WiseConnectOutcome>
  readStatus(userId: number): Promise<WiseConnectionStatus | null>
  disconnect(userId: number): Promise<boolean>
  newState(): string
}

const requireUser = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
): { userId: number } => ({ userId: requireSessionPrincipal(context).userId })

const requireConfigured = (service: Readonly<WiseService>): { callbackUrl: string } => {
  const clientId = service.clientId()
  const callbackUrl = service.callbackUrl()
  if (clientId === null || callbackUrl === null) {
    throw new ApiError({
      status: 503,
      code: 'service_unavailable',
      message:
        'Wise is not configured for this deployment. A Wise client id and callback URL are required.',
    })
  }
  return { callbackUrl }
}

const serialize = (status: WiseConnectionStatus) => ({
  profile_id: status.profileId,
  profile_type: status.profileType,
  environment: status.environment,
  granted_at: status.grantedAt,
  payable: status.payable,
})

export const installWiseRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<WiseService>,
): void => {
  api.get('/integrations/wise', async (context) => {
    const { userId } = requireUser(context)
    const status = await service.readStatus(userId)
    return context.json(
      {
        data: {
          configured: service.clientId() !== null && service.callbackUrl() !== null,
          connection: status === null ? null : serialize(status),
        },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  // The button. Answers with the URL rather than redirecting, so the shell can
  // send the person there itself and a caller can see where it is being sent
  // before following.
  api.post('/integrations/wise/authorize', async (context) => {
    const { userId } = requireUser(context)
    const { callbackUrl } = requireConfigured(service)
    const state = service.newState()
    await service.beginAuthorization({ state, userId, redirectUri: callbackUrl })
    return context.json(
      { data: { authorize_url: service.authorizeUrl({ state, redirectUri: callbackUrl }) } },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /**
   * Where Wise sends the person back.
   *
   * Not JSON: a browser lands here, so it redirects to the settings page either
   * way and the page says what happened. Deliberately not authenticated -- the
   * state is the authorization, and it names whose grant this is. Requiring a
   * session here as well would refuse a person who authorised in a browser that
   * did not carry their cookie, and would still not make the flow any safer,
   * because a state nobody issued is refused regardless of who is logged in.
   */
  api.get('/integrations/wise/callback', async (context) => {
    const url = new URL(context.req.url)
    const settings = service.settingsUrl()
    const error = url.searchParams.get('error')
    if (error !== null) {
      // The person pressed Cancel, or Wise refused. Neither is our failure.
      return context.redirect(`${settings}?wise=${encodeURIComponent(error)}`, 302)
    }
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (state === null || code === null) {
      return context.redirect(`${settings}?wise=invalid_callback`, 302)
    }
    let result: WiseConnectOutcome
    try {
      result = await service.completeAuthorization({ state, code })
    } catch {
      // Wise was unreachable or answered with something we could not read. The
      // state is already spent either way, which is what the schema wants: a
      // callback that failed halfway is not one to replay.
      result = { outcome: 'exchange_failed' }
    }
    return context.redirect(
      `${settings}?wise=${result.outcome === 'connected' ? 'connected' : result.outcome}`,
      302,
    )
  })

  /**
   * Disconnecting, which is the person's own to do and nobody else's.
   *
   * This revokes the grant. It deliberately does not detach the payout account:
   * that is the record of where money went, detaching is final, and a person
   * reconnecting the same Wise profile next week should not have to be relinked
   * by an administrator to be paid again.
   */
  api.delete('/integrations/wise', async (context) => {
    const { userId } = requireUser(context)
    const removed = await service.disconnect(userId)
    if (!removed) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist.',
      })
    }
    return context.body(null, 204)
  })
}
