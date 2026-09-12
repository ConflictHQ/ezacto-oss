/**
 * Which requests are served by the app that has runtime services.
 *
 * The entry serves two apps. The shell is composed without services at all, so
 * that a page render never opens the database; everything that needs a service
 * goes to the app built from `createRuntimeServices`. This predicate is the
 * switch between them, and a route mounted on the services app whose path this
 * does not admit is answered by the shell instead -- which has no such route,
 * so a real deployment returns the not-found page and the suite never notices,
 * because both apps are correct in isolation.
 *
 * That is not hypothetical (#615). Stripe's deliveries and the three client-portal
 * magic-link routes all mounted correctly and were all unreachable in a
 * deployment, because `/webhooks` and `/portal` were not on this list. Stripe
 * would have posted a real payment here, been handed a 200 and an HTML page,
 * and recorded the invoice as settled nowhere.
 *
 * `contract-reachability.test.ts` now holds every services-app route against
 * this predicate, so a new prefix cannot be introduced without being added.
 */
const SERVICE_PATH_PREFIXES: readonly string[] = [
  '/__ezacto/bootstrap',
  '/api/v1',
  '/auth',
  // Followed by a contact from an emailed link; the session is what it issues.
  '/portal',
  // No session, by definition: a payment processor calling us. The signature is
  // the authorisation.
  '/webhooks',
]

export const isServicePath = (path: string): boolean =>
  SERVICE_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  )

export const isDataRequest = (request: Request): boolean =>
  isServicePath(new URL(request.url).pathname)
