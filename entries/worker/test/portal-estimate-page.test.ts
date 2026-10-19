import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import { workerInstanceThemeSurface } from '../src/instance-theme.js'
import { isServicePath } from '../src/data-request.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * Issue 1010, slice 3: the page a contact answers an estimate on is mounted
 * with the portal routes it calls, behind the same key, and nowhere else.
 */
describe('the customer estimate page on the Worker', () => {
  let miniflare: Miniflare
  let keyed: ReturnType<typeof createApp>
  let unkeyed: ReturnType<typeof createApp>
  let env: WorkerEnv

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    const base: WorkerEnv = {
      DB: await miniflare.getD1Database('DB'),
      API_CURSOR_SIGNING_KEY: 'A'.repeat(43),
      ENVIRONMENT: 'test',
      RELEASE: 'portal-estimate-page-test',
      APP_BASE_URL: 'https://app.example.test',
    }
    env = { ...base, PORTAL_MAGIC_LINK_SIGNING_KEY: `${'Q'.repeat(42)}A` }
    keyed = createApp(
      await createRuntimeServices(env),
      workerBrandAssetSurface,
      workerInstanceThemeSurface,
    )
    unkeyed = createApp(
      await createRuntimeServices(base),
      workerBrandAssetSurface,
      workerInstanceThemeSurface,
    )
  })

  afterAll(async () => miniflare.dispose())

  it('[security] serves a page that sets nothing, loads nothing foreign and keeps the referrer home', async () => {
    const response = await keyed.request('/portal/estimate-review', {}, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    const html = await response.text()
    expect(html).toContain('/assets/portal-estimates.js')
    expect(html).toContain('data-portal-estimates')
    expect(html).not.toMatch(/token/iu)
  })

  it('[api] is reachable by the app that has the services', () => {
    expect(isServicePath('/portal/estimate-review')).toBe(true)
  })

  it('[security] is absent where the portal key is not configured', async () => {
    const response = await unkeyed.request('/portal/estimate-review', {}, env)
    expect(response.status).toBe(404)
  })

  it('[security] shows a contact with no session nothing of any estimate', async () => {
    const list = await keyed.request('/portal/estimates', {}, env)
    expect(list.status).toBe(401)
    const one = await keyed.request('/portal/estimates/1', {}, env)
    expect(one.status).toBe(401)
    const answer = await keyed.request(
      '/portal/estimates/1/response',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ decision: 'accept', version: 'a'.repeat(64) }),
      },
      env,
    )
    expect(answer.status).toBe(401)
  })

  it('[unit] serves the page script as JavaScript', async () => {
    const shell = createApp(undefined, workerBrandAssetSurface, workerInstanceThemeSurface)
    const response = await shell.request('/assets/portal-estimates.js', {}, env)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    const script = await response.text()
    expect(script).toContain('/portal/estimates')
    expect(script).toContain('/portal/verify')
  })
})
