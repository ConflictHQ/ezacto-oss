/**
 * Linear's side of the work-item contract (issue 1177, contract only).
 *
 * Pure functions and types, no network and no credential: the state mapping,
 * the webhook verification rules and the rate-limit reading that a Linear
 * adapter must follow. They are Linear's own rules and share nothing with the
 * GitHub signing scheme. The values below come from Linear's public webhook,
 * GraphQL and rate-limit documentation and must be rechecked against the
 * current docs when the real adapter is written.
 */

import type { WorkItemWebhookRequest, WorkItemWebhookVerdict } from './provider.js'

/** Linear's workflow state types. The remote state is stored whole; only the projection is lossy. */
export const LINEAR_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const
export type LinearStateType = (typeof LINEAR_STATE_TYPES)[number]

/**
 * Open until work is finished or abandoned. `completed` and `canceled` are the
 * only closed types. A type this list does not know yields null, which the
 * caller must surface as a mapping failure, never guess as open.
 */
export function linearStateToCommon(type: string): 'open' | 'closed' | null {
  switch (type) {
    case 'triage':
    case 'backlog':
    case 'unstarted':
    case 'started':
      return 'open'
    case 'completed':
    case 'canceled':
      return 'closed'
    default:
      return null
  }
}

/** A delivery older or newer than this, against the body's own timestamp, is a replay. */
export const LINEAR_WEBHOOK_TOLERANCE_MS = 60_000

export interface LinearVerifyOptions {
  readonly secret: string
  /** Epoch milliseconds, injected so the check is testable. */
  readonly now: number
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * `Linear-Signature` is the hex HMAC-SHA256 of the raw body under the webhook
 * secret. The signature is checked before the body is parsed, then the body's
 * `webhookTimestamp` (epoch ms) must be within the tolerance. `Linear-Delivery`
 * is the id the shared journal dedupes on.
 */
export async function verifyLinearWebhook(
  request: WorkItemWebhookRequest,
  options: LinearVerifyOptions,
): Promise<WorkItemWebhookVerdict> {
  const signature = request.headers['linear-signature']
  if (signature === undefined || signature === '')
    return { verified: false, reason: 'missing_signature' }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(options.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = hex(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(request.body)),
  )
  if (!equalConstantTime(expected, signature.toLowerCase())) {
    return { verified: false, reason: 'bad_signature' }
  }
  const delivery = request.headers['linear-delivery']
  if (delivery === undefined || delivery === '') return { verified: false, reason: 'malformed' }
  let stamp: unknown
  try {
    stamp = (JSON.parse(request.body) as { webhookTimestamp?: unknown }).webhookTimestamp
  } catch {
    return { verified: false, reason: 'malformed' }
  }
  if (typeof stamp !== 'number' || !Number.isFinite(stamp))
    return { verified: false, reason: 'malformed' }
  if (Math.abs(options.now - stamp) > LINEAR_WEBHOOK_TOLERANCE_MS) {
    return { verified: false, reason: 'malformed' }
  }
  return { verified: true, deliveryId: delivery }
}

/** What the adapter must do next after a Linear response. Safe to show; carries no payload. */
export type LinearBudgetDecision =
  | { readonly action: 'proceed' }
  | {
      readonly action: 'cooldown'
      readonly untilEpochMs: number
      readonly why: 'requests' | 'complexity' | 'ratelimited'
    }

export interface LinearRateLimitInput {
  readonly headers: Readonly<Record<string, string | undefined>>
  /** `extensions.code` of the first GraphQL error, if any. Linear reports limits as RATELIMITED. */
  readonly errorCode?: string
  readonly now: number
  /** Cooldown when Linear gave no reset time. */
  readonly fallbackCooldownMs?: number
}

function numberHeader(headers: LinearRateLimitInput['headers'], name: string): number | null {
  const raw = headers[name]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

/**
 * Reset headers are epoch seconds. A RATELIMITED error or an exhausted bucket
 * means stop until the reset; a missing reset falls back to a fixed cooldown.
 */
export function linearBudget(input: LinearRateLimitInput): LinearBudgetDecision {
  const fallback = input.now + (input.fallbackCooldownMs ?? 60_000)
  const buckets = [
    {
      why: 'requests',
      remaining: 'x-ratelimit-requests-remaining',
      reset: 'x-ratelimit-requests-reset',
    },
    {
      why: 'complexity',
      remaining: 'x-ratelimit-complexity-remaining',
      reset: 'x-ratelimit-complexity-reset',
    },
  ] as const
  for (const bucket of buckets) {
    const remaining = numberHeader(input.headers, bucket.remaining)
    if (remaining !== null && remaining <= 0) {
      const reset = numberHeader(input.headers, bucket.reset)
      return {
        action: 'cooldown',
        why: bucket.why,
        untilEpochMs: reset === null ? fallback : reset * 1000,
      }
    }
  }
  if (input.errorCode === 'RATELIMITED') {
    const reset = numberHeader(input.headers, 'x-ratelimit-requests-reset')
    return {
      action: 'cooldown',
      why: 'ratelimited',
      untilEpochMs: reset === null ? fallback : reset * 1000,
    }
  }
  return { action: 'proceed' }
}
