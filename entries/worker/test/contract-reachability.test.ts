import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apiContractOperations } from '@ezacto/api'
import { createApp, type WorkerEnv } from '../src/app.js'
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
    app = createApp(await createRuntimeServices(env))
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
  // document never mentions is a surface no client can discover. These three
  // predate the guard — backup status, and the GitHub sign-in redirects whose
  // OIDC counterparts are documented. Naming them keeps the gap visible and
  // makes admitting the next one a decision rather than an omission.
  //
  // One caveat this list cannot express: the app under test is the Worker's.
  // `get /api/v1/backup/status` is mounted only where `services.backupStatus`
  // is defined, which the Worker runtime sets and the container runtime does
  // not — so it answers here and not there. This guard therefore proves the
  // contract against ONE entry, and a route mounted in only one of them still
  // passes. Extending it over the container is #374.
  const undocumented = [
    'get /api/v1/backup/status',
    'get /auth/github',
    'get /auth/github/callback',
  ]

  it('[contract] documents every API route the deployed app answers', () => {
    const documented = new Set(
      apiContractOperations.map(
        (operation) => `${operation.method} ${operation.path}`,
      ),
    )
    const surplus = app.routes
      .filter(
        (route) =>
          route.method !== 'ALL' &&
          (route.path.startsWith('/api/v1') || route.path.startsWith('/auth')),
      )
      .map((route) => `${route.method.toLowerCase()} ${route.path}`)
      .filter(
        (route) => !documented.has(route) && !undocumented.includes(route),
      )
      .sort()

    expect(surplus).toEqual([])
  })
})
