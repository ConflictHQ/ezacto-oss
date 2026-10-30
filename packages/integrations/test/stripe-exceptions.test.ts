import { describe, expect, it } from 'vitest'
import { readStripePaymentAlert } from '../src/stripe/exceptions.js'
const event = (type = 'charge.refunded', fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_owned',
    type,
    created: 1792454400,
    data: {
      object: {
        id: 'ch_owned',
        payment_intent: 'pi_owned',
        amount: 10000,
        amount_refunded: 5000,
        currency: 'usd',
        refunded: false,
        status: 'needs_response',
        ...fields,
      },
    },
  })
describe('minimal Stripe refund and dispute reports', () => {
  it('keeps cumulative refund amount and expanded payment identity without payer data', () => {
    const parsed = readStripePaymentAlert(
      event('charge.refunded', {
        payment_intent: { id: 'pi_owned' },
        billing_details: { email: 'private@example.test' },
      }),
    )
    expect(parsed).toMatchObject({
      id: 'evt_owned',
      kind: 'refund',
      amountCents: 5000,
      currency: 'USD',
      providerStatus: 'partially_refunded',
      paymentIntentId: 'pi_owned',
    })
    expect(JSON.stringify(parsed)).not.toContain('private')
  })
  it.each(['created', 'updated', 'closed', 'funds_withdrawn', 'funds_reinstated'])(
    'accepts dispute %s with its own amount and status',
    (type) => {
      expect(
        readStripePaymentAlert(event(`charge.dispute.${type}`, { id: 'dp_owned', status: 'won' })),
      ).toMatchObject({
        kind: 'dispute',
        objectId: 'dp_owned',
        amountCents: 10000,
        providerStatus: 'won',
      })
    },
  )
  it.each([
    { amount_refunded: 0 },
    { amount_refunded: 10001 },
    { amount_refunded: 1.5 },
    { payment_intent: null },
    { currency: 'US Dollars' },
    { id: 'bad\nvalue' },
  ])('refuses malformed or unmatchable money %j', (fields) => {
    expect(readStripePaymentAlert(event('charge.refunded', fields))).toBeNull()
  })
  it('ignores unsupported event types and malformed JSON', () => {
    expect(readStripePaymentAlert(event('charge.updated'))).toBeNull()
    expect(readStripePaymentAlert('{')).toBeNull()
  })
})
