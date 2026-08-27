import { Hono } from 'hono'

/**
 * Bindings the entry needs today. D1/R2/Queues land with the stories that use
 * them (D17) — an unused binding is a lie in the config, so they are not here yet.
 */
export type Env = {
  /** Which deployment this is: `dev` or `prod`. Set per environment in wrangler.jsonc. */
  ENVIRONMENT: string
  /** Git commit this Worker was built from. CI passes the real SHA at deploy. */
  RELEASE: string
}

export type Health = {
  status: 'ok'
  service: 'ezacto'
  environment: string
  release: string
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>()

  app.get('/healthz', (c) => {
    const body: Health = {
      status: 'ok',
      service: 'ezacto',
      environment: c.env.ENVIRONMENT,
      release: c.env.RELEASE,
    }
    // Never cached: the point of this endpoint is to say what is running *now*.
    return c.json(body, 200, { 'cache-control': 'no-store' })
  })

  app.get('/', (c) =>
    c.html(
      page(c.env.ENVIRONMENT, c.env.RELEASE),
      200,
      { 'cache-control': 'no-store' },
    ),
  )

  return app
}

/**
 * The instance-identity page. It states what this deployment is and what commit
 * it runs — deliberately not a pretend product UI. `apps/web` mounts here when
 * the web-ui epic lands.
 */
function page(environment: string, release: string) {
  const short = release.slice(0, 7)
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>ezacto — ${escapeHtml(environment)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  p { margin: 0 0 1rem; opacity: .75; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .25rem 1rem; margin: 0;
       font-family: ui-monospace, SFMono-Regular, monospace; font-size: .875rem; }
  dt { opacity: .6; }
  dd { margin: 0; }
</style>
<main>
  <h1>ezacto</h1>
  <p>Open-source time tracking &amp; invoicing. This deployment is up; the product is still being built.</p>
  <dl>
    <dt>environment</dt><dd>${escapeHtml(environment)}</dd>
    <dt>release</dt><dd>${escapeHtml(short)}</dd>
    <dt>health</dt><dd><a href="/healthz">/healthz</a></dd>
  </dl>
</main>
</html>`
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}
