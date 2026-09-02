import {
  senderIdentityEligibilityFailure,
  senderIdentityUnavailableMessage,
  type ResolvedSenderIdentity,
  type SenderIdentityUnavailableCode,
  type SenderIdentityVerificationStatus,
} from '@ezacto/core'
import { EmailProviderTerminalError } from './provider-errors.js'

export { EmailProviderTerminalError } from './provider-errors.js'
export { senderIdentityEligibilityFailure }
export type {
  ResolvedSenderIdentity,
  SenderIdentityUnavailableCode,
  SenderIdentityVerificationStatus,
}
export {
  SesMailer,
  type SesAccountHealth,
  type SesIdentityHealth,
  type SesIdentitySummary,
  type SesMailerConfig,
  type SesMailerOptions,
  type SesSuppression,
} from './ses.js'

export type EmailDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'bounced'
  | 'complained'
  | 'failed'

export interface EmailRecipient {
  email: string
  name?: string
}

export interface EmailSender {
  email: string
  name?: string
}

/** Provider input is an HTTP message document, not an SMTP transport envelope. */
export interface EmailMessage {
  from: EmailSender
  replyTo?: readonly EmailRecipient[]
  to: readonly EmailRecipient[]
  template: string
  subject: string
  text: string
  html?: string
  related?: { type: string; id: number }
}

export interface EmailLogRecord {
  id: number
  from: EmailSender | null
  replyTo: EmailRecipient[]
  to: EmailRecipient[]
  template: string
  subject: string
  provider: string | null
  providerMessageId: string | null
  status: EmailDeliveryStatus
  relatedType: string | null
  relatedId: number | null
  attemptCount: number
  failureCode: EmailFailureCode | null
  failureReason: string | null
  providerRequestId: string | null
  providerLatencyMs: number | null
  createdAt: string
  updatedAt: string
}

export type EmailFailureCode =
  | 'queue_unavailable'
  | 'provider_timeout'
  | 'provider_rejected'

export interface EmailLogStore {
  createQueued(message: EmailMessage): Promise<EmailLogRecord>
  get(deliveryId: number): Promise<EmailLogRecord | null>
  claimAttempt(
    deliveryId: number,
    provider: string,
    attemptId: string,
    leaseSeconds: number,
  ): Promise<number | null>
  releaseAttempt(
    deliveryId: number,
    provider: string,
    attemptId: string,
  ): Promise<boolean>
  markSent(
    deliveryId: number,
    provider: string,
    receipt: EmailProviderReceipt,
    attemptId: string,
  ): Promise<EmailLogRecord>
  markProviderFailed(
    deliveryId: number,
    provider: string,
    failureCode: Exclude<EmailFailureCode, 'queue_unavailable'>,
    attemptId: string,
    failureReason?: string,
  ): Promise<EmailLogRecord>
  markQueueFailed(deliveryId: number): Promise<EmailLogRecord>
  list(input?: {
    status?: EmailDeliveryStatus
    limit?: number
  }): Promise<EmailLogRecord[]>
}

export interface QueuedEmailJob {
  schemaVersion: 1
  deliveryId: number
  message: EmailMessage
}

/** Durable runtime queue producer. It never invokes an email provider inline. */
export interface EmailQueue {
  send(job: QueuedEmailJob): Promise<void>
}

/**
 * Providers implement their HTTP API behind this port. SMTP hosts, ports,
 * credentials, TLS modes, and transport envelopes do not enter the seam.
 */
export interface HttpEmailProvider {
  readonly name: string
  send(
    message: EmailMessage,
    options: { signal: AbortSignal; idempotencyKey: string },
  ): Promise<EmailProviderReceipt>
}

export interface EmailProviderReceipt {
  messageId: string
  requestId?: string
  latencyMs?: number
}

export interface QueuedMailer {
  enqueue(message: EmailMessage): Promise<EmailLogRecord>
}

export class EmailQueueUnavailableError extends Error {
  constructor() {
    super('email queue is unavailable')
    this.name = 'EmailQueueUnavailableError'
  }
}

export const EMAIL_RETRY_POLICY = {
  maxAttempts: 5,
  delaySeconds: [60, 300, 900, 3_600] as const,
  providerTimeoutMs: 10_000,
  attemptLeaseSeconds: 30,
  claimedRetryDelaySeconds: 5,
} as const

const text = (value: string, field: string, maximum: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || [...normalized].length > maximum) {
    throw new RangeError(`${field} must contain between 1 and ${maximum} characters`)
  }
  return normalized
}

const headerText = (value: string, field: string, maximum: number): string => {
  const normalized = text(value, field, maximum)
  if (/\p{Cc}/u.test(normalized)) {
    throw new RangeError(`${field} must not contain control characters`)
  }
  return normalized
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const mailbox = (
  value: EmailRecipient | EmailSender,
  label: string,
): EmailRecipient => {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`${label} must be a mailbox`)
  }
  const email = headerText(value.email, `${label} email`, 254).toLowerCase()
  if (!emailPattern.test(email)) throw new RangeError(`${label} email is invalid`)
  return value.name === undefined
    ? { email }
    : { email, name: headerText(value.name, `${label} name`, 200) }
}

const copyMessage = (message: EmailMessage): EmailMessage => {
  if (!Array.isArray(message.to) || message.to.length < 1 || message.to.length > 100) {
    throw new RangeError('to must contain between 1 and 100 recipients')
  }
  const from = mailbox(message.from, 'from')
  const recipients = message.to.map((recipient) => mailbox(recipient, 'recipient'))
  const replyTo =
    message.replyTo === undefined
      ? undefined
      : message.replyTo.map((recipient) => mailbox(recipient, 'reply-to'))
  if (replyTo !== undefined && (replyTo.length < 1 || replyTo.length > 10)) {
    throw new RangeError('replyTo must contain between 1 and 10 recipients')
  }
  const related = message.related
  if (
    related !== undefined &&
    (!Number.isSafeInteger(related.id) || related.id < 1)
  ) {
    throw new RangeError('related id must be a positive safe integer')
  }
  return {
    from,
    ...(replyTo === undefined ? {} : { replyTo }),
    to: recipients,
    template: headerText(message.template, 'template', 128),
    subject: headerText(message.subject, 'subject', 998),
    text: text(message.text, 'text', 1_000_000),
    ...(message.html === undefined
      ? {}
      : { html: text(message.html, 'html', 2_000_000) }),
    ...(related === undefined
      ? {}
      : { related: { type: headerText(related.type, 'related type', 128), id: related.id } }),
  }
}

export const createQueuedMailer = (
  log: EmailLogStore,
  queue: EmailQueue,
): QueuedMailer => ({
  async enqueue(message) {
    const safeMessage = copyMessage(message)
    const delivery = await log.createQueued(safeMessage)
    try {
      await queue.send({
        schemaVersion: 1,
        deliveryId: delivery.id,
        message: safeMessage,
      })
    } catch {
      await log.markQueueFailed(delivery.id)
      throw new EmailQueueUnavailableError()
    }
    return delivery
  },
})

export interface SenderIdentityResolver {
  resolveSenderIdentity(id?: number): Promise<ResolvedSenderIdentity | null>
}

export class SenderIdentityUnavailableError extends Error {
  constructor(
    readonly code: SenderIdentityUnavailableCode,
    readonly senderIdentityId: number | null,
  ) {
    super(senderIdentityUnavailableMessage(code))
    this.name = 'SenderIdentityUnavailableError'
  }
}

export interface SenderBoundQueuedMailer {
  assertAvailable(senderIdentityId?: number): Promise<void>
  enqueue(
    message: Omit<EmailMessage, 'from' | 'replyTo'> & {
      senderIdentityId?: number
    },
  ): Promise<EmailLogRecord>
}

export const configuredEmailSender = (value: string): EmailSender => {
  if (typeof value !== 'string') throw new TypeError('configured sender must be a string')
  const normalized = value.normalize('NFC').trim()
  const angle = /^(.*?)<([^<>]+)>$/u.exec(normalized)
  if (angle === null) return mailbox({ email: normalized }, 'configured sender')
  const name = angle[1]!.trim()
  return mailbox(
    {
      email: angle[2]!.trim(),
      ...(name === '' ? {} : { name }),
    },
    'configured sender',
  )
}

/**
 * Deployment-brand mail uses the operator's validated provider From value.
 * Organization invoice mail must use createSenderBoundQueuedMailer and its
 * provider evidence checks instead.
 */
export const createDeploymentSenderQueuedMailer = (
  from: string,
  queued: QueuedMailer,
): SenderBoundQueuedMailer => {
  const sender = configuredEmailSender(from)
  return {
    async assertAvailable(senderIdentityId) {
      if (senderIdentityId !== undefined) {
        throw new SenderIdentityUnavailableError(
          'sender_identity_missing',
          senderIdentityId,
        )
      }
    },
    enqueue(message) {
      if (message.senderIdentityId !== undefined) {
        throw new SenderIdentityUnavailableError(
          'sender_identity_missing',
          message.senderIdentityId,
        )
      }
      return queued.enqueue({
        from: sender,
        to: message.to,
        template: message.template,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.related === undefined ? {} : { related: message.related }),
      })
    },
  }
}

const assertSenderEvidence = (identity: ResolvedSenderIdentity): void => {
  const failure = senderIdentityEligibilityFailure(identity)
  if (failure !== null) {
    throw new SenderIdentityUnavailableError(failure, identity.id)
  }
}

/** Resolves authoritative sender evidence before the durable log or queue is touched. */
export const createSenderBoundQueuedMailer = (
  identities: SenderIdentityResolver,
  queued: QueuedMailer,
  expectedProvider?: string,
  configuredFrom?: string,
): SenderBoundQueuedMailer => {
  if (expectedProvider === 'smtp' && configuredFrom === undefined) {
    throw new TypeError('SMTP organization mail requires a deployment configured From address')
  }
  const deploymentSender =
    configuredFrom === undefined ? null : configuredEmailSender(configuredFrom)
  const resolveAvailable = async (
    senderIdentityId?: number,
  ): Promise<ResolvedSenderIdentity> => {
    const identity = await identities.resolveSenderIdentity(senderIdentityId)
    if (identity === null) {
      throw new SenderIdentityUnavailableError(
        'sender_identity_missing',
        senderIdentityId ?? null,
      )
    }
    if (expectedProvider !== undefined && identity.provider !== expectedProvider) {
      throw new SenderIdentityUnavailableError(
        'sender_provider_mismatch',
        identity.id,
      )
    }
    assertSenderEvidence(identity)
    if (
      deploymentSender !== null &&
      identity.email.normalize('NFC').trim().toLowerCase() !== deploymentSender.email
    ) {
      throw new SenderIdentityUnavailableError(
        'sender_identity_binding_mismatch',
        identity.id,
      )
    }
    if (senderIdentityId === undefined && !identity.isDefault) {
      throw new SenderIdentityUnavailableError(
        'sender_identity_not_default',
        identity.id,
      )
    }
    return identity
  }
  return {
    async assertAvailable(senderIdentityId) {
      await resolveAvailable(senderIdentityId)
    },
    async enqueue(message) {
      const identity = await resolveAvailable(message.senderIdentityId)
      return queued.enqueue({
        from: { email: identity.email, name: identity.displayName },
        ...(identity.replyToEmail === null
          ? {}
          : { replyTo: [{ email: identity.replyToEmail }] }),
        to: message.to,
        template: message.template,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(message.related === undefined ? {} : { related: message.related }),
      })
    },
  }
}

export type EmailQueueDisposition =
  | { action: 'ack' }
  | { action: 'retry'; delaySeconds: number }

const providerCall = async (
  provider: HttpEmailProvider,
  message: EmailMessage,
  deliveryId: number,
  timeoutMs: number,
): Promise<EmailProviderReceipt> => {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new DOMException('email provider timed out', 'TimeoutError'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      provider.send(message, {
        signal: controller.signal,
        idempotencyKey: `ezacto-email-${deliveryId}`,
      }),
      timedOut,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const failureCode = (
  error: unknown,
): Exclude<EmailFailureCode, 'queue_unavailable'> =>
  error instanceof DOMException && error.name === 'TimeoutError'
    ? 'provider_timeout'
    : 'provider_rejected'

const safeFailureReason = (error: unknown): string | undefined =>
  error instanceof EmailProviderTerminalError ? error.reason : undefined

const safeReceipt = (receipt: EmailProviderReceipt): EmailProviderReceipt => {
  const messageId = text(receipt.messageId, 'provider message id', 512)
  const requestId =
    receipt.requestId === undefined
      ? undefined
      : text(receipt.requestId, 'provider request id', 512)
  const latencyMs = receipt.latencyMs
  if (
    latencyMs !== undefined &&
    (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > 3_000_000)
  ) {
    throw new RangeError(
      'provider latency must be between 0 and 3000000 milliseconds',
    )
  }
  return {
    messageId,
    ...(requestId === undefined ? {} : { requestId }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
  }
}

export const processQueuedEmail = async (
  job: QueuedEmailJob,
  queueAttempt: number,
  log: EmailLogStore,
  provider: HttpEmailProvider,
  options: {
    providerTimeoutMs?: number
    attemptLeaseSeconds?: number
    createAttemptId?: () => string
  } = {},
): Promise<EmailQueueDisposition> => {
  if (
    job.schemaVersion !== 1 ||
    !Number.isSafeInteger(job.deliveryId) ||
    job.deliveryId < 1
  ) {
    throw new TypeError('queued email job is invalid')
  }
  if (!Number.isSafeInteger(queueAttempt) || queueAttempt < 1) {
    throw new RangeError('queue attempt must be a positive safe integer')
  }
  const message = copyMessage(job.message)
  const providerTimeoutMs =
    options.providerTimeoutMs ?? EMAIL_RETRY_POLICY.providerTimeoutMs
  const attemptLeaseSeconds =
    options.attemptLeaseSeconds ?? EMAIL_RETRY_POLICY.attemptLeaseSeconds
  if (
    !Number.isSafeInteger(providerTimeoutMs) ||
    providerTimeoutMs < 1 ||
    providerTimeoutMs > 3_000_000
  ) {
    throw new RangeError('email provider timeout must be between 1 and 3000000 milliseconds')
  }
  if (
    !Number.isSafeInteger(attemptLeaseSeconds) ||
    attemptLeaseSeconds < 1 ||
    attemptLeaseSeconds > 3_600 ||
    attemptLeaseSeconds * 1_000 <= providerTimeoutMs
  ) {
    throw new RangeError(
      'email delivery attempt lease must exceed the provider timeout and be at most 3600 seconds',
    )
  }
  const attemptId = text(
    options.createAttemptId?.() ?? crypto.randomUUID(),
    'email delivery attempt id',
    128,
  )
  // The queue's delivery counter includes lease contention and persistence
  // redeliveries. Only the atomically persisted provider-attempt count may
  // consume the provider retry budget or select its backoff interval.
  const providerAttempt = await log.claimAttempt(
    job.deliveryId,
    provider.name,
    attemptId,
    attemptLeaseSeconds,
  )
  if (providerAttempt === null) {
    const current = await log.get(job.deliveryId)
    if (current === null) throw new Error('queued email log does not exist')
    return current.status === 'queued'
      ? {
          action: 'retry',
          delaySeconds: EMAIL_RETRY_POLICY.claimedRetryDelaySeconds,
        }
      : { action: 'ack' }
  }
  if (providerAttempt > EMAIL_RETRY_POLICY.maxAttempts) {
    throw new Error('email delivery provider attempt budget is exhausted')
  }

  let delivered: EmailProviderReceipt
  try {
    delivered = await providerCall(
      provider,
      message,
      job.deliveryId,
      providerTimeoutMs,
    )
  } catch (error) {
    const terminalReason = safeFailureReason(error)
    if (
      terminalReason === undefined &&
      providerAttempt < EMAIL_RETRY_POLICY.maxAttempts
    ) {
      if (!(await log.releaseAttempt(job.deliveryId, provider.name, attemptId))) {
        throw new Error('email delivery attempt ownership was lost before retry', {
          cause: error,
        })
      }
      return {
        action: 'retry',
        delaySeconds: EMAIL_RETRY_POLICY.delaySeconds[providerAttempt - 1]!,
      }
    }
    await log.markProviderFailed(
      job.deliveryId,
      provider.name,
      failureCode(error),
      attemptId,
      terminalReason,
    )
    return { action: 'ack' }
  }

  // A provider success and the durable receipt are different failure domains.
  // Persistence errors escape to the queue; they must never be relabelled as a
  // provider rejection or overwrite another attempt's terminal outcome.
  await log.markSent(
    job.deliveryId,
    provider.name,
    safeReceipt(delivered),
    attemptId,
  )
  return { action: 'ack' }
}

export type InProcessEmailConsumer = (
  job: QueuedEmailJob,
  attempt: number,
) => Promise<EmailQueueDisposition>

export type InProcessEmailScheduler = (
  task: () => Promise<void>,
  delaySeconds: number,
) => void

const defaultScheduler: InProcessEmailScheduler = (task, delaySeconds) => {
  if (delaySeconds === 0) {
    queueMicrotask(() => void task())
    return
  }
  setTimeout(() => void task(), delaySeconds * 1_000)
}

/** Container adapter: enqueue returns after scheduling, never after provider I/O. */
export class InProcessEmailQueue implements EmailQueue {
  constructor(
    private readonly consume: InProcessEmailConsumer,
    private readonly schedule: InProcessEmailScheduler = defaultScheduler,
  ) {}

  async send(job: QueuedEmailJob): Promise<void> {
    const run = async (attempt: number): Promise<void> => {
      let disposition: EmailQueueDisposition
      try {
        disposition = await this.consume(job, attempt)
      } catch {
        if (attempt >= EMAIL_RETRY_POLICY.maxAttempts) return
        this.schedule(
          async () => run(attempt + 1),
          EMAIL_RETRY_POLICY.delaySeconds[attempt - 1]!,
        )
        return
      }
      if (disposition.action === 'retry') {
        this.schedule(async () => run(attempt + 1), disposition.delaySeconds)
      }
    }
    this.schedule(async () => run(1), 0)
  }
}
