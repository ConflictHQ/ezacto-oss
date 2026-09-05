import type { Context, Hono } from 'hono'
import {
  normalizeIdentityEmail,
  type ProviderIdentityAssertion,
  type ProviderIdentityResolution,
} from '@ezacto/core'
import * as oauth from 'oauth4webapi'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

export const GITHUB_PROVIDER_KEY = 'github'
export const GITHUB_AUTHORIZATION_ENDPOINT = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_ENDPOINT = 'https://api.github.com/user'
export const GITHUB_USER_EMAILS_ENDPOINT = 'https://api.github.com/user/emails'

const GITHUB_STATE_COOKIE_NAME = '__Host-ezacto_github_state'
const TRANSACTION_TTL_MS = 10 * 60 * 1_000
const RATE_WINDOW_MS = 10 * 60 * 1_000
const RETENTION_MS = 24 * 60 * 60 * 1_000

export interface GitHubTransactionStorePort {
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
  consume(provider: string, stateHash: string, now: string): Promise<GitHubTransaction | null>
}

export interface GitHubTransaction {
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

export interface GitHubIdentityResolver {
  resolveProvider(assertion: ProviderIdentityAssertion): Promise<ProviderIdentityResolution>
}

export interface GitHubSessionIssuer {
  issue(userId: number): Promise<{ setCookie: string }>
}

export interface GitHubProviderConfig {
  clientId: string
  clientSecret: string
  redirectOrigin: string
  timeoutMs?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export interface GitHubRouteOptions<Bindings extends object> {
  transactions: GitHubTransactionStorePort
  identities: GitHubIdentityResolver
  sessions: GitHubSessionIssuer
  provider(bindings: Bindings): GitHubProviderConfig | null
  clientKey(request: Request): string
  now?: () => string
}

interface NormalizedConfig {
  clientId: string
  clientSecret: string
  redirectOrigin: string
  timeoutMs: number
  fetch?: GitHubProviderConfig['fetch']
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const canonicalTimestamp = (value: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new TypeError('GitHub adapter clock must return a canonical UTC timestamp')
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

const normalizedConfig = (config: GitHubProviderConfig): NormalizedConfig => {
  const redirect = httpsUrl(config.redirectOrigin, 'GitHub redirect origin')
  if (redirect.pathname !== '/' || redirect.origin !== redirect.href.slice(0, -1)) {
    throw new RangeError('GitHub redirect origin must contain only an HTTPS origin')
  }
  const clientId = nonempty(config.clientId, 'GitHub client id', 512)
  const clientSecret = nonempty(config.clientSecret, 'GitHub client secret', 4096)
  const timeoutMs = config.timeoutMs ?? 10_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('GitHub timeout must be between 1 and 60000 milliseconds')
  }
  return {
    clientId,
    clientSecret,
    redirectOrigin: redirect.origin,
    timeoutMs,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  }
}

/** Validate provider configuration with the same contract used by GitHub routes. */
export const assertValidGitHubProviderConfig = (config: GitHubProviderConfig): void => {
  normalizedConfig(config)
}

const githubError = (
  status: 400 | 401 | 403 | 404 | 429 | 503,
  code: string,
  message: string,
): ApiError => new ApiError({ status, code, message })

const authFailure = (): ApiError =>
  githubError(
    401,
    'github_authentication_failed',
    'The GitHub identity response could not be authenticated.',
  )

const callbackUri = (config: NormalizedConfig): string =>
  `${config.redirectOrigin}/auth/github/callback`

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
  `${GITHUB_STATE_COOKIE_NAME}=${state}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`

const clearStateCookie = (): string =>
  `${GITHUB_STATE_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const cookieValue = (request: Request): string | null => {
  const header = request.headers.get('cookie')
  if (header === null) return null
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${GITHUB_STATE_COOKIE_NAME}=`))
    .map((part) => part.slice(GITHUB_STATE_COOKIE_NAME.length + 1))
  if (matches.length !== 1 || matches[0] === '') return null
  return matches[0]!
}

const setRedirectHeaders = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  context.header('cache-control', 'no-store')
  context.header('referrer-policy', 'no-referrer')
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

interface GitHubUser {
  id: number
  name: string | null
  login: string
}

interface GitHubEmail {
  email: string
  verified: boolean
  primary: boolean
}

const fetchJson = async <T>(
  url: string,
  config: NormalizedConfig,
  accessToken: string,
): Promise<T> => {
  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${accessToken}`,
    'user-agent': 'ezacto',
  })
  const init: RequestInit = {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(config.timeoutMs),
  }
  const response = config.fetch !== undefined
    ? await config.fetch(url, init)
    : await fetch(url, init)
  if (!response.ok) throw authFailure()
  return (await response.json()) as T
}

const exchangeCode = async (
  code: string,
  redirectUri: string,
  codeVerifier: string,
  config: NormalizedConfig,
): Promise<string> => {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': 'ezacto',
  })
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: body.toString(),
    signal: AbortSignal.timeout(config.timeoutMs),
  }
  const response = config.fetch !== undefined
    ? await config.fetch(GITHUB_TOKEN_ENDPOINT, init)
    : await fetch(GITHUB_TOKEN_ENDPOINT, init)
  const result = (await response.json()) as Record<string, unknown>
  if (typeof result.access_token !== 'string' || result.access_token === '') {
    throw authFailure()
  }
  return result.access_token
}

/**
 * Select the primary verified email from the GitHub /user/emails response.
 * If no primary verified email exists, fall back to the first verified email.
 * Returns null if no verified email is available.
 */
const selectVerifiedEmail = (emails: GitHubEmail[]): string | null => {
  if (!Array.isArray(emails) || emails.length === 0) return null
  const verified = emails.filter(
    (entry) =>
      typeof entry.email === 'string' &&
      entry.email !== '' &&
      entry.verified === true,
  )
  if (verified.length === 0) return null
  const primary = verified.find((entry) => entry.primary === true)
  return (primary ?? verified[0]!).email
}

/**
 * Attempt to split a full name into first/last tokens. GitHub only provides
 * a single `name` field (nullable). If it contains a space, split on the
 * first space. Otherwise treat the whole value as the first name.
 */
const splitName = (name: string | null | undefined): { firstName?: string; lastName?: string } => {
  const text = optionalText(name ?? undefined)
  if (text === undefined) return {}
  const separator = text.indexOf(' ')
  if (separator === -1) return { firstName: text }
  const firstName = text.slice(0, separator)
  const lastName = text.slice(separator + 1).trim()
  if (firstName === '' || lastName === '') return { firstName: text }
  return { firstName, lastName }
}

export const installGitHubRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: GitHubRouteOptions<Bindings>,
): void => {
  const now = options.now ?? (() => new Date().toISOString())

  app.get('/auth/github', async (context) => {
    const configured = options.provider(context.env)
    if (configured === null) {
      throw githubError(404, 'github_provider_not_found', 'The GitHub identity provider is not configured.')
    }
    let config: NormalizedConfig
    try {
      config = normalizedConfig(configured)
    } catch {
      throw githubError(
        503,
        'github_provider_unavailable',
        'The GitHub identity provider is temporarily unavailable.',
      )
    }
    const redirectUri = callbackUri(config)
    const clientKey = nonempty(
      options.clientKey(context.req.raw),
      'GitHub client key',
      1024,
    )

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const timestamp = canonicalTimestamp(now())
      const expiresAt = new Date(
        Date.parse(timestamp) + TRANSACTION_TTL_MS,
      ).toISOString()
      const state = oauth.generateRandomState()
      const codeVerifier = oauth.generateRandomCodeVerifier()
      const created = await options.transactions.create({
        provider: GITHUB_PROVIDER_KEY,
        issuer: 'https://github.com',
        clientId: config.clientId,
        clientKeyHash: await sha256Hex(clientKey),
        stateHash: await sha256Hex(state),
        codeVerifier,
        nonce: '',
        redirectUri,
        expiresAt,
        createdAt: timestamp,
        rateWindowStart: new Date(
          Date.parse(timestamp) - RATE_WINDOW_MS,
        ).toISOString(),
        cleanupBefore: new Date(
          Date.parse(timestamp) - RETENTION_MS,
        ).toISOString(),
      })
      if (created === 'rate_limited') {
        throw githubError(
          429,
          'github_start_rate_limited',
          'Too many GitHub sign-in attempts. Try again later.',
        )
      }
      if (created === 'collision') continue

      const authorization = new URL(GITHUB_AUTHORIZATION_ENDPOINT)
      authorization.searchParams.set('client_id', config.clientId)
      authorization.searchParams.set('redirect_uri', redirectUri)
      authorization.searchParams.set('scope', 'read:user user:email')
      authorization.searchParams.set('state', state)
      authorization.searchParams.set(
        'code_challenge',
        await oauth.calculatePKCECodeChallenge(codeVerifier),
      )
      authorization.searchParams.set('code_challenge_method', 'S256')
      context.header('set-cookie', stateCookie(state, expiresAt), { append: true })
      setRedirectHeaders(context)
      return context.redirect(authorization.href, 302)
    }
    throw githubError(
      503,
      'github_provider_unavailable',
      'The GitHub sign-in could not be started.',
    )
  })

  app.get('/auth/github/callback', async (context) => {
    context.header('set-cookie', clearStateCookie(), { append: true })
    const configured = options.provider(context.env)
    if (configured === null) {
      throw githubError(404, 'github_provider_not_found', 'The GitHub identity provider is not configured.')
    }
    let config: NormalizedConfig
    try {
      config = normalizedConfig(configured)
    } catch {
      throw githubError(
        503,
        'github_provider_unavailable',
        'The GitHub identity provider is temporarily unavailable.',
      )
    }
    const url = new URL(context.req.url)
    const returnedStates = url.searchParams.getAll('state')
    const returnedCodes = url.searchParams.getAll('code')
    const returnedErrors = url.searchParams.getAll('error')
    const cookieState = cookieValue(context.req.raw)
    if (
      returnedStates.length !== 1 ||
      cookieState === null ||
      returnedCodes.length > 1 ||
      returnedErrors.length > 1 ||
      (returnedCodes.length === 0) === (returnedErrors.length === 0)
    ) {
      throw authFailure()
    }
    const returnedStateHash = await sha256Hex(returnedStates[0]!)
    const cookieStateHash = await sha256Hex(cookieState)
    if (!secureEqual(returnedStateHash, cookieStateHash)) throw authFailure()

    const transaction = await options.transactions.consume(
      GITHUB_PROVIDER_KEY,
      returnedStateHash,
      canonicalTimestamp(now()),
    )
    if (
      transaction === null ||
      transaction.issuer !== 'https://github.com' ||
      transaction.clientId !== config.clientId ||
      transaction.redirectUri !== callbackUri(config)
    ) {
      throw authFailure()
    }

    if (returnedErrors.length === 1) throw authFailure()

    try {
      const accessToken = await exchangeCode(
        returnedCodes[0]!,
        transaction.redirectUri,
        transaction.codeVerifier,
        config,
      )

      const user = await fetchJson<GitHubUser>(GITHUB_USER_ENDPOINT, config, accessToken)
      if (
        typeof user.id !== 'number' ||
        !Number.isSafeInteger(user.id) ||
        user.id < 1
      ) {
        throw authFailure()
      }

      const emails = await fetchJson<GitHubEmail[]>(
        GITHUB_USER_EMAILS_ENDPOINT,
        config,
        accessToken,
      )
      const verifiedEmail = selectVerifiedEmail(emails)
      if (verifiedEmail === null) {
        throw githubError(
          401,
          'github_email_not_verified',
          'A verified GitHub email address is required.',
        )
      }

      const { firstName, lastName } = splitName(user.name)
      const subject = String(user.id)

      let identity: ProviderIdentityResolution
      try {
        identity = await options.identities.resolveProvider({
          provider: GITHUB_PROVIDER_KEY,
          subject,
          email: normalizeIdentityEmail(verifiedEmail),
          emailVerified: true,
          ...(firstName === undefined ? {} : { firstName }),
          ...(lastName === undefined ? {} : { lastName }),
        })
      } catch (error) {
        if (error instanceof RangeError || error instanceof TypeError) {
          throw githubError(
            400,
            'github_profile_incomplete',
            'GitHub did not return the profile required to create this user.',
          )
        }
        throw error
      }
      if (identity.status === 'disabled') {
        throw githubError(403, 'account_disabled', 'This ezacto user is disabled.')
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
