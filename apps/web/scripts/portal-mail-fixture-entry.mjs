// Browser-only entry. Production Worker composition, a real D1-backed sign-in
// and a captured queue; no consumer or external delivery is run by this fixture.
import production from '../../../entries/worker/src/index.ts'
import { createRuntimeServices } from '../../../entries/worker/src/runtime.ts'
const captured = []
const queue = {
  send: async (job) => {
    captured.push(job)
  },
}
export default {
  ...production,
  async fetch(request, env, context) {
    const url = new globalThis.URL(request.url)
    // The style audit exercises the real scanner-safe confirmation GET. Only
    // this GET receives local signing material: request/send and redemption
    // POST remain unconfigured, and no link is issued or consumed by the fixture.
    if (request.method === 'GET' && url.pathname === '/auth/magic-link/verify') {
      return production.fetch(request, {
        ...env,
        MAGIC_LINK_SIGNING_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAg',
      }, context)
    }
    if (url.pathname === '/__ezacto_browser_fixture__/scheduled-notices' || url.pathname === '/__ezacto_browser_fixture__/scheduled-dispatch') {
      if (request.method !== 'POST' || request.headers.get('x-ezacto-browser-fixture-control') !== 'start-end-round-trip')
        return new globalThis.Response(null, { status: 403 })
      const noticeOrigin = new globalThis.URL(url.origin)
      noticeOrigin.hostname = 'localhost'
      const services = await createRuntimeServices({
        ...env, EMAIL_QUEUE: queue, APP_BASE_URL: noticeOrigin.origin,
        MAILGUN_API_KEY: 'local-browser-fixture-only', MAILGUN_DOMAIN: 'example.test', MAIL_FROM: 'notify@example.test',
      })
      const selected = url.pathname.endsWith('/scheduled-dispatch') ? services.scheduledRunDispatch : services.scheduledRunNotices
      if (!selected) return new globalThis.Response(null, {status:503})
      const result = await selected.processDue(new Date().toISOString())
      return globalThis.Response.json({result,jobs:captured}, {headers:{'cache-control':'no-store'}})
    }
    if (url.pathname === '/__ezacto_browser_fixture__/drain-outbox') {
      if (
        request.method !== 'POST' ||
        request.headers.get('x-ezacto-browser-fixture-control') !== 'start-end-round-trip'
      )
        return new globalThis.Response(null, { status: 403 })
      // Exercise the real subscriber delivery the production cron performs.
      const services = await createRuntimeServices(env)
      for (let batch = 0; batch < 100; batch += 1) {
        const result = await services.outbox.drain(100)
        if (result.interrupted !== undefined)
          return globalThis.Response.json(result, { status: 503 })
        if (result.examined < 100) return globalThis.Response.json(result)
      }
      return new globalThis.Response('Fixture outbox did not drain', { status: 503 })
    }
    if (url.pathname === '/__ezacto_browser_fixture__/portal-mail') {
      if (request.headers.get('x-ezacto-browser-fixture-control') !== 'start-end-round-trip')
        return new globalThis.Response(null, { status: 403 })
      return globalThis.Response.json(
        { jobs: captured },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    if (url.pathname.startsWith('/portal/')) {
      const mailOrigin = new globalThis.URL(url.origin)
      mailOrigin.hostname = 'localhost'
      return production.fetch(
        request,
        {
          ...env,
          EMAIL_QUEUE: queue,
          APP_BASE_URL: mailOrigin.origin,
          MAILGUN_API_KEY: 'local-browser-fixture-only',
          MAILGUN_DOMAIN: 'example.test',
          MAIL_FROM: 'notify@example.test',
        },
        context,
      )
    }
    return production.fetch(request, env, context)
  },
}
