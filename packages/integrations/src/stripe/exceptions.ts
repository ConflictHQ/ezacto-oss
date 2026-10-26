/** Minimal verified provider reports; never carries card, payer or evidence data. */
export interface StripePaymentAlert {
  readonly id: string
  readonly eventType: string
  readonly kind: 'refund' | 'dispute'
  readonly paymentIntentId: string
  readonly objectId: string
  readonly amountCents: number
  readonly currency: string
  readonly providerStatus: string
  readonly occurredAt: string
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_]{1,255}$/.test(value)
const reference = (value: unknown): string | null =>
  id(value)
    ? value
    : value && typeof value === 'object' && id((value as { id?: unknown }).id)
      ? (value as { id: string }).id
      : null
export const readStripePaymentAlert = (payload: string): StripePaymentAlert | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const event = parsed as Record<string, unknown>
  const allowed = [
    'charge.dispute.created',
    'charge.dispute.updated',
    'charge.dispute.closed',
    'charge.dispute.funds_withdrawn',
    'charge.dispute.funds_reinstated',
  ]
  if (event.type !== 'charge.refunded' && !allowed.includes(String(event.type))) return null
  const object = (event.data as { object?: Record<string, unknown> } | undefined)?.object
  if (
    !object ||
    !id(event.id) ||
    !id(object.id) ||
    !Number.isSafeInteger(event.created) ||
    Number(event.created) <= 0
  )
    return null
  const paymentIntentId = reference(object.payment_intent)
  const kind = event.type === 'charge.refunded' ? 'refund' : 'dispute'
  const amount = kind === 'refund' ? object.amount_refunded : object.amount
  if (
    !paymentIntentId ||
    !Number.isSafeInteger(amount) ||
    Number(amount) <= 0 ||
    Number(amount) > 9_000_000_000_000 ||
    typeof object.currency !== 'string' ||
    !/^[a-zA-Z]{3}$/.test(object.currency)
  )
    return null
  if (
    kind === 'refund' &&
    (!Number.isSafeInteger(object.amount) || Number(amount) > Number(object.amount))
  )
    return null
  const status =
    kind === 'refund'
      ? object.refunded === true
        ? 'refunded'
        : 'partially_refunded'
      : object.status
  if (typeof status !== 'string' || !/^[a-z_]{1,80}$/.test(status)) return null
  const date = new Date(Number(event.created) * 1000)
  if (!Number.isFinite(date.getTime())) return null
  return {
    id: event.id,
    eventType: String(event.type),
    kind,
    paymentIntentId,
    objectId: object.id,
    amountCents: Number(amount),
    currency: object.currency.toUpperCase(),
    providerStatus: status,
    occurredAt: date.toISOString(),
  }
}
