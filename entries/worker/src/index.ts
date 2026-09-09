import type { QueuedEmailJob } from '@ezacto/mailer'
import { createApp, type WorkerEnv } from './app.js'
import { consumeCloudflareEmailBatch } from './email-queue.js'
import { runDemoMaintenance } from './demo.js'
import { runNightlyExport } from './nightly-export.js'
import {
  createRuntimeServices,
  createWorkerMailProvider,
} from './runtime.js'

const publicApp = createApp()

const isDataRequest = (request: Request): boolean => {
  const path = new URL(request.url).pathname
  return (
    path === '/__ezacto/bootstrap' ||
    path.startsWith('/__ezacto/bootstrap/') ||
    path === '/api/v1' ||
    path.startsWith('/api/v1/') ||
    path === '/auth' ||
    path.startsWith('/auth/')
  )
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

export const worker: ExportedHandler<WorkerEnv, QueuedEmailJob> = {
  async fetch(request, env, executionContext) {
    if (!isDataRequest(request)) {
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
  async queue(batch, env) {
    const provider = createWorkerMailProvider(env)
    if (provider === null) {
      throw new TypeError('no email provider is configured')
    }
    const services = await createRuntimeServices(env, {
      emailProvider: provider,
    })
    await consumeCloudflareEmailBatch(batch, services.emailLog, provider)
  },
  async scheduled(controller, env) {
    const services = await createRuntimeServices(env)
    if (controller.cron === '0 3 * * *' && env.ATTACHMENTS !== undefined) {
      await runNightlyExport(env.DB, env.ATTACHMENTS)
    }
    // Refuses on any deployment that is not the demo, so this line is safe to
    // read as unconditional. See `runDemoMaintenance`.
    await runDemoMaintenance(env, controller.cron)
    await services.outbox.drain()
  },
}

export default worker
