import type { QueuedEmailJob } from '@ezacto/mailer'
import { createApp, type WorkerEnv } from './app.js'
import { isDataRequest } from './data-request.js'
import { workerBrandAssetSurface } from './brand-assets.js'
import { workerInstanceThemeSurface } from './instance-theme.js'
import { consumeCloudflareEmailBatch } from './email-queue.js'
import { runDemoMaintenance } from './demo.js'
import { runNightlyExport } from './nightly-export.js'
import {
  createRuntimeServices,
  createWorkerMailProvider,
} from './runtime.js'

const publicApp = createApp(undefined, workerBrandAssetSurface, workerInstanceThemeSurface)

/**
 * Loopback has no TLS to upgrade to. `wrangler dev`, the container runtime and
 * the browser suite all serve cleartext on these hosts by design, so the rule
 * below has to know the difference between "no certificate here" and "a
 * certificate somebody skipped".
 */
const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  hostname === '127.0.0.1' ||
  hostname === '::1' ||
  hostname === '[::1]'

/**
 * Refuse to hold a conversation in cleartext with a real host.
 *
 * A sign-in form served over http:// posts to a relative action, so the
 * password leaves the browser in the clear and redirecting the POST is too
 * late -- the secret is on the wire before this code runs. So the two halves
 * are answered differently, and neither is a redirect-and-carry-on:
 *
 *   GET/HEAD  301 to the https:// form of the same URL. Nothing confidential
 *             has been sent yet, so upgrading the link is the whole fix, and it
 *             happens before any HTML with a password field exists.
 *   anything  403. A body arrived over cleartext. It cannot be un-sent, and
 *   else      completing the request would ratify it; re-posting it to https
 *             would put the same secret on the wire a second time and return
 *             200, which reads to the caller as "that was fine".
 *
 * Returns null when the request is already safe, which is every https request
 * and every loopback one.
 */
const cleartextRefusal = (request: Request): Response | null => {
  const url = new URL(request.url)
  if (url.protocol !== 'http:' || isLoopbackHost(url.hostname)) return null
  if (request.method === 'GET' || request.method === 'HEAD') {
    url.protocol = 'https:'
    return new Response(null, {
      status: 301,
      headers: { location: url.toString(), 'cache-control': 'no-store' },
    })
  }
  return Response.json(
    {
      error: {
        code: 'https_required',
        message: 'This endpoint is only served over HTTPS.',
        fields: [],
      },
    },
    { status: 403, headers: { 'cache-control': 'no-store' } },
  )
}

/**
 * Tell the browser not to try cleartext again. The redirect above fixes the
 * request in hand; this fixes the next one, which is the one that would
 * otherwise carry a session cookie up the unencrypted leg.
 *
 * Set only on https responses: announcing a year of HTTPS-only from a
 * cleartext origin is ignored by browsers, and setting it on loopback would
 * pin a developer's whole `localhost` to a scheme nothing there serves.
 */
const withStrictTransport = (request: Request, response: Response): Response => {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' || isLoopbackHost(url.hostname)) return response
  const headers = new Headers(response.headers)
  headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
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
    // First, before a route is matched or a service is constructed: nothing
    // below this line should ever compose a response for a cleartext request.
    const refusal = cleartextRefusal(request)
    if (refusal !== null) return refusal
    if (!isDataRequest(request)) {
      return withStrictTransport(
        request,
        await publicApp.fetch(request, env, executionContext),
      )
    }
    try {
      const services = await createRuntimeServices(env)
      return withStrictTransport(
        request,
        await createApp(services, workerBrandAssetSurface, workerInstanceThemeSurface).fetch(
          request,
          env,
          executionContext,
        ),
      )
    } catch {
      // Configuration and migration failures stay fail-closed and never reflect
      // binding values, bearer credentials, SQL, or secret material.
      return withStrictTransport(request, unavailable())
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
    if (controller.cron === '0 3 * * *') {
      // Daily rather than every minute: a definition is due on a date, so the
      // finest resolution the cadence has is a day, and fifty-nine of every
      // sixty extra passes could only find the same nothing.
      //
      // The event this sweep writes is drained below in the same invocation,
      // which is why it runs before `outbox.drain()` rather than after.
      //
      // `scheduledTime` rather than the wall clock so that a run delayed into
      // the next day still generates the day it was scheduled for. The engine
      // treats every definition due on or before that date, so the day a cron
      // misses entirely is caught up by the next one.
      await services.recurringInvoices.generateDue(
        new Date(controller.scheduledTime).toISOString().slice(0, 10),
        { type: 'system' },
      )
    }
    // Refuses on any deployment that is not the demo, so this line is safe to
    // read as unconditional. See `runDemoMaintenance`.
    await runDemoMaintenance(env, controller.cron)
    await services.outbox.drain()
  },
}

export default worker
