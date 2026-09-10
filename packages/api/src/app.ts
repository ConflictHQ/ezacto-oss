import { Hono } from 'hono'
import {
  apiAuthenticationMiddleware,
  installApiTokenRoutes,
  installTwoFactorRoutes,
} from './auth.js'
import type { ApiContext, CreateApiAppOptions } from './context.js'
import { errorResponse, notFoundResponse } from './errors.js'

export const createApiApp = <Bindings extends object = object>(
  options: CreateApiAppOptions<Bindings> = {},
) => {
  const app = new Hono<ApiContext<Bindings>>()

  app.use('*', async (context, next) => {
    const requestId = crypto.randomUUID()
    context.set('requestId', requestId)
    context.header('x-request-id', requestId)
    await next()
  })

  const authenticateApi = apiAuthenticationMiddleware<Bindings>(options.authentication)
  // A resource's representation can change with profile, grants, and token
  // scopes. This boundary owns the policy, including failures before routing.
  app.use('*', async (context, next) => {
    const path = context.req.path
    if (path !== '/api/v1' && !path.startsWith('/api/v1/')) return next()
    context.header('cache-control', 'no-store')
    await next()
    context.header('cache-control', 'no-store')
    context.header('etag', undefined)
    context.header('last-modified', undefined)
    // Never instruct a client to reuse a representation obtained under an
    // earlier, potentially more privileged identity.
    if (context.res.status === 304) {
      context.res = errorResponse(new Error('Conditional responses are forbidden for authenticated API resources'), context)
    }
  })
  app.use('*', (context, next) => {
    const path = context.req.path
    if (path === '/api/v1' || path.startsWith('/api/v1/')) {
      return authenticateApi(context, next)
    }
    return next()
  })

  app.onError((error, context) => errorResponse(error, context))
  app.notFound((context) => notFoundResponse(context))
  options.installApp?.(app)

  const api = new Hono<ApiContext<Bindings>>()
  api.get('/', (context) =>
    context.json({
      data: { service: 'ezacto', version: 'v1' },
      links: { self: '/api/v1' },
    }),
  )
  api.get('/whoami', (context) => {
    const principal = context.get('principal')
    return context.json(
      {
        data: {
          user_id: principal.userId,
          profile: principal.profile,
          manager_grants: [...principal.managerGrants],
          authentication:
            principal.authentication.kind === 'token'
              ? {
                  kind: 'token' as const,
                  token_id: principal.authentication.tokenId,
                  scopes: [...principal.authentication.scopes],
                }
              : { kind: 'session' as const },
        },
        links: { self: '/api/v1/whoami' },
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })
  if (options.authentication?.twoFactor !== undefined) {
    installTwoFactorRoutes(api, options.authentication.twoFactor)
  }
  if (options.authentication?.tokens !== undefined) {
    installApiTokenRoutes(
      api,
      options.authentication.tokens,
      options.authentication.activity,
    )
  }
  options.installApi?.(api)
  app.route('/api/v1', api)

  return app
}
