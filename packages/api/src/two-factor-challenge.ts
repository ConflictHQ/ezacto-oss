import type { Context, Hono } from 'hono'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError, type FieldError } from './errors.js'

/**
 * The step between "the password was right" and "here is a session".
 *
 * Issue 731: every sign-in path called `sessions.issue` the moment the primary
 * credential checked out, so a user who had enrolled a second factor was
 * protected by nothing but the belief that they were. This module is the gate
 * those paths were missing, and it is deliberately one module rather than a
 * branch in each of them -- a second factor that four routes each implement
 * their own way is a second factor three routes will eventually skip.
 *
 * Which paths use it is a policy decision, recorded in docs/security.md: the
 * gate guards the credentials ezacto itself verifies (password, staff magic
 * link). Federated sign-ins are exempt because the identity provider owns the
 * factor policy for the account it is asserting, and a second prompt here
 * would neither add a factor the IdP lacks nor be one this instance could
 * enforce on the IdP's own session.
 */

/** Host-scoped and path-wide: the redirect leg lands on `/`, not on the API. */
export const TWO_FACTOR_CHALLENGE_COOKIE = '__Host-ezacto_2fa_challenge'

const CHALLENGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type TwoFactorChallengeVerdict =
  | { status: 'accepted'; userId: number }
  | { status: 'rejected' }
  | { status: 'locked' }
  | { status: 'unknown_challenge' }

export interface TwoFactorGate {
  /** True only for a confirmed enrolment. A pending one changes no sign-in. */
  isEnrolled(userId: number): Promise<boolean>
  issueChallenge(userId: number): Promise<{ token: string; expiresAt: string }>
  redeemChallenge(token: string, code: string): Promise<TwoFactorChallengeVerdict>
}

export interface TwoFactorChallengeSessionIssuer {
  issue(userId: number): Promise<{ setCookie: string }>
}

export interface TwoFactorChallengeRouteOptions {
  gate: TwoFactorGate
  sessions: TwoFactorChallengeSessionIssuer
}

const challengeCookie = (token: string, expiresAt: string): string => {
  if (!CHALLENGE_TOKEN_PATTERN.test(token)) {
    throw new Error('two-factor gate returned malformed challenge material')
  }
  const expires = new Date(expiresAt)
  if (!Number.isFinite(expires.valueOf())) {
    throw new Error('two-factor gate returned a malformed challenge expiry')
  }
  return `${TWO_FACTOR_CHALLENGE_COOKIE}=${token}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`
}

export const expiredChallengeCookie = (): string =>
  `${TWO_FACTOR_CHALLENGE_COOKIE}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const cookieValue = (request: Request): string | null => {
  const header = request.headers.get('cookie')
  if (header === null) return null
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${TWO_FACTOR_CHALLENGE_COOKIE}=`))
    .map((part) => part.slice(TWO_FACTOR_CHALLENGE_COOKIE.length + 1))
  if (matches.length !== 1 || matches[0] === '') return null
  return matches[0]!
}

export interface ChallengedSignIn {
  status: 'two_factor_required'
  expiresAt: string
  /**
   * The same token the cookie carries. Named in the body as well because the
   * native clients do not keep cookies, and because it is worth nothing on its
   * own -- it names a user and buys the holder the right to be asked for a code.
   */
  token: string
}

/**
 * The one thing a sign-in route calls once it knows who the user is. Either it
 * hands back the session cookie it always did, or it hands back a challenge and
 * no session at all. There is no third answer, and no way to get the session
 * without going back through `redeemChallenge`.
 */
export const issueSessionOrChallenge = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  options: { gate?: TwoFactorGate; sessions: TwoFactorChallengeSessionIssuer },
  userId: number,
): Promise<ChallengedSignIn | null> => {
  if (options.gate !== undefined && (await options.gate.isEnrolled(userId))) {
    const challenge = await options.gate.issueChallenge(userId)
    context.header('set-cookie', challengeCookie(challenge.token, challenge.expiresAt), {
      append: true,
    })
    return {
      status: 'two_factor_required',
      expiresAt: challenge.expiresAt,
      token: challenge.token,
    }
  }
  const session = await options.sessions.issue(userId)
  context.header('set-cookie', session.setCookie, { append: true })
  // A challenge left over from an abandoned attempt would otherwise sit in the
  // browser until it expired, and be presented at the next sign-in.
  context.header('set-cookie', expiredChallengeCookie(), { append: true })
  return null
}

const presented = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<{ token: string; code: string }> => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 4 * 1024 })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
    ])
  }
  const record = body as Record<string, unknown>
  const fields: FieldError[] = Object.keys(record)
    .filter((field) => field !== 'code' && field !== 'challenge')
    .map((field) => ({
      field,
      code: 'unknown',
      message: `${field} is not accepted`,
    }))
  // Length only, as on the settings routes: saying which kind of credential
  // was malformed tells an attacker which of the two the endpoint just read.
  if (
    typeof record.code !== 'string' ||
    record.code.length < 1 ||
    record.code.length > 64
  ) {
    fields.push({
      field: 'code',
      code: 'required',
      message: 'code must contain between 1 and 64 characters',
    })
  }
  if (record.challenge !== undefined && typeof record.challenge !== 'string') {
    fields.push({
      field: 'challenge',
      code: 'invalid',
      message: 'challenge must be a string',
    })
  }
  if (fields.length > 0) throw validationError(fields)
  const token =
    typeof record.challenge === 'string' && record.challenge !== ''
      ? record.challenge
      : cookieValue(context.req.raw)
  if (token === null) {
    throw new ApiError({
      status: 401,
      code: 'two_factor_challenge_invalid',
      message: 'The sign-in challenge is invalid, already used, or expired.',
    })
  }
  return { token, code: record.code as string }
}

export const installTwoFactorChallengeRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: TwoFactorChallengeRouteOptions,
): void => {
  app.post('/auth/two-factor/challenge', async (context) => {
    const { token, code } = await presented(context)
    const verdict = await options.gate.redeemChallenge(token, code)
    if (verdict.status === 'locked') {
      throw new ApiError({
        status: 429,
        code: 'two_factor_locked',
        message: 'Too many incorrect verification codes. Try again later.',
      })
    }
    if (verdict.status === 'rejected') {
      throw new ApiError({
        status: 401,
        code: 'invalid_two_factor_code',
        message: 'The verification code is invalid.',
      })
    }
    if (verdict.status === 'unknown_challenge') {
      // The challenge is gone, so the cookie carrying it is worthless; leaving
      // it would make the next sign-in present a token that cannot succeed.
      context.header('set-cookie', expiredChallengeCookie(), { append: true })
      throw new ApiError({
        status: 401,
        code: 'two_factor_challenge_invalid',
        message: 'The sign-in challenge is invalid, already used, or expired.',
      })
    }
    const session = await options.sessions.issue(verdict.userId)
    context.header('set-cookie', session.setCookie, { append: true })
    context.header('set-cookie', expiredChallengeCookie(), { append: true })
    return context.json({ data: { status: 'authenticated' as const } }, 200, {
      'cache-control': 'no-store',
    })
  })
}
