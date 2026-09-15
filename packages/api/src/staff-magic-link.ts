import type { Context, Hono } from 'hono'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError } from './errors.js'
import type { OidcAppCodeStorePort } from './oidc.js'
import {
  issueSessionOrChallenge,
  type TwoFactorGate,
} from './two-factor-challenge.js'
import {
  signInMethodUnavailable,
  type SignInMethodPolicy,
} from './sign-in-methods.js'

export const STAFF_MAGIC_LINK_TTL_MS = 10 * 60 * 1_000
export const STAFF_MAGIC_LINK_THROTTLE_MS = 60 * 1_000
export const STAFF_MAGIC_LINK_MAX_CODE_ATTEMPTS = 5
export const DEFAULT_STAFF_MAGIC_LINK_APP_REDIRECT_URI = 'ezacto://auth/callback'

export type StaffMagicLinkFlow = 'app' | 'web'

/** The email the mailer must deliver: both a tappable link and a typed code. */
export interface StaffMagicLinkDelivery {
  kind: 'magic_link_signin'
  to: string
  link: string
  code: string
  expiresAt: string
}

export interface StaffMagicLinkMailer {
  enqueue(delivery: StaffMagicLinkDelivery): Promise<void>
}

export interface StaffMagicLinkStorePort {
  create(input: {
    userId: number
    tokenHash: string
    codeHash: string
    flow: StaffMagicLinkFlow
    expiresAt: string
    createdAt: string
    cleanupBefore: string
  }): Promise<'created' | 'collision'>
  consumeByToken(
    tokenHash: string,
    now: string
  ): Promise<{ userId: number; flow: StaffMagicLinkFlow } | null>
  consumeByCode(
    userId: number,
    codeHash: string,
    now: string,
    maxAttempts: number
  ): Promise<{ userId: number; flow: StaffMagicLinkFlow } | null>
  hasActiveLink(userId: number, now: string, since: string): Promise<boolean>
}

export interface StaffUserDirectory {
  /** The active staff user for an address, or null. Never reveals existence. */
  findByEmail(email: string): Promise<{ userId: number } | null>
}

export interface StaffSessionIssuer {
  issue(userId: number): Promise<{ setCookie: string }>
}

export interface StaffMagicLinkRouteOptions<Bindings extends object> {
  users: StaffUserDirectory
  magicLinks: StaffMagicLinkStorePort
  sessions: StaffSessionIssuer
  /**
   * Issue 731. A magic link is a credential this instance issued and verified,
   * so an enrolled user still owes a code before the link becomes a session.
   */
  twoFactor?: TwoFactorGate
  /** Issue 761. All three legs go together when the operator switches it off. */
  policy?: SignInMethodPolicy
  /** Reused OIDC app-code store: bridges a tapped link to the native app. */
  appCodes: OidcAppCodeStorePort
  /**
   * Absent where the deployment turned magic-link on (it has the key) but has
   * no email transport: the routes still mount so the surface is one decision,
   * and the request leg answers 503 rather than pretending to send.
   */
  mailer?: StaffMagicLinkMailer
  /** HMAC key for the low-entropy code, so a DB leak alone cannot brute it. */
  codeKey: Uint8Array
  /** Public origin the emailed link points at (not the request host). */
  linkOrigin(bindings: Bindings): string
  appRedirectUri?: string
  now?: () => string
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const sha256Hex = async (value: string): Promise<string> =>
  toHex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    )
  )

const hmacHex = async (value: string, key: Uint8Array): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>
  )
  return toHex(new Uint8Array(signature))
}

const generateToken = (): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(32)))

const generateCode = (): string => {
  // A uniform 6-digit code (000000–999999) from rejection-free modular reduction
  // over a large random draw; the tiny bias is immaterial next to the 5-attempt
  // ceiling and 10-minute expiry.
  const [value] = crypto.getRandomValues(new Uint32Array(1))
  return (value! % 1_000_000).toString().padStart(6, '0')
}

const codePattern = /^[0-9]{6}$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/

const accepted = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>
) =>
  context.json({ data: { status: 'magic_link_sent' as const } }, 202, {
    'cache-control': 'no-store',
  })

const noStoreRedirect = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  location: string
) => {
  context.header('cache-control', 'no-store')
  context.header('referrer-policy', 'no-referrer')
  return context.redirect(location, 303)
}

export const installStaffMagicLinkRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: StaffMagicLinkRouteOptions<Bindings>
): void => {
  const now = options.now ?? (() => new Date().toISOString())
  const appRedirectUri =
    options.appRedirectUri ?? DEFAULT_STAFF_MAGIC_LINK_APP_REDIRECT_URI
  const assertLive = async (bindings: unknown): Promise<void> => {
    if (options.policy === undefined) return
    if (!(await options.policy.isLive('magic_link', bindings))) {
      signInMethodUnavailable()
    }
  }

  app.post('/auth/magic-link', async (context) => {
    await assertLive(context.env)
    // A deployment-level state, identical for every address, so returning it
    // before the lookup leaks nothing about who has an account.
    if (options.mailer === undefined) {
      throw new ApiError({
        status: 503,
        code: 'magic_link_unavailable',
        message: 'Sign-in email is not configured on this instance.',
      })
    }
    const mailer = options.mailer
    const body = await readJsonBody<unknown>(context, { maxBytes: 4 * 1024 })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
      ])
    }
    const record = body as Record<string, unknown>
    const email =
      typeof record.email === 'string' ? record.email.trim().toLowerCase() : ''
    if (email.length < 3 || email.length > 254 || !emailPattern.test(email)) {
      throw validationError([
        { field: 'email', code: 'invalid', message: 'a valid email is required' },
      ])
    }
    const flow: StaffMagicLinkFlow = record.flow === 'app' ? 'app' : 'web'
    for (const key of Object.keys(record)) {
      if (key !== 'email' && key !== 'flow') {
        throw validationError([
          { field: key, code: 'unknown', message: `${key} is not accepted` },
        ])
      }
    }

    // Never reveal whether an address maps to a user: unknown emails and
    // throttled repeats return the same 202 as a freshly sent link.
    const user = await options.users.findByEmail(email)
    if (user === null) return accepted(context)

    const issuedAt = now()
    const since = new Date(
      Date.parse(issuedAt) - STAFF_MAGIC_LINK_THROTTLE_MS
    ).toISOString()
    if (await options.magicLinks.hasActiveLink(user.userId, issuedAt, since)) {
      return accepted(context)
    }

    const token = generateToken()
    const code = generateCode()
    const expiresAt = new Date(
      Date.parse(issuedAt) + STAFF_MAGIC_LINK_TTL_MS
    ).toISOString()
    const created = await options.magicLinks.create({
      userId: user.userId,
      tokenHash: await sha256Hex(token),
      codeHash: await hmacHex(code, options.codeKey),
      flow,
      expiresAt,
      createdAt: issuedAt,
      cleanupBefore: new Date(
        Date.parse(issuedAt) - STAFF_MAGIC_LINK_TTL_MS
      ).toISOString(),
    })
    if (created !== 'created') return accepted(context)

    const link = new URL('/auth/magic-link/verify', options.linkOrigin(context.env))
    link.searchParams.set('token', token)
    if (flow === 'app') link.searchParams.set('flow', 'app')

    await mailer.enqueue({
      kind: 'magic_link_signin',
      to: email,
      link: link.href,
      code,
      expiresAt,
    })
    return accepted(context)
  })

  app.get('/auth/magic-link/verify', async (context) => {
    await assertLive(context.env)
    const token = context.req.query('token')
    if (typeof token !== 'string' || !tokenPattern.test(token)) {
      throw new ApiError({
        status: 400,
        code: 'magic_link_invalid',
        message: 'The sign-in link is malformed.',
      })
    }
    const at = now()
    const redemption = await options.magicLinks.consumeByToken(
      await sha256Hex(token),
      at
    )
    if (redemption === null) {
      throw new ApiError({
        status: 401,
        code: 'magic_link_invalid',
        message: 'The sign-in link is invalid, already used, or expired.',
      })
    }
    if (redemption.flow === 'app') {
      const appCode = generateToken()
      const created = await options.appCodes.create({
        provider: 'magic-link',
        codeHash: await sha256Hex(appCode),
        userId: redemption.userId,
        createdAt: at,
        expiresAt: new Date(Date.parse(at) + 2 * 60 * 1_000).toISOString(),
        cleanupBefore: new Date(Date.parse(at) - 2 * 60 * 1_000).toISOString(),
      })
      if (created !== 'created') {
        throw new ApiError({
          status: 503,
          code: 'magic_link_unavailable',
          message: 'Could not complete app sign-in. Try again.',
        })
      }
      const target = new URL(appRedirectUri)
      target.searchParams.set('code', appCode)
      return noStoreRedirect(context, target.href)
    }
    // The challenge token rides in the HttpOnly cookie the gate sets, never in
    // the location: a redirect URL reaches the referrer header, the history and
    // any proxy log. The query flag carries no credential -- it only tells the
    // shell to open on the code step instead of the password form.
    const challenge = await issueSessionOrChallenge(
      context,
      {
        ...(options.twoFactor === undefined ? {} : { gate: options.twoFactor }),
        sessions: options.sessions,
      },
      redemption.userId,
    )
    return noStoreRedirect(context, challenge === null ? '/' : '/?two_factor=1')
  })

  app.post('/auth/magic-link/exchange', async (context) => {
    await assertLive(context.env)
    const body = await readJsonBody<unknown>(context, { maxBytes: 4 * 1024 })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
      ])
    }
    const record = body as Record<string, unknown>
    const email =
      typeof record.email === 'string' ? record.email.trim().toLowerCase() : ''
    const code = typeof record.code === 'string' ? record.code.trim() : ''
    if (!emailPattern.test(email) || !codePattern.test(code)) {
      throw validationError([
        {
          field: 'code',
          code: 'invalid',
          message: 'a valid email and 6-digit code are required',
        },
      ])
    }
    const invalid = new ApiError({
      status: 401,
      code: 'magic_link_invalid',
      message: 'The code is invalid, already used, or expired.',
    })
    const user = await options.users.findByEmail(email)
    if (user === null) throw invalid
    const redemption = await options.magicLinks.consumeByCode(
      user.userId,
      await hmacHex(code, options.codeKey),
      now(),
      STAFF_MAGIC_LINK_MAX_CODE_ATTEMPTS
    )
    if (redemption === null) throw invalid
    const challenge = await issueSessionOrChallenge(
      context,
      {
        ...(options.twoFactor === undefined ? {} : { gate: options.twoFactor }),
        sessions: options.sessions,
      },
      redemption.userId,
    )
    context.header('cache-control', 'no-store')
    if (challenge !== null) {
      return context.json(
        {
          data: {
            status: challenge.status,
            challenge: challenge.token,
            expires_at: challenge.expiresAt,
          },
        },
        200,
      )
    }
    return context.json({ data: { ok: true } }, 200)
  })
}
