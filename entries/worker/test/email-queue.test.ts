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
  createRuntimeServices,
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
    expect(services.authMailer).toBeUndefined()
  })

  it('[unit] binds SES only from a complete validated static runtime contract', () => {
    const base = {
      DB: database,
      API_CURSOR_SIGNING_KEY: cursorKey,
      ENVIRONMENT: 'test',
      RELEASE: 'ses-test',
    } satisfies WorkerEnv

    expect(createWorkerSesMailer(base)).toBeNull()
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
