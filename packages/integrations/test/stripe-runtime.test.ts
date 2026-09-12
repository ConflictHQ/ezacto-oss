import { describe, expect, it, vi } from 'vitest'
import {
  createStripeRuntime,
  type StripeConfig,
  type StripeSource,
} from '../src/stripe/runtime.js'

const secret = 'whsec_example_secret'
const nowSeconds = 1_757_592_000
const now = () => new Date(nowSeconds * 1000)

const config: StripeConfig = { apiKey: 'sk_test_example', webhookSecret: secret }

const invoice = { id: 1315, number: '1315', currency: 'USD', dueAmountCents: 250_000 }

const source = (overrides: Partial<StripeSource> = {}): StripeSource => ({
  readInvoice: vi.fn(async () => invoice),
  readLink: vi.fn(async () => null),
  saveLink: vi.fn(async (_id: number, link: { paymentLinkId: string; url: string }) => link),
  invoiceForLink: vi.fn(async () => null),
  recordPayment: vi.fn(async () => undefined),
  ...overrides,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const stripeServer = () => {
  const calls: string[] = []
  const fetch = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname
    calls.push(path)
    if (path === '/v1/prices') return json({ id: 'price_1' })
    if (path === '/v1/payment_links') {
      return json({ id: 'plink_1', url: 'https://buy.stripe.com/test_example' })
    }
    throw new Error(`unexpected ${path}`)
  })
  return { fetch, calls }
}

const runtime = (
  overrides: { config?: StripeConfig; source?: StripeSource; server?: ReturnType<typeof stripeServer> } = {},
) => {
  const server = overrides.server ?? stripeServer()
  const src = overrides.source ?? source()
  return {
    server,
    source: src,
    runtime: createStripeRuntime({
      config: overrides.config ?? config,
      source: src,
      fetch: server.fetch,
      now,
    }),
  }
}

const sign = async (payload: string, timestamp = nowSeconds): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${String(timestamp)}.${payload}`),
  )
  const hex = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `t=${String(timestamp)},v1=${hex}`
}

const paidSession = (metadata: Record<string, string> = { ezacto_invoice_id: '1315' }) =>
  JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        payment_status: 'paid',
        payment_intent: 'pi_example',
        amount_total: 250_000,
        currency: 'usd',
        metadata,
      },
    },
  })

describe('minting the link an invoice is paid at', () => {
  it('[money] creates a price then a link, and keeps it', async () => {
    const harness = runtime()
    expect(await harness.runtime.paymentLink(1315)).toEqual({
      kind: 'linked',
      url: 'https://buy.stripe.com/test_example',
    })
    expect(harness.server.calls).toEqual(['/v1/prices', '/v1/payment_links'])
    expect(harness.source.saveLink).toHaveBeenCalledWith(1315, {
      paymentLinkId: 'plink_1',
      url: 'https://buy.stripe.com/test_example',
    })
  })

  it('[money] the link it mints confirms the invoice by number to the payer', async () => {
    const harness = runtime()
    await harness.runtime.paymentLink(1315)
    const linkBody = new URLSearchParams(
      await (harness.server.fetch.mock.calls[1]![0] as Request).clone().text(),
    )
    expect(
      linkBody.get('after_completion[hosted_confirmation][custom_message]'),
    ).toContain('1315')
  })

  it('[money] reuses the link rather than minting a second one', async () => {
    // The URL that went out in an email has to keep working, and a second mint
    // leaves another Price on the account every time somebody opens the
    // invoice.
    const harness = runtime({
      source: source({
        readLink: vi.fn(async () => ({
          paymentLinkId: 'plink_old',
          url: 'https://buy.stripe.com/test_old',
        })),
      }),
    })
    expect(await harness.runtime.paymentLink(1315)).toEqual({
      kind: 'linked',
      url: 'https://buy.stripe.com/test_old',
    })
    expect(harness.server.calls).toEqual([])
  })

  it('[money] charges what is still owed, not the original total', async () => {
    const harness = runtime({
      source: source({
        readInvoice: vi.fn(async () => ({ ...invoice, dueAmountCents: 50_000 })),
      }),
    })
    await harness.runtime.paymentLink(1315)
    const priceBody = new URLSearchParams(
      await (harness.server.fetch.mock.calls[0]![0] as Request).clone().text(),
    )
    expect(priceBody.get('unit_amount')).toBe('50000')
  })

  it('[money] refuses an invoice with nothing left to pay', async () => {
    // A link for zero is one Stripe refuses, and a link for the original total
    // would collect money that is not due.
    const harness = runtime({
      source: source({ readInvoice: vi.fn(async () => ({ ...invoice, dueAmountCents: 0 })) }),
    })
    expect(await harness.runtime.paymentLink(1315)).toEqual({
      kind: 'refused',
      reason: 'this invoice has nothing left to pay',
    })
    expect(harness.server.calls).toEqual([])
  })

  it('[api] refuses when the deployment has no key, without calling Stripe', async () => {
    const harness = runtime({ config: { apiKey: undefined, webhookSecret: secret } })
    expect((await harness.runtime.paymentLink(1315)).kind).toBe('refused')
    expect(harness.server.calls).toEqual([])
    expect(harness.runtime.configured()).toBe(false)
  })

  it('[api] refuses an invoice that does not exist', async () => {
    const harness = runtime({ source: source({ readInvoice: vi.fn(async () => null) }) })
    expect(await harness.runtime.paymentLink(1315)).toEqual({
      kind: 'refused',
      reason: 'the invoice does not exist',
    })
  })

  it('[money] keys both creates on the invoice, so a retry makes nothing new', async () => {
    const harness = runtime()
    await harness.runtime.paymentLink(1315)
    const keys = harness.server.fetch.mock.calls.map(([request]) =>
      (request as Request).headers.get('idempotency-key'),
    )
    expect(keys).toEqual(['ezacto-invoice-1315-price', 'ezacto-invoice-1315-link'])
  })
})

describe('receiving a payment', () => {
  it('[money] records a verified paid session against our invoice', async () => {
    const harness = runtime()
    const payload = paidSession()
    expect(
      await harness.runtime.receiveWebhook({
        payload,
        signature: await sign(payload),
      }),
    ).toEqual({ kind: 'recorded', invoiceId: 1315 })
    expect(harness.source.recordPayment).toHaveBeenCalledWith({
      invoiceId: 1315,
      paymentIntentId: 'pi_example',
      amountCents: 250_000,
    })
  })

  it('[security] refuses an unsigned delivery', async () => {
    const harness = runtime()
    expect(
      await harness.runtime.receiveWebhook({ payload: paidSession(), signature: null }),
    ).toEqual({ kind: 'unverified' })
    expect(harness.source.recordPayment).not.toHaveBeenCalled()
  })

  it('[security] refuses a forged signature', async () => {
    const harness = runtime()
    expect(
      await harness.runtime.receiveWebhook({
        payload: paidSession(),
        signature: `t=${String(nowSeconds)},v1=deadbeef`,
      }),
    ).toEqual({ kind: 'unverified' })
    expect(harness.source.recordPayment).not.toHaveBeenCalled()
  })

  it('[security] refuses everything when no signing secret is configured', async () => {
    // Without one nothing can tell a real delivery from a forged one, so the
    // safe answer is to trust none of them.
    const harness = runtime({ config: { apiKey: 'sk_test_example', webhookSecret: undefined } })
    const payload = paidSession()
    expect(
      await harness.runtime.receiveWebhook({ payload, signature: await sign(payload) }),
    ).toEqual({ kind: 'unverified' })
    expect(harness.source.recordPayment).not.toHaveBeenCalled()
  })

  it('[money] ignores a session that moved no money', async () => {
    const harness = runtime()
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { payment_status: 'unpaid', payment_intent: 'pi_x', amount_total: 1, currency: 'usd' } },
    })
    expect(
      (await harness.runtime.receiveWebhook({ payload, signature: await sign(payload) })).kind,
    ).toBe('ignored')
    expect(harness.source.recordPayment).not.toHaveBeenCalled()
  })

  it('[security] ignores a payment that names no invoice of ours', async () => {
    // Stripe takes money for things other than our invoices. Guessing which one
    // this settled would credit somebody else's.
    const harness = runtime()
    const payload = paidSession({})
    expect(
      await harness.runtime.receiveWebhook({ payload, signature: await sign(payload) }),
    ).toEqual({ kind: 'ignored', reason: 'the payment names no invoice of ours' })
    expect(harness.source.recordPayment).not.toHaveBeenCalled()
  })
})
