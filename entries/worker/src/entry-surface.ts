/**
 * What each deployment actually answers, declared rather than discovered.
 *
 * The app is shared between the two entries; the services are not. A capability
 * whose service one runtime composes and the other does not is a route that
 * answers in one deployment and 404s in the other — and nothing said so. The
 * contract guard proved the OpenAPI document against the Worker alone, so a
 * route mounted in only one entry passed it (#374).
 *
 * These three lists are asserted from both sides. A route added to one entry
 * and not the other fails the entry that has it (it is not declared) and the
 * entry that does not (it is declared and missing). Making the difference a
 * decision someone writes down is the whole point; the lists may shrink, and a
 * new name appearing in one is a capability that shipped in half the product.
 */

/**
 * Answered by a deployment and absent from the OpenAPI document. A surface no
 * generated client can discover, which is a gap rather than a feature.
 *
 * The GitHub pair are sign-in redirects whose OIDC counterparts are documented.
 * Backup status used to be here and no longer is: it was documented when a
 * screen was finally written against it, which is the direction this list is
 * meant to move in.
 *
 * The three portal routes are browser-facing like the GitHub pair: a contact
 * follows a link and gets a session, and there is no generated-client call to
 * make. They were invisible to this guard twice over -- unmounted everywhere,
 * and outside the `/api/v1` and `/auth` prefixes it looked at, so both halves
 * passed by mutual absence. They appear here only when a deployment configures
 * a magic-link key; without one the routes are not mounted at all.
 */
export const UNDOCUMENTED_ROUTES: readonly string[] = [
  'get /auth/github',
  'get /auth/github/callback',
  'post /portal/magic-link',
  'get /portal/verify',
  'get /portal/statements',
]

/**
 * Mounted only where the deployment carries Intuit keys.
 *
 * Four of the six are in the contract, so a generated client can call them; the
 * two above are not, for the reason given there. They are gated together
 * because they are one feature: a callback with no connect button behind it is
 * a URL nobody can reach, and a connect button with no callback is a handshake
 * that cannot finish.
 */
export const QUICKBOOKS_ROUTES: readonly string[] = [
  'get /api/v1/integrations/quickbooks',
  'post /api/v1/integrations/quickbooks/authorize',
  'get /api/v1/integrations/quickbooks/callback',
  'post /api/v1/integrations/quickbooks/settings',
  'delete /api/v1/integrations/quickbooks',
  'post /api/v1/integrations/quickbooks/webhook',
]

/**
 * Gated on the Wise API token, exactly as the QuickBooks set above and for the
 * same reason. One feature: a screen that cannot list a single destination is
 * worse than no screen.
 */
export const WISE_ROUTES: readonly string[] = [
  'get /api/v1/integrations/wise',
  'get /api/v1/integrations/wise/recipients',
  'post /api/v1/integrations/wise/recipients/link',
  'delete /api/v1/integrations/wise/recipients/:accountId',
]

/**
 * Mounted by the Worker and not by the container.
 *
 * `backup/status` reads the R2 export the nightly Worker cron writes. The
 * container's backups are the operator's own filesystem concern — `RESTORE.md`
 * is the contract there — so there is no run history for it to report and the
 * absence is deliberate.
 */
export const WORKER_ONLY_ROUTES: readonly string[] = ['get /api/v1/backup/status']

/** Mounted by the container and not by the Worker. */
export const CONTAINER_ONLY_ROUTES: readonly string[] = []

/** Mounted only where a magic-link signing key is configured, in either entry. */
export const PORTAL_ROUTES: readonly string[] = [
  'post /portal/magic-link',
  'get /portal/verify',
  'get /portal/statements',
]

/**
 * Every API, auth and portal route an app composes, in the form the lists above
 * use. `/portal` is in the sweep because leaving it out is how three routes
 * stayed unreachable in every deployment without either half of the guard
 * noticing.
 */
export const mountedApiRoutes = (
  routes: readonly { method: string; path: string }[],
): ReadonlySet<string> =>
  new Set(
    routes
      .filter(
        (route) =>
          route.method !== 'ALL' &&
          (route.path.startsWith('/api/v1') ||
            route.path.startsWith('/auth') ||
            route.path.startsWith('/portal')),
      )
      .map((route) => `${route.method.toLowerCase()} ${route.path}`),
  )

/**
 * Exactly what this entry should answer, in this configuration.
 *
 * An exact set rather than two subset checks, because subset checks are vacuous
 * in the direction that matters: an empty `WORKER_ONLY_ROUTES` satisfies "every
 * declared Worker-only route is mounted here" and "no declared Worker-only
 * route is mounted there" at the same time, which is how a route mounted in one
 * entry and declared nowhere would still have passed. Comparing the whole set
 * means an undeclared difference is a route on one side of the equality and not
 * the other, whichever entry it is missing from.
 */
export const expectedApiRoutes = (
  documented: readonly string[],
  entry: 'worker' | 'container',
  options: {
    readonly portal: boolean
    readonly quickBooks?: boolean
    readonly wise?: boolean
  },
): ReadonlySet<string> => {
  const gatedOff = new Set([
    ...(options.portal ? [] : PORTAL_ROUTES),
    ...(options.quickBooks === true ? [] : QUICKBOOKS_ROUTES),
    ...(options.wise === true ? [] : WISE_ROUTES),
    ...(entry === 'worker' ? CONTAINER_ONLY_ROUTES : WORKER_ONLY_ROUTES),
  ])
  return new Set(
    [...documented, ...UNDOCUMENTED_ROUTES].filter((route) => !gatedOff.has(route)),
  )
}

/** Sorted difference both ways, which is what a failure has to read as. */
export const routeDifference = (
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): { readonly unexpected: string[]; readonly missing: string[] } => ({
  unexpected: [...actual].filter((route) => !expected.has(route)).sort(),
  missing: [...expected].filter((route) => !actual.has(route)).sort(),
})
