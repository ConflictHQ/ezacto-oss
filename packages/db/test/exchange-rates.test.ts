import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase } from '../src/adapters.js'
import { migrateContainer } from '../src/migrate.js'
import { convertCents, recordExchangeRates } from '../src/exchange-rates.js'

/**
 * Issue 522's second half. The model already refused to consolidate across
 * currencies rather than invent a rate; this is the rate, and the rules that
 * keep it evidence rather than a calculation.
 */

const at = '2026-09-12T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const fixture = async () => {
  const database = new BetterSqlite3(':memory:')
  await migrateContainer(database)
  database.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('CONFLICT', '{}', '${at}', '${at}')`)
  sqlite = database
  return createContainerDatabase(database)
}

// ECB publishes euro-based: 1 EUR = 1.08 USD, 1 EUR = 0.85 GBP.
const seedFriday = async (database: Awaited<ReturnType<typeof fixture>>) =>
  recordExchangeRates(database, {
    baseCurrency: 'EUR',
    asOf: '2026-09-11',
    source: 'ecb',
    fetchedAt: at,
    rates: [
      { currency: 'USD', ratePpb: 1_080_000_000 },
      { currency: 'GBP', ratePpb: 850_000_000 },
    ],
  })

describe('converting an amount', () => {
  it('[money] goes from the base to a quote', async () => {
    const database = await fixture()
    await seedFriday(database)
    // 100 EUR at 1.08 is 108 USD.
    expect(
      await convertCents(database, { cents: 10_000, from: 'EUR', to: 'USD', asOf: '2026-09-11' }),
    ).toMatchObject({ kind: 'converted', cents: 10_800 })
  })

  it('[money] crosses two quotes through the base', async () => {
    // USD to GBP is USD to EUR to GBP. Storing the cross directly beside its
    // two legs would be two places for one fact.
    const database = await fixture()
    await seedFriday(database)
    // 108 USD is 100 EUR is 85 GBP.
    expect(
      await convertCents(database, { cents: 10_800, from: 'USD', to: 'GBP', asOf: '2026-09-11' }),
    ).toMatchObject({ kind: 'converted', cents: 8_500 })
  })

  it('[money] takes the last published rate on or before the date', async () => {
    // The ECB publishes on business days. A Saturday invoice converts at
    // Friday's rate, because Friday's is the rate that applied -- taking the
    // next one would convert at a rate that did not exist when it was raised.
    const database = await fixture()
    await seedFriday(database)
    const saturday = await convertCents(database, {
      cents: 10_000,
      from: 'EUR',
      to: 'USD',
      asOf: '2026-09-12',
    })
    expect(saturday).toMatchObject({ kind: 'converted', cents: 10_800 })
    expect((saturday as { via: { asOf: string }[] }).via[0]!.asOf).toBe('2026-09-11')
  })

  it('[money] never reaches forward for a rate that did not exist yet', async () => {
    const database = await fixture()
    await seedFriday(database)
    expect(
      await convertCents(database, { cents: 10_000, from: 'EUR', to: 'USD', asOf: '2026-09-10' }),
    ).toEqual({ kind: 'no_rate', missing: 'USD' })
  })

  it('[money] says which rate it was missing rather than failing', async () => {
    // A missing rate is ordinary -- the feed has not run, or nobody quotes that
    // currency. A report that fell over would be worse than one showing a
    // figure per currency, which is what this system does today anyway.
    const database = await fixture()
    await seedFriday(database)
    expect(
      await convertCents(database, { cents: 10_000, from: 'EUR', to: 'JPY', asOf: '2026-09-11' }),
    ).toEqual({ kind: 'no_rate', missing: 'JPY' })
  })

  it('[unit] converts nothing when the currencies match', async () => {
    const database = await fixture()
    expect(
      await convertCents(database, { cents: 10_000, from: 'USD', to: 'USD', asOf: '2026-09-11' }),
    ).toEqual({ kind: 'same_currency', cents: 10_000 })
  })

  it('[money] reports every rate it went through', async () => {
    // The record a conversion leaves. An invoice converted in August must be
    // answerable in December with the rate it actually used.
    const database = await fixture()
    await seedFriday(database)
    const result = await convertCents(database, {
      cents: 10_800,
      from: 'USD',
      to: 'GBP',
      asOf: '2026-09-11',
    })
    expect((result as { via: { quoteCurrency: string }[] }).via.map((r) => r.quoteCurrency)).toEqual(
      ['USD', 'GBP'],
    )
  })

  it('[money] rounds half away from zero, like the rest of the money code', async () => {
    const database = await fixture()
    await recordExchangeRates(database, {
      baseCurrency: 'EUR',
      asOf: '2026-09-11',
      source: 'ecb',
      fetchedAt: at,
      rates: [{ currency: 'USD', ratePpb: 1_000_000_001 }],
    })
    // 1 cent at a hair over parity is still 1 cent, not 0.
    expect(
      await convertCents(database, { cents: 1, from: 'EUR', to: 'USD', asOf: '2026-09-11' }),
    ).toMatchObject({ cents: 1 })
  })
})

describe('what the table refuses', () => {
  it('[security] refuses to change a published rate', async () => {
    // Re-converting later would restate a figure somebody has already acted on.
    const database = await fixture()
    await seedFriday(database)
    expect(() =>
      sqlite!.exec(`UPDATE exchange_rates SET rate_ppb = 1 WHERE quote_currency = 'USD'`),
    ).toThrow(/published rate is immutable/u)
  })

  it('[money] ignores a repeat of a rate it already holds', async () => {
    // Re-running the feed must not restate anything.
    const database = await fixture()
    await seedFriday(database)
    await recordExchangeRates(database, {
      baseCurrency: 'EUR',
      asOf: '2026-09-11',
      source: 'ecb',
      fetchedAt: '2026-09-13T12:00:00.000Z',
      rates: [{ currency: 'USD', ratePpb: 9_999_999 }],
    })
    expect(
      await convertCents(database, { cents: 10_000, from: 'EUR', to: 'USD', asOf: '2026-09-11' }),
    ).toMatchObject({ cents: 10_800 })
  })

  it('[money] lets a person override the source, and says who did', async () => {
    // A correction is a manual row beside the published one, not an edit of it.
    const database = await fixture()
    await seedFriday(database)
    await recordExchangeRates(database, {
      baseCurrency: 'EUR',
      asOf: '2026-09-11',
      source: 'manual',
      fetchedAt: at,
      rates: [{ currency: 'USD', ratePpb: 1_100_000_000 }],
    })
    const result = await convertCents(database, {
      cents: 10_000,
      from: 'EUR',
      to: 'USD',
      asOf: '2026-09-11',
    })
    expect(result).toMatchObject({ cents: 11_000 })
    expect((result as { via: { source: string }[] }).via[0]!.source).toBe('manual')
  })

  it('[security] refuses a currency that is not a code', async () => {
    await fixture()
    expect(() =>
      sqlite!.exec(`INSERT INTO exchange_rates
        (base_currency, quote_currency, as_of, rate_ppb, source, fetched_at)
        VALUES ('EUR', 'dollars', '2026-09-11', 1000000000, 'ecb', '${at}')`),
    ).toThrow(/CHECK|constraint/iu)
  })
})
