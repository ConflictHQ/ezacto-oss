/**
 * The ECB's daily euro reference rates (issue 522).
 *
 * Chosen because it needs no account and no key, publishes a rate *for a date*
 * rather than a live quote, and is the rate a European auditor would expect to
 * see behind a converted figure. It is euro-based, which is why the store is:
 * a cross-rate is derived through EUR rather than held separately.
 *
 * It publishes on business days only, around 16:00 CET. That is not a gap to
 * paper over -- a Saturday invoice converts at Friday's rate because Friday's
 * is the rate that applied -- so this returns what the feed said and the store
 * decides which date a question takes.
 *
 * Parsed with a regular expression rather than an XML parser. The document is
 * a flat list of `<Cube currency="USD" rate="1.0800"/>` and pulling in a parser
 * for it would be a dependency in the Worker bundle for one shape that has not
 * changed in twenty years. A document that stops matching yields no rates,
 * which the caller reports rather than storing nothing silently.
 */

export const ECB_DAILY_URL =
  'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

export interface EcbRate {
  readonly currency: string
  /** Parts per billion of one euro, so the stored value is an integer. */
  readonly ratePpb: number
}

export interface EcbDailyRates {
  /** The date the feed says these rates are for, not the day they were read. */
  readonly asOf: string
  readonly rates: readonly EcbRate[]
}

export class EcbRatesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EcbRatesError'
  }
}

const DATE = /time=['"](\d{4}-\d{2}-\d{2})['"]/u
const CUBE = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]/gu

/**
 * Turns a decimal rate into parts per billion without going through a float
 * multiplication, which would make 1.0800 land a hair under the integer it
 * should be and round a conversion the wrong way once in a while.
 */
const toPpb = (decimal: string): number | null => {
  const [whole, fraction = ''] = decimal.split('.')
  if (whole === undefined) return null
  const padded = `${fraction}000000000`.slice(0, 9)
  const value = Number(`${whole}${padded}`)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export const parseEcbDailyRates = (xml: string): EcbDailyRates => {
  const date = DATE.exec(xml)?.[1]
  if (date === undefined) {
    throw new EcbRatesError('the ECB feed carried no date')
  }
  const rates: EcbRate[] = []
  for (const match of xml.matchAll(CUBE)) {
    const ppb = toPpb(match[2]!)
    // A rate that will not parse is skipped rather than stored wrong. The
    // caller sees a short list and can say so; a zero would convert money.
    if (ppb !== null) rates.push({ currency: match[1]!, ratePpb: ppb })
  }
  if (rates.length === 0) {
    throw new EcbRatesError('the ECB feed carried no rates')
  }
  return { asOf: date, rates }
}

export const fetchEcbDailyRates = async (
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<EcbDailyRates> => {
  const response = await fetchImplementation(ECB_DAILY_URL, {
    ...(signal === undefined ? {} : { signal }),
    headers: { accept: 'application/xml' },
  })
  if (!response.ok) {
    throw new EcbRatesError(
      `the ECB feed answered ${String(response.status)}`,
    )
  }
  return parseEcbDailyRates(await response.text())
}
