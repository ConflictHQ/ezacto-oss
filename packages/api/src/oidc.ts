import type { Context, Hono } from 'hono'
import {
  normalizeIdentityEmail,
  type ProviderIdentityAssertion,
  type ProviderIdentityResolution,
} from '@ezacto/core'
import * as oauth from 'oauth4webapi'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

export const OIDC_STATE_COOKIE_NAME = '__Host-ezacto_oidc_state'
export const OIDC_TRANSACTION_TTL_MS = 10 * 60 * 1_000
export const OIDC_START_RATE_WINDOW_MS = 10 * 60 * 1_000
export const OIDC_TRANSACTION_RETENTION_MS = 24 * 60 * 60 * 1_000

export interface OidcTransaction {
  id: number
  provider: string
  issuer: string
  clientId: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

export interface OidcTransactionStorePort {
  create(input: {
    provider: string
    issuer: string
    clientId: string
    clientKeyHash: string
    stateHash: string
    codeVerifier: string
    nonce: string
    redirectUri: string
    expiresAt: string
    createdAt: string
    rateWindowStart: string
    cleanupBefore: string
  }): Promise<'created' | 'collision' | 'rate_limited'>
  consume(provider: string, stateHash: string, now: string): Promise<OidcTransaction | null>
}

export interface OidcIdentityResolver {
  resolveProvider(assertion: ProviderIdentityAssertion): Promise<ProviderIdentityResolution>
}

export interface OidcSessionIssuer {
  issue(userId: number): Promise<{ setCookie: string }>
}

export type OidcClientAuthentication = 'client_secret_basic' | 'client_secret_post'

export interface OidcProviderConfig {
  issuer: string
  clientId: string
  clientSecret: string
  redirectOrigin: string
  clientAuthentication?: OidcClientAuthentication
  idTokenSigningAlgorithm?: oauth.JWSAlgorithm
  scopes?: readonly string[]
  timeoutMs?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export interface OidcRouteOptions<Bindings extends object> {
  transactions: OidcTransactionStorePort
  identities: OidcIdentityResolver
  sessions: OidcSessionIssuer
  provider(
    key: string,
    bindings: Bindings,
  ): OidcProviderConfig | null
  clientKey(request: Request): string
  now?: () => string
}

interface NormalizedProvider {
  issuer: URL
  client: oauth.Client
  clientAuthentication: oauth.ClientAuth
  redirectOrigin: string
  scopes: readonly string[]
  signingAlgorithm: oauth.JWSAlgorithm
  timeoutMs: number
  fetch?: OidcProviderConfig['fetch']
}

const providerPattern = /^[a-z][a-z0-9._-]{0,99}$/
const scopePattern = /^[\x21\x23-\x5B\x5D-\x7E]+$/
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const signingAlgorithms: ReadonlySet<oauth.JWSAlgorithm> = new Set([
  'PS256',
  'ES256',
  'RS256',
  'Ed25519',
  'ES384',
  'PS384',
  'RS384',
  'ES512',
  'PS512',
  'RS512',
  'ML-DSA-44',
  'ML-DSA-65',
  'ML-DSA-87',
  'EdDSA',
])

const oidcError = (
  status: 400 | 401 | 403 | 404 | 429 | 503,
  code: string,
  message: string,
): ApiError => new ApiError({ status, code, message })

const canonicalTimestamp = (value: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError('OIDC clock must return a canonical UTC timestamp')
  }
  return value
}

const nonempty = (value: string, field: string, maximum: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || [...normalized].length > maximum) {
    throw new RangeError(`${field} is invalid`)
  }
  return normalized
}

const httpsUrl = (value: string, field: string): URL => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RangeError(`${field} is invalid`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new RangeError(`${field} must be an HTTPS URL without credentials, query, or fragment`)
  }
  return url
}

const normalizedProvider = (config: OidcProviderConfig): NormalizedProvider => {
  const issuer = httpsUrl(config.issuer, 'OIDC issuer')
  const redirect = httpsUrl(config.redirectOrigin, 'OIDC redirect origin')
  if (redirect.pathname !== '/' || redirect.origin !== redirect.href.slice(0, -1)) {
    throw new RangeError('OIDC redirect origin must contain only an HTTPS origin')
  }
  const clientId = nonempty(config.clientId, 'OIDC client id', 512)
  const clientSecret = nonempty(config.clientSecret, 'OIDC client secret', 4096)
  const clientAuthentication = config.clientAuthentication ?? 'client_secret_post'
  const signingAlgorithm = config.idTokenSigningAlgorithm ?? 'RS256'
  if (!signingAlgorithms.has(signingAlgorithm)) {
    throw new RangeError('OIDC ID token signing algorithm is unsupported')
  }
  const scopes = [...(config.scopes ?? ['openid', 'email', 'profile'])]
  if (
    !scopes.includes('openid') ||
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((scope) => !scopePattern.test(scope))
  ) {
    throw new RangeError('OIDC scopes must be unique printable values including openid')
  }
  const timeoutMs = config.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('OIDC timeout must be between 1 and 60000 milliseconds')
  }
  return {
    issuer,
    redirectOrigin: redirect.origin,
    client: {
      client_id: clientId,
      id_token_signed_response_alg: signingAlgorithm,
      token_endpoint_auth_method: clientAuthentication,
    },
    clientAuthentication:
      clientAuthentication === 'client_secret_basic'
        ? oauth.ClientSecretBasic(clientSecret)
        : oauth.ClientSecretPost(clientSecret),
    scopes,
    signingAlgorithm,
    timeoutMs,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  }
}

/** Validate provider configuration with the same contract used by OIDC routes. */
export const assertValidOidcProviderConfig = (
  config: OidcProviderConfig,
): void => {
  normalizedProvider(config)
}

const transport = (provider: NormalizedProvider) => ({
  signal: () => AbortSignal.timeout(provider.timeoutMs),
  ...(provider.fetch === undefined
    ? {}
    : {
        [oauth.customFetch]: (url: string, init: oauth.CustomFetchOptions<string, unknown>) =>
          provider.fetch!(url, init as RequestInit),
      }),
})

const metadata = async (provider: NormalizedProvider): Promise<oauth.AuthorizationServer> => {
  try {
    const response = await oauth.discoveryRequest(provider.issuer, transport(provider))
    const discovered = await oauth.processDiscoveryResponse(provider.issuer, response)
    const endpoints = [
      discovered.authorization_endpoint,
      discovered.token_endpoint,
      discovered.jwks_uri,
      discovered.userinfo_endpoint,
    ]
    if (
      endpoints.some((endpoint) => !secureProviderEndpoint(endpoint)) ||
      discovered.response_types_supported?.includes('code') !== true ||
      discovered.code_challenge_methods_supported?.includes('S256') !== true ||
      discovered.id_token_signing_alg_values_supported?.includes(
        provider.signingAlgorithm,
      ) !== true ||
      (provider.client.token_endpoint_auth_method === 'client_secret_post'
        ? discovered.token_endpoint_auth_methods_supported?.includes(
            'client_secret_post',
          ) !== true
        : discovered.token_endpoint_auth_methods_supported !== undefined &&
          !discovered.token_endpoint_auth_methods_supported.includes(
            'client_secret_basic',
          ))
    ) {
      throw new Error('OIDC discovery metadata is missing required capabilities')
    }
    return discovered
  } catch {
    throw oidcError(
      503,
      'oidc_provider_unavailable',
      'The configured identity provider is temporarily unavailable.',
    )
  }
}

const secureProviderEndpoint = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

const callbackUri = (provider: string, config: NormalizedProvider): string =>
  `${config.redirectOrigin}/auth/oidc/${encodeURIComponent(provider)}/callback`

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const secureEqual = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

const stateCookie = (state: string, expiresAt: string): string =>
  `${OIDC_STATE_COOKIE_NAME}=${state}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`

const clearStateCookie = (): string =>
  `${OIDC_STATE_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const cookieValue = (request: Request): string | null => {
  const header = request.headers.get('cookie')
  if (header === null) return null
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${OIDC_STATE_COOKIE_NAME}=`))
    .map((part) => part.slice(OIDC_STATE_COOKIE_NAME.length + 1))
  if (matches.length !== 1 || matches[0] === '') return null
  return matches[0]!
}

const providerFor = <Bindings extends object>(
  key: string,
  context: Context<ApiContext<Bindings>>,
  options: OidcRouteOptions<Bindings>,
): NormalizedProvider => {
  if (!providerPattern.test(key)) {
    throw oidcError(404, 'oidc_provider_not_found', 'The identity provider is not configured.')
  }
  const configured = options.provider(key, context.env)
  if (configured === null) {
    throw oidcError(404, 'oidc_provider_not_found', 'The identity provider is not configured.')
  }
  try {
    return normalizedProvider(configured)
  } catch {
    throw oidcError(
      503,
      'oidc_provider_unavailable',
      'The configured identity provider is temporarily unavailable.',
    )
  }
}

const setRedirectHeaders = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  context.header('cache-control', 'no-store')
  context.header('referrer-policy', 'no-referrer')
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

interface EmailClaimSet {
  email: string
  emailVerified: boolean
}

const emailClaimSet = (
  source: Readonly<Record<string, unknown>>,
): EmailClaimSet | null => {
  const hasEmail = source.email !== undefined
  const hasVerification = source.email_verified !== undefined
  if (!hasEmail && !hasVerification) return null
  if (!hasEmail || !hasVerification || typeof source.email_verified !== 'boolean') {
    throw authFailure()
  }
  const email = optionalText(source.email)
  if (email === undefined) throw authFailure()
  return {
    email: normalizeIdentityEmail(email),
    emailVerified: source.email_verified,
  }
}

const resolveEmailClaims = (
  idToken: Readonly<Record<string, unknown>>,
  userInfo: Readonly<Record<string, unknown>>,
): EmailClaimSet => {
  const signed = emailClaimSet(idToken)
  const fetched = emailClaimSet(userInfo)
  if (signed === null) {
    if (fetched === null) throw authFailure()
    return fetched
  }
  if (fetched === null) return signed
  if (
    signed.email !== fetched.email ||
    signed.emailVerified !== fetched.emailVerified
  ) {
    throw authFailure()
  }
  return fetched
}

const authFailure = (): ApiError =>
  oidcError(
    401,
    'oidc_authentication_failed',
    'The identity provider response could not be authenticated.',
  )

export const installOidcRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: OidcRouteOptions<Bindings>,
): void => {
  const now = options.now ?? (() => new Date().toISOString())

  app.get('/auth/oidc/:provider', async (context) => {
    const key = context.req.param('provider')
    const provider = providerFor(key, context, options)
    const redirectUri = callbackUri(key, provider)
    const clientKey = nonempty(
      options.clientKey(context.req.raw),
      'OIDC client key',
      1024,
    )

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const timestamp = canonicalTimestamp(now())
      const expiresAt = new Date(
        Date.parse(timestamp) + OIDC_TRANSACTION_TTL_MS,
      ).toISOString()
      const state = oauth.generateRandomState()
      const nonce = oauth.generateRandomNonce()
      const codeVerifier = oauth.generateRandomCodeVerifier()
      const created = await options.transactions.create({
        provider: key,
        issuer: provider.issuer.href,
        clientId: provider.client.client_id,
        clientKeyHash: await sha256Hex(clientKey),
        stateHash: await sha256Hex(state),
        codeVerifier,
        nonce,
        redirectUri,
        expiresAt,
        createdAt: timestamp,
        rateWindowStart: new Date(
          Date.parse(timestamp) - OIDC_START_RATE_WINDOW_MS,
        ).toISOString(),
        cleanupBefore: new Date(
          Date.parse(timestamp) - OIDC_TRANSACTION_RETENTION_MS,
        ).toISOString(),
      })
      if (created === 'rate_limited') {
        throw oidcError(
          429,
          'oidc_start_rate_limited',
          'Too many identity provider sign-in attempts. Try again later.',
        )
      }
      if (created === 'collision') continue

      // Reserve the rate-limited transaction before making any provider
      // network request so blocked clients cannot turn discovery into an
      // unbounded outbound-request surface.
      const discovered = await metadata(provider)
      const authorization = new URL(discovered.authorization_endpoint!)
      authorization.searchParams.set('client_id', provider.client.client_id)
      authorization.searchParams.set('redirect_uri', redirectUri)
      authorization.searchParams.set('response_type', 'code')
      authorization.searchParams.set('scope', provider.scopes.join(' '))
      authorization.searchParams.set('state', state)
      authorization.searchParams.set('nonce', nonce)
      authorization.searchParams.set(
        'code_challenge',
        await oauth.calculatePKCECodeChallenge(codeVerifier),
      )
      authorization.searchParams.set('code_challenge_method', 'S256')
      context.header('set-cookie', stateCookie(state, expiresAt), { append: true })
      setRedirectHeaders(context)
      return context.redirect(authorization.href, 302)
    }
    throw oidcError(
      503,
      'oidc_provider_unavailable',
      'The identity provider sign-in could not be started.',
    )
  })

  app.get('/auth/oidc/:provider/callback', async (context) => {
    context.header('set-cookie', clearStateCookie(), { append: true })
    const key = context.req.param('provider')
    const provider = providerFor(key, context, options)
    const url = new URL(context.req.url)
    const returnedStates = url.searchParams.getAll('state')
    const returnedCodes = url.searchParams.getAll('code')
    const returnedErrors = url.searchParams.getAll('error')
    const returnedIssuers = url.searchParams.getAll('iss')
    const cookieState = cookieValue(context.req.raw)
    if (
      returnedStates.length !== 1 ||
      cookieState === null ||
      returnedCodes.length > 1 ||
      returnedErrors.length > 1 ||
      returnedIssuers.length > 1 ||
      (returnedCodes.length === 0) === (returnedErrors.length === 0)
    ) {
      throw authFailure()
    }
    const returnedStateHash = await sha256Hex(returnedStates[0]!)
    const cookieStateHash = await sha256Hex(cookieState)
    if (!secureEqual(returnedStateHash, cookieStateHash)) throw authFailure()

    const transaction = await options.transactions.consume(
      key,
      returnedStateHash,
      canonicalTimestamp(now()),
    )
    if (
      transaction === null ||
      transaction.issuer !== provider.issuer.href ||
      transaction.clientId !== provider.client.client_id ||
      transaction.redirectUri !== callbackUri(key, provider)
    ) {
      throw authFailure()
    }

    try {
      const discovered = await metadata(provider)
      const parameters = oauth.validateAuthResponse(
        discovered,
        provider.client,
        url,
        cookieState,
      )
      const tokenResponse = await oauth.authorizationCodeGrantRequest(
        discovered,
        provider.client,
        provider.clientAuthentication,
        parameters,
        transaction.redirectUri,
        transaction.codeVerifier,
        transport(provider),
      )
      const tokens = await oauth.processAuthorizationCodeResponse(
        discovered,
        provider.client,
        tokenResponse,
        { expectedNonce: transaction.nonce, requireIdToken: true },
      )
      await oauth.validateApplicationLevelSignature(
        discovered,
        tokenResponse,
        transport(provider),
      )
      const claims = oauth.getValidatedIdTokenClaims(tokens)
      if (claims === undefined || typeof claims.sub !== 'string') throw authFailure()

      const userInfoResponse = await oauth.userInfoRequest(
        discovered,
        provider.client,
        tokens.access_token,
        transport(provider),
      )
      const userInfo = await oauth.processUserInfoResponse(
        discovered,
        provider.client,
        claims.sub,
        userInfoResponse,
      )
      const { email, emailVerified } = resolveEmailClaims(claims, userInfo)
      const firstName = optionalText(userInfo.given_name ?? claims.given_name)
      const lastName = optionalText(userInfo.family_name ?? claims.family_name)

      let identity: ProviderIdentityResolution
      try {
        identity = await options.identities.resolveProvider({
          provider: key,
          subject: claims.sub,
          email,
          emailVerified,
          ...(firstName === undefined ? {} : { firstName }),
          ...(lastName === undefined ? {} : { lastName }),
        })
      } catch (error) {
        if (error instanceof RangeError || error instanceof TypeError) {
          throw oidcError(
            400,
            'oidc_profile_incomplete',
            'The identity provider did not return the profile required to create this user.',
          )
        }
        throw error
      }
      if (identity.status === 'disabled') {
        throw oidcError(403, 'account_disabled', 'This ezacto user is disabled.')
      }
      const session = await options.sessions.issue(identity.userId)
      context.header('set-cookie', session.setCookie, { append: true })
      setRedirectHeaders(context)
      return context.redirect('/', 303)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw authFailure()
    }
  })
}
