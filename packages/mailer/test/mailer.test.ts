import { MailgunMailer } from "../src/mailgun.js";
import { SesMailer } from "../src/ses.js";
import { describe, expect, it, vi } from 'vitest'
import {
  EMAIL_RETRY_POLICY,
  EmailProviderTerminalError,
  EmailQueueUnavailableError,
  InProcessEmailQueue,
  createDeploymentSenderQueuedMailer,
  createQueuedMailer,
  createRecipientAllowlistQueue,
  createSenderBoundQueuedMailer,
  processQueuedEmail,
  RECIPIENT_NOT_ALLOWED,
  restrictRecipients,
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
  cc: [],
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
    markRefused: vi.fn(async (_id: number, reason: string) =>
      record({ status: 'failed', failureCode: 'provider_rejected', failureReason: reason }),
    ),
    markBounced: vi.fn(async () => record({ status: 'bounced' })),
    markComplained: vi.fn(async () => record({ status: 'complained' })),
    getByProviderMessageId: vi.fn(async () => record()),
    countByStatus: vi.fn(async () => ({
      queued: 0, sent: 0, bounced: 0, complained: 0, failed: 0,
    })),
    countByStatusPerSender: vi.fn(async () => []),
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

describe("what every provider owes an attachment", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const withFile = {
    from: { email: "notify@example.test", name: "Ezacto" },
    to: [{ email: "owner@example.test", name: "Avery" }],
    template: "invoice",
    subject: "Invoice 1315",
    text: "The invoice is attached.",
    attachments: [
      { filename: "invoice-1315.pdf", contentType: "application/pdf", content: pdf },
    ],
  } as never;

  const withoutFile = {
    from: { email: "notify@example.test", name: "Ezacto" },
    to: [{ email: "owner@example.test", name: "Avery" }],
    template: "invoice",
    subject: "Invoice 1315",
    text: "The invoice is attached.",
  } as never;

  /**
   * The rule is not that every provider can attach a file. It is that none of
   * them may accept the message and quietly send it without one.
   *
   * An invoice whose own body says a document is attached, arriving with
   * nothing attached, is a failure the client discovers and the sender does
   * not. So a provider that cannot carry the file has to say so, and this test
   * fails a provider that resolves successfully having dropped it -- which is
   * the state every provider here was in before issue 626.
   */
  it("[security] carries the file or refuses the message, and never silently drops it", async () => {
    const carried: string[] = [];
    const outcomes: Record<string, string> = {};

    const providers = () => {
      const mailgunCarried: string[] = [];
      const mailgun = new MailgunMailer(
        { apiKey: "key-test-00000000deadbeef00000000", domain: "mail.example.test" },
        {
          monotonicNow: (() => {
            let tick = 0;
            return () => (tick += 1);
          })(),
          fetch: async (request) => {
            const body = await request.clone().formData().catch(() => null);
            if (body?.get("attachment") instanceof File) mailgunCarried.push("mailgun");
            return new Response(JSON.stringify({ id: "<a@b>", message: "Queued" }), { status: 200 });
          },
        },
      );
      const ses = new SesMailer(
        {
          accessKeyId: "TESTACCESSKEY",
          secretAccessKey: "test-secret-key",
          region: "us-west-2",
          from: "Ezacto <notify@example.test>",
        },
        {
          monotonicNow: (() => {
            let tick = 0;
            return () => (tick += 1);
          })(),
          fetch: async (request) =>
            request.method === "GET"
              ? new Response(JSON.stringify({}), {
                  status: 404,
                  headers: { "x-amzn-requestid": "request-1" },
                })
              : new Response(JSON.stringify({ MessageId: "ses-1" }), {
                  status: 200,
                  headers: { "x-amzn-requestid": "request-1" },
                }),
        },
      );
      return [
        ["mailgun", mailgun, mailgunCarried] as const,
        ["ses", ses, carried] as const,
      ];
    };

    const options = { signal: AbortSignal.timeout(2_000), idempotencyKey: "k1" };
    for (const [name, provider, seen] of providers()) {
      // First, prove this harness can send at all. Without this the test is
      // vacuous: a provider that throws for an unrelated reason would land in
      // "refused" and pass while dropping attachments silently.
      await expect(
        provider.send(withoutFile, options),
        `${name} cannot send even without an attachment, so this proves nothing`,
      ).resolves.toBeDefined();

      const outcome = await provider
        .send(withFile, options)
        .then(() => "sent" as const)
        .catch(() => "refused" as const);
      outcomes[name] = outcome;
      if (outcome === "sent") {
        expect(seen, `${name} reported success having dropped the file`).toContain(name);
      }
    }

    expect(Object.keys(outcomes).sort()).toEqual(["mailgun", "ses"]);
  });
});

describe('attachments through the queue', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const reference = {
    key: 'invoices/1315/invoice-1315.pdf',
    filename: 'invoice-1315.pdf',
    contentType: 'application/pdf',
  };

  const sender = () => {
    const sent: EmailMessage[] = [];
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async (message: EmailMessage) => {
        sent.push(message);
        return { messageId: 'm1', latencyMs: 1 };
      }),
    };
    return { provider, sent };
  };

  it('[unit] fetches what the job named and hands the bytes to the provider', async () => {
    const { provider, sent } = sender();
    const resolve = vi.fn(async () => pdf);
    await processQueuedEmail(
      { ...job, attachments: [reference] },
      1,
      store(),
      provider,
      { resolveAttachment: resolve },
    );
    expect(resolve).toHaveBeenCalledWith(reference);
    expect(sent[0]?.attachments).toEqual([
      { filename: 'invoice-1315.pdf', contentType: 'application/pdf', content: pdf },
    ]);
  });

  it('[security] refuses a job that carries the bytes themselves', async () => {
    // A Cloudflare Queues message is capped at 128 KB. Bytes on the job mean
    // something serialised a file into that envelope, and what that produces is
    // a silent truncation upstream rather than an error here.
    const { provider, sent } = sender();
    await expect(
      processQueuedEmail(
        {
          ...job,
          message: {
            ...message,
            attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', content: pdf }],
          },
        },
        1,
        store(),
        provider,
      ),
    ).rejects.toThrow(/by reference, not by value/u);
    expect(sent).toEqual([]);
  });

  it('[security] refuses when the file it names is not there', async () => {
    // Dropped instead, the client receives an invoice whose own body says a
    // document is attached and finds nothing -- a failure they discover and the
    // sender does not.
    const { provider, sent } = sender();
    for (const missing of [null, new Uint8Array()]) {
      await expect(
        processQueuedEmail({ ...job, attachments: [reference] }, 1, store(), provider, {
          resolveAttachment: async () => missing,
        }),
      ).rejects.toThrow(/attachment is missing/u);
    }
    expect(sent).toEqual([]);
  });

  it('[unit] refuses a job that names a file with no resolver to fetch it', async () => {
    const { provider } = sender();
    await expect(
      processQueuedEmail({ ...job, attachments: [reference] }, 1, store(), provider),
    ).rejects.toThrow(/no resolver was supplied/u);
  });

  it('[unit] leaves a message with nothing attached exactly as it was', async () => {
    const { provider, sent } = sender();
    await processQueuedEmail(job, 1, store(), provider, {
      resolveAttachment: async () => pdf,
    });
    expect(sent[0]?.attachments).toBeUndefined();
  });
});

/**
 * One invoice email can go to the person who pays it with others copied on the
 * same message. Cc is checked where To is, and it has to survive every place
 * that rebuilds a message on the way to a provider: a rebuild that forgot it
 * would still deliver the invoice to accounts payable and quietly drop everyone
 * who was copied.
 */
describe('cc', () => {
  const copied = [
    { email: '  Controller@Example.test ', name: ' Vale, Rowan ' },
    { email: 'FOUNDER@example.test' },
  ]
  const normalizedCopies = [
    { email: 'controller@example.test', name: 'Vale, Rowan' },
    { email: 'founder@example.test' },
  ]
  const identity: ResolvedSenderIdentity = {
    id: 44,
    version: 3,
    email: 'billing@example.test',
    displayName: 'Billing',
    replyToEmail: null,
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
  const queue = () => {
    const jobs: QueuedEmailJob[] = []
    return { jobs, send: vi.fn(async (sent: QueuedEmailJob) => void jobs.push(sent)) }
  }

  it('[unit] normalizes cc as it does to and carries it onto the queued job', async () => {
    const log = store()
    const queued = queue()
    await createQueuedMailer(log, queued).enqueue({ ...message, cc: copied })
    const expected = {
      ...message,
      to: [{ email: 'owner@example.test', name: 'Avery' }],
      cc: normalizedCopies,
    }
    expect(log.createQueued).toHaveBeenCalledWith(expected)
    expect(queued.jobs).toEqual([{ schemaVersion: 1, deliveryId: 7, message: expected }])
  })

  it('[unit] leaves cc off the copy when the message has none', async () => {
    const queued = queue()
    await createQueuedMailer(store(), queued).enqueue(message)
    expect('cc' in queued.jobs[0]!.message).toBe(false)
  })

  it('[unit] accepts exactly 100 recipients across to and cc', async () => {
    const queued = queue()
    const cc = Array.from({ length: 99 }, (_, index) => ({
      email: `copy-${String(index)}@example.test`,
    }))
    await createQueuedMailer(store(), queued).enqueue({ ...message, cc })
    expect(queued.jobs[0]!.message.cc).toEqual(cc)
  })

  it.each([
    [
      'a cc that is not a list',
      'controller@example.test',
      'cc must be a list of at least 1 recipient when present',
    ],
    ['an empty cc', [], 'cc must be a list of at least 1 recipient when present'],
    [
      'a cc address listed twice, in any case',
      [{ email: 'controller@example.test' }, { email: 'Controller@EXAMPLE.test' }],
      'cc must not list a recipient more than once',
    ],
    [
      'a cc address already in to, in any case',
      [{ email: 'OWNER@example.test' }],
      'cc must not repeat a recipient already in to',
    ],
    [
      'more than 100 recipients across to and cc',
      Array.from({ length: 100 }, (_, index) => ({
        email: `copy-${String(index)}@example.test`,
      })),
      'to and cc must together contain at most 100 recipients',
    ],
    ['a malformed cc address', [{ email: 'controller.example.test' }], 'cc email is invalid'],
    [
      'a header break in a cc name',
      [{ email: 'controller@example.test', name: 'Rowan\r\nBcc: someone@example.test' }],
      'cc name must not contain control characters',
    ],
  ])('[security] refuses %s before the durable log is written', async (_case, cc, refusal) => {
    const log = store()
    const queued = queue()
    const failure: unknown = await createQueuedMailer(log, queued)
      .enqueue({ ...message, cc } as never)
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RangeError)
    expect((failure as RangeError).message).toBe(refusal)
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queued.send).not.toHaveBeenCalled()
  })

  it('[unit] carries cc through the sender-bound and deployment-sender rebuilds', async () => {
    const organization = { enqueue: vi.fn(async () => record()) }
    await createSenderBoundQueuedMailer(
      { resolveSenderIdentity: vi.fn(async () => identity) },
      organization,
    ).enqueue({
      to: message.to,
      cc: copied,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
    expect(organization.enqueue).toHaveBeenCalledWith({
      from: { email: 'billing@example.test', name: 'Billing' },
      to: message.to,
      cc: copied,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })

    const deployment = { enqueue: vi.fn(async () => record()) }
    await createDeploymentSenderQueuedMailer('Ezacto <notify@example.test>', deployment).enqueue({
      to: message.to,
      cc: copied,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
    expect(deployment.enqueue).toHaveBeenCalledWith({
      from: { email: 'notify@example.test', name: 'Ezacto' },
      to: message.to,
      cc: copied,
      template: message.template,
      subject: message.subject,
      text: message.text,
    })
  })

  it('[unit] enqueuePersisted carries cc onto the queued job beside its attachments', async () => {
    const log = store()
    const queued = queue()
    const mailer = createSenderBoundQueuedMailer(
      { resolveSenderIdentity: vi.fn(async () => identity) },
      createQueuedMailer(log, queued),
      'ses',
    )
    const document = {
      key: 'invoices/1315/invoice-1315.pdf',
      filename: 'invoice-1315.pdf',
      contentType: 'application/pdf',
    }
    await mailer.enqueuePersisted!(
      701,
      {
        senderIdentityId: 44,
        senderIdentityVersion: 3,
        senderEvidenceVersion: 5,
        from: { email: 'billing@example.test', name: 'Billing' },
      },
      {
        to: [{ email: 'payables@example.test', name: 'Accounts Payable' }],
        cc: copied,
        template: 'invoice:1',
        subject: 'Invoice INV-1315',
        text: 'Invoice total $12.34',
        related: { type: 'invoice_message', id: 100 },
      },
      [document],
    )
    expect(log.createQueued).not.toHaveBeenCalled()
    expect(queued.jobs).toEqual([
      {
        schemaVersion: 1,
        deliveryId: 701,
        message: {
          from: { email: 'billing@example.test', name: 'Billing' },
          to: [{ email: 'payables@example.test', name: 'Accounts Payable' }],
          cc: normalizedCopies,
          template: 'invoice:1',
          subject: 'Invoice INV-1315',
          text: 'Invoice total $12.34',
          related: { type: 'invoice_message', id: 100 },
        },
        attachments: [document],
      },
    ])
  })

  it('[unit] hands cc from the queued job to the provider', async () => {
    const sent: EmailMessage[] = []
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async (delivered: EmailMessage) => {
        sent.push(delivered)
        return { messageId: 'provider-7' }
      }),
    }
    await expect(
      processQueuedEmail({ ...job, message: { ...message, cc: copied } }, 1, store(), provider),
    ).resolves.toEqual({ action: 'ack' })
    expect(sent.map((delivered) => delivered.cc)).toEqual([normalizedCopies])
  })

  it('[security] refuses a queued job whose cc repeats a to address before any attempt', async () => {
    // A job is checked on the way off the queue as well as on the way on, so
    // one that names the payer twice never reaches a provider.
    const log = store()
    const provider: HttpEmailProvider = {
      name: 'test-http',
      send: vi.fn(async () => ({ messageId: 'must-not-send' })),
    }
    await expect(
      processQueuedEmail(
        { ...job, message: { ...message, cc: [{ email: 'owner@EXAMPLE.test' }] } },
        1,
        log,
        provider,
      ),
    ).rejects.toThrow('cc must not repeat a recipient already in to')
    expect(log.claimAttempt).not.toHaveBeenCalled()
    expect(provider.send).not.toHaveBeenCalled()
  })
})

/**
 * The public demo's mail (#931): delivered, but only to the domains its
 * deployment lists. What has to hold is that nobody else is ever on what goes
 * to the queue, and that a message with nobody left goes nowhere.
 */
describe('recipient allowlist', () => {
  const allowed = new Set(['allowed.example'])
  const mixed: EmailMessage = {
    ...message,
    to: [{ email: 'payer@client.example' }, { email: 'Owner@Allowed.Example', name: 'Owner' }],
    cc: [{ email: 'finance@client.example' }, { email: 'ops@allowed.example' }],
  }

  it('[security] keeps only the allowed recipients, matching the domain whole and in any case', () => {
    expect(restrictRecipients(mixed, allowed)).toEqual({
      ...mixed,
      to: [{ email: 'Owner@Allowed.Example', name: 'Owner' }],
      cc: [{ email: 'ops@allowed.example' }],
    })
    // A subdomain, or a domain that merely ends the same way, is another domain.
    expect(
      restrictRecipients(
        { ...message, to: [{ email: 'a@mail.allowed.example' }, { email: 'b@notallowed.example' }] },
        allowed,
      ),
    ).toBeNull()
  })

  it('[unit] addresses the copies when nobody in To may be emailed, and drops an empty Cc', () => {
    expect(
      restrictRecipients(
        { ...message, to: [{ email: 'payer@client.example' }], cc: [{ email: 'ops@allowed.example' }] },
        allowed,
      ),
    ).toEqual({ ...message, to: [{ email: 'ops@allowed.example' }] })
    const onlyTo = restrictRecipients(
      { ...message, to: [{ email: 'ops@allowed.example' }], cc: [{ email: 'payer@client.example' }] },
      allowed,
    )
    expect(onlyTo).not.toHaveProperty('cc')
  })

  it('[security] queues the allowed recipients alone, and refuses a message with none', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const mailer = createQueuedMailer(
      log,
      createRecipientAllowlistQueue(queue, log, ['ALLOWED.example ']),
    )

    await mailer.enqueue(mixed)
    expect(queue.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          to: [{ email: 'owner@allowed.example', name: 'Owner' }],
          cc: [{ email: 'ops@allowed.example' }],
        }),
      }),
    )
    // The log keeps what was asked; only the queue is narrowed.
    expect(log.createQueued).toHaveBeenCalledWith(
      expect.objectContaining({ to: expect.arrayContaining([{ email: 'payer@client.example' }]) }),
    )

    queue.send.mockClear()
    const refused = await mailer.enqueue({ ...message, to: [{ email: 'payer@client.example' }] })
    expect(queue.send).not.toHaveBeenCalled()
    expect(log.markRefused).toHaveBeenCalledWith(refused.id, RECIPIENT_NOT_ALLOWED)
    expect(log.markQueueFailed).not.toHaveBeenCalled()
  })

  it('[security] with no domain listed, sends nothing to anyone', async () => {
    const log = store()
    const queue = { send: vi.fn(async () => undefined) }
    const mailer = createQueuedMailer(log, createRecipientAllowlistQueue(queue, log, []))
    await mailer.enqueue(mixed)
    await mailer.enqueueExisting!(700, mixed)
    expect(queue.send).not.toHaveBeenCalled()
    expect(log.markRefused).toHaveBeenCalledTimes(2)
    expect(log.markRefused).toHaveBeenLastCalledWith(700, RECIPIENT_NOT_ALLOWED)
  })
})
