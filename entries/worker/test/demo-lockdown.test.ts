import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEmailJob } from '@ezacto/mailer'
import { createApp, type WorkerEnv } from '../src/app.js'
import { workerBrandAssetSurface } from '../src/brand-assets.js'
import { workerInstanceThemeSurface } from '../src/instance-theme.js'
import {
  DEMO_PAYMENT_OPTIONS_ROUTE,
  DEMO_REFUSAL_MESSAGE,
  DEMO_REFUSED_ROUTES,
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

/** Every refused route with its parameters filled in, in the request form a client sends. */
const refusedRequests = DEMO_REFUSED_ROUTES.map((route) => {
  const [method, path] = route.split(' ') as [string, string]
  return { route, method: method.toUpperCase(), path: path.replace(/:[A-Za-z]+/gu, '1') }
})

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

  it('[api] records an invoice email as suppressed and hands nothing to a transport', async () => {
    await draftInvoice(fixture, 503)
    const sent = await call(fixture, 'POST', '/api/v1/invoices/503/deliveries', {
      body: {
        expected_version: 0,
        recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
        cc: [{ name: 'Finance', email: 'finance@client.example' }],
        confirmed: true,
      },
    })
    expect(sent.status).toBe(202)
    await fixture.services.outbox.drain()

    const logged = (await fixture.services.emailLog.list()).filter(
      (record) => record.relatedType === 'invoice_message',
    )
    expect(logged).toEqual([
      expect.objectContaining({
        status: 'suppressed',
        provider: null,
        providerMessageId: null,
        attemptCount: 0,
        to: [{ email: 'accounts@client.example', name: 'Accounts' }],
        cc: [{ email: 'finance@client.example', name: 'Finance' }],
      }),
    ])
    // The invoice's history still shows the send, and what became of it.
    const messages = (await (await call(fixture, 'GET', '/api/v1/invoices/503/messages')).json()) as {
      data: { delivery_status: string; body: string | null }[]
    }
    expect(messages.data.map((message) => message.delivery_status)).toEqual(['suppressed'])
    // No pay link: Stripe was configured with a key and the invoice offers card
    // payment, and neither Stripe nor BILL was asked for one.
    expect(messages.data[0]!.body ?? '').not.toMatch(/https?:\/\//u)
    expect(outbound).toEqual([])
    expect(fixture.queueSend).not.toHaveBeenCalled()
    // The document a delivery would carry is not staged in the bucket either.
    expect(fixture.bucketPut).not.toHaveBeenCalled()
  }, 30_000)

  it('[api] suppresses the preview a sender emails to themselves', async () => {
    await draftInvoice(fixture, 504)
    const preview = await call(fixture, 'POST', '/api/v1/invoices/504/deliveries/preview/send', {
      body: {
        recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
        attach_pdf: true,
      },
    })
    expect(preview.status).toBe(202)
    const { data } = (await preview.json()) as { data: { delivery_id: number } }
    await expect(fixture.services.emailLog.get(data.delivery_id)).resolves.toMatchObject({
      status: 'suppressed',
      relatedType: 'invoice_preview',
      to: [{ email: owner.email, name: 'Demo Administrator' }],
    })
    expect(outbound).toEqual([])
    expect(fixture.queueSend).not.toHaveBeenCalled()
    expect(fixture.bucketPut).not.toHaveBeenCalled()
  }, 30_000)

  it('[api] suppresses account mail: a password reset goes nowhere', async () => {
    const response = await fixture.app.request(
      '/auth/password/forgot',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        body: JSON.stringify({ email: owner.email }),
      },
      fixture.env,
    )
    expect(response.status).toBe(202)
    const reset = (await fixture.services.emailLog.list()).filter((record) =>
      record.template.startsWith('auth_password_reset'),
    )
    expect(reset).toEqual([expect.objectContaining({ status: 'suppressed' })])
    expect(fixture.queueSend).not.toHaveBeenCalled()
    expect(outbound).toEqual([])
  })

  it('[integration] its queue consumer suppresses whatever reaches it and builds no transport', async () => {
    // Enqueued before this deployment was the demo, say: on the queue already,
    // where a provider would have picked it up.
    const queued = await fixture.services.emailLog.createQueued({
      from: { email: 'billing@demo.example.test' },
      to: [{ email: 'someone@elsewhere.example' }],
      template: 'invoice:1',
      subject: 'Invoice INV-9',
      text: 'An invoice from before.',
    })
    const message = {
      body: {
        schemaVersion: 1 as const,
        deliveryId: queued.id,
        message: {
          from: { email: 'billing@demo.example.test' },
          to: [{ email: 'someone@elsewhere.example' }],
          template: 'invoice:1',
          subject: 'Invoice INV-9',
          text: 'An invoice from before.',
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
    await expect(fixture.services.emailLog.get(queued.id)).resolves.toMatchObject({
      status: 'suppressed',
    })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(outbound).toEqual([])
  })
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
    expect([...DEMO_REFUSED_ROUTES, DEMO_PAYMENT_OPTIONS_ROUTE].filter((route) => !mounted.has(route))).toEqual([])
  })

  it('[security] refuses none of them', async () => {
    for (const { route, method, path } of refusedRequests) {
      const response = await call(fixture, method, path, method === 'GET' ? {} : { body: {} })
      expect({ route, code: await errorCode(response) }).not.toEqual({ route, code: 'demo_disabled' })
    }
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

  it('[api] still sends invoice email through the queue, and asks Stripe for a link', async () => {
    await draftInvoice(fixture, 602)
    const sent = await call(fixture, 'POST', '/api/v1/invoices/602/deliveries', {
      body: {
        expected_version: 0,
        recipients: [{ name: 'Accounts', email: 'accounts@client.example' }],
        confirmed: true,
      },
    })
    expect(sent.status).toBe(202)
    // The link is minted while the body is composed. Stripe is unreachable
    // here, so the send goes without one -- but it was asked.
    expect(outbound.some((call) => call.startsWith('api.stripe.com'))).toBe(true)
    await fixture.services.outbox.drain()
    expect(fixture.jobs.map((job) => job.message.to)).toContainEqual([
      { email: 'accounts@client.example', name: 'Accounts' },
    ])
    const logged = (await fixture.services.emailLog.list()).filter(
      (record) => record.relatedType === 'invoice_message',
    )
    expect(logged.map((record) => record.status)).toEqual(['queued'])
  }, 30_000)

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

  it('[unit] matches a refused route by method and by whole segments', async () => {
    expect(await demoRefuses(request('POST', '/'), '/api/v1/invoices/77/payment-link')).toBe(true)
    expect(await demoRefuses(request('GET', '/'), '/api/v1/invoices/77/payment-link')).toBe(false)
    expect(await demoRefuses(request('POST', '/'), '/api/v1/invoices/77/payment-links')).toBe(false)
    expect(await demoRefuses(request('POST', '/'), '/api/v1/invoices/77/88/payment-link')).toBe(false)
    expect(await demoRefuses(request('GET', '/'), '/api/v1/sender-identities')).toBe(false)
  })

  it('[unit] reads an invoice edit for payment_options without consuming it', async () => {
    const edit = request('PATCH', '/', { expected_version: 1, payment_options: [] })
    expect(await demoRefuses(edit, '/api/v1/invoices/7')).toBe(true)
    // The route still reads the body it was sent.
    expect(await edit.json()).toEqual({ expected_version: 1, payment_options: [] })
    expect(
      await demoRefuses(request('PATCH', '/', { expected_version: 1, subject: 'x' }), '/api/v1/invoices/7'),
    ).toBe(false)
    expect(await demoRefuses(request('PATCH', '/', ['payment_options']), '/api/v1/invoices/7')).toBe(false)
  })

  it('[unit] leaves a body past the route’s limit to the route', async () => {
    const huge = request('PATCH', '/', {
      payment_options: [],
      padding: 'x'.repeat(1024 * 1024),
    })
    expect(await demoRefuses(huge, '/api/v1/invoices/7')).toBe(false)
  })
})
