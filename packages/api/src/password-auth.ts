import type { Hono } from 'hono'
import type { ResolvedUserIdentity } from '@ezacto/core'
import type { ApiContext } from './context.js'
import {
  ApiError,
  readJsonBody,
  validationError,
  type FieldError,
} from './errors.js'
import {
  issueSessionOrChallenge,
  type TwoFactorGate,
} from './two-factor-challenge.js'
import {
  signInMethodUnavailable,
  type SignInMethodPolicy,
} from './sign-in-methods.js'

export type AuthTokenKind = 'verify_email' | 'password_reset'

export interface AuthDelivery {
  kind: AuthTokenKind
  to: string
  token: string
  expiresAt: string
}

export interface PasswordAuthService {
  signup(input: {
    organizationName: string
    firstName: string
    lastName: string
    email: string
    password: string
    clientKey: string
  }): Promise<AuthDelivery>
  verifyEmail(token: string, clientKey: string): Promise<ResolvedUserIdentity>
  signIn(input: {
    email: string
    password: string
    clientKey: string
  }): Promise<
    | {
        status: 'authenticated'
        principal: ResolvedUserIdentity
        credentialVersion: number
      }
    | { status: 'invalid_credentials' }
    | { status: 'verification_required' }
  >
  requestPasswordReset(
    email: string,
    clientKey: string,
  ): Promise<AuthDelivery | null>
  resetPassword(
    token: string,
    password: string,
    clientKey: string,
  ): Promise<ResolvedUserIdentity>
}

/** Durable queue boundary. Provider calls happen behind this interface, never in the request. */
export interface AuthMailer {
  assertAvailable(kind: AuthTokenKind): Promise<void>
  enqueue(delivery: AuthDelivery): Promise<void>
}

export interface PasswordSessionIssuer {
  issue(
    userId: number,
    credentialVersion?: number,
  ): Promise<{ setCookie: string }>
}

export interface PasswordAuthRouteOptions {
  service: PasswordAuthService
  sessions: PasswordSessionIssuer
  /**
   * Issue 731. Absent only where the deployment composes no two-factor
   * service; where it is present, an enrolled user gets a challenge here and
   * no session until a code answers it.
   */
  twoFactor?: TwoFactorGate
  /**
   * Issue 761. When the operator has switched the password method off, the
   * whole family goes with it -- signing in, signing up, and the reset legs
   * that mint a password. Absent where no policy is composed, which leaves the
   * routes mounted exactly as they always were.
   */
  policy?: SignInMethodPolicy
  /**
   * Issue 732. Whether first-run signup is closed for this deployment.
   *
   * `/auth/signup` claims the instance: it creates organization 1 and user 1 as
   * administrator, and the claim is permanent. On a freshly deployed instance
   * that is a race between the operator and whoever finds the hostname first,
   * and the loser has no route back that does not involve the database.
   *
   * An operator who has set a bootstrap token has said they will claim the
   * instance through it. Closing this route is what makes that a statement
   * rather than a hope.
   */
  firstRunClosed?: (bindings: unknown) => boolean
  /** Deployment-brand sender used for every authentication email. */
  deploymentMailer?: AuthMailer
  clientKey(request: Request): string
}

const requireMailer = (mailer: AuthMailer | undefined): AuthMailer => {
  if (mailer !== undefined) return mailer
  throw new ApiError({
    status: 503,
    code: 'mailer_unavailable',
    message: 'Authentication email delivery is temporarily unavailable.',
  })
}

const bodyRecord = async (context: Parameters<typeof readJsonBody>[0]) => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 16 * 1024 })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
    ])
  }
  return body as Record<string, unknown>
}

const exactStringBody = async (
  context: Parameters<typeof readJsonBody>[0],
  required: readonly string[],
): Promise<Record<string, string>> => {
  const body = await bodyRecord(context)
  const accepted = new Set(required)
  const fields: FieldError[] = [
    ...required
      .filter((field) => typeof body[field] !== 'string' || body[field] === '')
      .map((field) => ({
        field,
        code: 'required',
        message: `${field} must be a non-empty string`,
      })),
    ...Object.keys(body)
      .filter((field) => !accepted.has(field))
      .map((field) => ({
        field,
        code: 'unknown',
        message: `${field} is not accepted`,
      })),
  ]
  if (fields.length > 0) throw validationError(fields)
  return Object.fromEntries(
    required.map((field) => [field, body[field] as string]),
  )
}

const safePrincipal = (principal: ResolvedUserIdentity) => ({
  user_id: principal.userId,
  profile: principal.profile,
  manager_grants: [...principal.managerGrants],
})

const translateAuthError = (error: unknown): never => {
  if (error instanceof Error && error.name === 'AuthRateLimitError') {
    const retryAfter =
      'retryAfterSeconds' in error &&
      typeof error.retryAfterSeconds === 'number'
        ? error.retryAfterSeconds
        : 60
    throw new ApiError({
      status: 429,
      code: 'rate_limit_exceeded',
      message: `Too many authentication attempts. Retry in ${retryAfter} seconds.`,
    })
  }
  if (
    error instanceof Error &&
    error.name === 'FirstRunSignupUnavailableError'
  ) {
    throw new ApiError({
      status: 409,
      code: 'signup_unavailable',
      message: 'First-run signup is no longer available for this instance.',
    })
  }
  if (error instanceof Error && error.name === 'InvalidAuthTokenError') {
    throw new ApiError({
      status: 401,
      code: 'invalid_auth_token',
      message: 'The authentication token is invalid, expired, or already used.',
    })
  }
  if (
    error instanceof Error &&
    error.name === 'PasswordDerivationOverloadedError'
  ) {
    throw new ApiError({
      status: 503,
      code: 'service_unavailable',
      message: 'Authentication is temporarily unavailable.',
    })
  }
  if (
    error instanceof Error &&
    error.name === 'SessionCredentialChangedError'
  ) {
    throw new ApiError({
      status: 401,
      code: 'invalid_credentials',
      message: 'The email address or password is invalid.',
    })
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    throw validationError([
      {
        field: 'credentials',
        code: 'invalid',
        message: 'The authentication fields are invalid.',
      },
    ])
  }
  throw error
}

export const installPasswordAuthRoutes = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: PasswordAuthRouteOptions,
): void => {
  // Checked inside each handler rather than at mount, because the setting can
  // change under a running instance and a route decided once at startup would
  // keep answering for as long as the isolate lived. Hiding the form is not
  // enough either way: a hidden form is still a mounted endpoint.
  const assertLive = async (bindings: unknown): Promise<void> => {
    if (options.policy === undefined) return
    if (!(await options.policy.isLive('password', bindings))) signInMethodUnavailable()
  }

  app.post('/auth/signup', async (context) => {
    await assertLive(context.env)
    if (options.firstRunClosed?.(context.env) === true) {
      throw new ApiError({
        status: 404,
        code: 'signup_unavailable',
        // Says the route is not here, not that a claim already exists: which of
        // those it is would tell an unauthenticated caller whether an instance
        // is still unclaimed, and that is the thing worth racing for.
        message: 'First-run signup is not available on this instance.',
      })
    }
    const body = await exactStringBody(context, [
      'organization_name',
      'first_name',
      'last_name',
      'email',
      'password',
    ])
    try {
      const mailer = requireMailer(options.deploymentMailer)
      await mailer.assertAvailable('verify_email')
      const delivery = await options.service.signup({
        organizationName: body.organization_name!,
        firstName: body.first_name!,
        lastName: body.last_name!,
        email: body.email!,
        password: body.password!,
        clientKey: options.clientKey(context.req.raw),
      })
      await mailer.enqueue(delivery)
      return context.json(
        { data: { status: 'verification_sent' as const } },
        202,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      translateAuthError(error)
    }
  })

  app.post('/auth/verify-email', async (context) => {
    await assertLive(context.env)
    const body = await exactStringBody(context, ['token'])
    try {
      const verified = await options.service.verifyEmail(
        body.token!,
        options.clientKey(context.req.raw),
      )
      return context.json(
        { data: { status: 'verified' as const, ...safePrincipal(verified) } },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      translateAuthError(error)
    }
  })

  app.post('/auth/sign-in', async (context) => {
    await assertLive(context.env)
    const body = await exactStringBody(context, ['email', 'password'])
    try {
      const result = await options.service.signIn({
        email: body.email!,
        password: body.password!,
        clientKey: options.clientKey(context.req.raw),
      })
      if (result.status === 'invalid_credentials') {
        throw new ApiError({
          status: 401,
          code: 'invalid_credentials',
          message: 'The email address or password is invalid.',
        })
      }
      if (result.status === 'verification_required') {
        throw new ApiError({
          status: 403,
          code: 'email_verification_required',
          message: 'Verify this email address before signing in.',
        })
      }
      // The credential version is checked as the session is issued, so an
      // enrolled user's version is carried on the challenge rather than
      // dropped: `redeemChallenge` issues without it, and a password changed
      // during the challenge revokes every session the change touches anyway.
      const challenge = await issueSessionOrChallenge(
        context,
        {
          ...(options.twoFactor === undefined ? {} : { gate: options.twoFactor }),
          sessions: {
            issue: (userId) =>
              options.sessions.issue(userId, result.credentialVersion),
          },
        },
        result.principal.userId,
      )
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
          { 'cache-control': 'no-store' },
        )
      }
      return context.json(
        {
          data: {
            status: 'authenticated' as const,
            ...safePrincipal(result.principal),
          },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      translateAuthError(error)
    }
  })

  app.post('/auth/password/forgot', async (context) => {
    await assertLive(context.env)
    const body = await exactStringBody(context, ['email'])
    try {
      const mailer = requireMailer(options.deploymentMailer)
      await mailer.assertAvailable('password_reset')
      const delivery = await options.service.requestPasswordReset(
        body.email!,
        options.clientKey(context.req.raw),
      )
      if (delivery !== null) await mailer.enqueue(delivery)
      return context.json(
        { data: { status: 'reset_requested' as const } },
        202,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      translateAuthError(error)
    }
  })

  app.post('/auth/password/reset', async (context) => {
    await assertLive(context.env)
    const body = await exactStringBody(context, ['token', 'password'])
    try {
      const reset = await options.service.resetPassword(
        body.token!,
        body.password!,
        options.clientKey(context.req.raw),
      )
      return context.json(
        {
          data: { status: 'password_reset' as const, ...safePrincipal(reset) },
        },
        200,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      translateAuthError(error)
    }
  })
}
