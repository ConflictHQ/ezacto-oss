import { describe, expect, it } from 'vitest'
import {
  createApp,
  type Env,
  type Health,
  type WorkerEnv,
} from '../src/app.js'

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

  it('serves the responsive application shell with the deployment stamp', async () => {
    const res = await app.request('/', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    expect(html).toContain('<title>ezacto — Time</title>')
    expect(html).toContain('abc1234')
    expect(html).toContain('data-timer-chip')
    expect(html).toContain('data-command-dialog')
    expect(html).toContain('data-sign-in-form')
    expect(html).toContain('data-oidc-unavailable')
    expect(html).not.toContain('data-oidc-provider')
    expect(html).toContain('data-current-identity')
    expect(html).toContain('data-logout')
    expect(html).toContain('/assets/ezacto.css')
    expect(html).toContain('/assets/ezacto.js')
    expect(html).toContain('name="robots" content="noindex"')
    expect(res.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    )
    expect(res.headers.get('content-security-policy')).toContain(
      "form-action 'self'",
    )
  })

  it('serves deterministic shell assets with explicit content types', async () => {
    const [style, script] = await Promise.all([
      app.request('/assets/ezacto.css', {}, env),
      app.request('/assets/ezacto.js', {}, env),
    ])

    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await style.text()).toContain('@media (max-width: 720px)')
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    const javascript = await script.text()
    expect(javascript.length).toBeGreaterThan(1_000)
    expect(javascript).toContain('/auth/sign-in')
    expect(javascript).toContain('/api/v1/sessions')
  })

  it('[security] advertises a configured Google flow without exposing its runtime secrets', async () => {
    const configured = {
      ...env,
      ENVIRONMENT: 'dev',
      DB: {} as D1Database,
      API_CURSOR_SIGNING_KEY: 'unused',
      OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
      OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
    } satisfies WorkerEnv
    const res = await app.request('/', {}, configured)
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('data-oidc-provider="google"')
    expect(html).toContain('href="/auth/oidc/google"')
    expect(html).not.toContain(configured.OIDC_GOOGLE_CLIENT_ID)
    expect(html).not.toContain(configured.OIDC_GOOGLE_CLIENT_SECRET)
    expect(html).not.toContain('accounts.google.com')
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
    const res = await app.request(
      '/',
      {},
      { ENVIRONMENT: '<script>x</script>', RELEASE: 'deadbeef' },
    )

    const html = await res.text()
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('404s an unknown path instead of falling through to the page', async () => {
    const res = await app.request('/nope', {}, env)
    expect(res.status).toBe(404)
  })
})
