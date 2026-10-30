import { processFeedbackEvent, type EmailLogStore } from './index.js'

/**
 * Mailgun's signed event webhook (ezacto-pvt #42, slice B).
 *
 * The signature is the whole authorisation, and it is weaker than it looks: it
 * is HMAC-SHA256 over `timestamp + token`, not over the body. So three things
 * stand in for body integrity. The timestamp must be recent, the token may be
 * spent once (the ledger's unique column), and an event is never trusted about
 * a message we did not send: it is matched on Mailgun's message id, and only a
 * recipient the message was addressed to is acted on.
 */

/** How far a signature's timestamp may be from our clock, either way. */
export const MAILGUN_SIGNATURE_WINDOW_SECONDS = 900

const MAX_PAYLOAD_CHARACTERS = 262_144

/** How an event was disposed of, written to the ledger. */
export type EmailFeedbackOutcome = 'bounced' | 'complained' | 'delivered' | 'ignored'

export type EmailFeedbackClaim = 'fresh' | 'resume' | 'duplicate' | 'token_reused'

export interface EmailFeedbackClaimInput {
  eventId: string
  signatureToken: string
  eventType: string
  severity: string | null
  recipient: string | null
  providerMessageId: string | null
  deliveryId: number | null
  now: string
}

/** The event ledger. Implemented over `email_feedback_events` in @ezacto/db. */
export interface EmailFeedbackLedger {
  /**
   * Records the event. `fresh` for the first caller; `resume` where the event
   * was accepted before but never finished (a crash between the two), so the
   * retry completes it; `duplicate` where it was finished; `token_reused` where
   * the signature token belongs to a different event.
   */
  claim(input: EmailFeedbackClaimInput): Promise<EmailFeedbackClaim>
  finish(
    eventId: string,
    now: string,
    outcome: EmailFeedbackOutcome,
    detail: string | null,
  ): Promise<void>
  /** Whether a send to this provider holds a live lease, so its message id is not yet recorded. */
  attemptInFlight(provider: string, now: string): Promise<boolean>
}

export type MailgunFeedbackResult =
  | { kind: 'applied'; outcome: EmailFeedbackOutcome }
  | { kind: 'duplicate' }
  | { kind: 'unverified' }
  | { kind: 'stale' }
  | { kind: 'replayed' }
  /** Verified, but not something that can ever be processed. Not worth a retry. */
  | { kind: 'malformed' }
  /** The message may be mid-send. Mailgun retries a 503, so nothing is recorded. */
  | { kind: 'retry' }

export interface MailgunFeedbackService {
  receive(payload: string): Promise<MailgunFeedbackResult>
}

export interface MailgunFeedbackOptions {
  signingKey: string
  log: EmailLogStore
  ledger: EmailFeedbackLedger
  now?: () => Date
}

const encoder = new TextEncoder()

const hexBytes = (value: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^(?:[0-9a-f]{2})+$/iu.test(value)) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const text = (value: unknown, maximum: number): string | null =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
    ? value.trim()
    : null

const bareMessageId = (value: string): string => value.replace(/^<|>$/gu, '')

export const createMailgunFeedbackService = (
  options: MailgunFeedbackOptions,
): MailgunFeedbackService => {
  if (options.signingKey.trim().length === 0) {
    throw new TypeError('Mailgun webhook signing key must not be empty')
  }
  const now = options.now ?? (() => new Date())
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(options.signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  return {
    async receive(payload) {
      if (payload.length > MAX_PAYLOAD_CHARACTERS) return { kind: 'malformed' }
      let body: Record<string, unknown> | null
      try {
        body = asObject(JSON.parse(payload))
      } catch {
        // Unparseable and unsigned are the same thing to a caller: no signature
        // was presented that could be checked.
        return { kind: 'unverified' }
      }
      const signature = asObject(body?.['signature'])
      const timestamp = text(signature?.['timestamp'], 32)
      const token = text(signature?.['token'], 255)
      const presented = text(signature?.['signature'], 128)
      const presentedBytes = presented === null ? null : hexBytes(presented)
      if (timestamp === null || token === null || presentedBytes === null) {
        return { kind: 'unverified' }
      }
      // verify() compares in constant time, which a string comparison of two
      // hex values does not.
      const genuine = await crypto.subtle.verify(
        'HMAC',
        await keyPromise,
        presentedBytes,
        encoder.encode(timestamp + token),
      )
      if (!genuine) return { kind: 'unverified' }

      const seconds = /^[0-9]{1,12}$/u.test(timestamp) ? Number(timestamp) : Number.NaN
      const current = now()
      if (
        !Number.isFinite(seconds) ||
        Math.abs(current.getTime() / 1000 - seconds) > MAILGUN_SIGNATURE_WINDOW_SECONDS
      ) {
        return { kind: 'stale' }
      }

      const data = asObject(body?.['event-data'])
      const eventId = text(data?.['id'], 255)
      const eventType = text(data?.['event'], 64)
      if (data === null || eventId === null || eventType === null) return { kind: 'malformed' }
      const severity = text(data['severity'], 32)
      const recipient = text(data['recipient'], 320)?.toLowerCase() ?? null
      const headers = asObject(asObject(data['message'])?.['headers'])
      const rawMessageId = text(headers?.['message-id'], 512)
      const providerMessageId = rawMessageId === null ? null : bareMessageId(rawMessageId)

      // Failed is only a bounce when permanent: Mailgun keeps retrying a
      // temporary failure, and one that later succeeds is not a bad address.
      const wanted: EmailFeedbackOutcome | null =
        eventType === 'failed' && severity === 'permanent'
          ? 'bounced'
          : eventType === 'complained'
            ? 'complained'
            : eventType === 'delivered'
              ? 'delivered'
              : null

      const at = current.toISOString()
      const record =
        wanted === null || providerMessageId === null
          ? null
          : await options.log.getByProviderMessageId(providerMessageId)
      if (
        wanted !== null &&
        providerMessageId !== null &&
        record === null &&
        (await options.ledger.attemptInFlight('mailgun', at))
      ) {
        // The send this event is about may not have written its message id
        // yet. Answering now would drop an event that a retry would land.
        return { kind: 'retry' }
      }

      const claim = await options.ledger.claim({
        eventId,
        signatureToken: token,
        eventType,
        severity,
        recipient,
        providerMessageId,
        deliveryId: record?.id ?? null,
        now: at,
      })
      if (claim === 'token_reused') return { kind: 'replayed' }
      if (claim === 'duplicate') return { kind: 'duplicate' }

      const finish = async (
        outcome: EmailFeedbackOutcome,
        detail: string | null,
      ): Promise<MailgunFeedbackResult> => {
        await options.ledger.finish(eventId, at, outcome, detail)
        return { kind: 'applied', outcome }
      }
      if (wanted === null) return finish('ignored', `event ${eventType} is not acted on`)
      if (record === null) return finish('ignored', 'no message of ours has this id')
      const addressed = [...record.to, ...record.cc].some(
        (person) => person.email.toLowerCase() === recipient?.toLowerCase(),
      )
      if (!addressed) return finish('ignored', 'recipient was not addressed on the message')
      if (wanted === 'delivered') return finish('delivered', null)

      if (record.status !== wanted && record.status !== 'sent') {
        return finish('ignored', `message is already ${record.status}`)
      }
      if (record.status === 'sent') {
        try {
          await processFeedbackEvent(
            {
              type: wanted === 'bounced' ? 'bounce' : 'complaint',
              providerMessageId: record.providerMessageId ?? providerMessageId!,
            },
            options.log,
          )
        } catch (error) {
          // A concurrent delivery of the same event may have moved the message
          // between our read and our write. If it now has the status we wanted,
          // the work is done.
          const latest = await options.log.getByProviderMessageId(providerMessageId!)
          if (latest?.status !== wanted) throw error
        }
      }
      return finish(wanted, text(data['reason'], 255))
    },
  }
}
