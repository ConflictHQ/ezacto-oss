import { describe, expect, it } from 'vitest'
import {
  STRIPE_SIGNATURE_TOLERANCE_SECONDS,
  StripeWebhookError,
  parseStripeSignatureHeader,
  readCheckoutCompletion,
  verifyStripeSignature,
} from '../src/stripe/webhook.js'

const secret = 'whsec_example_secret'
const nowSeconds = 1_757_592_000

/** The signature Stripe would have sent, computed the way Stripe computes it. */
const sign = async (payload: string, timestamp: number, key = secret): Promise<string> => {
  const imported = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign(
    'HMAC',
    imported,
    new TextEncoder().encode(`${String(timestamp)}.${payload}`),
  )
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' })

const header = async (
  payload = body,
  timestamp = nowSeconds,
  key = secret,
): Promise<string> => `t=${String(timestamp)},v1=${await sign(payload, timestamp, key)}`

describe('reading the Stripe-Signature header', () => {
  it('[unit] takes the timestamp and every v1 signature', () => {
    expect(parseStripeSignatureHeader('t=1492774577,v1=aaa,v1=bbb')).toEqual({
      timestamp: 1_492_774_577,
      signatures: ['aaa', 'bbb'],
    })
  })

  it('[security] discards every scheme that is not v1', () => {
    // Stripe sends a `v0` with test events and it is deliberately FAKE. A
    // parser that kept it would hand a forgeable signature to the comparison,
    // which is the downgrade attack their documentation names.
    expect(parseStripeSignatureHeader('t=1,v1=real,v0=fake,v2=future')).toEqual({
      timestamp: 1,
      signatures: ['real'],
    })
  })

  it('[api] refuses a header with no timestamp or no v1', () => {
    expect(() => parseStripeSignatureHeader('v1=aaa')).toThrow(/no timestamp/u)
    expect(() => parseStripeSignatureHeader('t=1,v0=fake')).toThrow(/no v1 signature/u)
    expect(() => parseStripeSignatureHeader('')).toThrow(StripeWebhookError)
  })

  it('[unit] survives whitespace, which a header may carry', () => {
    expect(parseStripeSignatureHeader('t=1, v1=aaa').signatures).toEqual(['aaa'])
  })
})

describe('verifying a delivery', () => {
  it('[security] accepts a signature Stripe would have produced', async () => {
    expect(
      await verifyStripeSignature({
        payload: body,
        header: await header(),
        secret,
        nowSeconds,
      }),
    ).toBe(true)
  })

  it('[security] refuses a body that was altered after signing', async () => {
    // The entire point: the signature covers the raw body.
    const signed = await header()
    expect(
      await verifyStripeSignature({
        payload: body.replace('evt_1', 'evt_2'),
        header: signed,
        secret,
        nowSeconds,
      }),
    ).toBe(false)
  })

  it('[security] refuses a signature made with a different secret', async () => {
    expect(
      await verifyStripeSignature({
        payload: body,
        header: await header(body, nowSeconds, 'whsec_somebody_elses'),
        secret,
        nowSeconds,
      }),
    ).toBe(false)
  })

  it('[security] refuses a v0 signature even when it is otherwise correct', async () => {
    // Computed with the real secret and offered under the fake scheme. If the
    // scheme were ignored this would pass, and a forged event would be
    // accepted from anybody who knows the test-mode trick.
    const signature = await sign(body, nowSeconds)
    await expect(
      verifyStripeSignature({
        payload: body,
        header: `t=${String(nowSeconds)},v0=${signature}`,
        secret,
        nowSeconds,
      }),
    ).rejects.toThrow(/no v1 signature/u)
  })

  it('[security] accepts during a secret roll, when several v1 values arrive', async () => {
    // The old secret stays live for up to 24 hours and Stripe signs once per
    // secret. Taking only the first would reject half the deliveries.
    const old = await sign(body, nowSeconds, 'whsec_previous')
    const current = await sign(body, nowSeconds)
    expect(
      await verifyStripeSignature({
        payload: body,
        header: `t=${String(nowSeconds)},v1=${old},v1=${current}`,
        secret,
        nowSeconds,
      }),
    ).toBe(true)
  })

  it('[security] refuses a replay of a delivery that is too old', async () => {
    // A valid signature stays valid for ever. The timestamp is inside the
    // signed payload, so it cannot be edited without breaking the signature --
    // checking it is what stops a captured delivery being replayed tomorrow.
    const stale = nowSeconds - STRIPE_SIGNATURE_TOLERANCE_SECONDS - 1
    expect(
      await verifyStripeSignature({
        payload: body,
        header: await header(body, stale),
        secret,
        nowSeconds,
      }),
    ).toBe(false)
  })

  it('[security] refuses a timestamp too far in the future as well', async () => {
    const ahead = nowSeconds + STRIPE_SIGNATURE_TOLERANCE_SECONDS + 1
    expect(
      await verifyStripeSignature({
        payload: body,
        header: await header(body, ahead),
        secret,
        nowSeconds,
      }),
    ).toBe(false)
  })

  it('[security] accepts one right at the edge of the tolerance', async () => {
    const edge = nowSeconds - STRIPE_SIGNATURE_TOLERANCE_SECONDS
    expect(
      await verifyStripeSignature({
        payload: body,
        header: await header(body, edge),
        secret,
        nowSeconds,
      }),
    ).toBe(true)
  })

  it('[security] refuses a tolerance of zero rather than disabling the check', async () => {
    // Stripe's own documentation warns that zero disables the recency check
    // entirely, which is the opposite of what somebody setting it to zero
    // believes they are doing.
    await expect(
      verifyStripeSignature({
        payload: body,
        header: await header(),
        secret,
        nowSeconds,
        toleranceSeconds: 0,
      }),
    ).rejects.toThrow(/greater than zero/u)
  })

  it('[security] throws on a blank secret rather than answering "not verified"', async () => {
    // A deployment with no secret cannot tell a real delivery from a forged
    // one. Answering false would make that look like an ordinary rejection
    // instead of the configuration error it is.
    await expect(
      verifyStripeSignature({ payload: body, header: await header(), secret: '  ', nowSeconds }),
    ).rejects.toThrow(/signing secret is required/u)
  })
})

describe('reading a completed checkout', () => {
  const session = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_status: 'paid',
          payment_intent: 'pi_example',
          amount_total: 2500,
          currency: 'usd',
          metadata: { ezacto_invoice_id: '1315' },
          ...overrides,
        },
      },
    })

  it('[money] reads the payment, the amount and our invoice', async () => {
    expect(readCheckoutCompletion(session())).toEqual({
      eventId: 'evt_1',
      eventType: 'checkout.session.completed',
      paymentIntentId: 'pi_example',
      amountCents: 2500,
      currency: 'USD',
      invoiceId: 1315,
    })
  })

  it('[money] ignores a session that completed without being paid', async () => {
    // `complete` with an unpaid status is a session that finished and moved no
    // money. Recording it would mark an invoice paid that is still owed.
    expect(readCheckoutCompletion(session({ payment_status: 'unpaid' }))).toBeNull()
  })

  it('[unit] ignores every other event type rather than failing on it', async () => {
    // Stripe sends what the endpoint subscribed to. Throwing on an event we did
    // not want would turn somebody's dashboard change into a failed delivery.
    expect(
      readCheckoutCompletion(JSON.stringify({ id: 'evt_2', type: 'customer.created' })),
    ).toBeNull()
  })

  it('[security] reports no invoice rather than guessing one', async () => {
    // Without our metadata there is nothing tying Stripe's money to an invoice,
    // and a guess here would credit somebody else's.
    expect(readCheckoutCompletion(session({ metadata: {} }))?.invoiceId).toBeNull()
    expect(
      readCheckoutCompletion(session({ metadata: { ezacto_invoice_id: 'not-a-number' } }))
        ?.invoiceId,
    ).toBeNull()
    expect(
      readCheckoutCompletion(session({ metadata: { ezacto_invoice_id: '-3' } }))?.invoiceId,
    ).toBeNull()
  })

  it('[api] refuses a body that is not JSON', async () => {
    expect(() => readCheckoutCompletion('<html>')).toThrow(/not JSON/u)
  })

  it('[api] ignores a session missing the fields a payment needs', async () => {
    expect(readCheckoutCompletion(session({ payment_intent: null }))).toBeNull()
    expect(readCheckoutCompletion(session({ amount_total: null }))).toBeNull()
  })
})
