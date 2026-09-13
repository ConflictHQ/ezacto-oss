// Provenance: issue 522, the half it calls "not a unit and some math".
//
// The model is already multi-currency and honestly refuses to consolidate --
// `contractorCostReport` says so in as many words: adding two currencies would
// "invent an exchange rate this system does not hold". This is the table that
// holds one.
//
// Two decisions are baked in here, and both are about a rate being evidence
// rather than a calculation.
//
// A rate is stored as used, never re-derived. An invoice converted in August at
// August's rate must still read the same in December: re-converting later would
// silently restate a figure somebody has already acted on, which is the failure
// a ledger exists to prevent. So every conversion records the rate it used, and
// nothing recomputes.
//
// A rate belongs to a date, and the date is the question's, not today's. The
// issue is explicit that which date differs per question -- an invoice converts
// at its issue date, a report at the date its period ends. This table stores
// `as_of` and the caller says which one it wants; nothing here assumes.
//
// Rates are euro-based because the ECB's are, and a cross-rate is derived
// through EUR rather than stored. Storing USD->GBP directly alongside the two
// legs would be two places for the same fact, and they would disagree the first
// time one was refreshed without the other.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

const canonicalCurrency = (column: string) =>
  `${column} = upper(${column}) AND length(${column}) = 3 AND ${column} NOT GLOB '*[^A-Z]*'`

export const exchangeRatesMigration = [
  `CREATE TABLE exchange_rates (
    -- Always EUR for an ECB rate. Named rather than assumed, so a second
    -- source with a different base does not have to pretend to be this one.
    base_currency TEXT NOT NULL CHECK (${canonicalCurrency('base_currency')}),
    quote_currency TEXT NOT NULL CHECK (${canonicalCurrency('quote_currency')}),
    -- The date the rate is *for*, which is the question's date and not the day
    -- it was fetched. ECB publishes on business days; a Saturday takes Friday's
    -- rate, and the row says Friday because that is the rate that applied.
    as_of TEXT NOT NULL CHECK (date(as_of, '+0 days') IS as_of),
    -- Parts per billion of the base. An integer, because a rate stored as a
    -- float is a rate that rounds differently on two machines, and money
    -- derived from it then disagrees.
    rate_ppb INTEGER NOT NULL CHECK (rate_ppb BETWEEN 1 AND 9000000000000000),
    source TEXT NOT NULL CHECK (source IN ('ecb','manual')),
    fetched_at TEXT NOT NULL CHECK (${canonicalTimestamp('fetched_at')}),
    PRIMARY KEY (base_currency, quote_currency, as_of, source),
    CHECK (base_currency <> quote_currency)
  ) STRICT`,

  `CREATE INDEX exchange_rates_lookup
    ON exchange_rates(quote_currency, as_of)`,

  // A published rate for a date does not change. Refreshing would restate
  // figures already derived from it -- the thing this table exists to stop --
  // so a correction is a `manual` row beside it, which the primary key allows
  // and which says plainly that somebody overrode the source.
  `CREATE TRIGGER exchange_rates_immutable
    BEFORE UPDATE ON exchange_rates
    BEGIN SELECT RAISE(ABORT, 'a published rate is immutable'); END`,
] as const
