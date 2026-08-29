import { describe, expect, it, vi } from 'vitest'
import {
  EMAIL_RETRY_POLICY,
  EmailProviderTerminalError,
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
  providerRequestId: null,
  providerLatencyMs: null,
  status: 'queued',
  relatedType: 'user',
  relatedId: 1,
  attemptCount: 0,
  failureCode: null,
  failureReason: null,
  createdAt: '2026-08-28T20:00:00.000Z',
  updatedAt: '2026-08-28T20:00:00.000Z',
  ...overrides,
})

const store = (): EmailLogStore => {
  let attemptCount = 0
  return {
    createQueued: vi.fn(async () => record()),
    get: vi.fn(async () => record()),
    claimAttempt: vi.fn(async () => {
      attemptCount += 1
      return attemptCount
    }),
    releaseAttempt: vi.fn(async () => true),
    markSent: vi.fn(async (_id, provider, receipt) =>
      record({
        status: 'sent',
        provider,
        providerMessageId: receipt.messageId,
        providerRequestId: receipt.requestId ?? null,
        providerLatencyMs: receipt.latencyMs ?? null,
      }),
    ),
    markProviderFailed: vi.fn(async (_id, provider, failureCode, _attempt, reason) =>
      record({ status: 'failed', provider, failureCode, failureReason: reason ?? null }),
    ),
    markQueueFailed: vi.fn(async () =>
      record({ status: 'failed', failureCode: 'queue_unavailable' }),
    ),
    list: vi.fn(async () => []),
  }
}

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
    expect(log.markQueueFailed).toHaveBeenCalledWith(7)
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
    expect(log.markProviderFailed).toHaveBeenCalledWith(
      7,
      'test-http',
      'provider_rejected',
      expect.any(String),
      undefined,
    )
    expect(JSON.stringify(vi.mocked(log.markProviderFailed).mock.calls)).not.toContain(
      'secret detail',
    )
  })

  it('[unit] does not spend provider retries on queue claim contention', async () => {
    const log = store()
    vi.mocked(log.claimAttempt)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(1)
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => {
        throw new Error('transient provider failure')
      }),
    }

    for (let queueAttempt = 1; queueAttempt <= 4; queueAttempt += 1) {
      await expect(
        processQueuedEmail(job, queueAttempt, log, provider),
      ).resolves.toEqual({
        action: 'retry',
        delaySeconds: EMAIL_RETRY_POLICY.claimedRetryDelaySeconds,
      })
    }
    await expect(processQueuedEmail(job, 5, log, provider)).resolves.toEqual({
      action: 'retry',
      delaySeconds: EMAIL_RETRY_POLICY.delaySeconds[0],
    })
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(log.markProviderFailed).not.toHaveBeenCalled()
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
    vi.mocked(log.claimAttempt).mockResolvedValue(
      EMAIL_RETRY_POLICY.maxAttempts,
    )
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
    expect(log.markProviderFailed).toHaveBeenCalledWith(
      7,
      'slow-http',
      'provider_timeout',
      expect.any(String),
      undefined,
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
    expect(log.markSent).toHaveBeenCalledWith(
      7,
      'test-http',
      { messageId: 'provider-7' },
      expect.any(String),
    )
    expect(provider.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: 'ezacto-email-7' }),
    )
  })

  it('[unit] logs a terminal provider reason and does not retry it', async () => {
    const log = store()
    const provider: HttpEmailProvider = {
      name: 'ses',
      send: vi.fn(async () => {
        throw new EmailProviderTerminalError('recipient_suppressed:BOUNCE')
      }),
    }

    await expect(processQueuedEmail(job, 1, log, provider)).resolves.toEqual({
      action: 'ack',
    })
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(log.releaseAttempt).not.toHaveBeenCalled()
    expect(log.markProviderFailed).toHaveBeenCalledWith(
      7,
      'ses',
      'provider_rejected',
      expect.any(String),
      'recipient_suppressed:BOUNCE',
    )
  })

  it('[unit] never relabels a post-send receipt persistence failure as provider failure', async () => {
    const log = store()
    vi.mocked(log.markSent).mockRejectedValue(new Error('database unavailable'))
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => ({ messageId: 'provider-7' })),
    }

    await expect(processQueuedEmail(job, 5, log, provider)).rejects.toThrow(
      'database unavailable',
    )
    expect(provider.send).toHaveBeenCalledTimes(1)
    expect(log.markProviderFailed).not.toHaveBeenCalled()
    expect(log.releaseAttempt).not.toHaveBeenCalled()
  })

  it('[unit] acknowledges terminal log redelivery without sending twice', async () => {
    const log = store()
    vi.mocked(log.claimAttempt).mockResolvedValue(null)
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
