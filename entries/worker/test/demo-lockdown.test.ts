import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEmailJob } from '@ezacto/mailer'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import { workerInstanceThemeSurface } from '../src/instance-theme.js'
import {
  DEMO_ACCOUNT_FIELD_ROUTES,
  DEMO_PAYMENT_OPTIONS_ROUTE,
  DEMO_REFUSAL_MESSAGE,
  DEMO_REFUSED_ROUTES,
  DEMO_SESSION_REVOKE_ROUTE,
  demoRefuses,
} from '../src/demo-lockdown.js'
import { seedDemoSender } from '../src/demo.js'
import { mountedApiRoutes } from '../src/entry-surface.js'
import { worker } from '../src/index.js'
import { createRuntimeServices, providerCredentials } from '../src/runtime.js'
import { demoDeployment } from '../src/app.js'

// The nightly rebuild is three years of seeded work: 104 seconds against
// Miniflare's D1, and the db package's demo-reset suite already holds it. What
// this file holds is what the Worker does around it -- the export it skips and
// the sender it seeds -- so the rebuild answers as it would and does nothing.
vi.mock('../src/demo.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/demo.js')>()
  return {
    ...original,
    runDemoMaintenance: vi.fn(async (env: WorkerEnv, cron: string) =>
      demoDeployment(env) && cron === original.DEMO_REBUILD_CRON
        ? { ran: 'rebuild' as const }
        : { ran: 'nothing' as const },
    ),
  }
})

/**
 * The public demo prints its administrator's password on its front page (#931),
 * so everything here is asked of a session anyone could hold. Two deployments
 * are composed from the real runtime against a real D1 and R2 with every
 * provider secret set: the demo, and production with DEMO_MODE left on -- the
 * misconfiguration that must change nothing.
 *
 * What reaches the outside world is watched where it would leave: the
 * Cloudflare queue a provider reads, the R2 bucket, and `fetch` for anything
 * not on this machine. A demo test passes only if none of them was touched.
 */

const at = '2026-10-06T12:00:00.000Z'
const cursorKey = 'A'.repeat(43)
const bootstrapToken = `ezacto_${'A'.repeat(16)}_${'B'.repeat(43)}`
const owner = { email: 'admin@demo.example.test', password: 'correct horse battery staple 🙂' }

/** An approved domain nothing in this file writes to, to look for in responses. */
const unmailedDomain = 'zq7-unmailed.example'

/** Requests that leave this machine, which no demo test may make. */
const outbound: string[] = []
/** What an outbound call answers, where a production test wants one to succeed. */
let answer: ((url: URL) => Response | null) | null = null
const realFetch = globalThis.fetch

beforeAll(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    // Miniflare's own bindings talk to workerd over loopback.
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      return realFetch(input, init)
    }
    outbound.push(`${url.host}${url.pathname}`)
    const answered = answer?.(url) ?? null
    if (answered !== null) return answered
    throw new Error(`outbound network is off in this test: ${url.host}`)
  })
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  outbound.length = 0
  answer = null
})

interface Fixture {
  readonly miniflare: Miniflare
  readonly env: WorkerEnv
  readonly database: D1Database
  readonly services: Awaited<ReturnType<typeof createRuntimeServices>>
  readonly app: ReturnType<typeof createApp>
  readonly cookie: string
  readonly jobs: QueuedEmailJob[]
  readonly queueSend: ReturnType<typeof vi.fn>
  readonly bucketPut: ReturnType<typeof vi.fn>
}

/**
 * One deployment. `demo` is the public demo; `prod` is a production worker
 * with DEMO_MODE copied into its vars, which `demoDeployment` must ignore.
 */
const deploy = async (kind: 'demo' | 'prod'): Promise<Fixture> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
    r2Buckets: ['ATTACHMENTS'],
  })
  const database = await miniflare.getD1Database('DB')
  const bucket = await miniflare.getR2Bucket('ATTACHMENTS')
  // Miniflare's bucket and the Workers types disagree about Blob, so the spy
  // passes the arguments through untyped rather than restating either.
  const bucketPut = vi.fn((key: string, value: unknown, options?: unknown) =>
    bucket.put(key, value as never, options as never),
  )
  const jobs: QueuedEmailJob[] = []
  const queueSend = vi.fn(async (job: QueuedEmailJob) => void jobs.push(job))
  const env: WorkerEnv = {
    DB: database,
    ATTACHMENTS: {
      put: bucketPut,
      get: (key: string) => bucket.get(key),
      head: (key: string) => bucket.head(key),
    } as unknown as R2Bucket,
    EMAIL_QUEUE: { send: queueSend } as unknown as Queue<QueuedEmailJob>,
    API_CURSOR_SIGNING_KEY: cursorKey,
    APP_BASE_URL: 'https://demo.example.test',
    ENVIRONMENT: kind === 'demo' ? 'dev' : 'prod',
    DEMO_MODE: 'true',
    // Read only where the deployment is the demo. Set here for both, so the
    // production fixture proves it is ignored there. Nothing here ever mails
    // the second domain, so it can only reach a response by the configuration
    // leaking into one.
    DEMO_MAIL_ALLOWED_DOMAINS: ` Allowed.Example, @${unmailedDomain.toUpperCase()} `,
    RELEASE: 'demo-lockdown-test',
    BRAND_EMAIL_SENDER_NAME: 'Folding Forks',
    MAIL_FROM: 'Folding Forks <billing@demo.example.test>',
    MAILGUN_API_KEY: 'mailgun-fixture-key',
    MAILGUN_DOMAIN: 'demo.example.test',
    QUICKBOOKS_CLIENT_ID: 'quickbooks-fixture-id',
    QUICKBOOKS_CLIENT_SECRET: 'quickbooks-fixture-secret',
    QUICKBOOKS_ENVIRONMENT: 'sandbox',
    WISE_TOKEN: 'wise-fixture-token',
    WISE_WEBHOOK_PUBLIC_KEY: 'wise-fixture-key',
    BILL_DEV_KEY: 'bill-fixture-dev-key',
    BILL_COMPANY_ID: 'bill-fixture-company',
    BILL_USERNAME: 'bill-fixture-user',
    BILL_PASSWORD: 'bill-fixture-password',
    BILL_ENVIRONMENT: 'sandbox',
    STRIPE_API_KEY: 'sk_test_fixture',
    STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  }
  const services = await createRuntimeServices(env)
  const app = createApp(services, workerBrandAssetSurface, workerInstanceThemeSurface)
  await services.bootstrap({
    organizationName: 'Folding Forks',
    ownerFirstName: 'Demo',
    ownerLastName: 'Administrator',
    ownerEmail: owner.email,
    token: bootstrapToken,
  })
  await services.enrollOwnerPassword({ token: bootstrapToken, password: owner.password })
  const signedIn = await app.request(
    '/auth/sign-in',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(owner),
    },
    env,
  )
  expect(signedIn.status).toBe(200)
  const cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
  return { miniflare, env, database, services, app, cookie, jobs, queueSend, bucketPut }
}

let keys = 0

/** Sentry instruments the exported handlers in place, and reaches for these. */
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext
const call = (
  fixture: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; form?: FormData; headers?: Record<string, string> } = {},
) =>
  fixture.app.request(
    path,
    {
      method,
      headers: {
        origin: 'http://localhost',
        cookie: fixture.cookie,
        'idempotency-key': `demo-lockdown-${String((keys += 1))}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.form !== undefined
        ? { body: options.form }
        : options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
    },
    fixture.env,
  )

/** A client and a draft invoice that offers card payment, so Stripe would have a link to mint. */
const draftInvoice = async (fixture: Fixture, id: number): Promise<void> => {
  await fixture.database
    .prepare(
      `INSERT INTO clients (id, name, currency, created_at, updated_at)
       VALUES (?, ?, 'USD', ?, ?)`,
    )
    .bind(id, `Fixture Client ${String(id)}`, at, at)
    .run()
  await fixture.database
    .prepare(
      `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date, state,
         amount_cents, due_amount_cents, payment_options, created_at, updated_at)
       VALUES (?, ?, ?, 'USD', '2026-10-01', '2026-10-31', 'draft', 1234, 1234,
         '["stripe_checkout"]', ?, ?)`,
    )
    .bind(id, id, `INV-${String(id)}`, at, at)
    .run()
  // What the invoice owes is its lines', so it needs one to owe anything.
  await fixture.database
    .prepare(
      `INSERT INTO invoice_line_items (invoice_id, position, kind, description, quantity,
         unit_price_cents, amount_cents, created_at, updated_at)
       VALUES (?, 0, 'Service', 'Advisory', 1, 1234, 1234, ?, ?)`,
    )
    .bind(id, at, at)
    .run()
}

const errorCode = async (response: Response): Promise<string | null> => {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return null
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? null
}

/**
 * Every refused route with its parameters filled in, in the request form a
 * client sends. With an id no record has: production answers each of these
 * too, and one of them removes a user.
 */
const refusedRequests = DEMO_REFUSED_ROUTES.map((route) => {
  const [method, path] = route.split(' ') as [string, string]
  return { route, method: method.toUpperCase(), path: path.replace(/:[A-Za-z]+/gu, '987654') }
})

/** Signs the demo's administrator in again: a second visitor, or a second tab. */
const signInAgain = async (fixture: Fixture): Promise<string> => {
  const signedIn = await fixture.app.request(
    '/auth/sign-in',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(owner),
    },
    fixture.env,
  )
  expect(signedIn.status).toBe(200)
  return signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
}

/** A user who is not the owner, as a teammate the demo publishes would be. */
const teammate = async (fixture: Fixture, email: string): Promise<number> => {
  const created = await call(fixture, 'POST', '/api/v1/users', {
    body: { first_name: 'Tea', last_name: 'Mate', email },
  })
  expect(created.status).toBe(201)
  return ((await created.json()) as { data: { id: number } }).data.id
}

const personVersion = async (fixture: Fixture, id: number): Promise<number> =>
  ((await (await call(fixture, 'GET', `/api/v1/team/people/${String(id)}`)).json()) as {
    data: { version: number }
  }).data.version

const pdf = () =>
  new File([new TextEncoder().encode('%PDF-1.4 fixture purchase order')], 'po.pdf', {
    type: 'application/pdf',
  })

describe('the public demo (ENVIRONMENT=dev, DEMO_MODE=true)', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await deploy('demo')
    // What the nightly rebuild does after it empties the database.
    await expect(seedDemoSender(fixture.services, fixture.env)).resolves.toBe('seeded')
    // Every invoice email carries its PDF: the case that would stage a file
    // in the bucket for the message to name.
    await fixture.services.invoiceDocumentPreference!.setOrganizationPreference('document', true)
  }, 60_000)

  afterAll(async () => fixture.miniflare.dispose())

  it('[security] composes no provider, whatever secrets the deployment holds', () => {
    expect(providerCredentials(fixture.env)).toEqual({})
    expect(fixture.services.quickBooks).toBeUndefined()
    expect(fixture.services.wise).toBeUndefined()
    expect(fixture.services.wiseWebhook).toBeUndefined()
    expect(fixture.services.stripe!.configured()).toBe(false)
    expect(fixture.services.bill!.status().configured).toBe(false)
  })

  it('[security] seeds the deployment’s own sender, attested without calling anyone', async () => {
    expect(await fixture.services.emailConfiguration.listSenderIdentities()).toEqual([
      expect.objectContaining({
        email: 'billing@demo.example.test',
        displayName: 'Folding Forks',
        provider: 'mailgun',
        isDefault: true,
        evidence: expect.objectContaining({
          source: 'deployment_config',
          verificationStatus: 'operator_configured',
        }),
      }),
    ])
    expect(outbound).toEqual([])
  })

  it('[security] refuses every listed route with demo_disabled, touching nothing outside', async () => {
    for (const { route, method, path } of refusedRequests) {
      const response = await call(fixture, method, path, method === 'GET' ? {} : { body: {} })
      expect({ route, status: response.status }).toEqual({ route, status: 403 })
      expect(await response.json()).toMatchObject({
        error: { code: 'demo_disabled', message: DEMO_REFUSAL_MESSAGE },
      })
    }
    expect(outbound).toEqual([])
    expect(fixture.bucketPut).not.toHaveBeenCalled()
    expect(fixture.queueSend).not.toHaveBeenCalled()
  })

  it('[security] asks who you are before saying what the demo refuses', async () => {
    const response = await fixture.app.request(
      '/api/v1/sender-identities',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: '{}',
      },
      fixture.env,
    )
    expect(response.status).toBe(401)
  })

  it('[security] refuses a refused route however its path is spelled', async () => {
    // The router decodes `%69` to `i` and runs the handler; the guard has to
    // read the same path or this is a sender identity created on the demo.
    const before = await fixture.services.emailConfiguration.listSenderIdentities()
    const encoded = await call(fixture, 'POST', '/api/v1/sender-identit%69es', {
      body: {
        email: 'billing@demo.example.test',
        display_name: 'Invoices',
        reply_to_email: 'pay-here@attacker.example',
        provider: 'mailgun',
        provider_identity: 'billing@demo.example.test',
      },
    })
    expect(encoded.status).toBe(403)
    expect(await fixture.services.emailConfiguration.listSenderIdentities()).toEqual(before)
    // HEAD reaches the GET handler, so the OAuth callback refuses it too.
    const head = await call(fixture, 'HEAD', '/api/v1/integrations/quickbooks/callback?code=x&state=y')
    expect(head.status).toBe(403)
  })

  it('[security] refuses changing how an invoice may be paid, and no other edit', async () => {
    await draftInvoice(fixture, 501)
    const options = await call(fixture, 'PATCH', '/api/v1/invoices/501', {
      body: { expected_version: 0, payment_options: ['paypal_checkout'] },
    })
    expect(options.status).toBe(403)
    expect(await errorCode(options)).toBe('demo_disabled')
    const notes = await call(fixture, 'PATCH', '/api/v1/invoices/501', {
      body: { expected_version: 0, notes: 'Thank you for your business.' },
    })
    expect(notes.status).toBe(200)
  })

  it('[security] refuses an upload before a byte reaches the bucket', async () => {
    await draftInvoice(fixture, 502)
    const form = new FormData()
    form.append('file', pdf())
    const upload = await call(fixture, 'POST', '/api/v1/invoices/502/attachments', { form })
    expect(upload.status).toBe(403)
    expect(await errorCode(upload)).toBe('demo_disabled')
    // A real PNG signature into a real slot, so that it is the demo that
    // refuses this and not the image sniffer or the slot lookup.
    const logo = new FormData()
    logo.append(
      'file',
      new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])],
        'logo.png',
        { type: 'image/png' },
      ),
    )
    const brand = await call(fixture, 'POST', '/api/v1/settings/brand-assets/wordmark-light', {
      form: logo,
    })
    expect(brand.status).toBe(403)
    expect(fixture.bucketPut).not.toHaveBeenCalled()
    const rows = await fixture.database
      .prepare(`SELECT count(*) AS count FROM file_objects`)
      .first<{ count: number }>()
    expect(rows?.count).toBe(0)
  })

  it('[security] refuses what would lock the next visitor out, and the way in stays as printed', async () => {
    // Every visitor is the same administrator. Each of these, let through,
    // keeps whoever comes next out of the accounts the front page prints
    // until the nightly rebuild -- or lets one visitor decide who else gets in.
    const attempts: readonly (readonly [string, string, unknown])[] = [
      ['POST', '/api/v1/two-factor', undefined],
      ['POST', '/api/v1/two-factor/confirm', { code: '123456' }],
      ['DELETE', '/api/v1/two-factor', { code: '123456' }],
      ['PATCH', '/api/v1/admin/sign-in-methods/password', { enabled: false }],
      ['POST', '/api/v1/settings/sso-domains', { domain: 'visitor.example' }],
      ['POST', '/api/v1/settings/sso-domains/1/verify', undefined],
      ['DELETE', '/api/v1/settings/sso-domains/1', undefined],
    ]
    for (const [method, path, body] of attempts) {
      const response = await call(fixture, method, path, body === undefined ? {} : { body })
      expect({ method, path, status: response.status, code: await errorCode(response) }).toEqual({
        method,
        path,
        status: 403,
        code: 'demo_disabled',
      })
    }
    // A reset needs a token rather than a session, and is refused all the same.
    const reset = await fixture.app.request(
      '/auth/password/reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ token: 'A'.repeat(43), password: 'a password nobody else knows' }),
      },
      fixture.env,
    )
    expect({ status: reset.status, code: await errorCode(reset) }).toEqual({
      status: 403,
      code: 'demo_disabled',
    })

    // Nothing moved: no second factor, password sign-in still on, no domain,
    // and the published password still signs in.
    const twoFactor = (await (await call(fixture, 'GET', '/api/v1/two-factor')).json()) as {
      data: { enrolled: boolean; pending_confirmation: boolean }
    }
    expect(twoFactor.data).toMatchObject({ enrolled: false, pending_confirmation: false })
    const methods = (await (await call(fixture, 'GET', '/api/v1/admin/sign-in-methods')).json()) as {
      data: { method: string; enabled: boolean }[]
    }
    expect(methods.data.find((state) => state.method === 'password')?.enabled).toBe(true)
    const domains = (await (await call(fixture, 'GET', '/api/v1/settings/sso-domains')).json()) as {
      data: unknown[]
    }
    expect(domains.data).toEqual([])
    const signIn = await fixture.app.request(
      '/auth/sign-in',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify(owner),
      },
      fixture.env,
    )
    expect(signIn.status).toBe(200)
  })

  it('[security] takes a deletion request from a published account and leaves the account as printed', async () => {
    // App Review and Google Play sign in to this demo with the published
    // password and ask, from the mobile app's Delete Account, to delete the
    // account they are in. The request has to run end to end -- recorded, and
    // answered -- without deleting or deactivating anything the next visitor
    // signs in as.
    fixture.queueSend.mockClear()
    const asked = await call(fixture, 'POST', '/api/v1/profile/deletion-request', { body: {} })
    expect(asked.status).toBe(202)
    const { data } = (await asked.json()) as { data: { user_id: number; requested_at: string } }
    expect(data.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u)

    // Recorded where the administrators read who did what.
    const recorded = await fixture.database
      .prepare(
        `SELECT aggregate_id AS userId FROM event_outbox
         WHERE event_type = 'account.deletion_requested'`,
      )
      .all<{ userId: number }>()
    expect(recorded.results).toEqual([{ userId: data.user_id }])

    // The administrators' notice is held to the demo's list like all its mail:
    // the published administrator's address is not on it.
    expect(fixture.queueSend).not.toHaveBeenCalled()
    const notice = (await fixture.services.emailLog.list()).filter((record) =>
      record.subject.includes('asked to have their'),
    )
    expect(notice).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: 'demo_recipient_not_allowed' }),
    ])
    expect(outbound).toEqual([])

    // Asking again answers with the first request, and the account is as
    // printed: still active, and the published password still signs in.
    const again = await call(fixture, 'POST', '/api/v1/profile/deletion-request', { body: {} })
    expect(again.status).toBe(202)
    expect(((await again.json()) as { data: { requested_at: string } }).data.requested_at).toBe(
      data.requested_at,
    )
    const person = (await (await call(fixture, 'GET', `/api/v1/team/people/${String(data.user_id)}`)).json()) as {
      data: { is_active: boolean }
    }
    expect(person.data.is_active).toBe(true)
    await signInAgain(fixture)
  })

  it('[security] refuses deactivating, demoting or repointing anyone, and no other edit of them', async () => {
    // A teammate the front page publishes is one user: deactivated, demoted or
    // given another sign-in address, it keeps the next visitor out until the
    // nightly rebuild. Any user, so the demo keeps no list of whose is whose.
    const id = await teammate(fixture, 'teammate@demo.example.test')
    const person = `/api/v1/team/people/${String(id)}`
    const user = `/api/v1/users/${String(id)}`
    const version = await personVersion(fixture, id)
    const attempts: readonly (readonly [string, string, unknown])[] = [
      ['PATCH', person, { expected_version: version, is_active: false }],
      ['PATCH', person, { expected_version: version, profile: 'administrator' }],
      ['PATCH', user, { is_active: false }],
      ['PATCH', user, { profile: 'administrator' }],
      ['PATCH', user, { email: 'someone@visitor.example' }],
      ['DELETE', user, undefined],
    ]
    for (const [method, path, body] of attempts) {
      const response = await call(fixture, method, path, body === undefined ? {} : { body })
      expect({ method, path, body, status: response.status, code: await errorCode(response) }).toEqual({
        method,
        path,
        body,
        status: 403,
        code: 'demo_disabled',
      })
    }
    const after = (await (await call(fixture, 'GET', user)).json()) as {
      data: { is_active: boolean; profile: string; email: string }
    }
    expect(after.data).toMatchObject({
      is_active: true,
      profile: 'member',
      email: 'teammate@demo.example.test',
    })

    // Everything else about a person is the demo's to change.
    const renamed = await call(fixture, 'PATCH', person, {
      body: { expected_version: version, timezone: 'America/Costa_Rica' },
    })
    expect(renamed.status).toBe(200)
    const telephone = await call(fixture, 'PATCH', user, { body: { telephone: '555 0100' } })
    expect(telephone.status).toBe(200)
  })

  it('[security] lets a visitor sign out, and sign nobody else out', async () => {
    // Every visitor signed in as the administrator is the same user, and can
    // list every one of its sessions -- the fixture's own included.
    const second = await signInAgain(fixture)
    const sessions = (await (
      await call(fixture, 'GET', '/api/v1/sessions', { headers: { cookie: second } })
    ).json()) as { data: { id: number; current: boolean; revoked_at: string | null }[] }
    const others = sessions.data.filter((session) => !session.current && session.revoked_at === null)
    expect(others.length).toBeGreaterThan(0)
    for (const session of others) {
      const ended = await call(fixture, 'DELETE', `/api/v1/sessions/${String(session.id)}`, {
        headers: { cookie: second },
      })
      expect({ id: session.id, status: ended.status, code: await errorCode(ended) }).toEqual({
        id: session.id,
        status: 403,
        code: 'demo_disabled',
      })
    }
    // Whoever holds them is still signed in.
    expect((await call(fixture, 'GET', '/api/v1/whoami')).status).toBe(200)

    // Signing out is ending your own, which the demo needs.
    const own = sessions.data.find((session) => session.current)!
    const signedOut = await call(fixture, 'DELETE', `/api/v1/sessions/${String(own.id)}`, {
      headers: { cookie: second },
    })
    expect(signedOut.status).toBe(200)
    expect((await call(fixture, 'GET', '/api/v1/whoami', { headers: { cookie: second } })).status).toBe(
      401,
    )
  })

  it('[security] delivers an invoice email to the allowed recipients and nobody else', async () => {
    await draftInvoice(fixture, 503)
    const sent = await call(fixture, 'POST', '/api/v1/invoices/503/deliveries', {
      body: {
        expected_version: 0,
        recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
        cc: [
          { name: 'Owner', email: 'owner@Allowed.Example' },
          { name: 'Finance', email: 'finance@client.example' },
        ],
        confirmed: true,
      },
    })
    expect(sent.status).toBe(202)
    await fixture.services.outbox.drain()

    // One job, carrying the allowed copy alone -- addressed To them, since
    // nobody in To may be emailed -- and the invoice PDF it was sent with.
    const job = fixture.jobs.find((queued) => queued.message.template.startsWith('invoice:'))!
    expect(job.message.to).toEqual([{ email: 'owner@allowed.example', name: 'Owner' }])
    expect(job.message).not.toHaveProperty('cc')
    expect(job.attachments?.map((file) => file.contentType)).toContain('application/pdf')
    // The log keeps what the sender asked for; only the queue was narrowed.
    const logged = (await fixture.services.emailLog.list()).filter(
      (record) => record.relatedType === 'invoice_message',
    )
    expect(logged).toEqual([
      expect.objectContaining({
        status: 'queued',
        to: [{ email: 'accounts@client.example', name: 'Accounts' }],
      }),
    ])
    // No pay link: Stripe was configured with a key and the invoice offers card
    // payment, and neither Stripe nor BILL was asked for one.
    const messages = (await (await call(fixture, 'GET', '/api/v1/invoices/503/messages')).json()) as {
      data: { delivery_status: string; body: string | null }[]
    }
    expect(messages.data[0]!.body ?? '').not.toMatch(/https?:\/\//u)
    expect(outbound).toEqual([])
  }, 30_000)

  it('[security] hands nothing to a transport when nobody it is addressed to is allowed', async () => {
    await draftInvoice(fixture, 504)
    fixture.queueSend.mockClear()
    const sent = await call(fixture, 'POST', '/api/v1/invoices/504/deliveries', {
      body: {
        expected_version: 0,
        recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
        cc: [{ name: 'Lookalike', email: 'a@mail.allowed.example' }],
        confirmed: true,
      },
    })
    expect(sent.status).toBe(202)
    await fixture.services.outbox.drain()

    expect(fixture.queueSend).not.toHaveBeenCalled()
    const logged = (await fixture.services.emailLog.list()).filter(
      (record) => record.relatedType === 'invoice_message' && record.subject.includes('INV-504'),
    )
    expect(logged).toEqual([
      expect.objectContaining({
        status: 'failed',
        provider: null,
        failureCode: 'provider_rejected',
        failureReason: 'demo_recipient_not_allowed',
      }),
    ])
    // The invoice's history shows the send, and that it did not go.
    const messages = (await (await call(fixture, 'GET', '/api/v1/invoices/504/messages')).json()) as {
      data: { delivery_status: string }[]
    }
    expect(messages.data.map((message) => message.delivery_status)).toEqual(['failed'])
    expect(outbound).toEqual([])
  }, 30_000)

  it('[security] sends nothing at all where the deployment lists no domain', async () => {
    // The same demo, deployed without DEMO_MAIL_ALLOWED_DOMAINS: fail closed.
    const env: WorkerEnv = { ...fixture.env, DEMO_MAIL_ALLOWED_DOMAINS: undefined }
    const services = await createRuntimeServices(env)
    const app = createApp(services, workerBrandAssetSurface, workerInstanceThemeSurface)
    await draftInvoice(fixture, 505)
    fixture.queueSend.mockClear()
    const sent = await app.request(
      '/api/v1/invoices/505/deliveries',
      {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          cookie: fixture.cookie,
          'idempotency-key': 'demo-lockdown-unlisted',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          expected_version: 0,
          recipients: [{ name: 'Owner', email: 'owner@allowed.example' }],
          confirmed: true,
        }),
      },
      env,
    )
    expect(sent.status).toBe(202)
    await services.outbox.drain()
    expect(fixture.queueSend).not.toHaveBeenCalled()
    const logged = (await services.emailLog.list()).filter((record) =>
      record.subject.includes('INV-505'),
    )
    expect(logged.map((record) => record.failureReason)).toEqual(['demo_recipient_not_allowed'])
  }, 30_000)

  it('[security] holds every other mail path to the same list: a preview, a password reset', async () => {
    // Both go to the demo administrator, whose domain is not on the list.
    fixture.queueSend.mockClear()
    await draftInvoice(fixture, 506)
    const preview = await call(fixture, 'POST', '/api/v1/invoices/506/deliveries/preview/send', {
      body: { recipients: [{ name: 'Owner', email: 'owner@allowed.example' }] },
    })
    expect(preview.status).toBe(202)
    const { data } = (await preview.json()) as { data: { delivery_id: number } }
    await expect(fixture.services.emailLog.get(data.delivery_id)).resolves.toMatchObject({
      status: 'failed',
      relatedType: 'invoice_preview',
      failureReason: 'demo_recipient_not_allowed',
      to: [{ email: owner.email, name: 'Demo Administrator' }],
    })

    const reset = await fixture.app.request(
      '/auth/password/forgot',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ email: owner.email }),
      },
      fixture.env,
    )
    expect(reset.status).toBe(202)
    const resets = (await fixture.services.emailLog.list()).filter((record) =>
      record.template.startsWith('auth_password_reset'),
    )
    expect(resets).toEqual([
      expect.objectContaining({ status: 'failed', failureReason: 'demo_recipient_not_allowed' }),
    ])
    expect(fixture.queueSend).not.toHaveBeenCalled()
    expect(outbound).toEqual([])
  }, 30_000)

  it('[security] leaves refused mail out of the sending reputation', async () => {
    // A message held back here, so the figures have one to leave out: no
    // provider saw it, and it says nothing about how the sender's mail lands.
    await draftInvoice(fixture, 507)
    const preview = await call(fixture, 'POST', '/api/v1/invoices/507/deliveries/preview/send', {
      body: { recipients: [{ name: 'Owner', email: 'owner@allowed.example' }] },
    })
    expect(preview.status).toBe(202)
    const { data } = (await preview.json()) as { data: { delivery_id: number } }
    await expect(fixture.services.emailLog.get(data.delivery_id)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'demo_recipient_not_allowed',
    })

    const health = await call(fixture, 'GET', '/api/v1/email-health')
    expect(health.status).toBe(200)
    expect(((await health.json()) as { data: { reputation: { failed: number } } }).data.reputation.failed).toBe(0)
  })

  it('[integration] its queue consumer holds whatever reaches it to the same list', async () => {
    // On the queue already -- enqueued before this deployment was the demo,
    // say -- where the producer never saw it.
    const job = async (to: string): Promise<{ id: number; message: { body: QueuedEmailJob; attempts: number; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> } }> => {
      const message = {
        from: { email: 'billing@demo.example.test' },
        to: [{ email: to }],
        cc: [{ email: 'finance@client.example' }],
        template: 'invoice:1',
        subject: `Invoice for ${to}`,
        text: 'An invoice from before.',
      }
      const queued = await fixture.services.emailLog.createQueued(message)
      return {
        id: queued.id,
        message: {
          body: { schemaVersion: 1, deliveryId: queued.id, message },
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
      }
    }
    const nobody = await job('someone@elsewhere.example')
    const allowed = await job('ops@allowed.example')
    const bodies: string[] = []
    answer = (url) =>
      url.host === 'api.mailgun.net'
        ? Response.json({ id: '<allowed@demo.example.test>', message: 'Queued. Thank you.' })
        : null
    const recordBody = vi.spyOn(globalThis, 'fetch')
    await worker.queue!(
      { messages: [nobody.message, allowed.message] } as unknown as MessageBatch<QueuedEmailJob>,
      fixture.env,
      executionContext,
    )
    for (const [request] of recordBody.mock.calls) {
      if (request instanceof Request && new URL(request.url).host === 'api.mailgun.net') {
        bodies.push(await request.clone().text())
      }
    }

    await expect(fixture.services.emailLog.get(nobody.id)).resolves.toMatchObject({
      status: 'failed',
      failureReason: 'demo_recipient_not_allowed',
    })
    await expect(fixture.services.emailLog.get(allowed.id)).resolves.toMatchObject({
      status: 'sent',
      provider: 'mailgun',
    })
    // One call, for the allowed message, carrying the allowed address alone.
    expect(outbound).toEqual(['api.mailgun.net/v3/demo.example.test/messages'])
    expect(bodies).toHaveLength(1)
    const sent = new URLSearchParams(bodies[0])
    expect(sent.getAll('to').join(',')).toContain('ops@allowed.example')
    expect(sent.getAll('cc')).toEqual([])
    expect(bodies[0]).not.toContain('client.example')
    expect(nobody.message.ack).toHaveBeenCalledOnce()
    expect(allowed.message.ack).toHaveBeenCalledOnce()
  })

  it('[security] names no approved domain in any page or response it serves', async () => {
    // Anyone can open the demo. A page, script or response that named an
    // approved domain would tell every visitor where the demo can send mail.
    // Addresses somebody typed into the demo are the demo's own data; the
    // domain looked for here is one nothing in this file ever writes, so it
    // can only turn up by the deployment's configuration leaking.
    const leaks: string[] = []
    const inspect = async (label: string, response: Response): Promise<void> => {
      const text = (await response.text()).toLowerCase()
      if (text.includes(unmailedDomain)) leaks.push(label)
      for (const [name, value] of response.headers) {
        if (value.toLowerCase().includes(unmailedDomain)) leaks.push(`${label} (${name})`)
      }
    }

    // Mail refused, mail previewed and account mail asked for, so the log and
    // the invoice history have the demo's refusals in them to be read back.
    await draftInvoice(fixture, 508)
    await inspect(
      'send',
      await call(fixture, 'POST', '/api/v1/invoices/508/deliveries', {
        body: {
          expected_version: 0,
          recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
          confirmed: true,
        },
      }),
    )
    await fixture.services.outbox.drain()
    await inspect(
      'preview',
      await call(fixture, 'POST', '/api/v1/invoices/508/deliveries/preview/send', {
        body: { recipients: [{ name: 'Accounts', email: 'accounts@client.example' }] },
      }),
    )
    await inspect(
      'password reset request',
      await fixture.app.request(
        '/auth/password/forgot',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost' },
          body: JSON.stringify({ email: owner.email }),
        },
        fixture.env,
      ),
    )
    expect(
      (await fixture.services.emailLog.list({ status: 'failed' })).some(
        (record) => record.failureReason === 'demo_recipient_not_allowed',
      ),
    ).toBe(true)

    // Every page, asset and read the Worker serves, its parameters filled with
    // the invoice above where one is wanted. Several answer 404 for want of a
    // real record, and are read all the same: an error is a response too.
    const reads = new Set(
      fixture.app.routes
        .filter((route) => route.method === 'GET' && !route.path.includes('*'))
        .map((route) => route.path),
    )
    expect(reads.size).toBeGreaterThan(50)
    for (const path of reads) {
      const filled = path.replace(/:id\b/gu, '508').replace(/:[A-Za-z]+/gu, '1')
      await inspect(`GET ${filled}`, await call(fixture, 'GET', filled))
    }
    await inspect('GET /api/v1/invoices/508/email-defaults', await call(fixture, 'GET', '/api/v1/invoices/508/email-defaults'))
    expect(leaks).toEqual([])
  }, 120_000)
})

describe('the demo at night', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await deploy('demo')
  }, 60_000)

  afterAll(async () => fixture.miniflare.dispose())

  it('[integration] gives itself a sender after the rebuild, and copies nothing into the bucket', async () => {
    await worker.scheduled!(
      { cron: '0 3 * * *', scheduledTime: Date.parse(at), noRetry: () => undefined } as ScheduledController,
      fixture.env,
      executionContext,
    )
    // It can send: the deployment's own address, as the default.
    expect(await fixture.services.emailConfiguration.listSenderIdentities()).toEqual([
      expect.objectContaining({ email: 'billing@demo.example.test', isDefault: true }),
    ])
    // Nothing a visitor typed yesterday was exported to storage the rebuild
    // never empties.
    const exports = await fixture.database
      .prepare(`SELECT count(*) AS count FROM backup_runs`)
      .first<{ count: number }>()
    expect(exports?.count).toBe(0)
    expect(fixture.bucketPut).not.toHaveBeenCalled()
    expect(outbound).toEqual([])
  }, 60_000)

  it('[integration] while production still exports its books every night', async () => {
    const production = await deploy('prod')
    try {
      await worker.scheduled!(
        { cron: '0 3 * * *', scheduledTime: Date.parse(at), noRetry: () => undefined } as ScheduledController,
        production.env,
        executionContext,
      )
      const exports = await production.database
        .prepare(`SELECT status FROM backup_runs`)
        .all<{ status: string }>()
      expect(exports.results).toEqual([{ status: 'completed' }])
      expect(production.bucketPut).toHaveBeenCalled()
      expect(await production.services.emailConfiguration.listSenderIdentities()).toEqual([])
    } finally {
      await production.miniflare.dispose()
    }
  }, 60_000)
})

describe('production with DEMO_MODE left on (ENVIRONMENT=prod)', () => {
  let fixture: Fixture

  beforeAll(async () => {
    fixture = await deploy('prod')
  }, 60_000)

  afterAll(async () => fixture.miniflare.dispose())

  it('[security] composes every provider it holds secrets for', () => {
    expect(providerCredentials(fixture.env)).toMatchObject({
      QUICKBOOKS_CLIENT_ID: 'quickbooks-fixture-id',
      STRIPE_API_KEY: 'sk_test_fixture',
    })
    expect(fixture.services.quickBooks).toBeDefined()
    expect(fixture.services.wise).toBeDefined()
    expect(fixture.services.stripe!.configured()).toBe(true)
    expect(fixture.services.bill!.status().configured).toBe(true)
  })

  it('[contract] mounts every route the demo refuses, so none of the list is stale', () => {
    // Composed with every provider, so this app mounts everything the demo's
    // could. A route renamed without its entry here fails rather than quietly
    // coming back unguarded on the demo.
    const mounted = mountedApiRoutes(fixture.app.routes)
    expect(
      [
        ...DEMO_REFUSED_ROUTES,
        DEMO_PAYMENT_OPTIONS_ROUTE,
        ...Object.keys(DEMO_ACCOUNT_FIELD_ROUTES),
        DEMO_SESSION_REVOKE_ROUTE,
      ].filter((route) => !mounted.has(route)),
    ).toEqual([])
  })

  it('[security] refuses none of them', async () => {
    for (const { route, method, path } of refusedRequests) {
      const response = await call(fixture, method, path, method === 'GET' ? {} : { body: {} })
      expect({ route, code: await errorCode(response) }).not.toEqual({ route, code: 'demo_disabled' })
    }
  })

  it('[api] still lets an administrator deactivate a person and end another session', async () => {
    const id = await teammate(fixture, 'teammate@prod.example.test')
    const deactivated = await call(fixture, 'PATCH', `/api/v1/team/people/${String(id)}`, {
      body: { expected_version: await personVersion(fixture, id), is_active: false },
    })
    expect(deactivated.status).toBe(200)
    const promoted = await call(fixture, 'PATCH', `/api/v1/users/${String(id)}`, {
      body: { profile: 'accounting' },
    })
    expect(promoted.status).toBe(200)

    const second = await signInAgain(fixture)
    const third = await signInAgain(fixture)
    const thirdId = ((await (
      await call(fixture, 'GET', '/api/v1/sessions', { headers: { cookie: third } })
    ).json()) as { data: { id: number; current: boolean }[] }).data.find((session) => session.current)!.id
    const ended = await call(fixture, 'DELETE', `/api/v1/sessions/${String(thirdId)}`, {
      headers: { cookie: second },
    })
    expect(ended.status).toBe(200)
    expect((await call(fixture, 'GET', '/api/v1/whoami', { headers: { cookie: third } })).status).toBe(401)
  })

  it('[api] still lets an administrator set the sender, the invoice defaults and the files', async () => {
    const created = await call(fixture, 'POST', '/api/v1/sender-identities', {
      body: {
        email: 'billing@demo.example.test',
        display_name: 'Folding Forks Billing',
        provider: 'mailgun',
        provider_identity: 'billing@demo.example.test',
      },
    })
    expect(created.status).toBe(201)
    const { data: sender } = (await created.json()) as { data: { id: number } }
    const verified = await call(fixture, 'POST', `/api/v1/sender-identities/${String(sender.id)}/refresh`, {
      body: { expected_evidence_version: 0 },
    })
    expect(verified.status).toBe(200)
    const made = await call(fixture, 'POST', `/api/v1/sender-identities/${String(sender.id)}/default`, {
      body: { expected_version: 0 },
    })
    expect(made.status).toBe(200)

    const defaults = await call(fixture, 'POST', '/api/v1/settings/invoice-defaults', {
      body: { notes: 'Pay by transfer to account 000-000.' },
    })
    expect(defaults.status).toBe(200)

    await draftInvoice(fixture, 601)
    const form = new FormData()
    form.append('file', pdf())
    const upload = await call(fixture, 'POST', '/api/v1/invoices/601/attachments', { form })
    expect(upload.status).toBe(201)
    expect(fixture.bucketPut).toHaveBeenCalled()

    const options = await call(fixture, 'PATCH', '/api/v1/invoices/601', {
      body: { expected_version: 0, payment_options: ['stripe_checkout'] },
    })
    expect(options.status).toBe(200)
  })

  it('[api] still sends invoice email to everyone it names, and asks Stripe for a link', async () => {
    await draftInvoice(fixture, 602)
    const sent = await call(fixture, 'POST', '/api/v1/invoices/602/deliveries', {
      body: {
        expected_version: 0,
        recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
        cc: [{ name: 'Owner', email: 'owner@allowed.example' }],
        confirmed: true,
      },
    })
    expect(sent.status).toBe(202)
    // The link is minted while the body is composed. Stripe is unreachable
    // here, so the send goes without one -- but it was asked.
    expect(outbound.some((call) => call.startsWith('api.stripe.com'))).toBe(true)
    await fixture.services.outbox.drain()
    // DEMO_MAIL_ALLOWED_DOMAINS is set on this deployment too, and changes
    // nothing: production is not the demo.
    const job = fixture.jobs.find((queued) => queued.message.template.startsWith('invoice:'))!
    expect(job.message.to).toEqual([{ email: 'accounts@client.example', name: 'Accounts' }])
    expect(job.message.cc).toEqual([{ email: 'owner@allowed.example', name: 'Owner' }])
    const logged = (await fixture.services.emailLog.list()).filter(
      (record) => record.relatedType === 'invoice_message',
    )
    expect(logged.map((record) => record.status)).toEqual(['queued'])
  }, 30_000)

  it('[api] tells the administrators of a deletion request, and changes nothing about the account', async () => {
    fixture.queueSend.mockClear()
    const asked = await call(fixture, 'POST', '/api/v1/profile/deletion-request', { body: {} })
    expect(asked.status).toBe(202)
    const { data } = (await asked.json()) as { data: { user_id: number } }
    const notice = fixture.jobs.find((queued) =>
      queued.message.template.startsWith('account_deletion_request:'),
    )!
    expect(notice.message.to).toEqual([{ email: owner.email }])
    expect(notice.message.subject).toBe('Demo Administrator asked to have their Folding Forks account deleted')
    expect(notice.message.text).toContain('Nothing has been deleted or deactivated.')
    const person = (await (await call(fixture, 'GET', `/api/v1/team/people/${String(data.user_id)}`)).json()) as {
      data: { is_active: boolean }
    }
    expect(person.data.is_active).toBe(true)
  })

  it('[integration] its queue consumer still hands queued mail to the provider', async () => {
    const queued = await fixture.services.emailLog.createQueued({
      from: { email: 'billing@demo.example.test' },
      to: [{ email: 'someone@elsewhere.example' }],
      template: 'invoice:1',
      subject: 'Invoice INV-9',
      text: 'An invoice.',
    })
    answer = (url) =>
      url.host === 'api.mailgun.net'
        ? Response.json({ id: '<sent-9@demo.example.test>', message: 'Queued. Thank you.' })
        : null
    const message = {
      body: {
        schemaVersion: 1 as const,
        deliveryId: queued.id,
        message: {
          from: { email: 'billing@demo.example.test' },
          to: [{ email: 'someone@elsewhere.example' }],
          template: 'invoice:1',
          subject: 'Invoice INV-9',
          text: 'An invoice.',
        },
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }
    await worker.queue!(
      { messages: [message] } as unknown as MessageBatch<QueuedEmailJob>,
      fixture.env,
      executionContext,
    )
    expect(outbound).toEqual(['api.mailgun.net/v3/demo.example.test/messages'])
    await expect(fixture.services.emailLog.get(queued.id)).resolves.toMatchObject({
      status: 'sent',
      provider: 'mailgun',
    })
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('[security] seeds no demo sender', async () => {
    await expect(seedDemoSender(fixture.services, fixture.env)).resolves.toBe('unavailable')
  })
})

describe('demoRefuses', () => {
  const request = (method: string, path: string, body?: unknown) =>
    new Request(`https://demo.example.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    })
  /** Signed in with session 12 unless a test says otherwise. */
  const refuses = (made: Request, path: string, actingSession: string | null = '12') =>
    demoRefuses(made, path, actingSession)

  it('[unit] matches a refused route by method and by whole segments', async () => {
    expect(await refuses(request('POST', '/'), '/api/v1/invoices/77/payment-link')).toBe(true)
    expect(await refuses(request('GET', '/'), '/api/v1/invoices/77/payment-link')).toBe(false)
    expect(await refuses(request('POST', '/'), '/api/v1/invoices/77/payment-links')).toBe(false)
    expect(await refuses(request('POST', '/'), '/api/v1/invoices/77/88/payment-link')).toBe(false)
    expect(await refuses(request('GET', '/'), '/api/v1/sender-identities')).toBe(false)
  })

  it('[unit] reads an invoice edit for payment_options without consuming it', async () => {
    const edit = request('PATCH', '/', { expected_version: 1, payment_options: [] })
    expect(await refuses(edit, '/api/v1/invoices/7')).toBe(true)
    // The route still reads the body it was sent.
    expect(await edit.json()).toEqual({ expected_version: 1, payment_options: [] })
    expect(
      await refuses(request('PATCH', '/', { expected_version: 1, subject: 'x' }), '/api/v1/invoices/7'),
    ).toBe(false)
    expect(await refuses(request('PATCH', '/', ['payment_options']), '/api/v1/invoices/7')).toBe(false)
  })

  it('[unit] leaves a body past the route’s limit to the route', async () => {
    const huge = request('PATCH', '/', {
      payment_options: [],
      padding: 'x'.repeat(1024 * 1024),
    })
    expect(await refuses(huge, '/api/v1/invoices/7')).toBe(false)
  })

  it('[unit] refuses what would change who can sign in, and no other edit of a person', async () => {
    for (const [path, body] of [
      ['/api/v1/team/people/5', { expected_version: 1, is_active: false }],
      ['/api/v1/team/people/5', { expected_version: 1, profile: 'member' }],
      ['/api/v1/users/5', { is_active: false }],
      ['/api/v1/users/5', { profile: 'administrator' }],
      ['/api/v1/users/5', { email: 'someone@visitor.example' }],
    ] as const) {
      expect({ path, body, refused: await refuses(request('PATCH', '/', body), path) }).toEqual({
        path,
        body,
        refused: true,
      })
    }
    expect(await refuses(request('DELETE', '/'), '/api/v1/users/5')).toBe(true)
    // A name, a timezone, a telephone: the demo working as a demo should.
    expect(
      await refuses(request('PATCH', '/', { expected_version: 1, timezone: 'UTC' }), '/api/v1/team/people/5'),
    ).toBe(false)
    expect(await refuses(request('PATCH', '/', { telephone: '555 0100' }), '/api/v1/users/5')).toBe(false)
    // `email` is a user's sign-in address; a person edit has no such field.
    expect(
      await refuses(request('PATCH', '/', { expected_version: 1, email: 'x@y.example' }), '/api/v1/team/people/5'),
    ).toBe(false)
  })

  it('[unit] lets a session end itself, and no other', async () => {
    expect(await refuses(request('DELETE', '/'), '/api/v1/sessions/12', '12')).toBe(false)
    expect(await refuses(request('DELETE', '/'), '/api/v1/sessions/13', '12')).toBe(true)
    // An API token is no session at all, so it ends none of them.
    expect(await refuses(request('DELETE', '/'), '/api/v1/sessions/12', null)).toBe(true)
    expect(await refuses(request('GET', '/'), '/api/v1/sessions', '12')).toBe(false)
  })
})
