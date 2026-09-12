/**
 * Verifying that a webhook really came from Stripe (#102).
 *
 * This is the whole of the authorisation on that endpoint. Stripe has no
 * session with us, so a delivery that is not verified is an anonymous POST that
 * would otherwise mark an invoice paid -- which is the reason to write this
 * carefully rather than reach for the first hex comparison that type-checks.
 *
 * Four things the algorithm demands, each of which is a way to get it wrong:
 *
 * 1. ONLY the `v1` scheme. Stripe sends an additional `v0` signature with test
 *    events, and it is deliberately fake. Accepting any scheme that verifies
 *    would accept `v0`, which is exactly the downgrade attack the documentation
 *    names.
 * 2. EVERY `v1` value, not the first. While an endpoint secret is being rolled
 *    the old one stays live for up to 24 hours, and Stripe signs once per
 *    secret -- taking only the first would reject half the deliveries during a
 *    rotation.
 * 3. A CONSTANT-TIME comparison, so a wrong guess cannot be narrowed by how
 *    long the refusal took.
 * 4. A TIMESTAMP tolerance, because a valid signature stays valid for ever. The
 *    timestamp is inside the signed payload, so it cannot be edited without
 *    breaking the signature -- checking it is what stops a captured delivery
 *    being replayed.
 *
 * Checked against Stripe rather than against itself. The unit tests below sign
 * with the same code path they verify, which is the flaw issue 421 names in the
 * Deel client: a fixture shaped by the same assumption as the code cannot catch
 * the assumption being wrong. So this was also run against a delivery the Stripe
 * CLI actually produced -- `stripe listen` forwarding a real
 * `checkout.session.completed` to a local capture. That delivery carried both a
 * v1 and a v0 signature, and confirmed the four properties above: the genuine
 * signature verified, a body altered by one space did not, a wrong secret did
 * not, a replay an hour later did not, and Stripe's own v0 offered alone was
 * refused outright.
 */

/** Stripe's own default, and the one their libraries use. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300

export class StripeWebhookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeWebhookError'
  }
}

export interface StripeSignatureHeader {
  timestamp: number
  /** Every `v1` signature in the header, in the order they appeared. */
  signatures: readonly string[]
}

/**
 * Splits the header on `,` and each element on `=`.
 *
 * Anything that is not `t` or `v1` is discarded rather than inspected -- that
 * is what makes `v0` unreachable rather than merely unused.
 */
export const parseStripeSignatureHeader = (header: string): StripeSignatureHeader => {
  let timestamp: number | null = null
  const signatures: string[] = []
  for (const element of header.split(',')) {
    const separator = element.indexOf('=')
    if (separator <= 0) continue
    const prefix = element.slice(0, separator).trim()
    const value = element.slice(separator + 1).trim()
    if (prefix === 't') {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed) && parsed > 0) timestamp = parsed
      continue
    }
    if (prefix === 'v1' && value !== '') signatures.push(value)
  }
  if (timestamp === null) {
    throw new StripeWebhookError('the Stripe-Signature header carries no timestamp')
  }
  if (signatures.length === 0) {
    throw new StripeWebhookError('the Stripe-Signature header carries no v1 signature')
  }
  return { timestamp, signatures }
}

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Compares without leaking where two strings first differ.
 *
 * Length is folded into the result rather than returned early: an early return
 * on length is itself a timing signal, and it is the one people leave in.
 */
const equalsConstantTime = (first: string, second: string): boolean => {
  let difference = first.length ^ second.length
  const length = Math.max(first.length, second.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (first.charCodeAt(index) || 0) ^ (second.charCodeAt(index) || 0)
  }
  return difference === 0
}

export interface StripeWebhookVerification {
  payload: string
  header: string
  secret: string
  /** Seconds since the epoch, injected so a test owns the clock. */
  nowSeconds: number
  toleranceSeconds?: number
}

/**
 * Answers whether this delivery is genuinely Stripe's.
 *
 * A blank secret throws rather than returning false. A deployment that has not
 * configured one has no way to tell a real delivery from a forged one, and
 * answering "not verified" would let that look like an ordinary rejection
 * instead of the configuration error it is.
 */
export const verifyStripeSignature = async (
  input: Readonly<StripeWebhookVerification>,
): Promise<boolean> => {
  if (input.secret.trim() === '') {
    throw new StripeWebhookError('a Stripe webhook signing secret is required')
  }
  const { timestamp, signatures } = parseStripeSignatureHeader(input.header)

  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS
  // A tolerance of zero disables the check rather than tightening it, which
  // Stripe's own documentation warns about -- so it is refused here.
  if (tolerance <= 0) {
    throw new StripeWebhookError('a Stripe signature tolerance must be greater than zero')
  }
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = hex(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${String(timestamp)}.${input.payload}`),
    ),
  )

  // Every candidate is compared, and the loop is not short-circuited on a
  // match, so the work done does not depend on which signature matched.
  let matched = false
  for (const candidate of signatures) {
    if (equalsConstantTime(candidate, expected)) matched = true
  }
  return matched
}

export interface StripeCheckoutCompletion {
  eventId: string
  eventType: string
  /** Stripe's own id for the payment, and our idempotency key. */
  paymentIntentId: string
  amountCents: number
  currency: string
  /** Our invoice id, carried through `metadata` on the payment link. */
  invoiceId: number | null
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * The one event this integration acts on, read out of a verified body.
 *
 * `checkout.session.completed` rather than `payment_intent.succeeded`, because
 * the session is what carries the metadata we set on the payment link -- and
 * without that there is nothing tying Stripe's money to our invoice.
 *
 * Returns null for every other event type. Stripe sends what the endpoint is
 * subscribed to, and an integration that threw on an event it did not want
 * would turn somebody else's dashboard change into a failed delivery.
 */
export const readCheckoutCompletion = (
  payload: string,
): StripeCheckoutCompletion | null => {
  let body: Record<string, unknown>
  try {
    body = object(JSON.parse(payload))
  } catch {
    throw new StripeWebhookError('the Stripe webhook body is not JSON')
  }
  const eventType = typeof body['type'] === 'string' ? body['type'] : ''
  if (eventType !== 'checkout.session.completed') return null

  const session = object(object(body['data'])['object'])
  // Only a session that was actually paid. `complete` with an unpaid status is
  // a session that finished without money moving.
  if (session['payment_status'] !== 'paid') return null

  const paymentIntent = session['payment_intent']
  const amount = session['amount_total']
  const currency = session['currency']
  if (
    typeof paymentIntent !== 'string' ||
    paymentIntent === '' ||
    typeof amount !== 'number' ||
    typeof currency !== 'string'
  ) {
    return null
  }

  const metadata = object(session['metadata'])
  const invoiceId = Number(metadata['ezacto_invoice_id'])

  return {
    eventId: typeof body['id'] === 'string' ? body['id'] : '',
    eventType,
    paymentIntentId: paymentIntent,
    amountCents: amount,
    currency: currency.toUpperCase(),
    invoiceId: Number.isSafeInteger(invoiceId) && invoiceId > 0 ? invoiceId : null,
  }
}
