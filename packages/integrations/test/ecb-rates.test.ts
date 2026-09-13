import { describe, expect, it } from 'vitest'
import {
  EcbRatesError,
  fetchEcbDailyRates,
  parseEcbDailyRates,
} from '../src/ecb/rates.js'

/**
 * Issue 522. The ECB's daily reference rates, pinned to the wire shape they
 * actually publish -- the lesson from the four integration bugs that shipped
 * because the only test was a stub agreeing with itself.
 */

// The real document's shape, trimmed. Nested Cubes, date on the middle one.
const feed = (date = '2026-09-11', body = `
      <Cube currency='USD' rate='1.0800'/>
      <Cube currency='GBP' rate='0.85'/>
      <Cube currency='JPY' rate='163.51'/>`) => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"
                 xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube>
    <Cube time='${date}'>${body}
    </Cube>
  </Cube>
</gesmes:Envelope>`

describe('reading the feed', () => {
  it('[money] takes the date the feed states, not the day it was read', async () => {
    // A Saturday fetch returns Friday's rates, and Friday is what they are for.
    expect(parseEcbDailyRates(feed()).asOf).toBe('2026-09-11')
  })

  it('[money] converts a decimal rate to parts per billion exactly', () => {
    // Not via a float multiply: 1.08 * 1e9 lands a hair under the integer it
    // should be, and a conversion then rounds the wrong way once in a while.
    const { rates } = parseEcbDailyRates(feed())
    expect(rates).toEqual([
      { currency: 'USD', ratePpb: 1_080_000_000 },
      { currency: 'GBP', ratePpb: 850_000_000 },
      { currency: 'JPY', ratePpb: 163_510_000_000 },
    ])
  })

  it('[money] handles a rate with more precision than it needs', () => {
    const { rates } = parseEcbDailyRates(
      feed('2026-09-11', `<Cube currency='HUF' rate='395.1234567891'/>`),
    )
    expect(rates[0]).toEqual({ currency: 'HUF', ratePpb: 395_123_456_789 })
  })

  it('[security] skips a rate it cannot read rather than storing a wrong one', () => {
    // A zero would convert money.
    const { rates } = parseEcbDailyRates(
      feed('2026-09-11', `<Cube currency='USD' rate='1.08'/><Cube currency='XXX' rate='0'/>`),
    )
    expect(rates.map((rate) => rate.currency)).toEqual(['USD'])
  })

  it('[security] refuses a document with no date rather than guessing today', () => {
    expect(() => parseEcbDailyRates('<Envelope><Cube/></Envelope>')).toThrow(EcbRatesError)
  })

  it('[security] refuses a document that parsed to nothing', () => {
    // The shape changing upstream must be loud, not an empty successful run.
    expect(() => parseEcbDailyRates(feed('2026-09-11', ''))).toThrow(/no rates/u)
  })
})

describe('fetching it', () => {
  it('[unit] reads the published document', async () => {
    const result = await fetchEcbDailyRates(async () => new Response(feed()))
    expect(result.asOf).toBe('2026-09-11')
    expect(result.rates).toHaveLength(3)
  })

  it('[security] refuses a non-200 rather than parsing an error page', async () => {
    await expect(
      fetchEcbDailyRates(async () => new Response('nope', { status: 503 })),
    ).rejects.toThrow(/answered 503/u)
  })
})
