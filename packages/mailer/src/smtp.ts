import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js'
import type {
  EmailMessage,
  EmailProviderReceipt,
  EmailRecipient,
  HttpEmailProvider,
} from './index.js'
import { EmailProviderTerminalError } from './provider-errors.js'

export interface SmtpMailerConfig {
  url: string
  from: string
}

export interface SmtpMailerOptions {
  createTransport?: typeof nodemailer.createTransport
  monotonicNow?: () => number
}

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

const hasAsciiControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 31 || code === 127
  })

const smtpUrl = (value: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    hasAsciiControl(value)
  ) {
    throw new RangeError('SMTP URL is invalid')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RangeError('SMTP URL is invalid')
  }
  if (
    (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') ||
    url.hostname.length === 0 ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.hash !== ''
  ) {
    throw new RangeError('SMTP URL must be an smtp:// or smtps:// endpoint')
  }
  return value
}

const sender = (value: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 320 ||
    value.trim() !== value ||
    hasAsciiControl(value)
  ) {
    throw new RangeError('SMTP from address is invalid')
  }
  const angle = /^[^<>]*<([^<>]+)>$/u.exec(value)
  if (!emailPattern.test((angle?.[1] ?? value).trim())) {
    throw new RangeError('SMTP from address is invalid')
  }
  return value
}

const recipient = ({ email, name }: EmailRecipient) =>
  name === undefined ? email : { address: email, name }

const safeLatency = (started: number, completed: number): number => {
  const latency = Math.round(completed - started)
  if (!Number.isSafeInteger(latency) || latency < 0 || latency > 3_000_000) {
    throw new RangeError('SMTP monotonic clock returned an invalid latency')
  }
  return latency
}

type SmtpError = Error & { code?: unknown; responseCode?: unknown }

const terminalReason = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null
  const smtp = error as SmtpError
  if (
    typeof smtp.responseCode === 'number' &&
    Number.isInteger(smtp.responseCode) &&
    smtp.responseCode >= 500 &&
    smtp.responseCode <= 599
  ) {
    return `smtp_rejected:SMTP_${smtp.responseCode}`
  }
  if (typeof smtp.code === 'string' && /^(?:EAUTH|ENOAUTH|EENVELOPE)$/u.test(smtp.code)) {
    return `smtp_rejected:${smtp.code}`
  }
  return null
}

const messageId = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    hasAsciiControl(value)
  ) {
    throw new Error('SMTP server returned an invalid message id')
  }
  return value
}

/** Container-only SMTP adapter. Provider I/O remains behind the runtime-neutral seam. */
export class SmtpMailer implements HttpEmailProvider {
  readonly name = 'smtp'
  readonly from: string

  private readonly url: string
  private readonly createTransport: typeof nodemailer.createTransport
  private readonly monotonicNow: () => number

  constructor(config: SmtpMailerConfig, options: SmtpMailerOptions = {}) {
    this.url = smtpUrl(config.url)
    this.from = sender(config.from)
    this.createTransport = options.createTransport ?? nodemailer.createTransport
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
  }

  private transport() {
    return this.createTransport({
      url: this.url,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  }

  /** Connects and authenticates without sending, so a bad endpoint blocks startup. */
  async verify(): Promise<void> {
    const transport = this.transport()
    try {
      await transport.verify()
    } finally {
      transport.close()
    }
  }

  async send(
    message: EmailMessage,
    options: { signal: AbortSignal; idempotencyKey: string },
  ): Promise<EmailProviderReceipt> {
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(options.idempotencyKey)) {
      throw new RangeError('SMTP idempotency key is invalid')
    }
    if (options.signal.aborted) {
      throw new DOMException('SMTP delivery aborted', 'AbortError')
    }

    const transport = this.transport()
    const abort = () => transport.close()
    options.signal.addEventListener('abort', abort, { once: true })
    const started = this.monotonicNow()
    let info: SMTPTransport.SentMessageInfo
    try {
      info = await transport.sendMail({
        from: recipient(message.from),
        to: message.to.map(recipient),
        ...(message.replyTo === undefined
          ? {}
          : { replyTo: message.replyTo.map(recipient) }),
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        messageId: `<${options.idempotencyKey}@ezacto.invalid>`,
        headers: { 'X-Ezacto-Idempotency-Key': options.idempotencyKey },
        disableFileAccess: true,
        disableUrlAccess: true,
      })
    } catch (error) {
      if (options.signal.aborted) {
        throw new DOMException('SMTP delivery aborted', 'AbortError')
      }
      const reason = terminalReason(error)
      if (reason !== null) throw new EmailProviderTerminalError(reason)
      throw error
    } finally {
      options.signal.removeEventListener('abort', abort)
      transport.close()
    }

    if (
      !Array.isArray(info.accepted) ||
      info.accepted.length !== message.to.length ||
      (Array.isArray(info.rejected) && info.rejected.length > 0) ||
      (Array.isArray(info.pending) && info.pending.length > 0)
    ) {
      throw new EmailProviderTerminalError('smtp_rejected:PARTIAL')
    }
    return {
      messageId: messageId(info.messageId),
      latencyMs: safeLatency(started, this.monotonicNow()),
    }
  }
}
