import type { Context, Hono } from 'hono'
import {
  normalizeIdentityEmail,
  type ProviderIdentityAssertion,
  type ProviderIdentityResolution,
} from '@ezacto/core'
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError } from './errors.js'

/** Application-owned provider key recorded against the linked identity. */
export const APPLE_PROVIDER_KEY = 'apple'
/** The only issuer a native Sign in with Apple identity token may carry. */
export const APPLE_ISSUER = 'https://appleid.apple.com'
/** Apple's fixed, CDN-served signing-key set. */
export const APPLE_JWKS_URI = 'https://appleid.apple.com/auth/keys'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60 * 1_000
const DEFAULT_COOLDOWN_MS = 30 * 1_000
const MAX_IDENTITY_TOKEN_LENGTH = 16 * 1_024
const MAX_REQUEST_BODY_BYTES = 32 * 1_024
const MAX_SUBJECT_LENGTH = 500
const MAX_AUDIENCE_LENGTH = 512
const compactJwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export type AppleFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Deployment configuration for native Sign in with Apple.
 *
 * `clientId` is the audience an identity token must carry: the iOS bundle
 * identifier the app ships under, and optionally a web Services ID beside it.
 * One value or several, separated by whitespace or commas -- a token is
 * accepted when its `aud` is any of them, which is how one Apple team serves an
 * app and a website at once.
 */
export interface AppleProviderConfig {
  clientId: string
  timeoutMs?: number
  cacheMaxAgeMs?: number
  cooldownMs?: number
  fetch?: AppleFetch
  /** Injectable validation clock for deterministic boundary tests. */
  now?: () => Date
}

interface NormalizedAppleConfig {
  audiences: readonly string[]
  timeoutMs: number
  cacheMaxAgeMs: number
  cooldownMs: number
  fetch?: AppleFetch
  now: () => Date
}

/** What a verified Apple identity token yields. */
export interface AppleAssertion {
  /** Stable, Apple-issued subject (`sub`). Opaque and case-sensitive. */
  subject: string
  /** The verified address from the token; Apple issues one for every sign-in. */
  email: string
  emailVerified: boolean
}

export interface AppleIdentityTokenVerifier {
  /** Returns null for every malformed, unverifiable, expired, or unavailable token. */
  verify(identityToken: string): Promise<AppleAssertion | null>
}

export interface AppleIdentityResolver {
  resolveProvider(
    assertion: ProviderIdentityAssertion,
  ): Promise<ProviderIdentityResolution>
}

export interface AppleSessionIssuer {
  issue(userId: number): Promise<{ setCookie: string }>
}

export interface AppleRouteOptions<Bindings extends object> {
  identities: AppleIdentityResolver
  sessions: AppleSessionIssuer
  provider(bindings: Bindings): AppleProviderConfig | null
  /**
   * The token verifier. Production leaves this unset and the route builds one
   * from the resolved configuration, caching Apple's JWKS across requests; a
   * test injects a fake to exercise the route without real crypto.
   */
  verifier?: AppleIdentityTokenVerifier
}

const appleError = (
  status: 400 | 401 | 403 | 404 | 503,
  code: string,
  message: string,
): ApiError => new ApiError({ status, code, message })

const authFailure = (): ApiError =>
  appleError(
    401,
    'apple_authentication_failed',
    'The Apple identity token could not be authenticated.',
  )

const audiencesFrom = (value: string): readonly string[] => {
  if (typeof value !== 'string') {
    throw new TypeError('Apple client id must be a string')
  }
  const audiences = value
    .normalize('NFC')
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (
    audiences.length === 0 ||
    audiences.some((entry) => [...entry].length > MAX_AUDIENCE_LENGTH) ||
    new Set(audiences).size !== audiences.length
  ) {
    throw new RangeError('Apple client id must name at least one unique audience')
  }
  return audiences
}

const integerOption = (
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${field} is invalid`)
  }
  return resolved
}

const normalizedConfig = (config: AppleProviderConfig): NormalizedAppleConfig => {
  if (config.fetch !== undefined && typeof config.fetch !== 'function') {
    throw new TypeError('Apple JWKS fetch must be a function')
  }
  if (config.now !== undefined && typeof config.now !== 'function') {
    throw new TypeError('Apple validation clock must be a function')
  }
  const cacheMaxAgeMs = integerOption(
    config.cacheMaxAgeMs,
    DEFAULT_CACHE_MAX_AGE_MS,
    'Apple JWKS cache maximum age',
    1,
    24 * 60 * 60 * 1_000,
  )
  return {
    audiences: audiencesFrom(config.clientId),
    timeoutMs: integerOption(
      config.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      'Apple JWKS timeout',
      1,
      60_000,
    ),
    cacheMaxAgeMs,
    cooldownMs: integerOption(
      config.cooldownMs,
      DEFAULT_COOLDOWN_MS,
      'Apple JWKS cooldown',
      0,
      cacheMaxAgeMs,
    ),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    now: config.now ?? (() => new Date()),
  }
}

/** Validates deployment configuration using the same rules as the verifier. */
export const assertValidAppleProviderConfig = (
  config: AppleProviderConfig,
): void => {
  normalizedConfig(config)
}

const appleEmail = (payload: JWTPayload): string | null => {
  const value = payload.email
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    return normalizeIdentityEmail(value)
  } catch {
    return null
  }
}

/**
 * Apple sends `email_verified` (and `is_private_email`) as either a JSON boolean
 * or the string `"true"`/`"false"`, depending on the flow. Both spellings of
 * true are accepted; anything else is unverified.
 */
const appleEmailVerified = (payload: JWTPayload): boolean =>
  payload.email_verified === true || payload.email_verified === 'true'

/**
 * A verifier backed by Apple's published JWKS. The remote key set caches
 * successful keys and throttles unknown-key refreshes while still reloading
 * after the cooldown, so Apple's signing-key rotation converges. Every failure
 * -- signature, claims, transport, or key selection -- denies without leaking
 * which.
 */
export const createAppleIdentityTokenVerifier = (
  config: AppleProviderConfig,
): AppleIdentityTokenVerifier => {
  const normalized = normalizedConfig(config)
  const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URI), {
    timeoutDuration: normalized.timeoutMs,
    cacheMaxAge: normalized.cacheMaxAgeMs,
    cooldownDuration: normalized.cooldownMs,
    ...(normalized.fetch === undefined
      ? {}
      : { [customFetch]: normalized.fetch }),
  })

  return {
    verify: async (identityToken) => {
      if (
        typeof identityToken !== 'string' ||
        identityToken.length < 1 ||
        identityToken.length > MAX_IDENTITY_TOKEN_LENGTH ||
        !compactJwtPattern.test(identityToken)
      ) {
        return null
      }
      try {
        const currentDate = normalized.now()
        if (
          !(currentDate instanceof Date) ||
          !Number.isFinite(currentDate.valueOf())
        ) {
          return null
        }
        const { payload } = await jwtVerify(identityToken, jwks, {
          algorithms: ['RS256'],
          audience: [...normalized.audiences],
          issuer: APPLE_ISSUER,
          requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
          currentDate,
        })
        const nowSeconds = Math.floor(currentDate.valueOf() / 1_000)
        const { exp, iat, sub } = payload
        if (
          typeof sub !== 'string' ||
          sub.length === 0 ||
          [...sub].length > MAX_SUBJECT_LENGTH ||
          typeof iat !== 'number' ||
          !Number.isSafeInteger(iat) ||
          typeof exp !== 'number' ||
          !Number.isSafeInteger(exp) ||
          iat > nowSeconds ||
          iat >= exp
        ) {
          return null
        }
        const email = appleEmail(payload)
        if (email === null) return null
        return { subject: sub, email, emailVerified: appleEmailVerified(payload) }
      } catch {
        return null
      }
    },
  }
}

const optionalName = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const jsonObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const setResponseHeaders = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  context.header('cache-control', 'no-store')
  context.header('referrer-policy', 'no-referrer')
}

/**
 * Native Sign in with Apple.
 *
 * Unlike the browser OAuth providers, the app already holds an Apple identity
 * token (a signed JWT) from the platform prompt, so there is no redirect,
 * state cookie, or PKCE round trip. The app posts the token here; the route
 * verifies it against Apple's JWKS, resolves or creates the user through the
 * same identity resolver every provider shares, and issues the ordinary
 * server-side session. The app then mints its API token through
 * `/api/v1/api-tokens`, exactly as the OIDC app-code exchange does, so scope
 * and profile policy stay in one place.
 *
 * The route is always mounted; it fails closed with 404 until a deployment
 * configures `provider`, so nothing here runs before the Apple audience is set.
 */
export const installAppleRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: AppleRouteOptions<Bindings>,
): void => {
  // A single-organization deployment has one stable Apple audience, so the
  // JWKS-backed verifier is built once and reused; that is where jose's key
  // cache lives, and a fresh verifier per request would refetch every time.
  let cached: { key: string; verifier: AppleIdentityTokenVerifier } | null = null
  const verifierFor = (
    config: AppleProviderConfig,
    normalized: NormalizedAppleConfig,
  ): AppleIdentityTokenVerifier => {
    if (options.verifier !== undefined) return options.verifier
    const key = [
      normalized.audiences.join(','),
      normalized.timeoutMs,
      normalized.cacheMaxAgeMs,
      normalized.cooldownMs,
    ].join('|')
    if (cached === null || cached.key !== key) {
      cached = { key, verifier: createAppleIdentityTokenVerifier(config) }
    }
    return cached.verifier
  }

  app.post('/auth/apple', async (context) => {
    const configured = options.provider(context.env)
    if (configured === null) {
      throw appleError(
        404,
        'apple_provider_not_found',
        'The Apple identity provider is not configured.',
      )
    }
    let normalized: NormalizedAppleConfig
    try {
      normalized = normalizedConfig(configured)
    } catch {
      throw appleError(
        503,
        'apple_provider_unavailable',
        'The Apple identity provider is temporarily unavailable.',
      )
    }

    const body = await readJsonBody<unknown>(context, {
      maxBytes: MAX_REQUEST_BODY_BYTES,
    })
    if (!jsonObject(body)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
      ])
    }
    if (
      typeof body.identityToken !== 'string' ||
      body.identityToken.trim() === ''
    ) {
      throw validationError([
        {
          field: 'identityToken',
          code: 'invalid',
          message: 'identityToken is missing or empty',
        },
      ])
    }
    const unknownFields = Object.keys(body).filter(
      (field) => field !== 'identityToken' && field !== 'fullName',
    )
    if (unknownFields.length > 0) {
      throw validationError(
        unknownFields.map((field) => ({
          field,
          code: 'unknown',
          message: `${field} is not accepted`,
        })),
      )
    }
    if (body.fullName !== undefined && !jsonObject(body.fullName)) {
      throw validationError([
        { field: 'fullName', code: 'invalid', message: 'fullName must be an object' },
      ])
    }
    // Apple returns the name only on the very first authorization, so the app
    // forwards it here and nowhere else; `given`/`family` mirror the platform's
    // PersonNameComponents. Only these two are read.
    const nameSource = jsonObject(body.fullName) ? body.fullName : {}
    const firstName = optionalName(nameSource.givenName)
    const lastName = optionalName(nameSource.familyName)

    const verifier = verifierFor(configured, normalized)
    const assertion = await verifier.verify(body.identityToken)
    if (assertion === null) throw authFailure()

    let identity: ProviderIdentityResolution
    try {
      identity = await options.identities.resolveProvider({
        provider: APPLE_PROVIDER_KEY,
        subject: assertion.subject,
        email: assertion.email,
        emailVerified: assertion.emailVerified,
        ...(firstName === undefined ? {} : { firstName }),
        ...(lastName === undefined ? {} : { lastName }),
      })
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) {
        throw appleError(
          400,
          'apple_profile_incomplete',
          'Apple did not return the profile required to create this user.',
        )
      }
      throw error
    }
    // An assertion that matched nobody and came from a domain this instance has
    // not proven it owns gets no account -- the same rule the OIDC providers
    // enforce, so an arbitrary Apple ID cannot provision itself a user.
    if (identity.status === 'provisioning_not_permitted') {
      throw appleError(
        403,
        'provisioning_not_permitted',
        'This Apple account is not on a domain this instance provisions from.',
      )
    }
    if (identity.status === 'disabled') {
      throw appleError(403, 'account_disabled', 'This ezacto user is disabled.')
    }
    const session = await options.sessions.issue(identity.userId)
    context.header('set-cookie', session.setCookie, { append: true })
    setResponseHeaders(context)
    return context.json({ data: { ok: true } }, 200, {
      'cache-control': 'no-store',
    })
  })
}
