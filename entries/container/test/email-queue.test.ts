import { describe, expect, it } from 'vitest'
import type {
  EmailLogRecord,
  EmailLogStore,
  HttpEmailProvider,
} from '@ezacto/mailer'
import { ContainerEmailQueue } from '../src/email-queue.js'

const record = (attemptCount: number, status: 'queued' | 'failed'): EmailLogRecord => ({
  id: 1,
  from: { email: 'billing@example.test', name: 'Billing' },
  replyTo: [],
  to: [{ email: 'owner@example.test' }],
  template: 'verify_email',
  subject: 'Verify',
  provider: 'smtp',
  providerMessageId: null,
  status,
  relatedType: null,
  relatedId: null,
  attemptCount,
  failureCode: status === 'failed' ? 'provider_rejected' : null,
  failureReason: null,
  providerRequestId: null,
  providerLatencyMs: null,
  createdAt: '2026-08-31T12:00:00.000Z',
  updatedAt: '2026-08-31T12:00:00.000Z',
})

describe('container in-process email queue', () => {
  it('[unit] accelerates pending retries and drains their terminal outcome on close', async () => {
    let attempts = 0
    let failed = false
    let firstAttempt!: () => void
    const started = new Promise<void>((resolve) => {
      firstAttempt = resolve
    })
    const log: EmailLogStore = {
      createQueued: async () => record(0, 'queued'),
      get: async () => record(attempts, failed ? 'failed' : 'queued'),
      claimAttempt: async () => {
        attempts += 1
        firstAttempt()
        return attempts
      },
      releaseAttempt: async () => true,
      markSent: async () => {
        throw new Error('not sent')
      },
      markProviderFailed: async () => {
        failed = true
        return record(attempts, 'failed')
      },
      markQueueFailed: async () => record(attempts, 'failed'),
      markBounced: async () => record(attempts, 'bounced'),
      markComplained: async () => record(attempts, 'complained'),
      getByProviderMessageId: async () => null,
      countByStatus: async () => ({ queued: 0, sent: 0, bounced: 0, complained: 0, failed: 0 }),
      list: async () => [],
    }
    const provider: HttpEmailProvider = {
      name: 'smtp',
      send: async () => {
        throw new Error('temporary SMTP outage')
      },
    }
    const queue = new ContainerEmailQueue(log, provider)
    await queue.send({
      schemaVersion: 1,
      deliveryId: 1,
      message: {
        from: { email: 'billing@example.test', name: 'Billing' },
        to: [{ email: 'owner@example.test' }],
        template: 'verify_email',
        subject: 'Verify',
        text: 'Retry me.',
      },
    })
    await started

    await queue.close(2_000)

    expect(attempts).toBe(5)
    expect(failed).toBe(true)
    await expect(
      queue.send({
        schemaVersion: 1,
        deliveryId: 2,
        message: {
          from: { email: 'billing@example.test', name: 'Billing' },
          to: [{ email: 'other@example.test' }],
          template: 'verify_email',
          subject: 'Verify',
          text: 'Too late.',
        },
      }),
    ).rejects.toThrow('shutting down')
  })

  it('[unit] aborts a hanging provider within the bounded shutdown budget', async () => {
    let attempts = 0
    let failed = false
    let firstAttempt!: () => void
    const started = new Promise<void>((resolve) => {
      firstAttempt = resolve
    })
    const log: EmailLogStore = {
      createQueued: async () => record(0, 'queued'),
      get: async () => record(attempts, failed ? 'failed' : 'queued'),
      claimAttempt: async () => {
        attempts += 1
        firstAttempt()
        return attempts
      },
      releaseAttempt: async () => true,
      markSent: async () => {
        throw new Error('not sent')
      },
      markProviderFailed: async () => {
        failed = true
        return record(attempts, 'failed')
      },
      markQueueFailed: async () => record(attempts, 'failed'),
      markBounced: async () => record(attempts, 'bounced'),
      markComplained: async () => record(attempts, 'complained'),
      getByProviderMessageId: async () => null,
      countByStatus: async () => ({ queued: 0, sent: 0, bounced: 0, complained: 0, failed: 0 }),
      list: async () => [],
    }
    const provider: HttpEmailProvider = {
      name: 'smtp',
      send: async (_message, { signal }) =>
        new Promise((_resolve, reject) => {
          const aborted = () =>
            reject(new DOMException('provider aborted', 'AbortError'))
          if (signal.aborted) aborted()
          else signal.addEventListener('abort', aborted, { once: true })
        }),
    }
    const queue = new ContainerEmailQueue(log, provider)
    await queue.send({
      schemaVersion: 1,
      deliveryId: 1,
      message: {
        from: { email: 'billing@example.test', name: 'Billing' },
        to: [{ email: 'owner@example.test' }],
        template: 'verify_email',
        subject: 'Verify',
        text: 'Do not hang shutdown.',
      },
    })
    await started

    const before = performance.now()
    await queue.close(500)

    expect(performance.now() - before).toBeLessThan(450)
    expect(attempts).toBe(5)
    expect(failed).toBe(true)
  })

  it('[unit] rejects at the close deadline when a provider ignores cancellation', async () => {
    let resolveProvider!: () => void
    let startedProvider!: () => void
    const started = new Promise<void>((resolve) => {
      startedProvider = resolve
    })
    const providerFinished = new Promise<void>((resolve) => {
      resolveProvider = resolve
    })
    const log: EmailLogStore = {
      createQueued: async () => record(0, 'queued'),
      get: async () => record(1, 'queued'),
      claimAttempt: async () => 1,
      releaseAttempt: async () => true,
      markSent: async () => record(1, 'queued'),
      markProviderFailed: async () => record(1, 'failed'),
      markQueueFailed: async () => record(1, 'failed'),
      markBounced: async () => record(1, 'bounced'),
      markComplained: async () => record(1, 'complained'),
      getByProviderMessageId: async () => null,
      countByStatus: async () => ({ queued: 0, sent: 0, bounced: 0, complained: 0, failed: 0 }),
      list: async () => [],
    }
    const provider: HttpEmailProvider = {
      name: 'smtp',
      send: async () => {
        startedProvider()
        await providerFinished
        return { messageId: 'eventually-finished' }
      },
    }
    const queue = new ContainerEmailQueue(log, provider)
    await queue.send({
      schemaVersion: 1,
      deliveryId: 1,
      message: {
        from: { email: 'billing@example.test', name: 'Billing' },
        to: [{ email: 'owner@example.test' }],
        template: 'verify_email',
        subject: 'Verify',
        text: 'Ignore cancellation.',
      },
    })
    await started

    await expect(queue.close(25)).rejects.toThrow('did not drain')
    resolveProvider()
    await queue.close(1_000)
  })
})
