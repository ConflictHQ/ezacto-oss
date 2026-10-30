import { createApiIdempotencyAuthorization, isCsvStagingPath, withIdempotency } from '@ezacto/api'
import { demoDeployment, type AppEnv, type RuntimeServices } from '../../worker/src/app.js'
import { isDataRequest } from '../../worker/src/data-request.js'

interface App {
  fetch(request: Request, env: AppEnv): Response | Promise<Response>
}

/**
 * What the container answers a request with, once it has been made the
 * instance's own (`externalRequest`). The data paths keep the Worker's
 * idempotency contract (#952): a write with an Idempotency-Key runs once and
 * is replayed after that, and every answer advertises it. Everything else -- the
 * shell's pages -- goes straight to the app, as on the Worker.
 */
export const createContainerHandler = (
  services: Pick<RuntimeServices, 'idempotency' | 'tokens' | 'sessions' | 'authenticationSessions' | 'isOwnMoneyVisible' | 'invoiceElevations'>,
  app: App,
  env: AppEnv,
): ((request: Request) => Promise<Response>) => {
  const authorize = createApiIdempotencyAuthorization({
    tokens: services.tokens,
    sessions: services.authenticationSessions ?? services.sessions,
    ownMoneyVisible: services.isOwnMoneyVisible,
  }, async () => JSON.stringify([await services.idempotency.store.authorizationRevision(), env.RELEASE, demoDeployment(env)]), { ...(services.invoiceElevations === undefined ? {} : {invoiceElevations:services.invoiceElevations}) })
  const answer = (request: Request): Promise<Response> => Promise.resolve(app.fetch(request, env))
  return (request) => {
    // CSV owns its streamed hash/CAS protocol; the generic wrapper must not
    // buffer an unauthorised upload before the route's session/owner checks.
    if (isCsvStagingPath(new URL(request.url).pathname)) return answer(request)
    if (!isDataRequest(request)) return answer(request)
    return withIdempotency(request, answer, {
      store: services.idempotency.store,
      authorize,
      secret: services.idempotency.secret,
      report: (error) => {
        // The name alone: a driver error can quote SQL, and SQL can quote a
        // response that was being kept.
        console.error(
          `ezacto: an idempotent response was not recorded: ${error instanceof Error ? error.name : 'UnknownError'}`,
        )
      },
    })
  }
}
