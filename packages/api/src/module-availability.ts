import type { Hono } from 'hono'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'

/**
 * Operator switches for whole company modules (issue 1254).
 *
 * `organizations.modules` is the organization's own, in-app setting. These are
 * the operator's: environment variables, one per module, read by exactly one
 * parser and consulted by the shell, the API and the background jobs alike. An
 * operator-disabled module cannot be turned back on from the app, because
 * nothing in the app writes or reads these -- they live outside the database.
 *
 * Unset is on, so an install that sets nothing behaves as it always has. Only
 * `true` and `false` are accepted; anything else, blank included, refuses to
 * start rather than being guessed at as on or off.
 */
export const OPERATOR_MODULES = ['sso', 'backups', 'invoices', 'accounting'] as const

export type OperatorModule = (typeof OPERATOR_MODULES)[number]

/** The environment variable that switches each module. The two older names are kept. */
export const OPERATOR_MODULE_FLAGS = {
  sso: 'SSO_ENABLED',
  backups: 'BACKUPS_ENABLED',
  invoices: 'INVOICES_ENABLED',
  accounting: 'ACCOUNTING_ENABLED',
} as const satisfies Record<OperatorModule, string>

export type OperatorModuleEnv = {
  readonly [Flag in (typeof OPERATOR_MODULE_FLAGS)[OperatorModule]]?: string | undefined
}

export type ModuleAvailability = Readonly<Record<OperatorModule, boolean>>

/** Whether each operator module is on. Throws a TypeError naming the flag on a bad value. */
export const moduleAvailability = (env: OperatorModuleEnv): ModuleAvailability => {
  const state = {} as Record<OperatorModule, boolean>
  for (const module of OPERATOR_MODULES) {
    const name = OPERATOR_MODULE_FLAGS[module]
    const value = env[name]
    if (value === undefined || value === 'true') state[module] = true
    else if (value === 'false') state[module] = false
    else throw new TypeError(`${name} must be "true" or "false"`)
  }
  return state
}

// The API surface and the unauthenticated routes a module owns. A path is
// matched whole or up to a `/`, so `/api/v1/invoices` never claims
// `/api/v1/invoices-archive`. Accounting is listed first: the QuickBooks
// lines of an invoice belong to it, not to invoices.
const MODULE_PATHS: readonly (readonly [OperatorModule, readonly RegExp[]])[] = [
  [
    'accounting',
    [
      /^\/api\/v1\/integrations\/quickbooks(\/|$)/u,
      /^\/api\/v1\/invoices\/[^/]+\/quickbooks(\/|$)/u,
      /^\/webhooks\/quickbooks(\/|$)/u,
    ],
  ],
  [
    'sso',
    [
      // The exchange also redeems the app codes of the staff magic link, which
      // is not single sign-on and makes no provider call, so it stays.
      /^\/auth\/oidc\/(?!exchange(\/|$))/u,
      /^\/auth\/github(\/|$)/u,
      /^\/auth\/apple(\/|$)/u,
      /^\/api\/v1\/settings\/sso-domains(\/|$)/u,
    ],
  ],
  ['backups', [/^\/api\/v1\/backup(\/|$)/u, /^\/backup-download(\/|$)/u]],
  [
    'invoices',
    [
      /^\/api\/v1\/invoices(\/|$)/u,
      /^\/harvest\/v2\/invoices(\/|$)/u,
      /^\/api\/v1\/invoice-generations(\/|$)/u,
      /^\/api\/v1\/invoice-elevations(\/|$)/u,
      /^\/api\/v1\/recurring-invoices(\/|$)/u,
      /^\/api\/v1\/settings\/invoice-[^/]+(\/|$)/u,
      /^\/api\/v1\/clients\/[^/]+\/invoice-sending(\/|$)/u,
      /^\/api\/v1\/scheduled-(runs|jobs)(\/|$)/u,
      /^\/portal\/invoices(\/|$)/u,
    ],
  ],
]

/** The operator module that owns a request path, if any. */
export const moduleForPath = (path: string): OperatorModule | undefined =>
  MODULE_PATHS.find(([, patterns]) => patterns.some((pattern) => pattern.test(path)))?.[0]

/** The refusal every disabled-module call gets, whatever the route. */
export const moduleDisabled = (module: OperatorModule): ApiError =>
  new ApiError({
    status: 403,
    code: 'module_disabled',
    message: `The ${module} module is switched off by the operator of this instance.`,
  })

/**
 * Refuses a request to a disabled module before any route, service or provider
 * is reached. Data is untouched: turning the module back on restores it.
 *
 * Shell pages under a disabled module's own screens are not refused here; the
 * caller redirects those, because a browser navigating to a JSON error is a
 * dead end.
 */
export const installModuleGate = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  availability: (env: Bindings | undefined) => ModuleAvailability,
): void => {
  app.use('*', async (context, next) => {
    const module = moduleForPath(context.req.path)
    if (module !== undefined && !availability(context.env)[module]) {
      throw moduleDisabled(module)
    }
    await next()
  })
}
