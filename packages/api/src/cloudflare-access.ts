import {
  normalizeIdentityEmail,
  type EmailSignInResolution,
} from '@ezacto/core'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import type { ApiSessionResolver, SessionPrincipal } from './auth.js'

export const CLOUDFLARE_ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'

const defaultTimeoutMs = 5_000
const defaultCacheMaxAgeMs = 10 * 60 * 1_000
const defaultCooldownMs = 30 * 1_000
const maximumAssertionLength = 64 * 1_024
const compactJwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const teamHostnamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/

export type CloudflareAccessFetch = (
  url: string,
  init: {
    headers: Headers
    method: 'GET'
    redirect: 'manual'
    signal: AbortSignal
  },
) => Promise<Response>

export interface CloudflareAccessVerifierConfig {
  /** Canonical Access team origin, for example https://example.cloudflareaccess.com. */
  teamDomain: string
  /** Exact application AUD tag configured by Cloudflare Access. */
  audience: string
  timeoutMs?: number
  cacheMaxAgeMs?: number
  cooldownMs?: number
  fetch?: CloudflareAccessFetch
  /** Injectable validation clock for deterministic boundary tests. */
  now?: () => Date
}

export interface CloudflareAccessAssertion {
  email: string
}

export interface CloudflareAccessVerifier {
  /** Returns null for every malformed, unverifiable, expired, or unavailable assertion. */
  verify(assertion: string): Promise<CloudflareAccessAssertion | null>
}

export interface CloudflareAccessIdentityResolver {
  resolveEmail(address: string): Promise<EmailSignInResolution>
}

export interface CloudflareAccessSessionService extends ApiSessionResolver {
  issue(userId: number): Promise<{
    session: { id: number; userId: number }
    setCookie: string
  }>
}

export interface CloudflareAccessSessionResolverOptions {
  /** Existing application sessions are authoritative and checked first. */
  sessions: CloudflareAccessSessionService
  identities: CloudflareAccessIdentityResolver
  verifier: CloudflareAccessVerifier
}

interface NormalizedVerifierConfig {
  teamDomain: string
  audience: string
  timeoutMs: number
  cacheMaxAgeMs: number
  cooldownMs: number
  fetch?: CloudflareAccessFetch
  now: () => Date
}

const canonicalTeamDomain = (value: string): string => {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new TypeError(
      'Cloudflare Access team domain must be a canonical HTTPS origin',
    )
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(
      'Cloudflare Access team domain must be a canonical HTTPS origin',
    )
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== '/' ||
    value !== url.origin ||
    !teamHostnamePattern.test(url.hostname)
  ) {
    throw new TypeError(
      'Cloudflare Access team domain must be a canonical HTTPS origin',
    )
  }
  return url.origin
}

const printableValue = (
  value: string,
  field: string,
  maximum: number,
): string => {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new TypeError(`${field} must be a non-empty printable value`)
  }
  const length = [...value].length
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
  if (length < 1 || length > maximum || hasControlCharacter) {
    throw new TypeError(`${field} must be a non-empty printable value`)
  }
  return value
}

const integerOption = (
  value: number | undefined,
  fallback: number,
  field: string,
  minimum: number,
  maximum: number,
): number => {
  const resolved = value ?? fallback
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new TypeError(`${field} is invalid`)
  }
  return resolved
}

const normalizedConfig = (
  config: CloudflareAccessVerifierConfig,
): NormalizedVerifierConfig => {
  const cacheMaxAgeMs = integerOption(
    config.cacheMaxAgeMs,
    defaultCacheMaxAgeMs,
    'Cloudflare Access JWKS cache maximum age',
    1,
    24 * 60 * 60 * 1_000,
  )
  const cooldownMs = integerOption(
    config.cooldownMs,
    defaultCooldownMs,
    'Cloudflare Access JWKS cooldown',
    0,
    cacheMaxAgeMs,
  )
  if (config.fetch !== undefined && typeof config.fetch !== 'function') {
    throw new TypeError('Cloudflare Access JWKS fetch must be a function')
  }
  if (config.now !== undefined && typeof config.now !== 'function') {
    throw new TypeError('Cloudflare Access validation clock must be a function')
  }
  return {
    teamDomain: canonicalTeamDomain(config.teamDomain),
    audience: printableValue(
      config.audience,
      'Cloudflare Access audience',
      512,
    ),
    timeoutMs: integerOption(
      config.timeoutMs,
      defaultTimeoutMs,
      'Cloudflare Access JWKS timeout',
      1,
      60_000,
    ),
    cacheMaxAgeMs,
    cooldownMs,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    now: config.now ?? (() => new Date()),
  }
}

/** Validates deployment configuration using the same rules as the verifier. */
export const assertValidCloudflareAccessConfig = (
  config: CloudflareAccessVerifierConfig,
): void => {
  normalizedConfig(config)
}

/**
 * Creates a verifier backed only by the configured team-domain JWKS. The remote
 * resolver caches successful key sets and throttles unknown-key refreshes, while
 * still reloading after the cooldown so Cloudflare signing-key rotation converges.
 */
export const createCloudflareAccessVerifier = (
  config: CloudflareAccessVerifierConfig,
): CloudflareAccessVerifier => {
  const normalized = normalizedConfig(config)
  const jwks = createRemoteJWKSet(
    new URL('/cdn-cgi/access/certs', normalized.teamDomain),
    {
      timeoutDuration: normalized.timeoutMs,
      cacheMaxAge: normalized.cacheMaxAgeMs,
      cooldownDuration: normalized.cooldownMs,
      ...(normalized.fetch === undefined
        ? {}
        : { [customFetch]: normalized.fetch }),
    },
  )

  return {
    verify: async (assertion) => {
      if (
        typeof assertion !== 'string' ||
        assertion.length < 1 ||
        assertion.length > maximumAssertionLength ||
        !compactJwtPattern.test(assertion)
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
        const { payload } = await jwtVerify(assertion, jwks, {
          algorithms: ['RS256'],
          audience: normalized.audience,
          issuer: normalized.teamDomain,
          typ: 'JWT',
          requiredClaims: [
            'aud',
            'email',
            'exp',
            'iat',
            'iss',
            'nbf',
            'sub',
            'type',
          ],
          currentDate,
        })
        const nowSeconds = Math.floor(currentDate.valueOf() / 1_000)
        const { exp, iat, nbf } = payload
        if (
          payload.type !== 'app' ||
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          typeof payload.email !== 'string' ||
          typeof iat !== 'number' ||
          !Number.isSafeInteger(iat) ||
          typeof nbf !== 'number' ||
          !Number.isSafeInteger(nbf) ||
          typeof exp !== 'number' ||
          !Number.isSafeInteger(exp) ||
          iat > nowSeconds ||
          nbf > exp ||
          iat >= exp
        ) {
          return null
        }
        return { email: normalizeIdentityEmail(payload.email) }
      } catch {
        // Signature, claims, JWKS transport, and key-selection failures all deny
        // authentication without reflecting provider or token details.
        return null
      }
    },
  }
}

const principal = (
  identity: Extract<EmailSignInResolution, { status: 'active' }>,
  sessionId: number,
): SessionPrincipal => ({
  type: 'user',
  userId: identity.userId,
  profile: identity.profile,
  managerGrants: [...identity.managerGrants],
  authentication: { kind: 'session', sessionId: String(sessionId) },
})

/**
 * Adds Access as an optional browser identity provider without creating a
 * second application authentication mode. A verified Access email may only
 * select an existing, active user_email row already verified by ezacto; success
 * then issues the same server-side session used by every other browser flow.
 */
export const createCloudflareAccessSessionResolver = (
  options: CloudflareAccessSessionResolverOptions,
): ApiSessionResolver => ({
  resolve: async (request) => {
    const existing = await options.sessions.resolve(request)
    if (existing !== null) return existing

    const assertion = request.headers.get(CLOUDFLARE_ACCESS_JWT_HEADER)
    if (assertion === null) return null
    const verified = await options.verifier.verify(assertion)
    if (verified === null) return null

    const identity = await options.identities.resolveEmail(verified.email)
    if (identity.status !== 'active') return null
    const issued = await options.sessions.issue(identity.userId)
    if (
      !Number.isSafeInteger(issued.session.id) ||
      issued.session.id < 1 ||
      issued.session.userId !== identity.userId
    ) {
      throw new Error(
        'session service returned inconsistent Access session state',
      )
    }
    return {
      principal: principal(identity, issued.session.id),
      setCookie: issued.setCookie,
    }
  },
})
