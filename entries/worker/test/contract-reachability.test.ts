import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiContractOperations } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import {
  UNDOCUMENTED_ROUTES,
  expectedApiRoutes,
  mountedApiRoutes,
  routeDifference,
} from '../src/entry-surface.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * The contract is a promise made to generated clients, and nothing held the
 * deployment to it: five operations shipped in the OpenAPI document and in the
 * generated client while no entry mounted their routes, and the suite stayed
 * green because the only consumer of `apiContractOperations` was a fixture app
 * assembled by the same commit that wrote the contract. A fixture can always be
 * made to agree with itself. What a client calls is the app this entry composes
 * from the real runtime services, so that is what the contract is checked
 * against here.
 */
describe('Worker contract reachability', () => {
  let miniflare: Miniflare
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    const env: WorkerEnv = {
      DB: await miniflare.getD1Database('DB'),
      API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
      ENVIRONMENT: 'test',
      RELEASE: 'contract-reachability-test',
    }
    // The brand surface is passed the way `index.ts` passes it, or the guard
    // would prove the contract against an app the entry never serves.
    app = createApp(await createRuntimeServices(env), workerBrandAssetSurface)
  })

  afterAll(async () => miniflare.dispose())

  it('[contract] answers every documented operation on the deployed app', () => {
    const mounted = new Set(
      app.routes
        .filter((route) => route.method !== 'ALL')
        .map((route) => `${route.method.toLowerCase()} ${route.path}`),
    )
    const unreachable = apiContractOperations
      .map((operation) => `${operation.method} ${operation.path}`)
      .filter((operation) => !mounted.has(operation))
      .sort()

    expect(unreachable).toEqual([])
  })

  // The other half of the same promise: a route the deployment answers but the
  // document never mentions is a surface no client can discover. The list lives
  // in `entry-surface.ts` now, because the container's guard asserts the same
  // one — a gap declared in one entry's test was a gap the other could not see.
  it('[contract] documents every API route the deployed app answers', () => {
    const documented = new Set(
      apiContractOperations.map(
        (operation) => `${operation.method} ${operation.path}`,
      ),
    )
    const surplus = [...mountedApiRoutes(app.routes)]
      .filter(
        (route) => !documented.has(route) && !UNDOCUMENTED_ROUTES.includes(route),
      )
      .sort()

    expect(surplus).toEqual([])
  })

  // #374's second finding: this guard proved the contract against one entry, so
  // a route mounted in only one of them still passed. The difference is now
  // declared and asserted from both sides -- the container's test makes the
  // mirror-image assertions, so a capability wired into one runtime and not the
  // other fails the entry that has it and the entry that does not.
  it('[contract] answers exactly the surface declared for this entry', () => {
    // No magic-link key in this fixture, so the portal is off here.
    const difference = routeDifference(
      mountedApiRoutes(app.routes),
      expectedApiRoutes(
        apiContractOperations.map(
          (operation) => `${operation.method} ${operation.path}`,
        ),
        'worker',
        { portal: false },
      ),
    )

    expect(difference).toEqual({ unexpected: [], missing: [] })
  })
})
