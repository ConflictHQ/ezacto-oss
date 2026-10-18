import { Hono } from 'hono'
import { apiAuthenticationMiddleware, type ApiAuthentication } from './auth.js'
import type { ApiContext } from './context.js'
import { errorResponse } from './errors.js'
import type { IdempotencyOptions } from './idempotency.js'

/**
 * Reuse the API's credential, account, scope and CSRF checks before looking up
 * a stored answer. This app has no resource routes and cannot rerun a command.
 * Other surfaces have route-specific credentials (OAuth codes, webhook
 * signatures, bootstrap secrets): their writes retain claims, but their
 * responses cannot be replayed through this API authorization boundary.
 */
export const createApiIdempotencyAuthorization = (
  authentication: ApiAuthentication,
  authorizationRevision: () => Promise<string>,
): IdempotencyOptions['authorize'] => {
  const app = new Hono<ApiContext>()
  app.use('*', async (context, next) => {
    context.set('requestId', crypto.randomUUID())
    context.header('cache-control', 'no-store')
    await next()
  })
  app.use('*', apiAuthenticationMiddleware(authentication))
  app.all('*', async (context) => {
    const principal = context.get('principal')
    const credential = principal.authentication
    return context.json([
      'api-v1', await authorizationRevision(), principal.userId, principal.profile,
      [...(principal.managerGrants ?? [])].sort(), principal.ownMoneyVisible ?? false,
      credential.kind === 'token'
        ? ['token', credential.tokenId, [...credential.scopes].sort()]
        : ['session', credential.sessionId],
    ])
  })
  app.onError((error, context) => errorResponse(error, context))
  return async (request) => {
    const path = new URL(request.url).pathname
    if (path !== '/api/v1' && !path.startsWith('/api/v1/')) return null
    const response = await app.fetch(request)
    // A privilege change can rotate the session while resolving it. Deliver
    // that replacement instead of swallowing it and running the command under
    // the now-revoked request cookie. This answer never means the write ran.
    if (response.status === 200 && response.headers.getSetCookie().length > 0) {
      return Response.json({
        error: {
          code: 'authentication_changed',
          message: 'Your session changed. Reload before retrying this action.',
          fields: [],
        },
        request_id: crypto.randomUUID(),
      }, { status: 409, headers: response.headers })
    }
    return response.status === 200 ? response.text() : response
  }
}
