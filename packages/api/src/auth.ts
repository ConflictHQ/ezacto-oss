import type { Context, Hono, MiddlewareHandler } from 'hono'
import { canProfileUseApiScope, isApiScope, type ApiScope } from '@ezacto/core'
import { captureRequestActivity, type ActivityRecorder } from './activity-log.js'
import type { ApiContext, UserProfile } from './context.js'
import {
  ApiError,
  readJsonBody,
  validationError,
  type FieldError,
} from './errors.js'

export interface ApiTokenMetadata {
  id: number
  name: string
  scopes: string[]
  tokenHint: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export interface IssuedApiToken extends ApiTokenMetadata {
  token: string
}

export interface AuthenticatedApiToken {
  tokenId: number
  userId: number
  profile: UserProfile
  managerGrants?: string[]
  scopes: string[]
}

export interface ApiTokenService {
  authenticate(token: string): Promise<AuthenticatedApiToken | null>
  issue(input: {
    userId: number
    name: string
    scopes: readonly string[]
    expiresAt?: string | null
  }): Promise<IssuedApiToken>
  list(userId: number): Promise<ApiTokenMetadata[]>
  revoke(userId: number, tokenId: number): Promise<ApiTokenMetadata | null>
}

export type SessionPrincipal =
  | {
      type: 'user'
      userId: number
      profile: UserProfile
      managerGrants?: string[]
      authentication: { kind: 'session'; sessionId: string }
    }
  | {
      type: 'contact'
      contactId: number
      clientId: number
      authentication: { kind: 'session'; sessionId: string }
    }

export interface ApiSessionResolver {
  resolve(
    request: Request,
  ): Promise<
    | SessionPrincipal
    | { principal: SessionPrincipal; setCookie?: string }
    | null
  >
}

export interface ApiAuthentication {
  tokens?: ApiTokenService
  sessions?: ApiSessionResolver
  /**
   * Enrolment and recovery for a second factor. Optional, and its absence is a
   * working install rather than a degraded one: an instance that has not turned
   * two-factor on simply does not serve these routes.
   */
  twoFactor?: TwoFactorService
  /** Where credential events are recorded. Absent leaves them unrecorded. */
  activity?: ActivityRecorder
}

const unauthorized = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): never => {
  context.header('www-authenticate', 'Bearer realm="ezacto"')
  throw new ApiError({
    status: 401,
    code: 'authentication_required',
    message: 'A valid API token or user session is required.',
  })
}

const bearerToken = (authorization: string): string | null => {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization)
  return match?.[1] ?? null
}

const safeSessionMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

const requireSameOriginForUnsafeSessionRequest = (request: Request): void => {
  if (safeSessionMethods.has(request.method.toUpperCase())) return
  const origin = request.headers.get('origin')
  if (origin !== null && origin === new URL(request.url).origin) return
  throw new ApiError({
    status: 403,
    code: 'csrf_origin_mismatch',
    message:
      'Session-authenticated mutations require an exact same-origin request.',
  })
}

/**
 * Resolves exactly one credential source. An Authorization header always wins:
 * malformed or invalid bearer credentials never fall back to a session cookie.
 */
export const apiAuthenticationMiddleware =
  <Bindings extends object>(
    authentication: ApiAuthentication | undefined,
  ): MiddlewareHandler<ApiContext<Bindings>> =>
  async (context, next) => {
    const authorization = context.req.header('authorization')
    if (authorization !== undefined) {
      const token = bearerToken(authorization)
      const tokenService = authentication?.tokens
      if (token === null || tokenService === undefined)
        return unauthorized(context)
      const authenticated = await tokenService.authenticate(token)
      if (authenticated === null) return unauthorized(context)
      const scopes = authenticated.scopes
      if (
        !scopes.every(isApiScope) ||
        !scopes.every((scope) =>
          canProfileUseApiScope(authenticated.profile, scope as ApiScope),
        )
      ) {
        return unauthorized(context)
      }
      context.set('principal', {
        type: 'user',
        userId: authenticated.userId,
        profile: authenticated.profile,
        managerGrants: [...(authenticated.managerGrants ?? [])],
        authentication: {
          kind: 'token',
          tokenId: authenticated.tokenId,
          scopes: [...scopes],
        },
      })
      await next()
      return
    }

    requireSameOriginForUnsafeSessionRequest(context.req.raw)
    const resolved = await authentication?.sessions?.resolve(context.req.raw)
    if (resolved === undefined || resolved === null)
      return unauthorized(context)
    const principal = 'principal' in resolved ? resolved.principal : resolved
    if (principal.type === 'contact') {
      throw new ApiError({
        status: 403,
        code: 'contact_api_forbidden',
        message: 'Contact sessions cannot access the organization API.',
      })
    }
    context.set('principal', {
      ...principal,
      managerGrants: [...(principal.managerGrants ?? [])],
    })
    if ('principal' in resolved && resolved.setCookie !== undefined) {
      context.header('set-cookie', resolved.setCookie, { append: true })
    }
    await next()
  }

export const requireApiScope = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  scope: ApiScope,
): void => {
  const principal = context.get('principal')
  if (!canProfileUseApiScope(principal.profile, scope)) {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'The acting user profile cannot perform this operation.',
    })
  }
  if (principal.authentication.kind === 'session') return
  if (principal.authentication.scopes.includes(scope)) return
  throw new ApiError({
    status: 403,
    code: 'insufficient_scope',
    message: `This API token does not grant the ${scope} scope.`,
  })
}

export const requireSessionPrincipal = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): ApiContext<Bindings>['Variables']['principal'] & {
  authentication: { kind: 'session'; sessionId: string }
} => {
  const principal = context.get('principal')
  if (principal.authentication.kind !== 'session') {
    throw new ApiError({
      status: 403,
      code: 'session_required',
      message: 'This operation requires an authenticated user session.',
    })
  }
  return principal as ApiContext<Bindings>['Variables']['principal'] & {
    authentication: { kind: 'session'; sessionId: string }
  }
}

const tokenData = (token: ApiTokenMetadata) => ({
  id: token.id,
  name: token.name,
  scopes: [...token.scopes],
  token_hint: token.tokenHint,
  created_at: token.createdAt,
  last_used_at: token.lastUsedAt,
  expires_at: token.expiresAt,
  revoked_at: token.revokedAt,
})

const tokenId = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested API token does not exist.',
    })
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested API token does not exist.',
    })
  }
  return parsed
}

const issueFields = (body: Record<string, unknown>): FieldError[] => {
  const fields: FieldError[] = []
  const allowedKeys = new Set(['name', 'scopes', 'expires_at'])
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) {
      fields.push({
        field: key,
        code: 'unknown',
        message: `${key} is not accepted`,
      })
    }
  }
  const nameLength =
    typeof body.name === 'string' ? [...body.name.trim()].length : 0
  if (typeof body.name !== 'string' || nameLength < 1 || nameLength > 100) {
    fields.push({
      field: 'name',
      code: 'invalid',
      message: 'name must contain between 1 and 100 characters',
    })
  }
  if (
    !Array.isArray(body.scopes) ||
    body.scopes.length < 1 ||
    body.scopes.length > 100 ||
    !body.scopes.every((scope) => typeof scope === 'string')
  ) {
    fields.push({
      field: 'scopes',
      code: 'invalid',
      message: 'scopes must contain between 1 and 100 scope strings',
    })
  } else if (!body.scopes.every((scope) => isApiScope(scope as string))) {
    fields.push({
      field: 'scopes',
      code: 'unsupported',
      message: 'scopes contains a scope that is not supported',
    })
  } else if (new Set(body.scopes).size !== body.scopes.length) {
    fields.push({
      field: 'scopes',
      code: 'duplicate',
      message: 'scopes must not contain duplicate entries',
    })
  }
  if (
    body.expires_at !== undefined &&
    body.expires_at !== null &&
    typeof body.expires_at !== 'string'
  ) {
    fields.push({
      field: 'expires_at',
      code: 'invalid',
      message: 'expires_at must be a canonical UTC timestamp or null',
    })
  } else if (
    typeof body.expires_at === 'string' &&
    !isCanonicalTimestamp(body.expires_at)
  ) {
    fields.push({
      field: 'expires_at',
      code: 'invalid',
      message: 'expires_at must be a real canonical UTC timestamp',
    })
  }
  return fields
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const isCanonicalTimestamp = (value: string): boolean => {
  const match = canonicalTimestampPattern.exec(value)
  if (!match) return false
  const epoch = Date.parse(value)
  const date = new Date(epoch)
  return (
    Number.isFinite(epoch) &&
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6]) &&
    date.getUTCMilliseconds() === Number((match[7] ?? '').padEnd(3, '0') || 0)
  )
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const installApiTokenRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  tokens: ApiTokenService,
  // Optional so an install without a log still serves tokens. Where it is
  // present the write is awaited, not fired and forgotten: an API token is a
  // credential, and "one was issued and we cannot say who by" is not a state
  // this should be able to reach.
  activity?: ActivityRecorder,
): void => {
  api.get('/api-tokens', async (context) => {
    const principal = requireSessionPrincipal(context)
    return context.json(
      {
        data: (await tokens.list(principal.userId)).map(tokenData),
        links: { self: '/api/v1/api-tokens' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/api-tokens', async (context) => {
    const principal = requireSessionPrincipal(context)
    const parsed = await readJsonBody<unknown>(context)
    if (!isJsonObject(parsed)) {
      throw validationError([
        {
          field: 'body',
          code: 'invalid',
          message: 'request body must be a JSON object',
        },
      ])
    }
    const body = parsed
    const fields = issueFields(body)
    if (fields.length > 0) throw validationError(fields)
    const scopes = body.scopes as ApiScope[]
    if (
      !scopes.every((scope) => canProfileUseApiScope(principal.profile, scope))
    ) {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message:
          'The acting user profile cannot grant one or more requested scopes.',
      })
    }
    try {
      const issued = await tokens.issue({
        userId: principal.userId,
        name: (body.name as string).trim(),
        scopes,
        ...('expires_at' in body
          ? { expiresAt: body.expires_at as string | null }
          : {}),
      })
      if (activity !== undefined) {
        await captureRequestActivity(context, activity, {
          eventType: 'api_token.created',
          subjectId: issued.id,
          occurredAt: issued.createdAt,
          detail: { name: issued.name, scopes: issued.scopes },
        })
      }
      return context.json(
        { data: { ...tokenData(issued), token: issued.token } },
        201,
        { 'cache-control': 'no-store' },
      )
    } catch (error) {
      if (error instanceof RangeError) {
        const field = /scope/.test(error.message) ? 'scopes' : 'expires_at'
        throw validationError([
          { field, code: 'invalid', message: error.message },
        ])
      }
      throw error
    }
  })

  api.delete('/api-tokens/:tokenId', async (context) => {
    const principal = requireSessionPrincipal(context)
    const revoked = await tokens.revoke(
      principal.userId,
      tokenId(context.req.param('tokenId')),
    )
    if (revoked === null) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested API token does not exist.',
      })
    }
    // Recorded from the row's own revoked_at rather than from the clock here,
    // and only when the row carries one. A revocation the database did not
    // record is not one this log should claim happened.
    if (activity !== undefined && revoked.revokedAt !== null) {
      await captureRequestActivity(context, activity, {
        eventType: 'api_token.revoked',
        subjectId: revoked.id,
        occurredAt: revoked.revokedAt,
        detail: { name: revoked.name },
      })
    }
    return context.json({ data: tokenData(revoked) }, 200, {
      'cache-control': 'no-store',
    })
  })
}

/**
 * The second factor as the HTTP layer sees it. Nothing here computes a TOTP
 * code or touches a recovery code hash: the service does that, and keeping the
 * boundary at an interface is what lets the worker and the container share
 * these routes while each supplies its own storage.
 *
 * Every one of these routes is session-only. An API token is a long-lived
 * bearer credential, and letting one enrol, confirm, or remove a second factor
 * would make the token strictly stronger than the password it was issued
 * behind — the opposite of what enrolling is for.
 */
export interface TwoFactorStatus {
  enrolled: boolean
  /** A seed has been issued but no code has proved it, so sign-in is unchanged. */
  pendingConfirmation: boolean
  recoveryCodesRemaining: number
}

export interface TwoFactorEnrolmentOffer {
  secret: string
  otpauthUri: string
  /** Shown once, at enrolment. The service keeps only their hashes. */
  recoveryCodes: readonly string[]
}

export interface TwoFactorService {
  status(userId: number): Promise<TwoFactorStatus>
  beginEnrolment(userId: number): Promise<TwoFactorEnrolmentOffer>
  confirmEnrolment(
    userId: number,
    code: string,
  ): Promise<'enabled' | 'rejected' | 'not_pending'>
  /** `code` is a TOTP code or a recovery code; the service decides which. */
  disable(
    userId: number,
    code: string,
  ): Promise<'disabled' | 'rejected' | 'not_enrolled'>
}

const twoFactorStatusData = (status: TwoFactorStatus) => ({
  enrolled: status.enrolled,
  pending_confirmation: status.pendingConfirmation,
  recovery_codes_remaining: status.recoveryCodesRemaining,
})

const presentedCode = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<string> => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 4 * 1024 })
  if (!isJsonObject(body)) {
    throw validationError([
      {
        field: 'body',
        code: 'invalid',
        message: 'request body must be a JSON object',
      },
    ])
  }
  const fields: FieldError[] = Object.keys(body)
    .filter((field) => field !== 'code')
    .map((field) => ({
      field,
      code: 'unknown',
      message: `${field} is not accepted`,
    }))
  // Length only. Which shapes are codes is the service's business, and
  // answering "that is not a TOTP code" here would tell an attacker which of
  // the two kinds of credential the endpoint just turned down.
  if (
    typeof body.code !== 'string' ||
    body.code.length < 1 ||
    body.code.length > 64
  ) {
    fields.push({
      field: 'code',
      code: 'required',
      message: 'code must contain between 1 and 64 characters',
    })
  }
  if (fields.length > 0) throw validationError(fields)
  return body.code as string
}

const rejectedCode = (): never => {
  throw new ApiError({
    status: 401,
    code: 'invalid_two_factor_code',
    message: 'The verification code is invalid.',
  })
}

export const installTwoFactorRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: TwoFactorService,
): void => {
  api.get('/two-factor', async (context) => {
    const principal = requireSessionPrincipal(context)
    return context.json(
      {
        data: twoFactorStatusData(await service.status(principal.userId)),
        links: { self: '/api/v1/two-factor' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/two-factor', async (context) => {
    const principal = requireSessionPrincipal(context)
    let offer: TwoFactorEnrolmentOffer
    try {
      offer = await service.beginEnrolment(principal.userId)
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'TwoFactorEnrolmentLockedError'
      ) {
        throw new ApiError({
          status: 409,
          code: 'two_factor_already_enabled',
          message:
            'Two-factor authentication is already enabled. Remove it before enrolling again.',
        })
      }
      throw error
    }
    return context.json(
      {
        data: {
          secret: offer.secret,
          otpauth_uri: offer.otpauthUri,
          recovery_codes: [...offer.recoveryCodes],
        },
        links: { self: '/api/v1/two-factor' },
      },
      201,
      { 'cache-control': 'no-store' },
    )
  })

  api.post('/two-factor/confirm', async (context) => {
    const principal = requireSessionPrincipal(context)
    const code = await presentedCode(context)
    const result = await service.confirmEnrolment(principal.userId, code)
    if (result === 'rejected') rejectedCode()
    if (result === 'not_pending') {
      throw new ApiError({
        status: 409,
        code: 'no_pending_enrolment',
        message: 'There is no two-factor enrolment waiting to be confirmed.',
      })
    }
    return context.json(
      {
        data: twoFactorStatusData(await service.status(principal.userId)),
        links: { self: '/api/v1/two-factor' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.delete('/two-factor', async (context) => {
    const principal = requireSessionPrincipal(context)
    const code = await presentedCode(context)
    const result = await service.disable(principal.userId, code)
    if (result === 'rejected') rejectedCode()
    if (result === 'not_enrolled') {
      throw new ApiError({
        status: 409,
        code: 'two_factor_not_enabled',
        message: 'Two-factor authentication is not enabled for this user.',
      })
    }
    return context.json(
      {
        data: twoFactorStatusData(await service.status(principal.userId)),
        links: { self: '/api/v1/two-factor' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
