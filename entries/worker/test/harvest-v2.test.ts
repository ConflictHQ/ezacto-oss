import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type WorkerEnv } from '../src/app.js'
import { isServicePath } from '../src/data-request.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * The Harvest v2 shim on the Worker the entry composes: a real D1, the real
 * runtime services and a real stored API token. The route behavior itself is
 * pinned in packages/api; this holds what only the entry can get wrong, which
 * is whether the shim is mounted, reachable and answered in JSON.
 */
const bootstrapToken = `ezacto_abcdefghijklmnop_${'A'.repeat(43)}`

describe('Worker /harvest/v2 composition', () => {
  let miniflare: Miniflare
  let app: ReturnType<typeof createApp>
  let env: WorkerEnv
  let bearer: string

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    env = {
      DB: await miniflare.getD1Database('DB'),
      API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
      ENVIRONMENT: 'test',
      RELEASE: 'harvest-v2-test',
    }
    const services = await createRuntimeServices(env)
    await services.bootstrap({
      organizationName: 'Ezacto Test',
      ownerFirstName: 'Sample',
      ownerLastName: 'Owner',
      ownerEmail: 'owner@example.test',
      token: bootstrapToken,
    })
    bearer = (
      await services.tokens.issue({
        userId: 1,
        name: 'Harvest client',
        scopes: ['clients:read', 'team:read'],
      })
    ).token
    app = createApp(services)
  })

  afterAll(async () => miniflare.dispose())

  it('[contract] sends the shim to the app that has the services', () => {
    expect(isServicePath('/harvest/v2/clients')).toBe(true)
    expect(isServicePath('/harvest/v2')).toBe(true)
    expect(isServicePath('/harvest/v20')).toBe(false)
  })

  it('[api] serves the caller from an API token used as a Harvest bearer', async () => {
    const response = await app.request(
      '/harvest/v2/users/me',
      { headers: { authorization: `Bearer ${bearer}`, 'harvest-account-id': '1' } },
      env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      id: 1,
      first_name: 'Sample',
      email: 'owner@example.test',
      access_roles: ['administrator'],
    })
  })

  it('[api] pages an empty collection in the Harvest envelope', async () => {
    const response = await app.request(
      '/harvest/v2/clients',
      { headers: { authorization: `Bearer ${bearer}` } },
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      clients: [],
      total_entries: 0,
      total_pages: 1,
      page: 1,
    })
  })

  it('[security] refuses a request without a bearer and answers unknown paths in JSON', async () => {
    const anonymous = await app.request('/harvest/v2/clients', {}, env)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('content-type')).toContain('application/json')

    const unknown = await app.request(
      '/harvest/v2/time_entries/1/nonexistent',
      { headers: { authorization: `Bearer ${bearer}` } },
      env,
    )
    expect(unknown.status).toBe(404)
    expect(unknown.headers.get('content-type')).toContain('application/json')
    expect(await unknown.text()).not.toContain('data-not-found-page')
  })
})
