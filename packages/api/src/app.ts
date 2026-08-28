import { Hono } from 'hono'
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
  options.installApi?.(api)
  app.route('/api/v1', api)

  return app
}
