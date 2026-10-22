import * as Sentry from '@sentry/cloudflare'
import { scheduleConfirmedRunWorkflows } from './scheduled-run-workflow-scheduler.js'
import type { QueuedEmailJob } from '@ezacto/mailer'
import { createApiIdempotencyAuthorization, withIdempotency } from '@ezacto/api'
import { createApp, demoDeployment, demoMailDomains, type WorkerEnv } from './app.js'
import { isDataRequest } from './data-request.js'
import { workerBrandAssetSurface } from './brand-assets.js'
import { workerSignInMethodSurface } from './sign-in-methods.js'
import { workerInstanceThemeSurface } from './instance-theme.js'
import { consumeCloudflareEmailBatch } from './email-queue.js'
import { createAttachmentResolver } from './invoice-documents.js'
import { runDemoMaintenance, seedDemoSender } from './demo.js'
import { runNightlyExport } from './nightly-export.js'
import { createScheduledBillReconciliation } from '@ezacto/integrations'
import {
  createR2AttachmentObjectStore,
  createRuntimeServices,
  createWorkerMailProvider,
} from './runtime.js'

const publicApp = createApp(
  undefined,
  workerBrandAssetSurface,
  workerInstanceThemeSurface,
  workerSignInMethodSurface,
)

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
      const app = createApp(
        services,
        workerBrandAssetSurface,
        workerInstanceThemeSurface,
        workerSignInMethodSurface,
      )
      // A write with an Idempotency-Key runs once and is replayed after that
      // (#952). Every data answer says so in Idempotency-Key-Lifetime, which is
      // what lets a client retry a write here at all.
      return withStrictTransport(
        request,
        await withIdempotency(
          request,
          (incoming) => Promise.resolve(app.fetch(incoming, env, executionContext)),
          {
            store: services.idempotency.store,
            authorize: createApiIdempotencyAuthorization({
              tokens: services.tokens,
              sessions: services.authenticationSessions ?? services.sessions,
              ownMoneyVisible: services.isOwnMoneyVisible,
            }, async () => JSON.stringify([await services.idempotency.store.authorizationRevision(), env.RELEASE, demoDeployment(env)]), { ...(services.invoiceElevations === undefined ? {} : {invoiceElevations:services.invoiceElevations}) }),
            secret: services.idempotency.secret,
            waitUntil: (promise) => executionContext.waitUntil(promise),
            report: (error) => {
              console.error('[worker] idempotent response not recorded', error)
              Sentry.captureException(error)
            },
          },
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
    // The consumer fetches what a job names, immediately before sending. Bytes
    // never rode the queue to get here (issue 626).
    await consumeCloudflareEmailBatch(
      batch,
      services.emailLog,
      provider,
      env.ATTACHMENTS === undefined
        ? undefined
        : createAttachmentResolver(createR2AttachmentObjectStore(env.ATTACHMENTS)),
      // The demo's second net (#931): whoever enqueued a job, it reaches only
      // the domains the demo may email. Absent everywhere else.
      demoMailDomains(env) ?? undefined,
      services.emailSuppressions?.lookup,
    )
  },
  async scheduled(controller, env) {
    const services = await createRuntimeServices(env)
    if (controller.cron === '* * * * *')
      await services.paymentRuns?.processDue(new Date().toISOString())
    if (controller.cron === '* * * * *' && services.budgetAlerts !== undefined) {
      // Budget alerts (issue 934): a pass over the projects that asked to be
      // told, before the drain below so the event it writes is mailed in the
      // same invocation. A failed pass is reported and never stops the drain.
      try {
        await services.budgetAlerts.evaluate(new Date().toISOString())
      } catch (error) {
        console.error('[worker] budget alert evaluation failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.timeReminders !== undefined) {
      // Time reminders and week-end submission reminders (issue 935). Every
      // minute, because "due" is each person's own local time and the zones
      // between them put due times on every minute mark of the hour. Cheap when
      // nothing is due. Ahead of the drain so what it queues is sent now.
      try {
        await services.timeReminders.processDue(new Date().toISOString())
      } catch (error) {
        console.error('[worker] time reminders failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.timesheetAutoApprovalSweep !== undefined) {
      // Automatic timesheet approval (issue 1009): a bounded batch of weeks the
      // policy has made due. A no-op while the policy is off. A failure is
      // reported and never stops the drain.
      try {
        const run = await services.timesheetAutoApprovalSweep.processDue(new Date().toISOString())
        for (const failure of run.failed) {
          console.error('[worker] automatic approval failed', failure.submissionId, failure.message)
        }
      } catch (error) {
        console.error('[worker] automatic approval sweep failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.offsiteBackupSync !== undefined) {
      try { await services.offsiteBackupSync.processDue() }
      catch (error) {
        console.error('[worker] off-site backup checkpoint failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.scheduledJobProposals !== undefined) {
      try {
        const result = await services.scheduledJobProposals.processDue(new Date().toISOString())
        for (const failure of result.failed)
          console.error('[worker] scheduled job proposal failed', failure.jobId, failure.message)
      } catch (error) {
        console.error('[worker] scheduled job proposal sweep failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.scheduledRunNotices !== undefined) {
      try {
        await services.scheduledRunNotices.processDue(new Date().toISOString())
      } catch (error) {
        console.error('[worker] scheduled manifest notice failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.scheduledRunDispatch !== undefined) {
      try {
        if (env.SCHEDULED_RUN_WORKFLOW !== undefined) {
          const result = await scheduleConfirmedRunWorkflows(env.SCHEDULED_RUN_WORKFLOW, services.scheduledRunDispatch)
          for (const failure of result.failed) console.error('[worker] scheduled run Workflow failed', failure)
        } else {
          // Direct invocation remains available to unbound native fixtures and older installs.
          const result = await services.scheduledRunDispatch.processDue(new Date().toISOString())
          for (const failure of result.failed) console.error('[worker] scheduled run item failed', failure)
        }
      } catch (error) {
        console.error('[worker] scheduled run dispatch failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '* * * * *' && services.scheduledActionExpiry !== undefined) {
      // Proposed month-end runs past their deadline (issue 63). The sweep
      // reports its own failure, so it never stops the drain below.
      await services.scheduledActionExpiry.expireDue(new Date().toISOString(), (error) => {
        console.error('[worker] scheduled run expiry failed', error)
        Sentry.captureException(error)
      })
    }
    // Not on the demo (#931): its database is thrown away at this hour, and an
    // export would copy whatever visitors typed into it into the bucket, which
    // nothing ever empties.
    if (
      controller.cron === '0 3 * * *' &&
      env.ATTACHMENTS !== undefined &&
      !demoDeployment(env)
    ) {
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
      // Payment reminders that have come due (issue 801). Daily, like the
      // generation above and for the same reason: a reminder is due on a
      // date. The mail it enqueues is drained below in the same invocation.
      // `now` rather than `scheduledTime`: the rows carry their own due date,
      // and the message says how late the invoice is today.
      if (services.reminders !== undefined) {
        await services.reminders.processDue(new Date().toISOString())
      }
    }
    if (controller.cron === '0 * * * *' && services.bill !== undefined) {
      // Payments made at BILL (issue 834). Hourly: it walks every receivable
      // payment BILL holds, which is too much for the minute cron and too slow
      // for the daily one when a client has just paid. Cheap when BILL is not
      // configured or nothing is mirrored, and never throws -- a BILL outage
      // is reported and the drain below still runs.
      await createScheduledBillReconciliation({
        reconcile: services.bill.reconcilePayments,
        report: (error) => {
          console.error('[worker] BILL reconciliation failed', error)
          Sentry.captureException(error)
        },
      })()
    }
    if (controller.cron === '0 * * * *' && services.quickBooks !== undefined) {
      // Payments QuickBooks changed that no webhook told us of (issue 1013).
      // Hourly, resuming from a stored cursor, so a missed delivery is found
      // within the hour. Cheap when nothing changed, and a failed run is
      // recorded against the cursor, reported, and never stops the drain.
      try {
        await services.quickBooks.catchUp()
      } catch (error) {
        console.error('[worker] QuickBooks catch-up failed', error)
        Sentry.captureException(error)
      }
    }
    if (controller.cron === '0 * * * *' && services.deelSync?.status().configured === true) {
      // Deel time sync (issue 103, #1102). Runs only when the organization has
      // set the sync to automatic, once a day at its configured time; manual is
      // the default and this does nothing. Hourly, so a configured time is met
      // within the hour. A failed run is recorded in `deel_sync_runs`, reported,
      // and never stops the drain below.
      try {
        const run = await services.deelSync.runAutomaticIfDue()
        if (run.status === 'failed') {
          console.error('[worker] Deel time sync failed', run.error, run.failed)
          Sentry.captureException(new Error(run.error ?? 'Deel time sync had failed submissions'))
        }
      } catch (error) {
        console.error('[worker] Deel time sync failed', error)
        Sentry.captureException(error)
      }
    }
    // Refuses on any deployment that is not the demo, so this line is safe to
    // read as unconditional. See `runDemoMaintenance`.
    const maintenance = await runDemoMaintenance(env, controller.cron)
    // The rebuild empties the demo's sender with everything else, and nobody
    // using the demo may make another (#931).
    if (maintenance.ran === 'rebuild') await seedDemoSender(services, env)
    const drained = await services.outbox.drain()
    // A database failure while claiming stops the tick rather than throwing
    // (#1104). Nothing was lost: the events are still queued for the next
    // minute. Reported once per tick here, not once per row.
    if (drained.interrupted !== undefined) {
      console.error('[worker] outbox drain interrupted', drained.interrupted)
      Sentry.captureException(drained.interrupted)
    }
  },
}

// Crash/error reporting for the fetch, queue and scheduled handlers. Inert
// until an instance sets the SENTRY_DSN secret, so it is a no-op by default and
// on self-hosted deployments. PII scrubbed; errors only (no tracing quota).
export default Sentry.withSentry<WorkerEnv, QueuedEmailJob>(
  (env: WorkerEnv) => ({
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.ENVIRONMENT,
    release: env.RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
  }),
  worker,
)
