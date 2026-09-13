import { sql } from 'drizzle-orm'
import type { InvoiceStateDatabase } from './invoice-state.js'

/**
 * Converting between currencies, at a rate this system actually holds
 * (issue 522).
 *
 * The model was already multi-currency and already refused to consolidate --
 * `contractorCostReport` says adding two currencies would "invent an exchange
 * rate this system does not hold". This does not change that refusal into a
 * guess. It gives the system a rate, from a named source, for a named date, and
 * everything else still declines.
 */

/** Parts per billion, so a rate is an integer and rounds the same everywhere. */
const PPB = 1_000_000_000n

export interface StoredRate {
  readonly baseCurrency: string
  readonly quoteCurrency: string
  readonly asOf: string
  readonly ratePpb: number
  readonly source: 'ecb' | 'manual'
}

export type ConversionOutcome =
  | {
      readonly kind: 'converted'
      readonly cents: number
      /** Every rate the conversion went through, for the record it leaves. */
      readonly via: readonly StoredRate[]
    }
  | { readonly kind: 'same_currency'; readonly cents: number }
  | { readonly kind: 'no_rate'; readonly missing: string }

/**
 * The rate for a currency on or before a date.
 *
 * On *or before*, because the ECB publishes on business days: a Saturday
 * invoice converts at Friday's rate, and Friday is what the row says, because
 * Friday's rate is the one that applied. Taking the next published rate instead
 * would convert an invoice at a rate that did not exist when it was raised.
 *
 * A `manual` row for the same date wins over the source's. Somebody overriding
 * a published rate has said something the feed cannot.
 */
const rateOn = async (
  database: InvoiceStateDatabase,
  quoteCurrency: string,
  asOf: string,
): Promise<StoredRate | null> => {
  const rows = await database.all<{
    baseCurrency: string
    quoteCurrency: string
    asOf: string
    ratePpb: number
    source: 'ecb' | 'manual'
  }>(
    sql`SELECT base_currency AS baseCurrency, quote_currency AS quoteCurrency,
               as_of AS asOf, rate_ppb AS ratePpb, source
        FROM exchange_rates
        WHERE quote_currency = ${quoteCurrency} AND as_of <= ${asOf}
        ORDER BY as_of DESC, CASE source WHEN 'manual' THEN 0 ELSE 1 END
        LIMIT 1`,
  )
  return rows[0] ?? null
}

/**
 * Converts an amount, or says which rate it was missing.
 *
 * Answers rather than throws, because a missing rate is an ordinary state --
 * the feed has not run, or the currency is one nobody has quoted -- and a
 * report that fell over would be worse than one that shows a figure per
 * currency, which is what this system does today anyway.
 *
 * Cross-rates go through the base: USD to GBP is USD to EUR to GBP. Storing the
 * cross directly alongside its two legs would be two places for one fact, and
 * they would disagree the first time one was refreshed.
 */
export const convertCents = async (
  database: InvoiceStateDatabase,
  input: Readonly<{ cents: number; from: string; to: string; asOf: string }>,
): Promise<ConversionOutcome> => {
  const from = input.from.toUpperCase()
  const to = input.to.toUpperCase()
  if (from === to) return { kind: 'same_currency', cents: input.cents }

  const amount = BigInt(Math.trunc(input.cents))
  const via: StoredRate[] = []

  // Into the base first, unless it already is the base.
  let inBase = amount
  if (from !== 'EUR') {
    const leg = await rateOn(database, from, input.asOf)
    if (leg === null) return { kind: 'no_rate', missing: from }
    via.push(leg)
    // Rounded half away from zero, the same rule the money code uses
    // everywhere else, so a conversion does not drift against a total.
    inBase = divideRounded(amount * PPB, BigInt(leg.ratePpb))
  }

  if (to === 'EUR') {
    return { kind: 'converted', cents: Number(inBase), via }
  }
  const leg = await rateOn(database, to, input.asOf)
  if (leg === null) return { kind: 'no_rate', missing: to }
  via.push(leg)
  return {
    kind: 'converted',
    cents: Number(divideRounded(inBase * BigInt(leg.ratePpb), PPB)),
    via,
  }
}

/** Half away from zero, matching the rounding the rest of the money code uses. */
const divideRounded = (numerator: bigint, denominator: bigint): bigint => {
  const half = denominator / 2n
  return numerator >= 0n
    ? (numerator + half) / denominator
    : -((-numerator + half) / denominator)
}

export interface RecordRatesInput {
  readonly baseCurrency: string
  readonly asOf: string
  readonly source: 'ecb' | 'manual'
  readonly fetchedAt: string
  readonly rates: readonly { readonly currency: string; readonly ratePpb: number }[]
}

/**
 * Stores a day's rates, ignoring any already held.
 *
 * `INSERT OR IGNORE` rather than an upsert, because the table refuses updates:
 * a published rate for a date does not change, and re-running the feed must not
 * restate a figure somebody has already acted on. A correction is a `manual`
 * row beside it, which says plainly that a person overrode the source.
 */
export const recordExchangeRates = async (
  database: InvoiceStateDatabase,
  input: Readonly<RecordRatesInput>,
): Promise<number> => {
  let stored = 0
  for (const rate of input.rates) {
    if (rate.currency.toUpperCase() === input.baseCurrency.toUpperCase()) continue
    await database.run(
      sql`INSERT OR IGNORE INTO exchange_rates
            (base_currency, quote_currency, as_of, rate_ppb, source, fetched_at)
          VALUES (${input.baseCurrency.toUpperCase()}, ${rate.currency.toUpperCase()},
                  ${input.asOf}, ${rate.ratePpb}, ${input.source}, ${input.fetchedAt})`,
    )
    stored += 1
  }
  return stored
}
