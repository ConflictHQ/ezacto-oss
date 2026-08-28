import { describe, expect, it } from 'vitest'
import { createApp, type Env, type Health } from '../src/app.js'

const env: Env = { ENVIRONMENT: 'test', RELEASE: 'abc1234def5678' }

const app = createApp()

describe('worker entry', () => {
  it('reports health with the environment and release it was deployed with', async () => {
    const res = await app.request('/healthz', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as Health
    expect(body).toEqual({
      status: 'ok',
      service: 'ezacto',
      environment: 'test',
      release: 'abc1234def5678',
    })
  })

  it('serves an instance page naming the deployment and the short release', async () => {
    const res = await app.request('/', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    expect(html).toContain('<title>ezacto — test</title>')
    expect(html).toContain('abc1234')
    expect(html).toContain('/openapi/v1.json')
    // Deployments are not for search engines until the product is real.
    expect(html).toContain('name="robots" content="noindex"')
  })

  it('publishes the versioned OpenAPI contract without database bindings', async () => {
    const res = await app.request('/openapi/v1.json', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const document = (await res.json()) as {
      openapi: string
      info: { version: string }
      paths: Record<string, unknown>
    }
    expect(document.openapi).toBe('3.1.0')
    expect(document.info.version).toBe('1.0.0')
    expect(document.paths).toHaveProperty('/api/v1/time-entries')
    expect(document.paths).toHaveProperty('/api/v1/projects')
  })

  it('fails the shared API closed until this deployment configures an auth store', async () => {
    const res = await app.request('/api/v1', {}, env)

    expect(res.status).toBe(401)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="ezacto"')
    expect(await res.json()).toEqual({
      error: {
        code: 'authentication_required',
        message: 'A valid API token or user session is required.',
        fields: [],
      },
      request_id: res.headers.get('x-request-id'),
    })
  })

  it('escapes binding values rather than interpolating them into the page raw', async () => {
    const res = await app.request('/', {}, { ENVIRONMENT: '<script>x</script>', RELEASE: 'deadbeef' })

    const html = await res.text()
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('404s an unknown path instead of falling through to the page', async () => {
    const res = await app.request('/nope', {}, env)
    expect(res.status).toBe(404)
  })
})
