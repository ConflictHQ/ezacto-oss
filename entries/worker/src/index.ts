import { createApp, type WorkerEnv } from './app.js'
import { createRuntimeServices } from './runtime.js'

const publicApp = createApp()

const isApiRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname
  return path === '/api/v1' || path.startsWith('/api/v1/')
}

const unavailable = (): Response => {
  const requestId = crypto.randomUUID()
  return Response.json(
    {
      error: {
        code: 'service_unavailable',
        message: 'The API data service is temporarily unavailable.',
        fields: [],
      },
      request_id: requestId,
    },
    {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'retry-after': '5',
        'x-request-id': requestId,
      },
    },
  )
}

export const worker: ExportedHandler<WorkerEnv> = {
  async fetch(request, env, executionContext) {
    if (!isApiRequest(request)) {
      return publicApp.fetch(request, env, executionContext)
    }
    try {
      const services = await createRuntimeServices(env)
      return createApp(services).fetch(request, env, executionContext)
    } catch {
      // Configuration and migration failures stay fail-closed and never reflect
      // binding values, bearer credentials, SQL, or secret material.
      return unavailable()
    }
  },
}

export default worker
