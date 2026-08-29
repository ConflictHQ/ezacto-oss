import type { Hono } from 'hono'
import type { ResolvedUserIdentity } from '@ezacto/core'
import type { ApiContext } from './context.js'
import {
  requireSessionPrincipal,
  type ApiSessionResolver,
  type SessionPrincipal,
} from './auth.js'
import { ApiError } from './errors.js'

export const SESSION_COOKIE_NAME = '__Host-ezacto_session'

export type SessionRevocationReason =
  'user_revoked' | 'privilege_change' | 'password_reset' | 'user_disabled'

export interface SessionMetadata {
  id: number
  userId: number
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
  revocationReason: SessionRevocationReason | null
}

export interface SessionStorePort {
  issue(
    userId: number,
    credentialVersion?: number,
  ): Promise<{ token: string; session: SessionMetadata }>
  authenticate(token: string): Promise<{
    principal: ResolvedUserIdentity
    session: SessionMetadata
    rotatedToken?: string
  } | null>
  list(userId: number): Promise<SessionMetadata[]>
  revoke(userId: number, sessionId: number): Promise<SessionMetadata | null>
}

export interface ApiSessionService extends ApiSessionResolver {
  issue(
    userId: number,
    credentialVersion?: number,
  ): Promise<{ session: SessionMetadata; setCookie: string }>
  list(userId: number): Promise<SessionMetadata[]>
  revoke(userId: number, sessionId: number): Promise<SessionMetadata | null>
  clearCookie(): string
}

const cookieValue = (request: Request): string | null => {
  const header = request.headers.get('cookie')
  if (header === null) return null
  const matches = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
    .map((part) => part.slice(SESSION_COOKIE_NAME.length + 1))
  if (matches.length !== 1 || matches[0] === '') return null
  return matches[0]!
}

const sessionCookie = (token: string, absoluteExpiresAt: string): string => {
  if (!/^ezacto_session_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('session store returned malformed bearer material')
  }
  const expires = new Date(absoluteExpiresAt)
  if (!Number.isFinite(expires.valueOf())) {
    throw new Error('session store returned malformed absolute expiry')
  }
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`
}

const expiredCookie = (): string =>
  `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax`

const sessionPrincipal = (
  principal: ResolvedUserIdentity,
  sessionId: number,
): SessionPrincipal => ({
  type: 'user',
  userId: principal.userId,
  profile: principal.profile,
  managerGrants: [...principal.managerGrants],
  authentication: { kind: 'session', sessionId: String(sessionId) },
})

export const createApiSessionService = (
  store: SessionStorePort,
): ApiSessionService => ({
  resolve: async (request) => {
    const token = cookieValue(request)
    if (token === null) return null
    const authenticated = await store.authenticate(token)
    if (authenticated === null) return null
    return {
      principal: sessionPrincipal(
        authenticated.principal,
        authenticated.session.id,
      ),
      ...(authenticated.rotatedToken === undefined
        ? {}
        : {
            setCookie: sessionCookie(
              authenticated.rotatedToken,
              authenticated.session.absoluteExpiresAt,
            ),
          }),
    }
  },
  issue: async (userId, credentialVersion) => {
    const issued =
      credentialVersion === undefined
        ? await store.issue(userId)
        : await store.issue(userId, credentialVersion)
    return {
      session: issued.session,
      setCookie: sessionCookie(issued.token, issued.session.absoluteExpiresAt),
    }
  },
  list: (userId) => store.list(userId),
  revoke: (userId, sessionId) => store.revoke(userId, sessionId),
  clearCookie: expiredCookie,
})

const sessionId = (value: string): number => {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested session does not exist.',
    })
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError({
      status: 404,
      code: 'not_found',
      message: 'The requested session does not exist.',
    })
  }
  return parsed
}

const sessionData = (session: SessionMetadata, currentSessionId: string) => ({
  id: session.id,
  created_at: session.createdAt,
  last_seen_at: session.lastSeenAt,
  idle_expires_at: session.idleExpiresAt,
  absolute_expires_at: session.absoluteExpiresAt,
  revoked_at: session.revokedAt,
  revocation_reason: session.revocationReason,
  current: String(session.id) === currentSessionId,
})

export const installSessionRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  sessions: ApiSessionService,
): void => {
  api.get('/sessions', async (context) => {
    const principal = requireSessionPrincipal(context)
    const listed = await sessions.list(principal.userId)
    return context.json(
      {
        data: listed.map((session) =>
          sessionData(session, principal.authentication.sessionId),
        ),
        links: { self: '/api/v1/sessions' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.delete('/sessions/:sessionId', async (context) => {
    const principal = requireSessionPrincipal(context)
    const id = sessionId(context.req.param('sessionId'))
    const revoked = await sessions.revoke(principal.userId, id)
    if (revoked === null) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested session does not exist.',
      })
    }
    const isCurrent = String(id) === principal.authentication.sessionId
    if (isCurrent) {
      context.header('set-cookie', sessions.clearCookie(), { append: true })
    }
    return context.json(
      {
        data: sessionData(
          revoked,
          isCurrent ? '' : principal.authentication.sessionId,
        ),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
