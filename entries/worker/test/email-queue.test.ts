import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  EmailLogRecord,
  HttpEmailProvider,
  QueuedEmailJob,
} from '@ezacto/mailer'
import { EMAIL_RETRY_POLICY } from '@ezacto/mailer'
import { createApp, type WorkerEnv } from '../src/app.js'
import {
  consumeCloudflareEmailBatch,
  createCloudflareEmailQueue,
} from '../src/email-queue.js'
import {
  createMailgunSenderIdentityVerifier,
  createSesSenderIdentityVerifier,
  createRuntimeServices,
  createWorkerMailProvider,
  createWorkerMailgunMailer,
  createWorkerSesMailer,
} from '../src/runtime.js'

const cursorKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const password = 'correct horse battery staple 🙂'

describe('Worker email queue composition', () => {
  let miniflare: Miniflare
  let database: D1Database

  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    database = await miniflare.getD1Database('DB')
  })

  afterAll(async () => miniflare.dispose())

  it('[unit] maps the provider-neutral producer to a concrete Cloudflare Queue send', async () => {
    const send = vi.fn(async () => undefined)
    const queue = { send } as unknown as Queue<QueuedEmailJob>
    const job: QueuedEmailJob = {
      schemaVersion: 1,
      deliveryId: 4,
      message: {
        from: { email: 'billing@example.test', name: 'Billing' },
        to: [{ email: 'owner@example.test' }],
        template: 'verify_email',
        subject: 'Verify your ezacto email',
        text: 'Open the link.',
      },
    }
    await createCloudflareEmailQueue(queue).send(job)
    expect(send).toHaveBeenCalledWith(job)
  })

  it('[api] returns success before provider failure and exposes the terminal log', async () => {
    const queuedJobs: QueuedEmailJob[] = []
    const queue = {
      send: vi.fn(async (job: QueuedEmailJob) => void queuedJobs.push(job)),
    } as unknown as Queue<QueuedEmailJob>
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => {
        throw new Error('provider unavailable')
      }),
    }
    const env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      EMAIL_QUEUE: queue,
      APP_BASE_URL: 'https://ezacto.example',
      SES_FROM: 'notify@example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'mailer-test',
    } satisfies WorkerEnv
    const services = await createRuntimeServices(env, { emailProvider: provider })
    const app = createApp(services)
    const signup = await app.request(
      '/auth/signup',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '198.51.100.30',
        },
        body: JSON.stringify({
          organization_name: 'Halcyon Studio',
          first_name: 'Avery',
          last_name: 'Ng',
          email: 'owner@example.test',
          password,
        }),
      },
      env,
    )
    expect(signup.status).toBe(202)
    expect(provider.send).not.toHaveBeenCalled()
    expect(queuedJobs).toHaveLength(1)
    expect(queuedJobs[0]?.message).toMatchObject({
      from: { email: 'notify@example.test' },
      template: 'auth_email_verification:v1',
      subject: 'Verify your Halcyon Studio email',
    })
    expect(JSON.stringify(queuedJobs[0])).toContain('ezacto_verify_')

    const retries: number[] = []
    let acknowledged = false
    for (let attempts = 1; attempts <= 5; attempts += 1) {
      const queueMessage = {
        body: queuedJobs[0]!,
        attempts,
        retry: ({ delaySeconds }: { delaySeconds?: number } = {}) =>
          void retries.push(delaySeconds ?? 0),
        ack: () => {
          acknowledged = true
        },
      }
      await consumeCloudflareEmailBatch(
        { messages: [queueMessage] } as unknown as MessageBatch<QueuedEmailJob>,
        services.emailLog,
        provider,
      )
    }
    expect(retries).toEqual([60, 300, 900, 3_600])
    expect(acknowledged).toBe(true)
    expect(provider.send).toHaveBeenCalledTimes(5)
    await expect(services.emailLog.list({ status: 'failed' })).resolves.toEqual([
      expect.objectContaining({
        status: 'failed',
        attemptCount: 5,
        failureCode: 'provider_rejected',
      }) as EmailLogRecord,
    ])
  }, 20_000)

  it('[concurrency] does not spend provider retries on queue redelivery contention', async () => {
    const env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      ENVIRONMENT: 'test',
      RELEASE: 'mailer-test',
    } satisfies WorkerEnv
    const services = await createRuntimeServices(env)
    const message = {
      from: { email: 'billing@example.test', name: 'Billing' },
      to: [{ email: 'retry-budget@example.test' }],
      template: 'verify_email',
      subject: 'Verify your ezacto email',
      text: 'Open the link.',
    } as const
    const queued = await services.emailLog.createQueued(message)
    await expect(
      services.emailLog.claimAttempt(
        queued.id,
        'test-http',
        'abandoned-worker-attempt',
        30,
      ),
    ).resolves.toBe(1)

    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => {
        throw new Error('transient provider failure')
      }),
    }
    const retry = vi.fn()
    const ack = vi.fn()
    const job: QueuedEmailJob = {
      schemaVersion: 1,
      deliveryId: queued.id,
      message,
    }
    const consume = async (attempts: number) =>
      consumeCloudflareEmailBatch(
        {
          messages: [{ body: job, attempts, retry, ack }],
        } as unknown as MessageBatch<QueuedEmailJob>,
        services.emailLog,
        provider,
      )

    for (let attempts = 1; attempts <= 4; attempts += 1) {
      await consume(attempts)
    }
    expect(retry).toHaveBeenCalledTimes(4)
    expect(retry).toHaveBeenLastCalledWith({
      delaySeconds: EMAIL_RETRY_POLICY.claimedRetryDelaySeconds,
    })
    expect(ack).not.toHaveBeenCalled()
    expect(provider.send).not.toHaveBeenCalled()

    await expect(
      services.emailLog.releaseAttempt(
        queued.id,
        'test-http',
        'abandoned-worker-attempt',
      ),
    ).resolves.toBe(true)
    await consume(5)
    expect(retry).toHaveBeenLastCalledWith({
      delaySeconds: EMAIL_RETRY_POLICY.delaySeconds[1],
    })
    expect(ack).not.toHaveBeenCalled()
    expect(provider.send).toHaveBeenCalledTimes(1)
    await expect(services.emailLog.get(queued.id)).resolves.toMatchObject({
      status: 'queued',
      attemptCount: 2,
      failureCode: null,
    })

    for (let attempts = 6; attempts <= 8; attempts += 1) {
      await consume(attempts)
    }
    expect(retry).toHaveBeenCalledTimes(7)
    expect(ack).toHaveBeenCalledOnce()
    expect(provider.send).toHaveBeenCalledTimes(4)
    await expect(services.emailLog.get(queued.id)).resolves.toMatchObject({
      status: 'failed',
      attemptCount: EMAIL_RETRY_POLICY.maxAttempts,
      failureCode: 'provider_rejected',
    })
  })

  it('[api] keeps signup fail-closed before a queue and provider are both bound', async () => {
    const env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      ENVIRONMENT: 'test',
      RELEASE: 'mailer-test',
    } satisfies WorkerEnv
    const services = await createRuntimeServices(env)
    expect(services.deploymentAuthMailer).toBeUndefined()
    expect(services.organizationMailer).toBeUndefined()
  })

  it('[integration] keeps auth on deployment mail and blocks organization test sends before log, queue, or SES', async () => {
    const isolated = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const isolatedDatabase = await isolated.getD1Database('DB')
      const jobs: QueuedEmailJob[] = []
      const queue = {
        send: vi.fn(async (job: QueuedEmailJob) => void jobs.push(job)),
      } as unknown as Queue<QueuedEmailJob>
      const env = {
        DB: isolatedDatabase,
        API_CURSOR_SIGNING_KEY: cursorKey,
        EMAIL_QUEUE: queue,
        APP_BASE_URL: 'https://ezacto.example',
        AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_REGION: 'us-west-2',
        SES_FROM: 'bootstrap@example.test',
        ENVIRONMENT: 'test',
        RELEASE: 'sender-gate-acceptance',
      } satisfies WorkerEnv
      const providerFetch = vi.fn(async () => Response.json({}))
      const emailProvider = createWorkerSesMailer(env, { fetch: providerFetch })!
      const services = await createRuntimeServices(env, { emailProvider })
      const app = createApp(services)
      const request = (
        path: string,
        payload: unknown,
        headers: Record<string, string> = {},
      ) =>
        app.request(
          path,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'cf-connecting-ip': '198.51.100.31',
              ...headers,
            },
            body: JSON.stringify(payload),
          },
          env,
        )

      const signup = await request('/auth/signup', {
        organization_name: 'Bound Sender Studio',
        first_name: 'Avery',
        last_name: 'Ng',
        email: 'owner@example.test',
        password,
      })
      expect(signup.status).toBe(202)
      expect(jobs).toHaveLength(1)
      const token = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(
        jobs[0]!.message.text,
      )?.[0]
      expect(token).toBeTruthy()
      expect((await request('/auth/verify-email', { token })).status).toBe(200)

      await services.emailConfiguration.createSenderIdentity({
        id: 41,
        email: 'billing@example.test',
        displayName: 'Bound Sender Billing',
        provider: 'ses',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'worker-unverified-sender',
        occurredAt: '2026-09-02T06:00:00.000Z',
      })
      const reset = await request('/auth/password/forgot', {
        email: 'owner@example.test',
      })
      expect(reset.status).toBe(202)
      expect(jobs).toHaveLength(2)

      const signedIn = await request('/auth/sign-in', {
        email: 'owner@example.test',
        password,
      })
      expect(signedIn.status).toBe(200)
      const cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!
      const logCountBeforeTest = (await services.emailLog.list()).length
      const blocked = await request(
        '/api/v1/sender-identities/41/test-send',
        {
          template_kind: 'invoice',
          template_version: 1,
          variables: {
            company_name: 'Bound Sender Studio',
            invoice_id: '41',
            invoice_number: 'INV-41',
            invoice_amount: '$100.00',
            invoice_due_date: '2026-09-30',
          },
          confirmed: true,
        },
        {
          cookie,
          origin: 'http://localhost',
          'idempotency-key': 'worker-unverified-test-send',
        },
      )
      expect({ status: blocked.status, body: await blocked.json() }).toMatchObject({
        status: 409,
        body: { error: { code: 'sender_verification_pending' } },
      })
      expect(jobs).toHaveLength(2)
      expect(await services.emailLog.list()).toHaveLength(logCountBeforeTest)
      expect(providerFetch).not.toHaveBeenCalled()
    } finally {
      await isolated.dispose()
    }
  }, 20_000)

  it('[integration] confirms in HTTP, drains through real D1/outbox/Queue, then calls SES once', async () => {
    const isolated = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    })
    try {
      const isolatedDatabase = await isolated.getD1Database('DB')
      const jobs: QueuedEmailJob[] = []
      const queue = {
        send: vi.fn(async (job: QueuedEmailJob) => void jobs.push(job)),
      } as unknown as Queue<QueuedEmailJob>
      const provider: HttpEmailProvider = {
        name: 'ses',
        send: vi.fn(async () => ({ messageId: 'ses-invoice-1' })),
      }
      const env = {
        DB: isolatedDatabase,
        API_CURSOR_SIGNING_KEY: cursorKey,
        EMAIL_QUEUE: queue,
        APP_BASE_URL: 'https://ezacto.example',
        SES_FROM: 'notify@example.test',
        ENVIRONMENT: 'test',
        RELEASE: 'invoice-delivery-acceptance',
      } satisfies WorkerEnv
      const services = await createRuntimeServices(env, { emailProvider: provider })
      const app = createApp(services)
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers },
          body: JSON.stringify(body),
        }, env)
      const signup = await post('/auth/signup', {
        organization_name: 'Invoice Delivery Studio',
        first_name: 'Avery',
        last_name: 'Ng',
        email: 'owner@example.test',
        password,
      })
      expect(signup.status).toBe(202)
      const verificationToken = /ezacto_verify_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}/u.exec(
        jobs[0]!.message.text,
      )![0]
      expect((await post('/auth/verify-email', { token: verificationToken })).status).toBe(200)
      const signedIn = await post('/auth/sign-in', { email: 'owner@example.test', password })
      const cookie = signedIn.headers.get('set-cookie')!.split(';', 1)[0]!

      const configuredAt = '2026-09-02T12:00:00.000Z'
      await services.emailConfiguration.createSenderIdentity({
        id: 81,
        email: 'billing@example.test',
        displayName: 'Invoice Delivery Billing',
        provider: 'ses',
        providerIdentity: 'example.test',
        actorUserId: 1,
        commandId: 'invoice-delivery-sender',
        occurredAt: configuredAt,
      })
      await services.emailConfiguration.recordSenderEvidence({
        id: 81,
        expectedEvidenceVersion: 0,
        evidence: {
          source: 'provider_api',
          identityKind: 'domain',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          mailFromDomain: null,
          mailFromStatus: 'not_configured',
          observedAt: configuredAt,
        },
        actorUserId: 1,
        commandId: 'invoice-delivery-evidence',
        occurredAt: configuredAt,
      })
      await services.emailConfiguration.setDefaultSenderIdentity({
        id: 81,
        expectedVersion: 0,
        actorUserId: 1,
        commandId: 'invoice-delivery-default',
        occurredAt: configuredAt,
      })
      await isolatedDatabase.prepare(
        `INSERT INTO clients (id, name, currency, created_at, updated_at)
         VALUES (71, 'Delivery Client', 'USD', ?, ?)`,
      ).bind(configuredAt, configuredAt).run()
      await isolatedDatabase.prepare(
        `INSERT INTO invoices (id, client_id, number, currency, issue_date, due_date,
           state, amount_cents, due_amount_cents, created_at, updated_at)
         VALUES (72, 71, 'INV-72', 'USD', '2026-09-01', '2026-09-30',
           'draft', 1234, 1234, ?, ?)`,
      ).bind(configuredAt, configuredAt).run()

      const delivered = await post('/api/v1/invoices/72/deliveries', {
        expected_version: 0,
        recipients: [{ name: 'Client', email: 'client@example.net' }],
        confirmed: true,
      }, { cookie, 'idempotency-key': 'worker-invoice-delivery' })
      expect(delivered.status).toBe(202)
      expect(provider.send).not.toHaveBeenCalled()
      expect(jobs).toHaveLength(1)

      await services.outbox.drain()
      expect(jobs).toHaveLength(2)
      // The version comes from the live head rather than a literal. What this
      // asserts is that the job names the template that rendered it; which
      // number that is belongs to the migration ledger, and pinning it here
      // made this test fail when 0046 appended a version.
      const head = await database
        .prepare(`SELECT current_version FROM email_template_heads WHERE template_kind = 'invoice'`)
        .first<{ current_version: number }>()
      expect(head?.current_version).toBeGreaterThanOrEqual(1)
      expect(jobs[1]).toMatchObject({
        message: {
          from: { email: 'billing@example.test', name: 'Invoice Delivery Billing' },
          to: [{ email: 'client@example.net', name: 'Client' }],
          template: `invoice:${head!.current_version}`,
        },
      })
      const queueMessage = {
        body: jobs[1]!,
        attempts: 1,
        retry: vi.fn(),
        ack: vi.fn(),
      }
      await consumeCloudflareEmailBatch(
        { messages: [queueMessage] } as unknown as MessageBatch<QueuedEmailJob>,
        services.emailLog,
        provider,
      )
      expect(provider.send).toHaveBeenCalledOnce()
      expect(queueMessage.ack).toHaveBeenCalledOnce()
      await services.outbox.drain()
      expect(jobs).toHaveLength(2)
    } finally {
      await isolated.dispose()
    }
  }, 30_000)

  it('[unit] binds SES only from a complete validated static runtime contract', () => {
    const base = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      ENVIRONMENT: 'test',
      RELEASE: 'ses-test',
    } satisfies WorkerEnv

    expect(createWorkerSesMailer(base)).toBeNull()
    expect(createWorkerMailgunMailer(base)).toBeNull()
    expect(createWorkerMailProvider(base)).toBeNull()

    // Mailgun needs both halves; one alone is a misconfiguration, not a
    // no-transport deployment.
    expect(() =>
      createWorkerMailgunMailer({ ...base, MAILGUN_API_KEY: 'key-test' }),
    ).toThrow('Mailgun requires MAILGUN_API_KEY and MAILGUN_DOMAIN together')
    expect(() =>
      createWorkerMailgunMailer({ ...base, MAILGUN_DOMAIN: 'mail.example.test' }),
    ).toThrow('Mailgun requires MAILGUN_API_KEY and MAILGUN_DOMAIN together')
    expect(() =>
      createWorkerMailgunMailer({
        ...base,
        MAILGUN_API_KEY: 'key-test',
        MAILGUN_DOMAIN: 'mail.example.test',
        MAILGUN_REGION: 'apac' as 'us',
      }),
    ).toThrow("MAILGUN_REGION must be 'us' or 'eu'")

    const mailgunEnv = {
      ...base,
      MAILGUN_API_KEY: 'key-test',
      MAILGUN_DOMAIN: 'mail.example.test',
    } satisfies WorkerEnv
    expect(createWorkerMailProvider(mailgunEnv)).not.toBeNull()

    // Two transports cannot share one sender; refuse rather than pick.
    expect(() =>
      createWorkerMailProvider({
        ...mailgunEnv,
        AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_REGION: 'us-west-2',
        SES_FROM: 'notify@example.test',
      }),
    ).toThrow('Configure either Mailgun or SES, not both')

    expect(() =>
      createWorkerSesMailer({ ...base, SES_REGION: 'us-west-2' }),
    ).toThrow('SES requires AWS_ACCESS_KEY_ID')
    expect(() =>
      createWorkerSesMailer({
        ...base,
        AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_REGION: 'https://attacker.test',
        SES_FROM: 'notify@example.test',
      }),
    ).toThrow('SES region is invalid')
    expect(() =>
      createWorkerSesMailer({
        ...base,
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_REGION: 'us-west-2',
        SES_FROM: 'notify@example.test',
      }),
    ).toThrow('SES access key id is invalid')
    expect(() =>
      createWorkerSesMailer({
        ...base,
        AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_REGION: 'us-west-2',
        SES_FROM: 'notify@example.test',
        SES_CONFIGURATION_SET: 'events?redirect=attacker',
      }),
    ).toThrow('SES configuration set is invalid')
    expect(
      createWorkerSesMailer({
        ...base,
        AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        SES_REGION: 'us-west-2',
        SES_FROM: 'notify@example.test',
      }),
    ).toMatchObject({ name: 'ses', region: 'us-west-2' })
  })

  it('[unit] maps SES identity evidence without treating disabled domain DKIM as verified', async () => {
    const base = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      SES_REGION: 'us-west-2',
      SES_FROM: 'notify@example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'ses-evidence-test',
    } satisfies WorkerEnv
    const provider = createWorkerSesMailer(base, {
      fetch: async () =>
        Response.json({
          IdentityType: 'DOMAIN',
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS', SigningEnabled: false },
          MailFromAttributes: {},
        }),
    })!

    await expect(
      createSesSenderIdentityVerifier(provider).verify(
        {
          id: 1,
          email: 'billing@example.test',
          displayName: 'Billing',
          replyToEmail: null,
          provider: 'ses',
          providerIdentity: 'example.test',
          isDefault: false,
          version: 0,
          archivedAt: null,
          createdByUserId: 1,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          evidence: null,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      source: 'provider_api',
      identityKind: 'domain',
      verificationStatus: 'verified',
      dkimStatus: 'pending',
      mailFromDomain: null,
      mailFromStatus: 'not_configured',
    })
  })

  it('[unit] attests the exact Mailgun address the deployment sends from', async () => {
    const provider = createWorkerMailgunMailer({
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      MAILGUN_API_KEY: 'key-test',
      MAILGUN_DOMAIN: 'go.example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'mailgun-evidence-test',
    } satisfies WorkerEnv)!

    await expect(
      createMailgunSenderIdentityVerifier(provider, 'time@go.example.test').verify(
        {
          id: 1,
          email: 'time@go.example.test',
          displayName: 'Time',
          replyToEmail: null,
          provider: 'mailgun',
          providerIdentity: 'time@go.example.test',
          isDefault: false,
          version: 0,
          archivedAt: null,
          createdByUserId: 1,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          evidence: null,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      source: 'deployment_config',
      identityKind: 'email_address',
      verificationStatus: 'operator_configured',
      dkimStatus: 'not_applicable',
      mailFromDomain: null,
      mailFromStatus: 'not_configured',
    })
  })

  it('[security] refuses a Mailgun address off the configured sending domain', async () => {
    // The deployment's From and the identity agree with each other here, so the
    // SMTP-shaped check alone would pass. Mailgun would still refuse the send:
    // it accepts mail only for the domain it is configured with.
    const provider = createWorkerMailgunMailer({
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      MAILGUN_API_KEY: 'key-test',
      MAILGUN_DOMAIN: 'go.example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'mailgun-evidence-test',
    } satisfies WorkerEnv)!

    await expect(
      createMailgunSenderIdentityVerifier(provider, 'time@elsewhere.test').verify(
        {
          id: 1,
          email: 'time@elsewhere.test',
          displayName: 'Time',
          replyToEmail: null,
          provider: 'mailgun',
          providerIdentity: 'time@elsewhere.test',
          isDefault: false,
          version: 0,
          archivedAt: null,
          createdByUserId: 1,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          evidence: null,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'sender_identity_binding_mismatch' })
  })

  it('[unit] records disabled email-address DKIM without inventing alignment', async () => {
    const env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      SES_REGION: 'us-west-2',
      SES_FROM: 'notify@example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'ses-email-evidence-test',
    } satisfies WorkerEnv
    const provider = createWorkerSesMailer(env, {
      fetch: async () =>
        Response.json({
          IdentityType: 'EMAIL_ADDRESS',
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS', SigningEnabled: false },
          MailFromAttributes: {},
        }),
    })!

    await expect(
      createSesSenderIdentityVerifier(provider).verify(
        {
          id: 1,
          email: 'billing@example.test',
          displayName: 'Billing',
          replyToEmail: null,
          provider: 'ses',
          providerIdentity: 'billing@example.test',
          isDefault: false,
          version: 0,
          archivedAt: null,
          createdByUserId: 1,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          evidence: null,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      source: 'provider_api',
      identityKind: 'email_address',
      verificationStatus: 'verified',
      dkimStatus: 'not_applicable',
      mailFromDomain: null,
      mailFromStatus: 'not_configured',
    })
  })

  it('[unit] preserves provider identity kind for later exact From authorization', async () => {
    const base = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      SES_REGION: 'us-west-2',
      SES_FROM: 'notify@example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'ses-evidence-binding-test',
    } satisfies WorkerEnv
    const provider = createWorkerSesMailer(base, {
      fetch: async () =>
        Response.json({
          IdentityType: 'DOMAIN',
          VerifiedForSendingStatus: true,
          DkimAttributes: { Status: 'SUCCESS', SigningEnabled: true },
          MailFromAttributes: {},
        }),
    })!

    await expect(
      createSesSenderIdentityVerifier(provider).verify(
        {
          id: 1,
          email: 'billing@different.example',
          displayName: 'Billing',
          replyToEmail: null,
          provider: 'ses',
          providerIdentity: 'example.test',
          isDefault: false,
          version: 0,
          archivedAt: null,
          createdByUserId: 1,
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          evidence: null,
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      source: 'provider_api',
      identityKind: 'domain',
      verificationStatus: 'verified',
      dkimStatus: 'verified',
    })
  })

  it('[integration] persists the signed SES receipt before acknowledging the queue', async () => {
    const queue = { send: vi.fn(async () => undefined) } as unknown as Queue<QueuedEmailJob>
    const env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      EMAIL_QUEUE: queue,
      APP_BASE_URL: 'https://ezacto.example',
      AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      SES_REGION: 'us-west-2',
      SES_FROM: 'notify@example.test',
      SES_CONFIGURATION_SET: 'ezacto-events',
      ENVIRONMENT: 'test',
      RELEASE: 'ses-test',
    } satisfies WorkerEnv
    const ticks = [10, 12, 20, 26]
    const provider = createWorkerSesMailer(env, {
      now: () => new Date('2026-08-28T12:34:56.000Z'),
      monotonicNow: () => ticks.shift()!,
      fetch: async (request) =>
        request.method === 'GET'
          ? new Response('{}', {
              status: 404,
              headers: { 'x-amzn-requestid': 'suppression-request' },
            })
          : Response.json(
              { MessageId: 'ses-message-integration' },
              { headers: { 'x-amzn-requestid': 'send-request-integration' } },
            ),
    })!
    const services = await createRuntimeServices(env, { emailProvider: provider })
    const message = {
      from: { email: 'billing@example.test', name: 'Billing' },
      to: [{ email: 'ses-integration@example.test' }],
      template: 'verify_email',
      subject: 'Verify your ezacto email',
      text: 'Open the link.\n\nThis link expires.',
    } as const
    const delivery = await services.emailLog.createQueued(message)
    const retry = vi.fn()
    const ack = vi.fn()

    await consumeCloudflareEmailBatch(
      {
        messages: [
          {
            body: { schemaVersion: 1, deliveryId: delivery.id, message },
            attempts: 1,
            retry,
            ack,
          },
        ],
      } as unknown as MessageBatch<QueuedEmailJob>,
      services.emailLog,
      provider,
    )

    expect(retry).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledOnce()
    await expect(services.emailLog.get(delivery.id)).resolves.toMatchObject({
      status: 'sent',
      provider: 'ses',
      providerMessageId: 'ses-message-integration',
      providerRequestId: 'send-request-integration',
      providerLatencyMs: 6,
      failureReason: null,
    })
  })

  it('[integration] logs SES suppression as a terminal reason without a send call', async () => {
    const env = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      AWS_ACCESS_KEY_ID: 'TESTACCESSKEY',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      SES_REGION: 'us-west-2',
      SES_FROM: 'notify@example.test',
      ENVIRONMENT: 'test',
      RELEASE: 'ses-test',
    } satisfies WorkerEnv
    const fetch = vi.fn(async (_request: Request) =>
      Response.json({
        SuppressedDestination: {
          EmailAddress: 'suppressed@example.test',
          Reason: 'COMPLAINT',
        },
      }),
    )
    const provider = createWorkerSesMailer(env, { fetch })!
    const services = await createRuntimeServices(env, { emailProvider: provider })
    const message = {
      from: { email: 'billing@example.test', name: 'Billing' },
      to: [{ email: 'suppressed@example.test' }],
      template: 'verify_email',
      subject: 'Verify your ezacto email',
      text: 'Open the link.',
    } as const
    const delivery = await services.emailLog.createQueued(message)
    const ack = vi.fn()

    await consumeCloudflareEmailBatch(
      {
        messages: [
          {
            body: { schemaVersion: 1, deliveryId: delivery.id, message },
            attempts: 1,
            retry: vi.fn(),
            ack,
          },
        ],
      } as unknown as MessageBatch<QueuedEmailJob>,
      services.emailLog,
      provider,
    )

    expect(fetch).toHaveBeenCalledOnce()
    expect(ack).toHaveBeenCalledOnce()
    await expect(services.emailLog.get(delivery.id)).resolves.toMatchObject({
      status: 'failed',
      provider: 'ses',
      failureCode: 'provider_rejected',
      failureReason: 'recipient_suppressed:COMPLAINT',
    })
  })
})
