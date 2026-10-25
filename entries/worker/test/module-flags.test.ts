import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEmailJob } from '@ezacto/mailer'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import { workerInstanceThemeSurface } from '../src/instance-theme.js'
import { createRuntimeServices } from '../src/runtime.js'

/**
 * The operator's module switches (issue 1254), asked of a real runtime on a
 * real D1 with every provider secret set. What leaves the machine is watched at
 * `fetch` and at the mail queue: a disabled module passes only if neither was
 * touched, and only if the data it owns is exactly as it was.
 */

const at = '2026-10-06T12:00:00.000Z'
const cursorKey = 'A'.repeat(43)
const bootstrapToken = `ezacto_${'A'.repeat(16)}_${'B'.repeat(43)}`
const owner = { email: 'admin@modules.example.test', password: 'correct horse battery staple' }

const outbound: string[] = []
const realFetch = globalThis.fetch

beforeAll(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      return realFetch(input, init)
    }
    outbound.push(`${url.host}${url.pathname}`)
    throw new Error(`outbound network is off in this test: ${url.host}`)
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  outbound.length = 0
})

const secrets = {
  OIDC_GOOGLE_CLIENT_ID: 'google-fixture-id',
  OIDC_GOOGLE_CLIENT_SECRET: 'google-fixture-secret',
  GITHUB_CLIENT_ID: 'github-fixture-id',
  GITHUB_CLIENT_SECRET: 'github-fixture-secret',
  QUICKBOOKS_CLIENT_ID: 'quickbooks-fixture-id',
  QUICKBOOKS_CLIENT_SECRET: 'quickbooks-fixture-secret',
  QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN: 'quickbooks-fixture-verifier',
  QUICKBOOKS_ENVIRONMENT: 'sandbox',
} as const

let miniflare: Miniflare
let database: D1Database
let jobs: QueuedEmailJob[]
let baseEnv: WorkerEnv

interface Deployment {
  readonly app: ReturnType<typeof createApp>
  readonly env: WorkerEnv
}

/** The same database, composed again under other switches: restart with a changed environment. */
const deploy = async (flags: Partial<WorkerEnv>): Promise<Deployment> => {
  const env: WorkerEnv = { ...baseEnv, ...flags }
  const services = await createRuntimeServices(env)
  return { app: createApp(services, workerBrandAssetSurface, workerInstanceThemeSurface), env }
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
  })
  database = await miniflare.getD1Database('DB')
  const bucket = await miniflare.getR2Bucket('ATTACHMENTS')
  jobs = []
  baseEnv = {
    DB: database,
    ATTACHMENTS: {
      put: (key: string, value: unknown, options?: unknown) =>
        bucket.put(key, value as never, options as never),
      get: (key: string) => bucket.get(key),
      head: (key: string) => bucket.head(key),
    } as unknown as R2Bucket,
    EMAIL_QUEUE: { send: async (job: QueuedEmailJob) => void jobs.push(job) } as unknown as Queue<QueuedEmailJob>,
    API_CURSOR_SIGNING_KEY: cursorKey,
    APP_BASE_URL: 'https://modules.example.test',
    ENVIRONMENT: 'test',
    RELEASE: 'module-flags-test',
    MAIL_FROM: 'Fixture <billing@modules.example.test>',
    MAILGUN_API_KEY: 'mailgun-fixture-key',
    MAILGUN_DOMAIN: 'modules.example.test',
    ...secrets,
  }
  const services = await createRuntimeServices(baseEnv)
  await services.bootstrap({
    organizationName: 'Fixture Organization',
    ownerFirstName: 'Fixture',
    ownerLastName: 'Administrator',
    ownerEmail: owner.email,
    token: bootstrapToken,
  })
  await services.enrollOwnerPassword({ token: bootstrapToken, password: owner.password })
  await database
    .prepare(
      `INSERT INTO clients (id, name, currency, created_at, updated_at) VALUES (1, 'Fixture Client', 'USD', ?, ?)`,
    )
    .bind(at, at)
    .run()
  await database
    .prepare(
      `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
         amount_cents, due_amount_cents, payment_options, created_at, updated_at)
       VALUES (1, 1, 'INV-1', 'USD', '2026-10-01', '2026-10-31', 'draft', 1234, 1234, '[]', ?, ?)`,
    )
    .bind(at, at)
    .run()
}, 60_000)

afterAll(async () => miniflare.dispose())

const cookieFor = async (deployment: Deployment): Promise<string> => {
  const signedIn = await deployment.app.request(
    '/auth/sign-in',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(owner),
    },
    deployment.env,
  )
  expect(signedIn.status).toBe(200)
  return signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
}

const call = async (
  deployment: Deployment,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  deployment.app.request(
    path,
    {
      method,
      redirect: 'manual',
      headers: {
        origin: 'http://localhost',
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        'idempotency-key': `module-flags-${Math.random().toString(36).slice(2)}`,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    deployment.env,
  )

const refusal = async (response: Response): Promise<string | null> => {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return null
  return ((await response.json()) as { error?: { code?: string } }).error?.code ?? null
}

const refused = async (
  deployment: Deployment,
  cookie: string | undefined,
  requests: readonly (readonly [string, string])[],
): Promise<void> => {
  for (const [method, path] of requests) {
    const response = await call(deployment, method, path, {
      ...(cookie === undefined ? {} : { cookie }),
      ...(method === 'POST' ? { body: {} } : {}),
    })
    expect([method, path, response.status, await refusal(response)]).toEqual([
      method,
      path,
      403,
      'module_disabled',
    ])
  }
  expect(outbound).toEqual([])
  expect(jobs).toEqual([])
}

const rows = async (): Promise<unknown> => ({
  invoices: (await database.prepare('SELECT * FROM invoices ORDER BY id').all()).results,
  organization: (await database.prepare('SELECT modules FROM organizations').all()).results,
})

describe('operator module switches (issue 1254)', () => {
  it('[sso] refuses every federated sign-in route and offers none, with no provider call', async () => {
    const off = await deploy({ SSO_ENABLED: 'false' })
    const cookie = await cookieFor(off)
    await refused(off, undefined, [
      ['GET', '/auth/oidc/google'],
      ['GET', '/auth/oidc/google/callback'],
      ['GET', '/auth/github'],
      ['GET', '/auth/github/callback'],
      ['POST', '/auth/apple'],
      ['GET', '/auth/apple/disconnect'],
    ])
    await refused(off, cookie, [['GET', '/api/v1/settings/sso-domains']])
    const page = await (await off.app.request('/', {}, off.env)).text()
    expect(page).toContain('data-sso-unavailable')
    expect(page).not.toContain('data-oidc-provider')
    expect(page).not.toContain('/auth/oidc/google')
    // Password sign-in is not single sign-on and is untouched; the exchange
    // that also redeems magic-link app codes stays reachable.
    expect((await call(off, 'POST', '/auth/oidc/exchange', { body: {} })).status).not.toBe(403)

    const on = await deploy({})
    expect(await refusal(await call(on, 'GET', '/auth/github'))).not.toBe('module_disabled')
    const onPage = await (await on.app.request('/', {}, on.env)).text()
    expect(onPage).not.toContain('data-sso-unavailable')
    expect(onPage).toContain('data-oidc-provider="google"')
  })

  it('[backups] refuses the status, history, download and off-site routes', async () => {
    const off = await deploy({ BACKUPS_ENABLED: 'false' })
    const cookie = await cookieFor(off)
    await refused(off, cookie, [
      ['GET', '/api/v1/backup/status'],
      ['GET', '/api/v1/backup/runs'],
      ['POST', '/api/v1/backup/offsite/check'],
      ['POST', '/api/v1/backup/download-links'],
    ])
    await refused(off, undefined, [['GET', '/backup-download/not-a-token']])
    expect(await (await off.app.request('/settings/company', {}, off.env)).text()).toContain(
      'data-backups-unavailable',
    )
    const on = await deploy({})
    expect((await call(on, 'GET', '/api/v1/backup/status', { cookie })).status).toBe(200)
  })

  it('[accounting] refuses QuickBooks routes and the webhook before any provider call', async () => {
    const off = await deploy({ ACCOUNTING_ENABLED: 'false' })
    const cookie = await cookieFor(off)
    await refused(off, cookie, [
      ['GET', '/api/v1/integrations/quickbooks'],
      ['POST', '/api/v1/integrations/quickbooks/authorize'],
      ['GET', '/api/v1/invoices/1/quickbooks'],
      ['POST', '/api/v1/invoices/1/quickbooks/sync'],
    ])
    await refused(off, undefined, [['POST', '/webhooks/quickbooks']])
    expect(await (await off.app.request('/invoices', {}, off.env)).text()).toContain(
      'data-accounting-unavailable',
    )
  })

  it('[accounting #1217] reports composed native providers independently without contacting them', async () => {
    const flags = { QUICKBOOKS_CLIENT_ID: undefined, QUICKBOOKS_CLIENT_SECRET: undefined,
      BILL_DEV_KEY: 'private-bill-dev', BILL_COMPANY_ID: 'private-bill-company', BILL_USERNAME: 'private-bill-user', BILL_PASSWORD: 'private-bill-password',
      WISE_TOKEN: 'private-wise-token', DEEL_TOKEN: 'private-deel-token', DEEL_SYNC_START_DATE: '2026-01-01' }
    const ready = await deploy(flags)
    const html = await (await ready.app.request('/settings/company', {}, ready.env)).text()
    expect(html).not.toContain('data-accounting-unavailable')
    expect(html).toContain('data-quickbooks-unavailable')
    for (const id of ['bill', 'wise', 'deel']) expect(html).toContain(`data-accounting-provider="${id}" data-provider-available="true"`)
    for (const secret of Object.values(flags)) if (secret?.startsWith('private-')) expect(html).not.toContain(secret)
    expect(outbound).toEqual([])
    const off = await deploy({ ...flags, ACCOUNTING_ENABLED: 'false' })
    const disabled = await (await off.app.request('/settings/company', {}, off.env)).text()
    expect(disabled).toContain('data-accounting-unavailable')
    expect(outbound).toEqual([])
  })

  it('[invoices] refuses the invoice API, sends nothing, and sends the screens home', async () => {
    const on = await deploy({})
    const off = await deploy({ INVOICES_ENABLED: 'false' })
    const cookie = await cookieFor(off)
    await refused(off, cookie, [
      ['GET', '/api/v1/invoices'],
      ['GET', '/api/v1/invoices/1'],
      ['POST', '/api/v1/invoices/1/deliveries'],
      ['POST', '/api/v1/invoices/1/deliveries/preview'],
      ['POST', '/api/v1/invoices/1/deliveries/preview/send'],
      ['GET', '/api/v1/recurring-invoices'],
      ['POST', '/api/v1/invoice-generations'],
      ['GET', '/api/v1/settings/invoice-defaults'],
      ['GET', '/api/v1/settings/invoice-reminders'],
      ['GET', '/api/v1/clients/1/invoice-sending'],
      ['GET', '/api/v1/scheduled-runs/1'],
    ])
    await refused(off, undefined, [['GET', '/portal/invoices/not-a-token']])
    for (const path of ['/invoices', '/invoices/new', '/invoices/recurring', '/invoices/INV-1']) {
      const response = await call(off, 'GET', path, { cookie })
      expect([path, response.status, response.headers.get('location')]).toEqual([path, 302, '/'])
    }
    const page = await (await off.app.request('/', {}, off.env)).text()
    expect(page).toContain('data-invoices-unavailable')
    // Neither the sidebar nor the Menu offers the section.
    expect(page).not.toContain('data-money-nav')
    expect(page).not.toContain('menu-hint-invoices')
    expect(await (await on.app.request('/', {}, on.env)).text()).toContain('data-money-nav')
    // An invoice is not the only thing a client has: other APIs still answer.
    expect((await call(off, 'GET', '/api/v1/clients', { cookie })).status).toBe(200)
  })

  it('[invariant] disabling and re-enabling touches no data', async () => {
    const before = await rows()
    const off = await deploy({
      INVOICES_ENABLED: 'false',
      SSO_ENABLED: 'false',
      BACKUPS_ENABLED: 'false',
      ACCOUNTING_ENABLED: 'false',
    })
    const cookie = await cookieFor(off)
    await call(off, 'GET', '/api/v1/invoices', { cookie })
    await call(off, 'POST', '/api/v1/invoices/1/transitions', { cookie, body: { to: 'sent' } })
    await call(off, 'PATCH', '/api/v1/invoices/1', { cookie, body: { subject: 'x' } })
    expect(await rows()).toEqual(before)

    const on = await deploy({})
    const listed = await call(on, 'GET', '/api/v1/invoices', { cookie: await cookieFor(on) })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { data: { number: string }[] }
    expect(body.data.map((invoice) => invoice.number)).toEqual(['INV-1'])
    expect(await rows()).toEqual(before)
  })

  it('[override] neither organizations.modules nor an API write turns an operator-off module back on', async () => {
    const off = await deploy({ INVOICES_ENABLED: 'false', SSO_ENABLED: 'false' })
    const cookie = await cookieFor(off)
    await database
      .prepare(
        `UPDATE organizations SET modules = '{"invoices":true,"sso":true,"backups":true,"accounting":true}'`,
      )
      .run()
    try {
      await refused(off, cookie, [['GET', '/api/v1/invoices']])
      // The organization's own module settings do not name the operator's
      // modules, so there is nothing to write to.
      for (const module of ['invoices', 'sso', 'backups', 'accounting']) {
        const response = await call(off, 'PATCH', `/api/v1/admin/modules/${module}`, {
          cookie,
          body: { enabled: true },
        })
        expect([module, response.status]).toEqual([module, 404])
      }
      // Enabling the method in the app cannot make it live: it is not configured.
      const patched = await call(off, 'PATCH', '/api/v1/admin/sign-in-methods/google', {
        cookie,
        body: { enabled: true },
      })
      expect([patched.status, await refusal(patched)]).toEqual([409, 'sign_in_method_not_configured'])
      const listed = (await (await call(off, 'GET', '/api/v1/admin/sign-in-methods', { cookie })).json()) as {
        data: { method: string; configured: boolean }[]
      }
      expect(listed.data.filter((m) => ['google', 'github', 'apple'].includes(m.method))).toEqual([
        { method: 'google', configured: false, enabled: true },
        { method: 'github', configured: false, enabled: true },
        { method: 'apple', configured: false, enabled: true },
      ])
      await refused(off, undefined, [['GET', '/auth/oidc/google']])
    } finally {
      await database.prepare(`UPDATE organizations SET modules = '{}'`).run()
    }
  })

  it('[start-up] refuses any value but true or false, blank included', async () => {
    for (const name of ['SSO_ENABLED', 'BACKUPS_ENABLED', 'INVOICES_ENABLED', 'ACCOUNTING_ENABLED']) {
      for (const value of ['', ' ', 'TRUE', 'False', '0', 'off', 'yes']) {
        await expect(deploy({ [name]: value })).rejects.toThrow(name)
      }
    }
  })
})
