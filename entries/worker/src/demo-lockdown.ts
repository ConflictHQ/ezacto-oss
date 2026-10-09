import { ApiError, DEFAULT_MAX_JSON_BODY_BYTES } from '@ezacto/api'

/**
 * What the public demo refuses (#931).
 *
 * ezacto.io prints its administrator's password on its own front page, so every
 * route below is one any visitor can call -- and each of them reaches past the
 * demo's own database (a payment or accounting provider, the identity the
 * operator's real mail is sent under, the details an invoice tells a client to
 * pay into, object storage the nightly rebuild never empties), or would lock
 * the next visitor out of the shared accounts until that rebuild. Mail is not
 * here: it is sent, and held at the queue to the domains the deployment lists
 * -- see `demoMailDomains` and `createRecipientAllowlistQueue`.
 *
 * Declared rather than checked route by route, in the form `entry-surface.ts`
 * uses, so the list can be read in one place and `demo-lockdown.test.ts` can
 * hold every entry to a route the Worker actually mounts. A route that is
 * renamed fails that test rather than quietly coming back unguarded.
 */

export const DEMO_REFUSAL_MESSAGE = 'Not available on the public demo.'

/** The one answer every refusal gives, so a client can tell it from any other 403. */
export const demoRefusal = (): ApiError =>
  new ApiError({ status: 403, code: 'demo_disabled', message: DEMO_REFUSAL_MESSAGE })

/**
 * Connecting, configuring and disconnecting the providers, and the calls that
 * push a record to one. The runtime composes no provider credentials on the
 * demo at all, so these could only fail further in; refusing them here says
 * why, and does so before a request is built.
 */
export const DEMO_INTEGRATION_ROUTES: readonly string[] = [
  'post /api/v1/integrations/quickbooks/authorize',
  'get /api/v1/integrations/quickbooks/callback',
  'post /api/v1/integrations/quickbooks/settings',
  'delete /api/v1/integrations/quickbooks',
  'post /api/v1/invoices/:id/quickbooks/sync',
  'post /api/v1/integrations/bill/clients/:id',
  'post /api/v1/integrations/wise/recipients/link',
  'post /api/v1/integrations/wise/recipients',
  'post /api/v1/integrations/wise/contacts',
  'delete /api/v1/integrations/wise/destinations/:userId',
  'delete /api/v1/integrations/wise/recipients/:accountId',
  'post /api/v1/users/:id/payout-accounts',
  'delete /api/v1/payout-accounts/:id',
  'post /api/v1/staff-payments/provider-settings',
]

/** Money: a payment link minted at Stripe, and payouts quoted and sent through Wise. */
export const DEMO_PAYMENT_ROUTES: readonly string[] = [
  'post /api/v1/invoices/:id/payment-link',
  'post /api/v1/payment-runs/preview',
  'post /api/v1/payment-runs/:id/approve',
  'post /api/v1/payment-runs/:id/items/:itemId/reconcile',
]

/**
 * Who the organization's mail says it is from, and what its invoices tell a
 * client to pay into. Editable on the demo, these are a phishing kit: the
 * operator's verified sender with a stranger's name and reply-to, and an
 * invoice with a stranger's bank details in its notes.
 */
export const DEMO_IDENTITY_ROUTES: readonly string[] = [
  'post /api/v1/sender-identities',
  'patch /api/v1/sender-identities/:id',
  'post /api/v1/sender-identities/:id/default',
  'post /api/v1/sender-identities/:id/archive',
  'post /api/v1/sender-identities/:id/refresh',
  'post /api/v1/settings/invoice-defaults',
]

/**
 * Anything that would put a visitor's bytes in the bucket. The nightly rebuild
 * empties the database and not the bucket, so an upload outlives the demo it
 * was made in.
 */
export const DEMO_UPLOAD_ROUTES: readonly string[] = [
  'post /api/v1/invoices/:invoiceId/attachments',
  'post /api/v1/recurring-invoices/:recurringInvoiceId/attachments',
  'post /api/v1/estimates/:estimateId/attachments',
  'post /api/v1/expenses/:expenseId/attachments',
  'post /api/v1/projects/:projectId/attachments',
  'post /api/v1/settings/brand-assets/:slot',
]

/**
 * What would lock the next visitor out of the accounts the demo publishes, or
 * let one visitor decide who else gets in: a new password (the reset is the
 * only route that sets one), a second factor nobody else holds, a way of
 * signing in switched off, SSO provisioning opened to a domain a visitor
 * controls, and a user removed outright.
 */
export const DEMO_ACCESS_ROUTES: readonly string[] = [
  'post /auth/password/reset',
  'post /api/v1/two-factor',
  'post /api/v1/two-factor/confirm',
  'delete /api/v1/two-factor',
  'patch /api/v1/admin/sign-in-methods/:method',
  'post /api/v1/admin/retention-policy',
  'patch /api/v1/admin/deletion-requests/:id',
  'post /api/v1/admin/deletion-requests/:id/notification',
  'post /api/v1/settings/sso-domains',
  'post /api/v1/settings/sso-domains/:id/verify',
  'delete /api/v1/settings/sso-domains/:id',
  'delete /api/v1/users/:id',
]

export const DEMO_REFUSED_ROUTES: readonly string[] = [
  ...DEMO_INTEGRATION_ROUTES,
  ...DEMO_PAYMENT_ROUTES,
  ...DEMO_IDENTITY_ROUTES,
  ...DEMO_UPLOAD_ROUTES,
  ...DEMO_ACCESS_ROUTES,
]

/**
 * How an invoice may be paid is set through the ordinary invoice edit, which
 * takes one kind of change per request -- so this one is refused by the field
 * it carries rather than by its path. Every other edit of an invoice is the
 * demo working as a demo should.
 */
export const DEMO_PAYMENT_OPTIONS_ROUTE = 'patch /api/v1/invoices/:id'

/**
 * Whether someone is active, their permission profile, and the address a user
 * signs in with are each set through an edit that also changes a name or a
 * timezone -- so these are refused by the fields they carry. Any of them on an
 * account the demo publishes keeps the next visitor out of it. On any other
 * user they are the same switch, so the demo refuses them for every user
 * rather than keep a list of whose account is whose.
 */
export const DEMO_ACCOUNT_FIELD_ROUTES: Readonly<Record<string, readonly string[]>> = {
  'patch /api/v1/team/people/:id': ['is_active', 'profile'],
  'patch /api/v1/users/:id': ['is_active', 'profile', 'email'],
}

/**
 * Ending a session. The caller's own is signing out, which the demo needs; any
 * other is a different visitor signed out of the account they share, because
 * each account the demo publishes is one user, and every visitor signed in as
 * it can list all of its sessions.
 */
export const DEMO_SESSION_REVOKE_ROUTE = 'delete /api/v1/sessions/:sessionId'

interface CompiledRoute {
  readonly method: string
  readonly pattern: RegExp
}

/** A `:param` is one path segment, which is what the router matches it as. */
const compile = (route: string): CompiledRoute => {
  const [method, path] = route.split(' ')
  if (method === undefined || path === undefined) {
    throw new TypeError(`demo route must be "method /path": ${route}`)
  }
  const segments = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'),
    )
  return { method: method.toUpperCase(), pattern: new RegExp(`^${segments.join('/')}$`, 'u') }
}

const refused = DEMO_REFUSED_ROUTES.map(compile)
const sessionRevokeRoute = compile(DEMO_SESSION_REVOKE_ROUTE)

/** The edits refused by what they set rather than by where they are sent. */
const fieldRoutes: readonly { readonly route: CompiledRoute; readonly fields: readonly string[] }[] = [
  { route: compile(DEMO_PAYMENT_OPTIONS_ROUTE), fields: ['payment_options'] },
  ...Object.entries(DEMO_ACCOUNT_FIELD_ROUTES).map(([route, fields]) => ({
    route: compile(route),
    fields,
  })),
]

/** HEAD reaches a GET handler, so it has to meet the GET refusal too. */
const routedMethod = (method: string): string => (method === 'HEAD' ? 'GET' : method)

const matches = (route: CompiledRoute, method: string, path: string): boolean =>
  route.method === routedMethod(method) && route.pattern.test(path)

/** Every edit listed above reads a JSON body of up to this many bytes. */
const MAX_INSPECTED_BYTES = DEFAULT_MAX_JSON_BODY_BYTES

/**
 * Whether an edit sets any of `fields`. Read from a copy, so the route still
 * reads the body it was sent, and bounded the way the route is: a body past
 * its limit is refused there as too large, and reading further here would
 * spend the Worker's memory on a request that cannot succeed.
 */
const setsAnyOf = async (request: Request, fields: readonly string[]): Promise<boolean> => {
  const body = request.clone().body
  if (body === null) return false
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_INSPECTED_BYTES) {
        // Stop copying the rest. Never awaited: a clone is one branch of a
        // tee, and cancelling one branch settles only once the other -- the
        // route's -- is finished too, so waiting here would wait forever.
        void reader.cancel().catch(() => undefined)
        return false
      }
      chunks.push(value)
    }
  } catch {
    // A body that cannot be read here cannot be read by the route either,
    // which answers for it.
    return false
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // Not JSON, so not an edit the route will accept either.
    return false
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const edit: object = parsed
  return fields.some((field) => Object.hasOwn(edit, field))
}

/**
 * Whether the public demo refuses this request. Says nothing about any other
 * deployment.
 *
 * `path` must be the path the router matched on -- Hono's `context.req.path`,
 * which is percent-decoded -- and not the raw URL's. Matching the raw form would
 * let `/sender-identit%69es` past this check and into the handler the router
 * decodes it to. `actingSession` is the id of the session the request is
 * signed in with, or null where it has none.
 */
export const demoRefuses = async (
  request: Request,
  path: string,
  actingSession: string | null,
): Promise<boolean> => {
  if (refused.some((route) => matches(route, request.method, path))) return true
  if (matches(sessionRevokeRoute, request.method, path)) {
    return path.slice(path.lastIndexOf('/') + 1) !== actingSession
  }
  const edit = fieldRoutes.find(({ route }) => matches(route, request.method, path))
  return edit !== undefined && setsAnyOf(request, edit.fields)
}
