import { describe, expect, it } from 'vitest'
import { parseEstimateContent, estimateContentTotals } from '../src/estimate-content.js'
const content = {
  subject: null,
  notes: null,
  currency: 'USD',
  tax_rate_ppm: 100000,
  tax2_rate_ppm: 50000,
  discount_rate_ppm: 100000,
  lines: [
    {
      kind: 'Service',
      description: null,
      quantity: 2.5,
      unit_price_cents: 1001,
      taxed: true,
      taxed2: false,
    },
    {
      kind: 'Credit',
      description: null,
      quantity: 1,
      unit_price_cents: -1000,
      taxed: false,
      taxed2: true,
    },
  ],
}
describe('reusable estimate content', () => {
  it('rounds decimal quantities and discount-first parallel taxes half away from zero', () => {
    expect(estimateContentTotals(parseEstimateContent(content))).toEqual({
      amounts: [2503, -1000],
      amount_cents: 1533,
      discount_amount_cents: 150,
      tax_amount_cents: 225,
      tax2_amount_cents: -45,
    })
  })
  it('rejects private identity, malformed values and arithmetic overflow at the shared boundary', () => {
    for (const value of [
      { ...content, client_key: 'secret' },
      { ...content, tax_rate_ppm: 0.1 },
      { ...content, lines: [] },
      { ...content, currency: 'usd' },
      { ...content, lines: [{ ...content.lines[0], quantity: 1e20 }] },
      { ...content, lines: [{ ...content.lines[0], unit_price_cents: 0.1 }] },
      { ...content, lines: [{ ...content.lines[0], state: 'accepted' }] },
    ])
      expect(() => parseEstimateContent(value)).toThrow()
  })
})
