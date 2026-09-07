import type { Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import type { AuthDelivery, AuthMailer } from './password-auth.js'
import { assertFields, readObjectBody, resourceId, unknownFieldErrors } from './resources/support.js'

export interface UserEmailService {
  addEmail(input: { userId: number; email: string; clientKey: string }): Promise<AuthDelivery>
}

export interface UserEmailRouteOptions {
  service: UserEmailService
  /** Deployment-brand sender. The same one the other authentication mail goes out under. */
  deploymentMailer?: AuthMailer
  clientKey(request: Request): string
}

const bodyKeys = new Set(['email'])

const translate = (error: unknown): never => {
  if (error instanceof Error && error.name === 'AuthRateLimitError') {
    const retryAfter =
      'retryAfterSeconds' in error && typeof error.retryAfterSeconds === 'number'
        ? error.retryAfterSeconds
        : 60
    throw new ApiError({
      status: 429,
      code: 'rate_limit_exceeded',
      message: `Too many verification requests. Retry in ${retryAfter} seconds.`,
    })
  }
  if (error instanceof Error && error.name === 'EmailAddressUnavailableError') {
    throw new ApiError({
      status: 409,
      code: 'email_in_use',
      message: 'That email address is already on an account.',
    })
  }
  if (error instanceof Error && error.name === 'UnknownUserError') {
    throw new ApiError({ status: 404, code: 'not_found', message: 'The user does not exist.' })
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    throw new ApiError({
      status: 422,
      code: 'invalid_input',
      message: 'The email address is invalid.',
      fields: [{ field: 'email', code: 'invalid', message: 'email must be an email address' }],
    })
  }
  throw error
}

/**
 * Adding an address, not changing one. People here need both: the personal
 * address is what time entries match Deel and Wise by, the work address is what
 * Google signs them in with, and the resource-update path would have replaced
 * one with the other. The new address arrives pending and non-primary, and
 * `POST /auth/verify-email` finishes it with the token this route mails.
 */
export const installUserEmailRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: UserEmailRouteOptions,
): void => {
  api.post('/users/:id/emails', async (context) => {
    const principal = requireSessionPrincipal(context)
    const userId = resourceId(context.req.param('id'), 'user')
    if (
      principal.userId !== userId &&
      principal.profile !== 'administrator' &&
      principal.profile !== 'people_admin'
    ) {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only the person themselves or a people administrator can add an address.',
      })
    }
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, bodyKeys)
    if (typeof body.email !== 'string' || body.email.trim() === '') {
      errors.push({
        field: 'email',
        code: body.email === undefined ? 'required' : 'invalid',
        message: 'email must be a non-empty string',
      })
    }
    assertFields(errors)
    const mailer = options.deploymentMailer
    if (mailer === undefined) {
      throw new ApiError({
        status: 503,
        code: 'mailer_unavailable',
        message: 'Authentication email delivery is temporarily unavailable.',
      })
    }
    try {
      await mailer.assertAvailable('verify_email')
      const delivery = await options.service.addEmail({
        userId,
        email: body.email as string,
        clientKey: options.clientKey(context.req.raw),
      })
      await mailer.enqueue(delivery)
      return context.json(
        { data: { status: 'verification_sent' as const, email: delivery.to } },
        202,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      return translate(error)
    }
  })
}
