// Browser-only entry. Production Worker composition, a real D1-backed sign-in
// and a captured queue; no consumer or external delivery is run by this fixture.
import production from '../../../entries/worker/src/index.ts'
const captured = []
const queue = {
  send: async (job) => {
    captured.push(job)
  },
}
export default {
  ...production,
  fetch(request, env, context) {
    const url = new globalThis.URL(request.url)
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
