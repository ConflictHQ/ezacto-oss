import type { Context, Hono } from 'hono'
import type { ApiContext } from './context.js'
import {
  APPLE_ISSUER,
  APPLE_PROVIDER_KEY,
  createAppleIdentityTokenVerifier,
  type AppleIdentityResolver,
  type AppleIdentityTokenVerifier,
  type AppleSessionIssuer,
} from './apple.js'
import { readLimitedBody } from './errors.js'
import type { OidcTransactionStorePort } from './oidc.js'
import type { SignInMethodPolicy } from './sign-in-methods.js'

export const APPLE_WEB_START_PATH = '/auth/apple/start'
export const APPLE_WEB_CALLBACK_PATH = '/auth/apple/callback'
export const APPLE_WEB_STATE_COOKIE = '__Host-ezacto_apple_state'
const TRANSACTION_PROVIDER = 'apple-web'
const TTL_MS = 5 * 60 * 1000
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_BODY_BYTES = 32 * 1024

export interface AppleWebProviderConfig {
  servicesId: string
  redirectOrigin: string
}

/**
 * A grant is already held durably by the lifecycle service when exchange
 * returns. These operations never expose Apple refresh tokens to this module.
 * bindUser commits encrypted server-held capability custody for account closure.
 * bindBrowser creates a distinct opaque browser capability, never a mapping to
 * the public demo member. Native receipts cannot satisfy either web operation.
 * Unbound grants remain in durable service custody and recover through reauth;
 * sign-in errors never implicitly revoke a grouped Apple authorization.
 */
export interface AppleWebGrant {
  subject: string
  bindUser(userId: number): Promise<{ setCookie: string }>
  bindBrowser(): Promise<{ setCookie: string }>
}

export interface AppleWebLifecyclePort {
  challenge(input: {
    servicesId: string
    instanceOrigin: string
    redirectUri: string
    demo: boolean
    purpose: 'sign-in' | 'disconnect'
    requestId?: string
  }): Promise<{ challengeId: string; nonce: string; expiresAt: string }>
  exchange(input: {
    servicesId: string
    instanceOrigin: string
    redirectUri: string
    challengeId: string
    authorizationCode: string
    identityToken: string
    nonce: string
    demo: boolean
    purpose: 'sign-in' | 'disconnect'
  }): Promise<AppleWebGrant>
  connected(request: Request): Promise<boolean>
  /** Resolve only after Apple revocation succeeds; never on queue acceptance. */
  disconnect(request: Request): Promise<{ setCookie: string }>
}

export interface AppleWebRouteOptions<Bindings extends object> {
  transactions: OidcTransactionStorePort
  identities: AppleIdentityResolver
  sessions: AppleSessionIssuer
  provider(bindings: Bindings): AppleWebProviderConfig | null
  lifecycle(bindings: Bindings): AppleWebLifecyclePort | null
  clientKey(request: Request): string
  /** null is an ordinary instance; a number is the published demo member. */
  demoAccount(bindings: Bindings): number | null
  renderDisconnect(input: { connected: boolean; unavailable: boolean; disconnected?: boolean }): string
  policy?: SignInMethodPolicy
  verifier?: AppleIdentityTokenVerifier
  now?: () => Date
}

export const assertValidAppleWebProviderConfig = (config: AppleWebProviderConfig): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(config.servicesId)) {
    throw new TypeError('Apple web Services ID is invalid')
  }
  const url = new URL(config.redirectOrigin)
  if (url.protocol !== 'https:' || url.origin !== config.redirectOrigin) {
    throw new TypeError('Apple web redirect origin must be an exact HTTPS origin')
  }
}

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

const digest = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')

const stateCookie = (value: string, maxAge: number): string =>
  `${APPLE_WEB_STATE_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${maxAge}`

const browserState = (request: Request): string | null => {
  const values = (request.headers.get('cookie') ?? '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${APPLE_WEB_STATE_COOKIE}=`))
  if (values.length !== 1) return null
  const value = values[0]!.slice(APPLE_WEB_STATE_COOKIE.length + 1)
  return STATE_PATTERN.test(value) ? value : null
}

type Failure = 'unavailable' | 'invalid' | 'cancelled' | 'denied' | 'private_email' | 'disabled' | 'profile'
class WebFailure extends Error {
  constructor(readonly reason: Failure) { super(reason) }
}

const responseHeaders = <Bindings extends object>(context: Context<ApiContext<Bindings>>): void => {
  context.header('cache-control', 'no-store')
  context.header('referrer-policy', 'no-referrer')
}

export const installAppleWebRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: AppleWebRouteOptions<Bindings>,
): void => {
  const now = options.now ?? (() => new Date())
  let cached: { servicesId: string; verifier: AppleIdentityTokenVerifier } | null = null
  const configuration = async (context: Context<ApiContext<Bindings>>, requireEnabled = true) => {
    const provider = options.provider(context.env)
    const lifecycle = options.lifecycle(context.env)
    if (provider === null || lifecycle === null) throw new WebFailure('unavailable')
    assertValidAppleWebProviderConfig(provider)
    // The container normalizes request URLs from its trusted APP_BASE_URL.
    // Never infer redirect origins from Host or forwarded headers.
    if (new URL(context.req.url).origin !== provider.redirectOrigin) throw new WebFailure('invalid')
    if (requireEnabled && options.policy !== undefined && !(await options.policy.isLive('apple', context.env))) {
      throw new WebFailure('unavailable')
    }
    return { provider, lifecycle }
  }
  const verifierFor = (servicesId: string) => {
    if (options.verifier !== undefined) return options.verifier
    if (cached === null || cached.servicesId !== servicesId) {
      cached = { servicesId, verifier: createAppleIdentityTokenVerifier({ clientId: servicesId, now }) }
    }
    return cached.verifier
  }
  const failed = (context: Context<ApiContext<Bindings>>, error: unknown) =>
    context.redirect(`/?apple_sign_in=${error instanceof WebFailure ? error.reason : 'unavailable'}`, 303)

  app.get(APPLE_WEB_START_PATH, async (context) => {
    responseHeaders(context)
    try {
      const intents = new URL(context.req.url).searchParams.getAll('intent')
      if (intents.length > 1 || (intents.length === 1 && intents[0] !== 'disconnect')) throw new WebFailure('invalid')
      const cleanup = intents[0] === 'disconnect'
      const requests = new URL(context.req.url).searchParams.getAll('cleanup_request')
      if (requests.length > 1 || (requests.length === 1 && (!cleanup || !/^[A-Za-z0-9_-]{8,128}$/.test(requests[0]!)))) throw new WebFailure('invalid')
      const requestId = requests[0]
      const { provider, lifecycle } = await configuration(context, !cleanup)
      const clientKey = options.clientKey(context.req.raw)
      if (!clientKey || clientKey.length > 1024) throw new WebFailure('unavailable')
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const timestamp = now()
        const state = randomToken()
        const redirectUri = provider.redirectOrigin + APPLE_WEB_CALLBACK_PATH
        const challenge = await lifecycle.challenge({ servicesId: provider.servicesId,
          instanceOrigin: provider.redirectOrigin, redirectUri,
          demo: options.demoAccount(context.env) !== null, purpose: cleanup ? 'disconnect' : 'sign-in',
          ...(requestId === undefined ? {} : { requestId }) })
        if (!STATE_PATTERN.test(challenge.challengeId) || !STATE_PATTERN.test(challenge.nonce) ||
          !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= timestamp.valueOf() ||
          Date.parse(challenge.expiresAt) > now().valueOf() + TTL_MS) throw new WebFailure('unavailable')
        const created = await options.transactions.create({
          provider: TRANSACTION_PROVIDER, issuer: `${APPLE_ISSUER}/`, clientId: provider.servicesId,
          clientKeyHash: await digest(clientKey), stateHash: await digest(state),
          // The shared store requires this field. Apple does not consume PKCE;
          // security here is state, nonce and the single-use code exchange.
          codeVerifier: `${cleanup ? 'disconnect' : 'signin'}.${challenge.challengeId}`, nonce: challenge.nonce, redirectUri,
          expiresAt: challenge.expiresAt, createdAt: timestamp.toISOString(),
          rateWindowStart: new Date(timestamp.valueOf() - 10 * 60 * 1000).toISOString(),
          cleanupBefore: new Date(timestamp.valueOf() - 24 * 60 * 60 * 1000).toISOString(),
        })
        if (created === 'collision') continue
        if (created !== 'created') throw new WebFailure('unavailable')
        const authorization = new URL(`${APPLE_ISSUER}/auth/authorize`)
        authorization.search = new URLSearchParams({
          client_id: provider.servicesId, redirect_uri: redirectUri,
          response_type: 'code id_token', response_mode: 'form_post', scope: 'name email',
          state, nonce: challenge.nonce,
        }).toString()
        context.header('set-cookie', stateCookie(state, TTL_MS / 1000), { append: true })
        return context.redirect(authorization.href, 302)
      }
      throw new WebFailure('unavailable')
    } catch (error) { return failed(context, error) }
  })

  app.post(APPLE_WEB_CALLBACK_PATH, async (context) => {
    responseHeaders(context)
    try {
      const { provider, lifecycle } = await configuration(context, false)
      const origin = context.req.header('origin')
      if (origin !== undefined && origin !== APPLE_ISSUER) throw new WebFailure('invalid')
      if ((context.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
        throw new WebFailure('invalid')
      }
      const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(
        await readLimitedBody(context.req.raw.body, MAX_BODY_BYTES),
      ))
      for (const key of form.keys()) {
        if (!['state', 'code', 'id_token', 'user', 'error', 'error_description'].includes(key) || form.getAll(key).length !== 1) {
          throw new WebFailure('invalid')
        }
      }
      const state = form.get('state')
      if (state === null || !STATE_PATTERN.test(state) || state !== browserState(context.req.raw)) {
        throw new WebFailure('invalid')
      }
      context.header('set-cookie', stateCookie('', 0), { append: true })
      const transaction = await options.transactions.consume(TRANSACTION_PROVIDER, await digest(state), now().toISOString())
      const redirectUri = provider.redirectOrigin + APPLE_WEB_CALLBACK_PATH
      if (transaction === null || transaction.issuer !== `${APPLE_ISSUER}/` ||
        transaction.clientId !== provider.servicesId || transaction.redirectUri !== redirectUri ||
        Date.parse(transaction.expiresAt) <= now().valueOf()) throw new WebFailure('invalid')
      const cleanup = transaction.codeVerifier.startsWith('disconnect.')
      if (!cleanup && !transaction.codeVerifier.startsWith('signin.')) throw new WebFailure('invalid')
      if (!cleanup && options.policy !== undefined && !(await options.policy.isLive('apple', context.env))) throw new WebFailure('unavailable')
      if (form.has('error')) {
        if (form.has('code') || form.has('id_token')) throw new WebFailure('invalid')
        throw new WebFailure(form.get('error') === 'access_denied' ? 'cancelled' : 'invalid')
      }
      const code = form.get('code')
      const token = form.get('id_token')
      if (!code || code.length > 4096 || !token || token.length > 16384) throw new WebFailure('invalid')
      const nonce = transaction.nonce
      const challengeId = transaction.codeVerifier.slice(transaction.codeVerifier.indexOf('.') + 1)
      if (!STATE_PATTERN.test(challengeId)) throw new WebFailure('invalid')
      const assertion = await verifierFor(provider.servicesId).verify(token, { nonce })
      if (assertion === null || !assertion.emailVerified) throw new WebFailure('invalid')
      const demoUserId = options.demoAccount(context.env)
      const grant = await lifecycle.exchange({ servicesId: provider.servicesId, instanceOrigin: provider.redirectOrigin,
        redirectUri, challengeId, authorizationCode: code, identityToken: token, nonce, demo: demoUserId !== null, purpose: cleanup ? 'disconnect' : 'sign-in' })
      if (grant.subject !== assertion.subject) throw new WebFailure('invalid')
      if (cleanup) {
        const connection = await grant.bindBrowser()
        context.header('set-cookie', connection.setCookie, { append: true })
        return context.redirect('/auth/apple/disconnect', 303)
      }
      let userId: number
      if (demoUserId !== null) {
        // Never call the real identity resolver on the public demo: even a
        // resolver that later refuses provisioning may have linked an email.
        if (!Number.isSafeInteger(demoUserId) || demoUserId < 1) throw new WebFailure('unavailable')
        const connection = await grant.bindBrowser()
        context.header('set-cookie', connection.setCookie, { append: true })
        userId = demoUserId
      } else {
        let firstName: string | undefined
        let lastName: string | undefined
        if (form.has('user')) {
          const user: unknown = JSON.parse(form.get('user')!)
          if (typeof user !== 'object' || user === null || Array.isArray(user)) throw new WebFailure('profile')
          const name = (user as { name?: { firstName?: unknown; lastName?: unknown } }).name
          const cleanName = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 200 ? value.trim() : undefined
          firstName = cleanName(name?.firstName)
          lastName = cleanName(name?.lastName)
        }
        const identity = await options.identities.resolveProvider({ provider: APPLE_PROVIDER_KEY,
          subject: assertion.subject, email: assertion.email, emailVerified: assertion.emailVerified,
          ...(firstName === undefined ? {} : { firstName }), ...(lastName === undefined ? {} : { lastName }) })
        if (identity.status === 'disabled') throw new WebFailure('disabled')
        if (identity.status === 'provisioning_not_permitted') throw new WebFailure(assertion.isPrivateEmail ? 'private_email' : 'denied')
        userId = identity.userId
        const connection = await grant.bindUser(userId)
        context.header('set-cookie', connection.setCookie, { append: true })
      }
      const session = await options.sessions.issue(userId)
      context.header('set-cookie', session.setCookie, { append: true })
      return context.redirect('/', 303)
    } catch (error) {
      // Never revoke implicitly: Apple may group this grant with authorizations
      // in the native app or another website. Explicit disconnect owns that act.
      return failed(context, error)
    }
  })

  app.get('/auth/apple/disconnect', async (context) => {
    responseHeaders(context)
    try {
      const { lifecycle } = await configuration(context, false)
      const connected = await lifecycle.connected(context.req.raw)
      return context.html(options.renderDisconnect({ connected, unavailable: context.req.query('failed') === '1' }))
    } catch {
      return context.html(options.renderDisconnect({ connected: false, unavailable: true }), 503)
    }
  })

  app.post('/auth/apple/disconnect', async (context) => {
    responseHeaders(context)
    try {
      const { provider, lifecycle } = await configuration(context, false)
      if (context.req.header('origin') !== provider.redirectOrigin ||
        (context.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
        throw new WebFailure('invalid')
      }
      const form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(
        await readLimitedBody(context.req.raw.body, 1024),
      ))
      if (form.size !== 1 || form.get('confirm') !== 'disconnect') throw new WebFailure('invalid')
      if (!(await lifecycle.connected(context.req.raw))) return context.redirect('/auth/apple/disconnect', 303)
      const result = await lifecycle.disconnect(context.req.raw)
      context.header('set-cookie', result.setCookie, { append: true })
      return context.html(options.renderDisconnect({ connected: false, unavailable: false, disconnected: true }))
    } catch {
      return context.redirect('/auth/apple/disconnect?failed=1', 303)
    }
  })

}
