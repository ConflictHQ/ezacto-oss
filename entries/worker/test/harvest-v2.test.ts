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
        scopes: ['clients:read', 'projects:read', 'team:read', 'time_entries:read', 'invoices:read'],
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

  it('[api] mounts time entries and project assignments on the runtime services', async () => {
    const headers = { authorization: `Bearer ${bearer}` }
    const entries = await app.request('/harvest/v2/time_entries', { headers }, env)
    expect(entries.status).toBe(200)
    expect(await entries.json()).toMatchObject({ time_entries: [], total_entries: 0, page: 1 })
    const assignments = await app.request('/harvest/v2/users/me/project_assignments', { headers }, env)
    expect(assignments.status).toBe(200)
    expect(await assignments.json()).toMatchObject({ project_assignments: [], total_entries: 0 })
    expect((await app.request('/harvest/v2/time_entries/1', { headers }, env)).status).toBe(404)
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
  it('[api] reads native invoices through the wired Worker source', async () => {
    const at='2026-10-01T12:00:00.000Z'
    await env.DB.prepare("INSERT INTO clients(id,name,currency,created_at,updated_at)VALUES(1,'Sample Client','USD',?,?)").bind(at,at).run()
    await env.DB.prepare("INSERT INTO invoices(id,client_id,created_by_user_id,number,currency,issue_date,due_date,state,amount_cents,due_amount_cents,created_at,updated_at)VALUES(1,1,1,'SMP-1','USD','2026-10-01','2026-11-01','draft',2500,2500,?,?)").bind(at,at).run()
    await env.DB.prepare("INSERT INTO invoice_line_items(id,invoice_id,position,kind,description,quantity,unit_price_cents,amount_cents,taxed,taxed2,created_at,updated_at)VALUES(1,1,0,'Service','Sample line',1,2500,2500,0,0,?,?)").bind(at,at).run()
    const headers={authorization:`Bearer ${bearer}`}
    const page=await app.request('/harvest/v2/invoices',{headers},env)
    expect(page.status).toBe(200)
    expect(await page.json()).toMatchObject({invoices:[{id:1,number:'SMP-1',amount:25,client:{id:1,name:'Sample Client'}}],total_entries:1,per_page:100})
    const detail=await app.request('/harvest/v2/invoices/1',{headers},env)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({id:1,amount:25,creator:{id:1,name:'Sample Owner'}})
    const disabled=await app.request('/harvest/v2/invoices',{headers},{...env,INVOICES_ENABLED:'false'})
    expect(disabled.status).toBe(403)
    expect(await disabled.json()).toMatchObject({error:{code:'module_disabled'}})
  })

})
