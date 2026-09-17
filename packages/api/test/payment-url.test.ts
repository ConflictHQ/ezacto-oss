import { describe, expect, it, vi } from 'vitest'
import { invoicePaymentUrlForMail, invoicePaymentUrlForSend } from '../src/payment-url.js'

const stripe = (url: string | null) => ({
  paymentLink: vi.fn(async () => (url === null ? { kind: 'unavailable' } : { kind: 'linked', url })),
})

describe('where the client pays, for the mail that carries it (issue 838)', () => {
  it('[unit] BILL answers first for a client billed through it, and Stripe is not asked', async () => {
    const bill = { paymentLinkForSend: vi.fn(async () => 'https://bill.example/pay/1'), paymentLink: vi.fn(async () => null) }
    const card = stripe('https://stripe.example/pay/1')
    expect(await invoicePaymentUrlForSend({ bill, stripe: card })(41)).toBe('https://bill.example/pay/1')
    expect(card.paymentLink).not.toHaveBeenCalled()
  })

  it('[unit] a client not billed through BILL gets the Stripe link', async () => {
    const bill = { paymentLinkForSend: vi.fn(async () => null), paymentLink: vi.fn(async () => null) }
    expect(await invoicePaymentUrlForSend({ bill, stripe: stripe('https://stripe.example/pay/1') })(41)).toBe(
      'https://stripe.example/pay/1',
    )
  })

  it('[reliability] a provider that fails yields to the next, and nothing throws into the send', async () => {
    const bill = {
      paymentLinkForSend: vi.fn(async () => {
        throw new Error('BILL refused /v3/login (401)')
      }),
      paymentLink: vi.fn(async () => null),
    }
    expect(await invoicePaymentUrlForSend({ bill, stripe: stripe('https://stripe.example/pay/1') })(41)).toBe(
      'https://stripe.example/pay/1',
    )
    const failing = { paymentLink: vi.fn(async () => { throw new Error('stripe down') }) }
    expect(await invoicePaymentUrlForSend({ bill: { ...bill, paymentLinkForSend: async () => null }, stripe: failing })(41)).toBeNull()
  })

  it('[unit] later mail reads the link the send stored rather than minting again', async () => {
    const bill = { paymentLinkForSend: vi.fn(async () => 'minted'), paymentLink: vi.fn(async () => 'https://bill.example/pay/1') }
    expect(await invoicePaymentUrlForMail({ bill, stripe: stripe(null) })(41)).toBe('https://bill.example/pay/1')
    expect(bill.paymentLinkForSend).not.toHaveBeenCalled()
  })

  it('[unit] with no provider at all the answer is null', async () => {
    expect(await invoicePaymentUrlForSend({})(41)).toBeNull()
    expect(await invoicePaymentUrlForMail({})(41)).toBeNull()
  })
})
