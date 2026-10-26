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
  // A calendar-client Basic credential surface, outside the native API.
  'get /calendar/planning.ics',
  'get /auth/github',
  'get /auth/github/callback',
  'post /portal/magic-link',
  'get /portal/verify',
  'post /portal/verify',
  'get /portal/statements',
  'get /portal/estimates',
  'get /portal/estimates/:id',
  'post /portal/estimates/:id/response',
  'get /portal/estimate-review',
  // The hosted invoice page behind the link in an emailed invoice (issue 936).
  // Browser-facing like the portal set above, but unlike it neither gated on a
  // key nor on a session: the link's token is the authorisation, and both
  // entries mount all three.
  'get /portal/invoices/:token',
  'post /portal/invoices/:token/viewed',
  'get /portal/invoices/:token/document',
  // The single-use download of a backup, behind the link an administrator
  // minted (issue 39). Raw bytes for `curl`, not a generated-client call, and
  // the token is the authorisation. The Worker mounts it; see
  // `WORKER_ONLY_ROUTES`.
  'get /backup-download/:token',
  // Staff magic-link sign-in, the user-facing sibling of the portal set above
  // and gated on the same key. The verify leg is a browser confirm page and a form POST that
  // redirects, with no client call; request and exchange are called by the native app over raw
  // fetch, not a generated client -- so, like the OIDC app-code handoff, they
  // stay out of the generated client and, unlike it, out of the document too.
  'post /auth/magic-link',
  'get /auth/magic-link/verify',
  'post /auth/magic-link/verify',
  'post /auth/magic-link/exchange',
  // Native Sign in with Apple. The mobile app posts an Apple identity token
  // over raw fetch and gets the ordinary session back -- there is no redirect
  // and no generated-client call, so like the magic-link and OIDC app handoffs
  // it stays out of the generated client, and having no browser or client
  // surface to document, out of the document too. Always mounted; answers 404
  // until a deployment sets APPLE_CLIENT_ID.
  'post /auth/apple',
  'get /auth/apple/start',
  'post /auth/apple/callback',
  'get /auth/apple/disconnect',
  'post /auth/apple/disconnect',
]

/**
 * Mounted only where the deployment carries Intuit keys.
 *
 * Six of the eight are in the contract, so a generated client can call them;
 * the two above are not, for the reason given there. They are gated together
 * because they are one feature: a callback with no connect button behind it is
 * a URL nobody can reach, and a connect button with no callback is a handshake
 * that cannot finish. The two invoice routes (issue 819) are the same feature
 * seen from an invoice: without keys there is no mirror to report on, and the
 * invoice page shows no QuickBooks line.
 */
export const QUICKBOOKS_ROUTES: readonly string[] = [
  'get /api/v1/integrations/quickbooks',
  'post /api/v1/integrations/quickbooks/authorize',
  'get /api/v1/integrations/quickbooks/callback',
  'post /api/v1/integrations/quickbooks/settings',
  'delete /api/v1/integrations/quickbooks',
  'post /api/v1/integrations/quickbooks/webhook',
  'get /api/v1/integrations/quickbooks/reconciliation',
  'get /api/v1/invoices/:id/quickbooks',
  'post /api/v1/invoices/:id/quickbooks/sync',
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
export const WORKER_ONLY_ROUTES: readonly string[] = [
  'get /api/v1/backup/status',
  'post /api/v1/backup/offsite/check',
  'get /api/v1/backup/runs',
  // The signed download of a nightly bundle (issue 39): the bundle lives in
  // the Worker's R2 bucket, so the mint and the redemption go together.
  'post /api/v1/backup/download-links',
  'get /backup-download/:token',
  // The Deel time sync (#1102). Only the Worker composes the sync runtime and
  // its hourly schedule; the container has neither, so it does not answer these.
  'get /api/v1/deel-sync',
  'patch /api/v1/deel-sync/settings',
  'post /api/v1/deel-sync/preview',
  'post /api/v1/deel-sync/runs',
]

/** Mounted by the container and not by the Worker. */
export const CONTAINER_ONLY_ROUTES: readonly string[] = [
  'post /api/v1/csv-imports',
  'get /api/v1/csv-imports/:runId',
  'get /api/v1/csv-imports/:runId/mapping',
  'patch /api/v1/csv-imports/:runId/mapping',
  'post /api/v1/csv-imports/:runId/preview',
  'get /api/v1/csv-imports/:runId/errors',
  'get /api/v1/csv-imports/:runId/catalog',
  'get /api/v1/csv-imports/:runId/diagnostics',
  'delete /api/v1/csv-imports/:runId/input',
]

/**
 * Contact sign-in for the in-app portal, mounted only where
 * `PORTAL_MAGIC_LINK_SIGNING_KEY` is configured -- which is nowhere by default.
 *
 * It used to share `MAGIC_LINK_SIGNING_KEY` with the staff routes below, on the
 * reasoning that a second flag would always equal the first. That stopped being
 * true: `clients.conflict.media` runs its own portal worker with its own tokens,
 * its own store and its own mailer, so a deployment wants staff magic-link on
 * and this off. One key switching on two unrelated features is how that becomes
 * a surprise.
 *
 * Nothing in either repo calls these. They are kept rather than deleted because
 * central portal auth here is still a direction worth having open.
 *
 * Setting the key mounts them. Contact sign-in mail uses the deployment sender
 * and queue; a Worker without mail configured answers 503 for link requests.
 */
export const PORTAL_ROUTES: readonly string[] = [
  'post /portal/magic-link',
  'get /portal/verify',
  'post /portal/verify',
  'get /portal/statements',
  'get /portal/estimates',
  'get /portal/estimates/:id',
  'post /portal/estimates/:id/response',
  'get /portal/estimate-review',
]

/** Staff magic-link sign-in, gated on `MAGIC_LINK_SIGNING_KEY` alone. */
export const STAFF_MAGIC_LINK_ROUTES: readonly string[] = [
  'post /auth/magic-link',
  'get /auth/magic-link/verify',
  'post /auth/magic-link/verify',
  'post /auth/magic-link/exchange',
]

/**
 * Every API, auth, account-deletion and portal route an app composes, in the form the lists above
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
            route.path.startsWith('/account-deletion') ||
            route.path.startsWith('/portal') ||
            route.path.startsWith('/backup-download') || route.path.startsWith('/calendar/')),
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
    ...(options.portal ? [] : [...PORTAL_ROUTES, ...STAFF_MAGIC_LINK_ROUTES]),
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
