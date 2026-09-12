/**
 * Stripe, narrowed to one job: give an invoice a URL a client can pay at.
 *
 * Same posture as the other clients here -- the transport is injected, there is
 * no default credential and no environment lookup, and the tests never reach
 * Stripe. A stray POST on this path creates a real payment link against a real
 * account.
 *
 * There is deliberately no method that refunds, captures or cancels anything.
 * Collecting is the whole of what this is for, and a client that could move
 * money the other way is one somebody will eventually call by accident.
 */

export const STRIPE_API_BASE_URL = 'https://api.stripe.com'

export class StripeApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null, detail: string | null) {
    super(
      `Stripe request failed with status ${String(status)}${code === null ? '' : ` (${code})`}${
        detail === null ? '' : `: ${detail}`
      }`,
    )
    this.name = 'StripeApiError'
    this.status = status
    this.code = code
  }
}

export class StripeResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeResponseError'
  }
}

export interface StripeClientOptions {
  readonly apiKey: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly baseUrl?: string
}

/**
 * Stripe takes form encoding, not JSON, and nests with brackets:
 * `line_items[0][price]=price_123`. Flattened here rather than at each call
 * site, because hand-writing bracket keys is where a typo becomes a silently
 * ignored parameter.
 */
export const stripeForm = (
  input: Readonly<Record<string, unknown>>,
  prefix = '',
): URLSearchParams => {
  const params = new URLSearchParams()
  const walk = (value: unknown, key: string): void => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${key}[${String(index)}]`))
      return
    }
    if (typeof value === 'object') {
      for (const [child, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(nested, key === '' ? child : `${key}[${child}]`)
      }
      return
    }
    params.append(key, String(value))
  }
  walk(input, prefix)
  return params
}

export interface StripePaymentLink {
  readonly id: string
  /** Where the client pays. This is the thing that goes in the invoice email. */
  readonly url: string
}

export class StripeClient {
  readonly #apiKey: string
  readonly #fetch: (request: Request) => Promise<Response>
  readonly #baseUrl: string

  constructor(options: Readonly<StripeClientOptions>) {
    if (options.apiKey.trim() === '') {
      throw new StripeResponseError('a Stripe API key is required')
    }
    this.#apiKey = options.apiKey
    this.#fetch = options.fetch
    this.#baseUrl = options.baseUrl ?? STRIPE_API_BASE_URL
  }

  async #post(
    path: string,
    body: Readonly<Record<string, unknown>>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.#fetch(
      new Request(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          // Stripe's own idempotency, which the other integrations here do not
          // get to have. A retried create returns the first result rather than
          // making a second link.
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        body: stripeForm(body).toString(),
      }),
    )
    if (!response.ok) {
      let code: string | null = null
      let detail: string | null = null
      try {
        const failure = (await response.json()) as Record<string, unknown>
        const error = failure['error']
        if (typeof error === 'object' && error !== null) {
          const record = error as Record<string, unknown>
          if (typeof record['code'] === 'string') code = record['code']
          if (typeof record['message'] === 'string') detail = record['message']
        }
      } catch {
        // A non-JSON failure body is itself the diagnosis.
      }
      throw new StripeApiError(response.status, code, detail)
    }
    return (await response.json()) as Record<string, unknown>
  }

  /**
   * A price for one invoice, with its product described inline.
   *
   * Stripe requires a Price before a Payment Link -- `line_items[].price` takes
   * an id, not an amount -- so this is the first of two calls rather than
   * ceremony. `product_data` avoids leaving a catalogue of one-off products
   * behind for every invoice.
   */
  async createPrice(input: {
    readonly currency: string
    readonly unitAmountCents: number
    readonly productName: string
    readonly idempotencyKey?: string
  }): Promise<string> {
    if (!Number.isSafeInteger(input.unitAmountCents) || input.unitAmountCents <= 0) {
      throw new StripeResponseError('a Stripe price needs a positive whole-cent amount')
    }
    const body = await this.#post(
      '/v1/prices',
      {
        // Stripe wants lower case; ours are ISO upper case everywhere else.
        currency: input.currency.toLowerCase(),
        unit_amount: input.unitAmountCents,
        product_data: { name: input.productName },
      },
      input.idempotencyKey,
    )
    if (typeof body['id'] !== 'string') {
      throw new StripeResponseError('Stripe returned a price with no id')
    }
    return body['id']
  }

  /**
   * The payable URL.
   *
   * `metadata` is the thread back to our invoice: Stripe copies it onto the
   * checkout session, and the webhook reads it there. Without it a payment
   * arrives with nothing tying it to anything we raised.
   */
  async createPaymentLink(input: {
    readonly priceId: string
    readonly metadata: Readonly<Record<string, string>>
    readonly idempotencyKey?: string
  }): Promise<StripePaymentLink> {
    const body = await this.#post(
      '/v1/payment_links',
      {
        line_items: [{ price: input.priceId, quantity: 1 }],
        metadata: input.metadata,
      },
      input.idempotencyKey,
    )
    if (typeof body['id'] !== 'string' || typeof body['url'] !== 'string') {
      throw new StripeResponseError('Stripe returned a payment link with no URL')
    }
    return { id: body['id'], url: body['url'] }
  }
}
