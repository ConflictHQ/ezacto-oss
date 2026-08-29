import {
  createApiApp,
  ApiError,
  assertValidOidcProviderConfig,
  generateOpenApiDocument,
  installEmailLogRoutes,
  installGeneralResourceRoutes,
  installOidcRoutes,
  installPasswordAuthRoutes,
  installReportRoutes,
  installSessionRoutes,
  installTrackedResourceRoutes,
  readJsonBody,
  validationError,
  type ApiTokenService,
  type AuthMailer,
  type ApiSessionService,
  type GeneralResourceRouteOptions,
  type OidcIdentityResolver,
  type OidcProviderConfig,
  type OidcTransactionStorePort,
  type PasswordAuthService,
  type ReportReader,
  type TrackedResourceRepository,
} from '@ezacto/api'
import {
  InstanceBootstrapConflictError,
  type InstanceBootstrapInput,
  type InstanceBootstrapResult,
} from '@ezacto/db/d1'
import { renderAppShell, webAssets, type SignInProvider } from '@ezacto/web'
import type { EmailLogStore, QueuedEmailJob } from '@ezacto/mailer'

/** Worker bindings stay entry-owned; the shared API package is runtime-agnostic. */
export type Env = {
  ENVIRONMENT: string
  RELEASE: string
}

export type WorkerEnv = Env & {
  DB: D1Database
  API_CURSOR_SIGNING_KEY: string
  /** Bound together with a provider implementation; absent deployments fail auth email closed. */
  EMAIL_QUEUE?: Queue<QueuedEmailJob>
  APP_BASE_URL?: string
  OIDC_GOOGLE_CLIENT_ID?: string
  OIDC_GOOGLE_CLIENT_SECRET?: string
  /** SES credentials are Worker secrets; never place them in wrangler vars. */
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_SESSION_TOKEN?: string
  /** Static SES routing/configuration values. */
  SES_REGION?: string
  SES_FROM?: string
  SES_CONFIGURATION_SET?: string
  /** Temporary Worker secret installed only while the operator workflow runs. */
  EZACTO_BOOTSTRAP_TOKEN?: string
}

export interface RuntimeServices {
  bootstrap(input: InstanceBootstrapInput): Promise<InstanceBootstrapResult>
  tokens: ApiTokenService
  generalResources: GeneralResourceRouteOptions['repository']
  trackedResources: TrackedResourceRepository
  reports: ReportReader
  cursorSigningKey: Uint8Array
  passwordAuth: PasswordAuthService
  sessions: ApiSessionService
  emailLog: EmailLogStore
  identities: OidcIdentityResolver
  oidcTransactions: OidcTransactionStorePort
  authMailer?: AuthMailer
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
            sessions: services.sessions,
          },
          installApi: (api) => {
            installSessionRoutes(api, services.sessions)
            installEmailLogRoutes(api, services.emailLog)
            installGeneralResourceRoutes(api, {
              repository: services.generalResources,
              cursorSigningKey: services.cursorSigningKey,
            })
            installTrackedResourceRoutes(api, {
              repository: services.trackedResources,
              clock: systemClock,
              cursorSigningKey: services.cursorSigningKey,
            })
            installReportRoutes(api, services.reports)
          },
        }),
    installApp(app) {
      if (services !== undefined) {
        installOidcRoutes(app, {
          transactions: services.oidcTransactions,
          identities: services.identities,
          sessions: services.sessions,
          provider: oidcProvider,
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
        installPasswordAuthRoutes(app, {
          service: services.passwordAuth,
          sessions: services.sessions,
          ...(services.authMailer === undefined
            ? {}
            : { mailer: services.authMailer }),
          clientKey: (request) =>
            request.headers.get('cf-connecting-ip') ?? 'unknown-client',
        })
      }

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
            context.header(
              'www-authenticate',
              'Bearer realm="ezacto-bootstrap"',
            )
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
                message:
                  'The instance identity state does not match this bootstrap.',
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

      app.get('/assets/ezacto.css', (context) =>
        context.body(webAssets.stylesheet, 200, {
          'cache-control': 'public, max-age=0, must-revalidate',
          'content-type': 'text/css; charset=utf-8',
        }),
      )

      app.get('/assets/ezacto.js', (context) =>
        context.body(webAssets.javascript, 200, {
          'cache-control': 'public, max-age=0, must-revalidate',
          'content-type': 'text/javascript; charset=utf-8',
        }),
      )

      app.get('/', (context) =>
        context.html(
          renderAppShell({
            environment: context.env.ENVIRONMENT,
            release: context.env.RELEASE,
            signInProviders: configuredSignInProviders(context.env),
          }),
          200,
          {
            'cache-control': 'no-store',
            'content-security-policy': shellContentSecurityPolicy,
            'permissions-policy': 'camera=(), microphone=(), geolocation=()',
            'referrer-policy': 'same-origin',
            'x-content-type-options': 'nosniff',
          },
        ),
      )
    },
  })

const configuredCredential = (value: string | undefined): string | null => {
  if (value === undefined) return null
  const normalized = value.trim()
  return normalized === '' ? null : normalized
}

const redirectOrigin = (env: WorkerEnv): string => {
  if (env.ENVIRONMENT === 'dev') return 'https://ezacto.io'
  if (env.ENVIRONMENT === 'prod') return 'https://app.example.com'
  const configured = configuredCredential(env.APP_BASE_URL)
  if (configured === null) {
    throw new TypeError('APP_BASE_URL is required for OIDC outside live environments')
  }
  return configured
}

/** Application-owned provider registry. Request input never selects an issuer. */
export const oidcProvider = (
  key: string,
  env: WorkerEnv,
): OidcProviderConfig | null => {
  if (key !== 'google') return null
  const clientId = configuredCredential(env.OIDC_GOOGLE_CLIENT_ID)
  const clientSecret = configuredCredential(env.OIDC_GOOGLE_CLIENT_SECRET)
  if (clientId === null && clientSecret === null) return null
  if (clientId === null || clientSecret === null) {
    throw new TypeError('Google OIDC client id and secret must be configured together')
  }
  return {
    issuer: 'https://accounts.google.com',
    clientId,
    clientSecret,
    redirectOrigin: redirectOrigin(env),
    clientAuthentication: 'client_secret_post',
    idTokenSigningAlgorithm: 'RS256',
    scopes: ['openid', 'email', 'profile'],
  }
}

/** Public shell availability contains provider keys only, never credentials. */
export const configuredSignInProviders = (
  env: WorkerEnv,
): readonly SignInProvider[] => {
  try {
    const google = oidcProvider('google', env)
    if (google === null) return []
    assertValidOidcProviderConfig(google)
    return ['google']
  } catch {
    // A partial or invalid deployment configuration must not advertise a flow
    // that cannot start. The fixed provider route continues to fail closed.
    return []
  }
}

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
      .filter(
        (field) =>
          typeof record[field] !== 'string' || record[field].trim() === '',
      )
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

const secureTokenEqual = async (
  expected: string,
  presented: string,
): Promise<boolean> => {
  const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    )
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

const shellContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "connect-src 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')
