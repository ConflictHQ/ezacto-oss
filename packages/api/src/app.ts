import { Hono } from 'hono'
import { apiAuthenticationMiddleware, installApiTokenRoutes } from './auth.js'
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
  if (options.authentication?.tokens !== undefined) {
    installApiTokenRoutes(api, options.authentication.tokens)
  }
  options.installApi?.(api)
  app.route('/api/v1', api)

  return app
}
