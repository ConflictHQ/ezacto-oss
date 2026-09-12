import { describe, expect, it, vi } from 'vitest'
import {
  StripeApiError,
  StripeClient,
  StripeResponseError,
  stripeForm,
} from '../src/stripe/client.js'

const base = 'https://api.stripe.test'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const client = (fetch: (request: Request) => Promise<Response>) =>
  new StripeClient({ apiKey: 'sk_test_example', fetch, baseUrl: base })

describe('form encoding', () => {
  it('[unit] nests with brackets the way Stripe expects', () => {
    // `line_items[0][price]=price_1`, which is the shape their own curl
    // examples use. Hand-writing these keys is where a typo becomes a silently
    // ignored parameter.
    const params = stripeForm({
      line_items: [{ price: 'price_1', quantity: 1 }],
      metadata: { ezacto_invoice_id: '1315' },
    })
    expect(params.get('line_items[0][price]')).toBe('price_1')
    expect(params.get('line_items[0][quantity]')).toBe('1')
    expect(params.get('metadata[ezacto_invoice_id]')).toBe('1315')
  })

  it('[unit] leaves out what was not set rather than sending empty keys', () => {
    const params = stripeForm({ a: 1, b: undefined, c: null })
    expect([...params.keys()]).toEqual(['a'])
  })
})

describe('every request', () => {
  it('[security] authorises with the key and posts form encoding', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('authorization')).toBe('Bearer sk_test_example')
      expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
      return json({ id: 'price_1' })
    })
    await client(fetch).createPrice({
      currency: 'USD',
      unitAmountCents: 2500,
      productName: 'Invoice 1315',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('[api] refuses to construct without a key', () => {
    expect(() => new StripeClient({ apiKey: '  ', fetch: vi.fn() })).toThrow(
      StripeResponseError,
    )
  })

  it('[api] carries an idempotency key when it is given one', async () => {
    // Stripe's own idempotency, which the other integrations here do not get.
    // A retried create returns the first result rather than a second link.
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('idempotency-key')).toBe('invoice-1315-price')
      return json({ id: 'price_1' })
    })
    await client(fetch).createPrice({
      currency: 'USD',
      unitAmountCents: 2500,
      productName: 'Invoice 1315',
      idempotencyKey: 'invoice-1315-price',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('[api] reports Stripe’s own code and message', async () => {
    const fetch = vi.fn(async () =>
      json({ error: { code: 'parameter_invalid_integer', message: 'Invalid integer' } }, 400),
    )
    const error = await client(fetch)
      .createPrice({ currency: 'USD', unitAmountCents: 1, productName: 'x' })
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(StripeApiError)
    expect((error as StripeApiError).code).toBe('parameter_invalid_integer')
  })
})

describe('creating a price', () => {
  it('[money] sends whole cents and a lower-case currency', async () => {
    // Ours are ISO upper case everywhere else; Stripe wants lower.
    const fetch = vi.fn(async (request: Request) => {
      const body = new URLSearchParams(await request.clone().text())
      expect(body.get('currency')).toBe('usd')
      expect(body.get('unit_amount')).toBe('2500')
      expect(body.get('product_data[name]')).toBe('Invoice 1315')
      return json({ id: 'price_1' })
    })
    expect(
      await client(fetch).createPrice({
        currency: 'USD',
        unitAmountCents: 2500,
        productName: 'Invoice 1315',
      }),
    ).toBe('price_1')
  })

  it('[money] refuses a zero, negative or fractional amount', async () => {
    const fetch = vi.fn()
    for (const unitAmountCents of [0, -100, 25.5]) {
      await expect(
        client(fetch).createPrice({ currency: 'USD', unitAmountCents, productName: 'x' }),
      ).rejects.toThrow(/positive whole-cent amount/u)
    }
    // Nothing reached Stripe: a bad amount is caught before it can create a
    // real price on a real account.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('[api] treats a price with no id as a failure', async () => {
    const fetch = vi.fn(async () => json({ object: 'price' }))
    await expect(
      client(fetch).createPrice({ currency: 'USD', unitAmountCents: 1, productName: 'x' }),
    ).rejects.toThrow(/no id/u)
  })
})

describe('creating a payment link', () => {
  it('[money] carries our invoice id in metadata, which is the thread back', async () => {
    // Stripe copies this onto the checkout session and the webhook reads it
    // there. Without it a payment arrives tied to nothing we raised.
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/v1/payment_links')
      const body = new URLSearchParams(await request.clone().text())
      expect(body.get('line_items[0][price]')).toBe('price_1')
      expect(body.get('line_items[0][quantity]')).toBe('1')
      expect(body.get('metadata[ezacto_invoice_id]')).toBe('1315')
      return json({ id: 'plink_1', url: 'https://buy.stripe.com/test_example' })
    })
    expect(
      await client(fetch).createPaymentLink({
        priceId: 'price_1',
        metadata: { ezacto_invoice_id: '1315' },
      }),
    ).toEqual({ id: 'plink_1', url: 'https://buy.stripe.com/test_example' })
  })

  it('[api] treats a link with no URL as a failure', async () => {
    // An invoice email carrying an empty "pay here" is worse than one that
    // failed to send.
    const fetch = vi.fn(async () => json({ id: 'plink_1' }))
    await expect(
      client(fetch).createPaymentLink({ priceId: 'price_1', metadata: {} }),
    ).rejects.toThrow(/no URL/u)
  })
})

describe('what this client deliberately cannot do', () => {
  it('[security] answers for its whole surface, so nothing that moves money back can appear', () => {
    // Collecting is the whole job. A method that refunds, captures or cancels
    // is one somebody eventually calls by accident, so the absence is asserted
    // rather than assumed.
    expect(
      Object.getOwnPropertyNames(StripeClient.prototype)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual(['createPaymentLink', 'createPrice'])
  })
})
