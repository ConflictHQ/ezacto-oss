/** A deliberately closed publication vocabulary; new internal events are not exposed implicitly. */
export const webhookEventTypes = [
  'invoice.created',
  'invoice.sent',
  'invoice.viewed',
  'invoice.updated',
  'invoice.drafted',
  'invoice.reopened',
  'invoice.cancelled',
  'invoice.written_off',
  'invoice.closed',
  'invoice.unpaid',
  'invoice.partially_paid',
  'invoice.paid',
  'payment.recorded',
  'payment.updated',
  'payment.deleted',
  'time_entry.created_on_behalf',
  'time_entry.updated_on_behalf',
  'time_entry.stopped_on_behalf',
  'time_entry.deleted_on_behalf',
] as const
export type WebhookEventType = (typeof webhookEventTypes)[number]
export const webhookLimits = {
  subscriptions: 25,
  events: webhookEventTypes.length,
  urlBytes: 2048,
  bodyBytes: 16384,
  signatureToleranceSeconds: 300,
  rotationOverlapSeconds: 900,
  maxRotationOverlapSeconds: 86400,
  deliveryTimeoutMs: 5000,
  deliveryLeaseSeconds: 30,
  maxAttempts: 5,
  retryDelaySeconds: [60, 300, 900, 3600] as readonly number[],
  deliveryBatch: 10,
  replayBatch: 10,
  replayWindowSeconds: 7 * 86400,
  retentionDays: 30,
} as const
export class WebhookError extends Error {
  constructor(
    readonly code: string,
    readonly field: string = 'webhook',
  ) {
    super('The webhook operation could not be completed with the supplied input or current state.')
    this.name = 'WebhookError'
  }
}
export const isWebhookEventType = (value: unknown): value is WebhookEventType =>
  typeof value === 'string' && webhookEventTypes.includes(value as WebhookEventType)
export const webhookEvents = (value: unknown): WebhookEventType[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > webhookLimits.events ||
    value.some((event) => !isWebhookEventType(event))
  )
    throw new WebhookError('invalid_webhook_events', 'events')
  return [...new Set(value as WebhookEventType[])].sort()
}

/**
 * Conservative public-unicast policy, shared with the container's DNS-pinning transport.
 * IANA registries: https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 * IPv4 embedding/translation, protocol, documentation and deprecated relay space is excluded.
 */
export const isPublicWebhookAddress = (input: string): boolean => {
  const address = input.replace(/^\[|\]$/g, '')
  if (!/^[0-9a-fA-F:.]+$/.test(address)) return false
  let normalized: string
  try {
    normalized = new URL(
      address.includes(':') ? `https://[${address}]/` : `https://${address}/`,
    ).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (!normalized.includes(':')) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false
    const [a, b, c] = normalized.split('.').map(Number) as [number, number, number, number]
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  const [left, right] = normalized.split('::')
  const first = (left ?? '').split(':').filter(Boolean),
    last = (right ?? '').split(':').filter(Boolean)
  const words =
    right === undefined
      ? first
      : [...first, ...(Array(8 - first.length - last.length).fill('0') as string[]), ...last]
  if (words.length !== 8) return false
  const a = Number.parseInt(words[0]!, 16),
    b = Number.parseInt(words[1]!, 16)
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    a !== 0x2002 &&
    !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) &&
    !(a === 0x3fff && b < 0x1000) &&
    a !== 0x3ffe
  )
}
export const webhookUrl = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).length > webhookLimits.urlBytes ||
    value !== value.trim() ||
    [...value].some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127 || char === '\\',
    )
  )
    throw new WebhookError('invalid_webhook_url', 'url')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebhookError('invalid_webhook_url', 'url')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !hostname ||
    url.port === '0'
  )
    throw new WebhookError('invalid_webhook_url', 'url')
  const literal = hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  if (
    literal
      ? !isPublicWebhookAddress(hostname)
      : !hostname.includes('.') ||
        hostname
          .split('.')
          .some(
            (label) =>
              !/^[-a-z0-9]{1,63}$/.test(label) || label.startsWith('-') || label.endsWith('-'),
          ) ||
        ['localhost', 'local', 'localdomain', 'internal', 'home.arpa'].some(
          (suffix) => hostname === suffix || hostname.endsWith('.' + suffix),
        )
  )
    throw new WebhookError('webhook_destination_forbidden', 'url')
  url.hostname = hostname
  return url.href
}

export interface WebhookSourceEvent {
  id: string
  aggregateType: string
  aggregateId: number
  aggregateSequence: number
  eventType: string
  occurredAt: string
}
/** No source payload, actor, amount, note, address or credential is serialized. */
export const webhookBody = (event: WebhookSourceEvent): string => {
  const aggregate = event.eventType.startsWith('time_entry.') ? 'time_entry' : 'invoice'
  if (
    !isWebhookEventType(event.eventType) ||
    event.aggregateType !== aggregate ||
    !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.id) ||
    !Number.isSafeInteger(event.aggregateId) ||
    event.aggregateId < 1 ||
    !Number.isSafeInteger(event.aggregateSequence) ||
    event.aggregateSequence < 0 ||
    event.occurredAt.length > 40 ||
    !Number.isFinite(Date.parse(event.occurredAt))
  )
    throw new WebhookError('invalid_webhook_event', 'event')
  return JSON.stringify({
    schema_version: 1,
    event_id: event.id,
    event_type: event.eventType,
    occurred_at: event.occurredAt,
    resource: { type: aggregate, id: event.aggregateId, sequence: event.aggregateSequence },
    links: {
      resource: `/api/v1/${aggregate === 'invoice' ? 'invoices' : 'time-entries'}/${event.aggregateId}`,
    },
  })
}

const encoder = new TextEncoder()
const message = (timestamp: string, body: Uint8Array) => {
  const prefix = encoder.encode(timestamp + '.'),
    bytes = new Uint8Array(prefix.length + body.length)
  bytes.set(prefix)
  bytes.set(body, prefix.length)
  return bytes
}
const key = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ])
const secretIsValid = (secret: string) =>
  typeof secret === 'string' && secret.length >= 32 && secret.length <= 256
export const webhookSignature = async (input: {
  timestamp: number
  body: string
  secrets: readonly string[]
}): Promise<string> => {
  const body = encoder.encode(input.body)
  if (
    !Number.isSafeInteger(input.timestamp) ||
    input.timestamp < 1 ||
    input.timestamp > 9999999999999 ||
    body.length > webhookLimits.bodyBytes ||
    input.secrets.length < 1 ||
    input.secrets.length > 2 ||
    input.secrets.some((secret) => !secretIsValid(secret))
  )
    throw new WebhookError('invalid_webhook_signature_input')
  return (
    await Promise.all(
      input.secrets.map(
        async (secret) =>
          'v1=' +
          [
            ...new Uint8Array(
              await crypto.subtle.sign(
                'HMAC',
                await key(secret, 'sign'),
                message(String(input.timestamp), body),
              ),
            ),
          ]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
      ),
    )
  ).join(',')
}
/** Verify raw request bytes before parsing JSON, and deduplicate accepted event IDs separately. */
export const verifyWebhookSignature = async (input: {
  timestamp: string
  signature: string
  body: Uint8Array
  secrets: readonly string[]
  now?: number
  toleranceSeconds?: number
}): Promise<boolean> => {
  const tolerance = input.toleranceSeconds ?? webhookLimits.signatureToleranceSeconds,
    now = input.now ?? Date.now() / 1000
  if (
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 300 ||
    !Number.isFinite(now) ||
    !/^[1-9][0-9]{0,12}$/.test(input.timestamp) ||
    Math.abs(now - Number(input.timestamp)) > tolerance ||
    input.body.length > webhookLimits.bodyBytes ||
    input.signature.length > 140 ||
    input.secrets.length < 1 ||
    input.secrets.length > 2 ||
    input.secrets.some((secret) => !secretIsValid(secret))
  )
    return false
  const signatures = input.signature.split(',').map((value) => value.trim())
  if (
    signatures.length < 1 ||
    signatures.length > 2 ||
    signatures.some((value) => !/^v1=[a-f0-9]{64}$/.test(value))
  )
    return false
  for (const secret of input.secrets)
    for (const signature of signatures) {
      const bytes = Uint8Array.from(signature.slice(3).match(/../g)!, (value) =>
        Number.parseInt(value, 16),
      )
      if (
        await crypto.subtle.verify(
          'HMAC',
          await key(secret, 'verify'),
          bytes,
          message(input.timestamp, input.body),
        )
      )
        return true
    }
  return false
}
