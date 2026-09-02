import type { Hono } from 'hono'
import type { ResolvedUserIdentity } from '@ezacto/core'
import { SenderIdentityUnavailableError } from '@ezacto/mailer'
import type { ApiContext } from './context.js'
import {
  ApiError,
  readJsonBody,
  validationError,
  type FieldError,
} from './errors.js'

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
  mailer?: AuthMailer
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
  if (error instanceof SenderIdentityUnavailableError) {
    throw new ApiError({
      status: 503,
      code: 'sender_identity_unverified',
      message: error.message,
    })
  }
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
  app.post('/auth/signup', async (context) => {
    const body = await exactStringBody(context, [
      'organization_name',
      'first_name',
      'last_name',
      'email',
      'password',
    ])
    try {
      const mailer = requireMailer(options.mailer)
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
      const session = await options.sessions.issue(
        result.principal.userId,
        result.credentialVersion,
      )
      context.header('set-cookie', session.setCookie, { append: true })
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
    const body = await exactStringBody(context, ['email'])
    try {
      const mailer = requireMailer(options.mailer)
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
