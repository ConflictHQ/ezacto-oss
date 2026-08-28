import {
  createApiApp,
  ApiError,
  generateOpenApiDocument,
  installGeneralResourceRoutes,
  installTrackedResourceRoutes,
  readJsonBody,
  validationError,
  type ApiTokenService,
  type GeneralResourceRouteOptions,
  type TrackedResourceRepository,
} from '@ezacto/api'
import {
  InstanceBootstrapConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
} from '@ezacto/db/d1'

/** Worker bindings stay entry-owned; the shared API package is runtime-agnostic. */
export type Env = {
  ENVIRONMENT: string
  RELEASE: string
}

export type WorkerEnv = Env & {
  DB: D1Database
  API_CURSOR_SIGNING_KEY: string
  /** Temporary Worker secret installed only while the operator workflow runs. */
  EZACTO_BOOTSTRAP_TOKEN?: string
}

export interface RuntimeServices {
  bootstrap(input: InstanceBootstrapInput): Promise<InstanceBootstrapResult>
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
  createApiApp<WorkerEnv>({
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

      if (services !== undefined) {
        app.post('/__ezacto/bootstrap', async (context) => {
          const expected = context.env.EZACTO_BOOTSTRAP_TOKEN
          if (expected === undefined || expected.length === 0) {
            throw new ApiError({
              status: 503,
              code: 'service_unavailable',
              message: 'Instance bootstrap is not enabled.',
            })
          }

          const authorization = context.req.header('authorization')
          const presented = authorization?.startsWith('Bearer ')
            ? authorization.slice('Bearer '.length)
            : ''
          if (!(await secureTokenEqual(expected, presented))) {
            context.header('www-authenticate', 'Bearer realm="ezacto-bootstrap"')
            throw new ApiError({
              status: 401,
              code: 'authentication_required',
              message: 'Bootstrap authentication is required.',
            })
          }

          const input = await parseBootstrapBody(context)
          try {
            const result = await services.bootstrap({
              ...input,
              token: expected,
            })
            return context.json(
              {
                data: {
                  status: 'ready',
                  user_id: result.userId,
                  profile: result.profile,
                },
              },
              200,
              { 'cache-control': 'no-store' },
            )
          } catch (error) {
            if (error instanceof InstanceBootstrapConflictError) {
              throw new ApiError({
                status: 409,
                code: 'bootstrap_state_conflict',
                message: 'The instance identity state does not match this bootstrap.',
              })
            }
            if (error instanceof RangeError || error instanceof TypeError) {
              throw validationError([
                {
                  field: 'bootstrap',
                  code: 'invalid',
                  message: 'The bootstrap identity fields are invalid.',
                },
              ])
            }
            throw error
          }
        })
      }

      app.get('/', (context) =>
        context.html(page(context.env.ENVIRONMENT, context.env.RELEASE), 200, {
          'cache-control': 'no-store',
        }),
      )
    },
  })

type BootstrapBody = Omit<InstanceBootstrapInput, 'token'>

const bootstrapFields = [
  'organization_name',
  'owner_first_name',
  'owner_last_name',
  'owner_email',
] as const

const parseBootstrapBody = async (
  context: Parameters<typeof readJsonBody>[0],
): Promise<BootstrapBody> => {
  const body = await readJsonBody<unknown>(context, { maxBytes: 8 * 1024 })
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw validationError([
      { field: 'body', code: 'invalid', message: 'body must be a JSON object' },
    ])
  }
  const record = body as Record<string, unknown>
  const allowed = new Set<string>(bootstrapFields)
  const fields = [
    ...bootstrapFields
      .filter((field) => typeof record[field] !== 'string' || record[field].trim() === '')
      .map((field) => ({
        field,
        code: 'required',
        message: `${field} must be a non-empty string`,
      })),
    ...Object.keys(record)
      .filter((field) => !allowed.has(field))
      .map((field) => ({
        field,
        code: 'unknown',
        message: `${field} is not accepted`,
      })),
  ]
  if (fields.length > 0) throw validationError(fields)
  return {
    organizationName: record.organization_name as string,
    ownerFirstName: record.owner_first_name as string,
    ownerLastName: record.owner_last_name as string,
    ownerEmail: record.owner_email as string,
  }
}

const secureTokenEqual = async (expected: string, presented: string): Promise<boolean> => {
  const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const [left, right] = await Promise.all([digest(expected), digest(presented)])
  let difference = left.length ^ right.length
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ (right[index] ?? 0)
  }
  return difference === 0
}

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
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}
