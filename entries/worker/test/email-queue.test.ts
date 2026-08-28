import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  EmailLogRecord,
  HttpEmailProvider,
  QueuedEmailJob,
} from '@ezacto/mailer'
import { createApp, type WorkerEnv } from '../src/app.js'
import {
  consumeCloudflareEmailBatch,
  createCloudflareEmailQueue,
} from '../src/email-queue.js'
import { createRuntimeServices } from '../src/runtime.js'

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
      APP_ORIGIN: 'https://ezacto.example',
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
})
