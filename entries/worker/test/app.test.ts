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
    expect(html).toContain('<title>ezacto — Sign in</title>')
    expect(html).toContain('abc1234')
    expect(html).toContain('data-auth-gateway data-state="checking"')
    expect(html).toContain('data-authenticated-shell hidden inert')
    expect(html).toContain('data-timer-chip')
    expect(html).toContain('data-command-dialog')
    expect(html).toContain('data-sign-in-form')
    expect(html).not.toContain('data-oidc-provider')
    expect(html).not.toContain('data-oidc-entry')
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

  it('[acceptance] serves invoice browse and numeric detail shells without redirects', async () => {
    const list = await app.request('/invoices', {}, env)
    const detail = await app.request('/invoices/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="invoice-list"')
    expect(listHtml).toContain('data-invoice-list-page')
    expect(listHtml).toContain('href="/invoices" aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="invoice-detail"')
    expect(detailHtml).toContain('data-invoice-detail-page')
    expect(detailHtml).toContain('data-invoice-document data-document-shell')
    expect(detailHtml).toContain('data-ez-theme="precision"')
  })

  it.each(['/invoices/0', '/invoices/nope', '/invoices/9007199254740992'])(
    '[security] rejects invalid invoice detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it('[acceptance] serves the Clients V1 list and numeric detail shells', async () => {
    const list = await app.request('/clients', {}, env)
    const detail = await app.request('/clients/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="client-list"')
    expect(listHtml).toContain('data-client-list-page')
    expect(listHtml).toContain('href="/clients" aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="client-detail"')
    expect(detailHtml).toContain('data-client-detail-page')
    expect(detailHtml).toContain('<dt>Worked-for parent</dt>')
    expect(detailHtml).toContain('<dt>Bill-to client</dt>')
  })

  it.each(['/clients/0', '/clients/nope', '/clients/9007199254740992'])(
    '[security] rejects invalid client detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it('[acceptance] serves the Projects V1 list and numeric detail shells', async () => {
    const list = await app.request('/projects', {}, env)
    const detail = await app.request('/projects/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="project-list"')
    expect(listHtml).toContain('data-project-list-page')
    expect(listHtml).toContain('href="/projects" aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="project-detail"')
    expect(detailHtml).toContain('data-project-detail-page')
    expect(detailHtml).toContain('data-project-task-assignments')
    expect(detailHtml).toContain('<div class="project-form-body" data-project-form-body></div>')
    expect(detailHtml).not.toContain('name="hourly_rate_cents"')
    expect(detailHtml).not.toContain('name="cost_budget_cents"')
  })

  it.each(['/projects/0', '/projects/nope', '/projects/9007199254740992'])(
    '[security] rejects invalid project detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it('[acceptance] serves the Expenses V1 list and numeric detail shells', async () => {
    const list = await app.request('/expenses', {}, env)
    const detail = await app.request('/expenses/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="expense-list"')
    expect(listHtml).toContain('data-expense-list-page')
    expect(listHtml).toContain('data-expense-create-form')
    expect(listHtml).toContain('href="/expenses" aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="expense-detail"')
    expect(detailHtml).toContain('data-expense-detail-page')
    expect(detailHtml).toContain('data-expense-edit-form')
    expect(detailHtml).toContain('data-expense-attachment-form')
  })

  it.each(['/expenses/0', '/expenses/nope', '/expenses/9007199254740992'])(
    '[security] rejects invalid expense detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it.each(['/', '/clients', '/clients/42', '/projects', '/projects/42', '/expenses', '/expenses/42', '/invoices', '/invoices/42', '/invoices/new', '/approvals'])(
    '[security] renders %s as an inert shell under an overlay when a session cookie is present',
    async (path) => {
      const res = await app.request(
        path,
        { headers: { cookie: '__Host-ezacto_session=opaque-session-token' } },
        env,
      )

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toMatch(/data-auth-gateway[^>]+ hidden>/u)
      expect(html).toContain(
        'data-session-check-overlay role="status" aria-live="polite" aria-atomic="true">',
      )
      expect(html).toContain('data-authenticated-shell inert aria-busy="true"')
      expect(html).toContain('data-auth-action disabled')
      expect(html).not.toContain('opaque-session-token')
    },
  )

  it.each([
    'unrelated=value',
    '__Host-ezacto_session=',
    '__Host-ezacto_sessionish=opaque-session-token',
  ])('[security] does not resume the shell for non-session cookie %s', async (cookie) => {
    const res = await app.request('/', { headers: { cookie } }, env)
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('data-authenticated-shell hidden inert aria-busy="true"')
    expect(html).toContain(
      'data-session-check-overlay role="status" aria-live="polite" aria-atomic="true" hidden>',
    )
    expect(html).not.toMatch(/data-auth-gateway[^>]+ hidden>/u)
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

  it.each([
    {
      name: 'missing credentials',
      values: {},
    },
    {
      name: 'partial credentials',
      values: {
        APP_BASE_URL: 'https://local-tunnel.example',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
      },
    },
    {
      name: 'oversized client id',
      values: {
        ENVIRONMENT: 'dev',
        OIDC_GOOGLE_CLIENT_ID: 'x'.repeat(513),
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
    {
      name: 'oversized client secret',
      values: {
        ENVIRONMENT: 'prod',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'x'.repeat(4_097),
      },
    },
    {
      name: 'non-HTTPS origin',
      values: {
        APP_BASE_URL: 'http://localhost:8787',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
    {
      name: 'non-origin HTTPS URL',
      values: {
        APP_BASE_URL: 'https://local-tunnel.example/path',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
    {
      name: 'non-HTTPS scheme',
      values: {
        APP_BASE_URL: 'javascript:alert(1)',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
  ])('[security] does not advertise Google for $name', async ({ values }) => {
    const res = await app.request(
      '/',
      {},
      {
        ...env,
        DB: {} as D1Database,
        API_CURSOR_SIGNING_KEY: 'unused',
        ...values,
      },
    )
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).not.toContain('data-oidc-provider')
    expect(html).not.toContain('data-oidc-entry')
    expect(html).not.toContain('Single sign-on is not available')
    expect(html).toContain('method="post" action="/auth/sign-in"')
  })

  it('[security] does not leak provider availability across sequential Worker requests', async () => {
    const configured = {
      ...env,
      ENVIRONMENT: 'dev',
      DB: {} as D1Database,
      API_CURSOR_SIGNING_KEY: 'unused',
      OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
      OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
    } satisfies WorkerEnv
    const environments: WorkerEnv[] = [
      configured,
      { ...configured, OIDC_GOOGLE_CLIENT_SECRET: undefined },
      { ...configured, OIDC_GOOGLE_CLIENT_ID: 'x'.repeat(513) },
      configured,
    ]

    for (const [index, requestEnv] of environments.entries()) {
      const res = await app.request('/', {}, requestEnv)
      const html = await res.text()
      const shouldAdvertise = index === 0 || index === environments.length - 1

      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(html.includes('data-oidc-provider="google"')).toBe(shouldAdvertise)
      expect(html.includes('data-oidc-entry')).toBe(shouldAdvertise)
      expect(html).not.toContain('Single sign-on is not available')
    }
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
