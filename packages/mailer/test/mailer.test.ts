import { describe, expect, it, vi } from 'vitest'
import {
  EMAIL_RETRY_POLICY,
  EmailQueueUnavailableError,
  InProcessEmailQueue,
  createQueuedMailer,
  processQueuedEmail,
  type EmailLogRecord,
  type EmailLogStore,
  type EmailMessage,
  type HttpEmailProvider,
  type QueuedEmailJob,
} from '../src/index.js'

const message: EmailMessage = {
  to: [{ email: 'Owner@Example.test', name: 'Avery' }],
  template: 'verify_email',
  subject: 'Verify your ezacto email',
  text: 'Open the one-time verification link.',
  related: { type: 'user', id: 1 },
}

const record = (overrides: Partial<EmailLogRecord> = {}): EmailLogRecord => ({
  id: 7,
  to: [{ email: 'owner@example.test', name: 'Avery' }],
  template: 'verify_email',
  subject: 'Verify your ezacto email',
  provider: null,
  providerMessageId: null,
  status: 'queued',
  relatedType: 'user',
  relatedId: 1,
  attemptCount: 0,
  failureCode: null,
  createdAt: '2026-08-28T20:00:00.000Z',
  updatedAt: '2026-08-28T20:00:00.000Z',
  ...overrides,
})

const store = (): EmailLogStore => ({
  createQueued: vi.fn(async () => record()),
  get: vi.fn(async () => record()),
  recordAttempt: vi.fn(async () => record({ provider: 'test-http', attemptCount: 1 })),
  markSent: vi.fn(async () =>
    record({ status: 'sent', provider: 'test-http', providerMessageId: 'provider-7' }),
  ),
  markFailed: vi.fn(async (_id, provider, failureCode) =>
    record({ status: 'failed', provider, failureCode }),
  ),
  list: vi.fn(async () => []),
})

const job: QueuedEmailJob = { schemaVersion: 1, deliveryId: 7, message }

describe('queued mailer', () => {
  it('[unit] exposes an HTTP message/provider seam with no SMTP transport fields', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    await expect(createQueuedMailer(log, queue).enqueue(message)).resolves.toMatchObject({
      id: 7,
      status: 'queued',
    })
    expect(queue.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      deliveryId: 7,
      message: {
        ...message,
        to: [{ email: 'owner@example.test', name: 'Avery' }],
      },
    })
    expect(JSON.stringify(queue.send.mock.calls)).not.toMatch(
      /smtp|hostname|port|starttls|transport/i,
    )
  })

  it('[unit] marks a durable log failure when the queue cannot accept the job', async () => {
    const log = store()
    const mailer = createQueuedMailer(log, {
      send: vi.fn(async () => {
        throw new Error('binding unavailable')
      }),
    })
    await expect(mailer.enqueue(message)).rejects.toBeInstanceOf(
      EmailQueueUnavailableError,
    )
    expect(log.markFailed).toHaveBeenCalledWith(7, null, 'queue_unavailable')
  })

  it('[unit] retries provider failure with the bounded queue policy, then records failed', async () => {
    const log = store()
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => {
        throw new Error('provider 503 with secret detail')
      }),
    }
    for (let attempt = 1; attempt < EMAIL_RETRY_POLICY.maxAttempts; attempt += 1) {
      await expect(processQueuedEmail(job, attempt, log, provider)).resolves.toEqual({
        action: 'retry',
        delaySeconds: EMAIL_RETRY_POLICY.delaySeconds[attempt - 1],
      })
    }
    await expect(
      processQueuedEmail(job, EMAIL_RETRY_POLICY.maxAttempts, log, provider),
    ).resolves.toEqual({ action: 'ack' })
    expect(log.markFailed).toHaveBeenCalledWith(
      7,
      'test-http',
      'provider_rejected',
    )
    expect(JSON.stringify(vi.mocked(log.markFailed).mock.calls)).not.toContain(
      'secret detail',
    )
  })

  it('[unit] times out provider I/O without leaking the timeout into the enqueueing click', async () => {
    const log = store()
    let providerStarted = false
    const provider: HttpEmailProvider = {
      name: 'slow-http',
      send: vi.fn(
        async (): Promise<{ messageId: string }> =>
          new Promise<{ messageId: string }>(() => {
            providerStarted = true
          }),
      ),
    }
    const scheduled: Array<() => Promise<void>> = []
    const queue = new InProcessEmailQueue(
      async (queuedJob, attempt) =>
        processQueuedEmail(queuedJob, attempt, log, provider, {
          providerTimeoutMs: 1,
        }),
      (task) => void scheduled.push(task),
    )
    const mailer = createQueuedMailer(log, queue)
    await expect(mailer.enqueue(message)).resolves.toMatchObject({ status: 'queued' })
    expect(providerStarted).toBe(false)
    await scheduled.shift()!()
    expect(providerStarted).toBe(true)
    expect(scheduled).toHaveLength(1)
  })

  it('[unit] records provider timeout when the bounded retry policy is exhausted', async () => {
    const log = store()
    const provider: HttpEmailProvider = {
      name: 'slow-http',
      send: vi.fn(
        async (): Promise<{ messageId: string }> =>
          new Promise<{ messageId: string }>(() => undefined),
      ),
    }
    await expect(
      processQueuedEmail(job, EMAIL_RETRY_POLICY.maxAttempts, log, provider, {
        providerTimeoutMs: 1,
      }),
    ).resolves.toEqual({ action: 'ack' })
    expect(log.markFailed).toHaveBeenCalledWith(
      7,
      'slow-http',
      'provider_timeout',
    )
  })

  it('[unit] acknowledges a successful HTTP provider response and records its id', async () => {
    const log = store()
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => ({ messageId: 'provider-7' })),
    }
    await expect(processQueuedEmail(job, 1, log, provider)).resolves.toEqual({
      action: 'ack',
    })
    expect(log.markSent).toHaveBeenCalledWith(7, 'test-http', 'provider-7')
    expect(provider.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'ezacto-email-7' }),
    )
  })

  it('[unit] acknowledges terminal log redelivery without sending twice', async () => {
    const log = store()
    vi.mocked(log.get).mockResolvedValue(
      record({ status: 'sent', provider: 'test-http', providerMessageId: 'provider-7' }),
    )
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => ({ messageId: 'duplicate' })),
    }
    await expect(processQueuedEmail(job, 2, log, provider)).resolves.toEqual({
      action: 'ack',
    })
    expect(provider.send).not.toHaveBeenCalled()
  })
})
