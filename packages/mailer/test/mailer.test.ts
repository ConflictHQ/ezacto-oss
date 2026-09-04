import { describe, expect, it, vi } from 'vitest'
import {
  EMAIL_RETRY_POLICY,
  EmailProviderTerminalError,
  EmailQueueUnavailableError,
  InProcessEmailQueue,
  createQueuedMailer,
  createSenderBoundQueuedMailer,
  processQueuedEmail,
  type EmailLogRecord,
  type EmailLogStore,
  type EmailMessage,
  type HttpEmailProvider,
  type QueuedEmailJob,
  type ResolvedSenderIdentity,
} from '../src/index.js'

const message: EmailMessage = {
  from: { email: 'billing@example.test', name: 'Ezacto' },
  to: [{ email: 'Owner@Example.test', name: 'Avery' }],
  template: 'verify_email',
  subject: 'Verify your ezacto email',
  text: 'Open the one-time verification link.',
  related: { type: 'user', id: 1 },
}

const record = (overrides: Partial<EmailLogRecord> = {}): EmailLogRecord => ({
  id: 7,
  from: { email: 'billing@example.test', name: 'Ezacto' },
  replyTo: [],
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
    markBounced: vi.fn(async () => record({ status: 'bounced' })),
    markComplained: vi.fn(async () => record({ status: 'complained' })),
    getByProviderMessageId: vi.fn(async () => record()),
    countByStatus: vi.fn(async () => ({
      queued: 0, sent: 0, bounced: 0, complained: 0, failed: 0,
    })),
    list: vi.fn(async () => []),
  }
}

const job: QueuedEmailJob = { schemaVersion: 1, deliveryId: 7, message }

describe('queued mailer', () => {
  it('[unit] reuses a persisted delivery id and fences stale sender versions before queue I/O', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const identity: ResolvedSenderIdentity = {
      id: 44,
      version: 3,
      email: 'billing@example.test',
      displayName: 'Billing',
      replyToEmail: 'reply@example.test',
      provider: 'ses',
      providerIdentity: 'example.test',
      isDefault: true,
      archivedAt: null,
      evidence: {
        version: 5,
        source: 'provider_api',
        identityKind: 'domain',
        verificationStatus: 'verified',
        dkimStatus: 'verified',
        mailFromDomain: null,
        mailFromStatus: 'not_configured',
        observedAt: '2026-09-02T12:00:00.000Z',
      },
    }
    const mailer = createSenderBoundQueuedMailer(
      { resolveSenderIdentity: vi.fn(async () => identity) },
      createQueuedMailer(log, queue),
      'ses',
    )
    const binding = {
      senderIdentityId: 44,
      senderIdentityVersion: 3,
      senderEvidenceVersion: 5,
      from: { email: 'billing@example.test', name: 'Billing' },
      replyTo: [{ email: 'reply@example.test' }],
    }
    const persisted = {
      to: [{ email: 'client@example.test' }],
      template: 'invoice:1',
      subject: 'Invoice INV-1',
      text: 'Invoice total $12.34',
      related: { type: 'invoice_message', id: 100 },
    }
    await mailer.enqueuePersisted!(700, binding, persisted)
    await mailer.enqueuePersisted!(700, binding, persisted)
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queue.send).toHaveBeenNthCalledWith(1, expect.objectContaining({ deliveryId: 700 }))
    expect(queue.send).toHaveBeenNthCalledWith(2, expect.objectContaining({ deliveryId: 700 }))

    await expect(
      mailer.enqueuePersisted!(700, { ...binding, senderIdentityVersion: 2 }, persisted),
    ).rejects.toMatchObject({ code: 'sender_identity_binding_mismatch' })
    expect(queue.send).toHaveBeenCalledTimes(2)
  })

  it('[security] blocks unverified senders before the durable log or queue is touched', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const queued = createQueuedMailer(log, queue)
    const identities = {
      resolveSenderIdentity: vi.fn(async () => ({
        id: 41,
        email: 'billing@example.test',
        displayName: 'Billing',
        replyToEmail: null,
        provider: 'ses',
        providerIdentity: 'example.test',
        isDefault: false,
        archivedAt: null,
        evidence: {
          source: 'provider_api' as const,
          identityKind: 'domain' as const,
          verificationStatus: 'pending' as const,
          dkimStatus: 'pending' as const,
          mailFromDomain: null,
          mailFromStatus: 'not_configured' as const,
          observedAt: '2026-09-02T00:00:00.000Z',
        },
      })),
    }

    const attempted = createSenderBoundQueuedMailer(identities, queued).enqueue({
      senderIdentityId: 41,
      to: message.to,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
    await expect(attempted).rejects.toMatchObject({
      name: 'SenderIdentityUnavailableError',
      code: 'sender_verification_pending',
      senderIdentityId: 41,
    })
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('[unit] binds a verified organization From and Reply-To before queueing', async () => {
    const queued = { enqueue: vi.fn(async () => record()) }
    const identities = {
      resolveSenderIdentity: vi.fn(async () => ({
        id: 42,
        email: 'billing@example.test',
        displayName: 'Ezacto Billing',
        replyToEmail: 'accounts@example.test',
        provider: 'ses',
        providerIdentity: 'example.test',
        isDefault: true,
        archivedAt: null,
        evidence: {
          source: 'provider_api' as const,
          identityKind: 'domain' as const,
          verificationStatus: 'verified' as const,
          dkimStatus: 'verified' as const,
          mailFromDomain: 'bounce.example.test',
          mailFromStatus: 'verified' as const,
          observedAt: '2026-09-02T00:00:00.000Z',
        },
      })),
    }

    await createSenderBoundQueuedMailer(identities, queued).enqueue({
      to: message.to,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
    expect(identities.resolveSenderIdentity).toHaveBeenCalledWith(undefined)
    expect(queued.enqueue).toHaveBeenCalledWith({
      from: { email: 'billing@example.test', name: 'Ezacto Billing' },
      replyTo: [{ email: 'accounts@example.test' }],
      to: message.to,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
  })

  it('[unit] binds SMTP organization mail only after exact deployment attestation', async () => {
    const queued = { enqueue: vi.fn(async () => record()) }
    const identities = {
      resolveSenderIdentity: vi.fn(async () => ({
        id: 45,
        email: 'billing@example.test',
        displayName: 'Ezacto Billing',
        replyToEmail: 'accounts@example.test',
        provider: 'smtp',
        providerIdentity: 'billing@example.test',
        isDefault: true,
        archivedAt: null,
        evidence: {
          source: 'deployment_config' as const,
          identityKind: 'email_address' as const,
          verificationStatus: 'operator_configured' as const,
          dkimStatus: 'not_applicable' as const,
          mailFromDomain: null,
          mailFromStatus: 'not_configured' as const,
          observedAt: '2026-09-02T00:00:00.000Z',
        },
      })),
    }

    await createSenderBoundQueuedMailer(
      identities,
      queued,
      'smtp',
      'Ezacto Billing <billing@example.test>',
    ).enqueue({
      to: message.to,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
    expect(queued.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      from: { email: 'billing@example.test', name: 'Ezacto Billing' },
      replyTo: [{ email: 'accounts@example.test' }],
    }))
  })

  it('[security] blocks absent or stale SMTP deployment attestation before log and queue I/O', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const identity: ResolvedSenderIdentity = {
      id: 46,
      email: 'billing@example.test',
      displayName: 'Billing',
      replyToEmail: null,
      provider: 'smtp',
      providerIdentity: 'billing@example.test',
      isDefault: false,
      archivedAt: null,
      evidence: null,
    }
    const identities = { resolveSenderIdentity: vi.fn(async () => identity) }
    expect(() => createSenderBoundQueuedMailer(
      identities,
      createQueuedMailer(log, queue),
      'smtp',
    )).toThrow('deployment configured From address')
    const mailer = createSenderBoundQueuedMailer(
      identities,
      createQueuedMailer(log, queue),
      'smtp',
      'billing@example.test',
    )
    await expect(mailer.enqueue({
      senderIdentityId: 46,
      to: message.to,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })).rejects.toMatchObject({ code: 'sender_deployment_configuration_missing' })

    identities.resolveSenderIdentity.mockResolvedValue({
      ...identity,
      evidence: {
        source: 'deployment_config' as const,
        identityKind: 'email_address' as const,
        verificationStatus: 'operator_configured' as const,
        dkimStatus: 'not_applicable' as const,
        mailFromDomain: null,
        mailFromStatus: 'not_configured' as const,
        observedAt: '2026-09-02T00:00:00.000Z',
      },
    })
    const staleMailer = createSenderBoundQueuedMailer(
      identities,
      createQueuedMailer(log, queue),
      'smtp',
      'different@example.test',
    )
    await expect(staleMailer.enqueue({
      senderIdentityId: 46,
      to: message.to,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })).rejects.toMatchObject({ code: 'sender_identity_binding_mismatch' })
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('[security] never accepts deployment-config evidence for SES', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const identities = {
      resolveSenderIdentity: vi.fn(async () => ({
        id: 47,
        email: 'billing@example.test',
        displayName: 'Billing',
        replyToEmail: null,
        provider: 'ses',
        providerIdentity: 'billing@example.test',
        isDefault: false,
        archivedAt: null,
        evidence: {
          source: 'deployment_config' as const,
          identityKind: 'email_address' as const,
          verificationStatus: 'operator_configured' as const,
          dkimStatus: 'not_applicable' as const,
          mailFromDomain: null,
          mailFromStatus: 'not_configured' as const,
          observedAt: '2026-09-02T00:00:00.000Z',
        },
      })),
    }
    await expect(
      createSenderBoundQueuedMailer(
        identities,
        createQueuedMailer(log, queue),
        'ses',
      ).assertAvailable(47),
    ).rejects.toMatchObject({ code: 'sender_evidence_untrusted' })
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queue.send).not.toHaveBeenCalled()
  })

  it('[security] rejects SES email-address evidence without aligned DKIM or MAIL FROM before all I/O', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const provider: HttpEmailProvider = {
      name: 'ses',
      send: vi.fn(async () => ({ messageId: 'must-not-send' })),
    }
    const identities = {
      resolveSenderIdentity: vi.fn(async () => ({
        id: 43,
        email: 'billing@example.test',
        displayName: 'Billing',
        replyToEmail: null,
        provider: 'ses',
        providerIdentity: 'billing@example.test',
        isDefault: false,
        archivedAt: null,
        evidence: {
          source: 'provider_api' as const,
          identityKind: 'email_address' as const,
          verificationStatus: 'verified' as const,
          dkimStatus: 'not_applicable' as const,
          mailFromDomain: null,
          mailFromStatus: 'not_configured' as const,
          observedAt: '2026-09-02T00:00:00.000Z',
        },
      })),
    }

    await expect(
      createSenderBoundQueuedMailer(identities, createQueuedMailer(log, queue)).enqueue({
        senderIdentityId: 43,
        to: message.to,
        template: message.template,
        subject: message.subject,
        text: message.text,
      }),
    ).rejects.toMatchObject({ code: 'sender_alignment_missing' })
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queue.send).not.toHaveBeenCalled()
    expect(provider.send).not.toHaveBeenCalled()
  })

  it('[security] rejects header control characters before the durable log is written', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    await expect(
      createQueuedMailer(log, queue).enqueue({
        ...message,
        subject: 'Invoice\r\nBcc: attacker@example.test',
      }),
    ).rejects.toThrow('subject must not contain control characters')
    expect(log.createQueued).not.toHaveBeenCalled()
  })

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

  it('[unit] never invokes the provider after the durable attempt budget', async () => {
    const log = store()
    vi.mocked(log.claimAttempt).mockResolvedValue(
      EMAIL_RETRY_POLICY.maxAttempts + 1,
    )
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => ({ messageId: 'must-not-send' })),
    }

    await expect(processQueuedEmail(job, 101, log, provider)).rejects.toThrow(
      'email delivery provider attempt budget is exhausted',
    )
    expect(provider.send).not.toHaveBeenCalled()
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
