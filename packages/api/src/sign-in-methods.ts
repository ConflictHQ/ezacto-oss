import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import { assertFields, readObjectBody, unknownFieldErrors } from './resources/support.js'

/**
 * Which ways in this instance offers. Issue 761.
 *
 * Before this, the answer lived in three separate secret checks at deploy time:
 * password mounted unconditionally and could not be switched off at all, magic
 * link mounted if a signing key existed, Google if a client id did. An
 * administrator could neither see the answer nor change it.
 *
 * Two states, and keeping them apart is the point. **Configured** is the
 * deployment's: credentials exist, so the method could run. **Enabled** is the
 * operator's: it may run. A method is live only when both hold, and an
 * administrator can tell "we never set this up" from "we switched this off".
 *
 * Everything here refuses rather than warns. A setting that can empty the set
 * of ways into an instance is one an operator gets to be wrong about exactly
 * once, and the recovery is database surgery.
 */

export type SignInMethod =
  | 'password'
  | 'magic_link'
  | 'google'
  | 'github'
  | 'apple'

export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  'password',
  'magic_link',
  'google',
  'github',
  'apple',
]

export interface SignInMethodState {
  method: SignInMethod
  enabled: boolean
}

export interface SignInMethodService {
  list(): Promise<readonly SignInMethodState[]>
  /** The methods this user has demonstrated they can sign in with. */
  usableBy(userId: number): Promise<readonly SignInMethod[]>
  setEnabled(
    method: SignInMethod,
    enabled: boolean,
    updatedAt: string,
  ): Promise<readonly SignInMethodState[]>
}

export interface SignInMethodRouteOptions {
  service: SignInMethodService
  /** What the deployment has credentials for. Resolved per request: it can change. */
  configured(bindings: unknown): readonly SignInMethod[]
  clock(): string
}

/**
 * The read side, for everything that has to know whether a method may run.
 * Routes consult this rather than the repository so that "configured" and
 * "enabled" are combined in exactly one place.
 */
export interface SignInMethodPolicy {
  isLive(method: SignInMethod, bindings: unknown): Promise<boolean>
}

export const createSignInMethodPolicy = (options: {
  service: Pick<SignInMethodService, 'list'>
  configured(bindings: unknown): readonly SignInMethod[]
}): SignInMethodPolicy => ({
  isLive: async (method, bindings) => {
    if (!options.configured(bindings).includes(method)) return false
    const states = await options.service.list()
    return states.find((state) => state.method === method)?.enabled ?? true
  },
})

/** The refusal a route serves when the operator has switched a method off. */
export const signInMethodUnavailable = (): never => {
  throw new ApiError({
    status: 404,
    code: 'sign_in_method_unavailable',
    message: 'That sign-in method is not available on this instance.',
  })
}

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): number => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can manage sign-in methods.',
    })
  }
  return principal.userId
}

const isSignInMethod = (value: string): value is SignInMethod =>
  (SIGN_IN_METHODS as readonly string[]).includes(value)

const patchKeys = new Set(['enabled'])

const envelope = (
  states: readonly SignInMethodState[],
  configured: readonly SignInMethod[],
) => ({
  data: SIGN_IN_METHODS.map((method) => ({
    method,
    configured: configured.includes(method),
    enabled: states.find((state) => state.method === method)?.enabled ?? true,
  })),
  links: { self: '/api/v1/admin/sign-in-methods' },
})

export const installSignInMethodRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: SignInMethodRouteOptions,
): void => {
  api.get('/admin/sign-in-methods', async (context) => {
    assertAdministrator(context)
    return context.json(
      envelope(await options.service.list(), options.configured(context.env)),
      200,
      { 'cache-control': 'no-store' },
    )
  })

  api.patch('/admin/sign-in-methods/:method', async (context) => {
    const actingUserId = assertAdministrator(context)
    const method = context.req.param('method')
    if (!isSignInMethod(method)) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested sign-in method does not exist.',
      })
    }
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, patchKeys)
    if (typeof body.enabled !== 'boolean') {
      errors.push({
        field: 'enabled',
        code: body.enabled === undefined ? 'required' : 'invalid_boolean',
        message: 'enabled must be a boolean',
      })
    }
    assertFields(errors)
    const enabled = body.enabled as boolean
    const configured = options.configured(context.env)

    // Enabling something the deployment never set up would put a button on the
    // sign-in page that cannot work. Say which state is missing, because the
    // fix is a deployment change and not another click here.
    if (enabled && !configured.includes(method)) {
      throw new ApiError({
        status: 409,
        code: 'sign_in_method_not_configured',
        message:
          'This deployment has no credentials for that sign-in method, so it cannot be switched on.',
      })
    }

    if (!enabled) {
      const states = await options.service.list()
      const live = (candidate: SignInMethodState) =>
        candidate.enabled && configured.includes(candidate.method)
      const remaining = states.filter(
        (state) => state.method !== method && live(state),
      )
      if (remaining.length === 0) {
        throw new ApiError({
          status: 409,
          code: 'last_sign_in_method',
          message:
            'This is the only sign-in method left. Switching it off would leave nobody able to sign in.',
        })
      }
      // The likelier mistake, and the one a count cannot catch: an
      // administrator switches off the way they themselves get in. `usableBy`
      // is evidence -- a password on file, an identity linked by a previous
      // sign-in -- rather than a guess about what would probably work.
      const usable = await options.service.usableBy(actingUserId)
      if (!remaining.some((state) => usable.includes(state.method))) {
        throw new ApiError({
          status: 409,
          code: 'would_lock_out_administrator',
          message:
            'You have not signed in with any of the remaining methods, so switching this off would lock you out. Sign in once with another method first.',
        })
      }
    }

    return context.json(
      envelope(
        await options.service.setEnabled(method, enabled, options.clock()),
        configured,
      ),
      200,
      { 'cache-control': 'no-store' },
    )
  })
}
