import {
  createApiApp,
  generateOpenApiDocument,
  installGeneralResourceRoutes,
  installTrackedResourceRoutes,
  type ApiTokenService,
  type GeneralResourceRouteOptions,
  type TrackedResourceRepository,
} from '@ezacto/api'

/** Worker bindings stay entry-owned; the shared API package is runtime-agnostic. */
export type Env = {
  ENVIRONMENT: string
  RELEASE: string
}

export type WorkerEnv = Env & {
  DB: D1Database
  API_CURSOR_SIGNING_KEY: string
}

export interface RuntimeServices {
  tokens: ApiTokenService
  generalResources: GeneralResourceRouteOptions['repository']
  trackedResources: TrackedResourceRepository
  cursorSigningKey: Uint8Array
}

export type Health = {
  status: 'ok'
  service: 'ezacto'
  environment: string
  release: string
}

export const createApp = (services?: RuntimeServices) =>
  createApiApp<Env>({
    ...(services === undefined
      ? {}
      : {
          authentication: {
            tokens: services.tokens,
            // Native sessions are not implemented at this entry seam. Being
            // explicit keeps cookies from becoming an accidental credential.
            sessions: { resolve: async () => null },
          },
          installApi: (api) => {
            installGeneralResourceRoutes(api, {
              repository: services.generalResources,
              cursorSigningKey: services.cursorSigningKey,
            })
            installTrackedResourceRoutes(api, {
              repository: services.trackedResources,
              clock: systemClock,
              cursorSigningKey: services.cursorSigningKey,
            })
          },
        }),
    installApp(app) {
      app.get('/healthz', (context) => {
        const body: Health = {
          status: 'ok',
          service: 'ezacto',
          environment: context.env.ENVIRONMENT,
          release: context.env.RELEASE,
        }
        return context.json(body, 200, { 'cache-control': 'no-store' })
      })

      app.get('/openapi/v1.json', (context) =>
        context.json(generateOpenApiDocument(), 200, {
          'cache-control': 'public, max-age=300',
        }),
      )

      app.get('/', (context) =>
        context.html(page(context.env.ENVIRONMENT, context.env.RELEASE), 200, {
          'cache-control': 'no-store',
        }),
      )
    },
  })

const systemClock = {
  now() {
    const instant = new Date().toISOString()
    return {
      instant,
      date: instant.slice(0, 10),
      time: instant.slice(11, 16),
    }
  },
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
    <dt>contract</dt><dd><a href="/openapi/v1.json">/openapi/v1.json</a></dd>
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
