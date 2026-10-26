import type { NeutralDeposit } from '@ezacto/core'
import type { ObservedBankFeed } from './mercury.js'
import {
  BankFeedError,
  cents,
  configuration,
  cursorKey,
  cursorOf,
  identifier,
  object,
  optionalText,
  readJson,
  timestamp,
  type FeedObservations,
  type ReadFeedOptions,
} from './shared.js'

export interface WiseBankFeedOptions extends ReadFeedOptions {
  profileId: string
  balanceId: string
}
const excluded = new Set([
  'CARD',
  'CONVERSION',
  'MONEY_ADDED',
  'INCOMING_CROSS_BALANCE',
  'OUTGOING_CROSS_BALANCE',
  'DIRECT_DEBIT',
  'BALANCE_INTEREST',
  'BALANCE_ADJUSTMENT',
  'ACCRUAL_CHARGE',
  'INVESTMENT_TRADE_ORDER',
  'CARD_CASHBACK',
  'CARD_ORDER_CHECKOUT',
])
/** Public personal-token statement API. Statement credits alone do not prove settlement. */
export const createWiseBankFeed = (options: Readonly<WiseBankFeedOptions>): ObservedBankFeed => {
  const { start, end } = configuration(options)
  if (!/^\d{1,20}$/.test(options.profileId) || !/^\d{1,20}$/.test(options.balanceId))
    throw new BankFeedError('configuration')
  const scope = `wise:${options.environment ?? 'production'}:${options.profileId}:${options.balanceId}:${options.currency}:${start}:${end}`
  return {
    async poll(cursor) {
      const after = cursorKey(cursor, scope)
      if (after !== null) {
        const separator = after.indexOf('|')
        try {
          const date = after.slice(0, separator)
          if (separator < 0 || timestamp(date) !== date || date < start || date > end)
            throw new Error()
          identifier(after.slice(separator + 1))
        } catch {
          throw new BankFeedError('cursor')
        }
      }
      const url = new URL(
        `/2026Q4/profiles/${options.profileId}/balance-statements/${options.balanceId}/statement.json`,
        options.environment === 'sandbox' ? 'https://api.wise-sandbox.com' : 'https://api.wise.com',
      )
      url.search = new URLSearchParams({
        currency: options.currency,
        intervalStart: start,
        intervalEnd: end,
        type: 'COMPACT',
      }).toString()
      const body = object(await readJson(url, options))
      const query = object(body.query)
      if (
        query.currency !== options.currency ||
        String(query.accountId) !== options.balanceId ||
        timestamp(query.intervalStart) !== start ||
        timestamp(query.intervalEnd) !== end
      )
        throw new BankFeedError('response')
      if (!Array.isArray(body.transactions) || body.transactions.length > 10_000)
        throw new BankFeedError('response')
      const candidates: { key: string; deposit: NeutralDeposit; kind: string }[] = []
      const seen = new Set<string>()
      for (const raw of body.transactions) {
        const row = object(raw)
        const id = identifier(row.referenceNumber)
        if (seen.has(id)) throw new BankFeedError('response')
        seen.add(id)
        const amount = object(row.amount)
        if (amount.currency !== options.currency) throw new BankFeedError('response')
        const value = cents(amount.value)
        if (row.type === 'DEBIT' || value <= 0) continue
        if (row.type !== 'CREDIT') throw new BankFeedError('response')
        const details = object(row.details)
        if (typeof details.type !== 'string') throw new BankFeedError('response')
        if (excluded.has(details.type)) continue
        const date = timestamp(row.date)
        if (date < start || date > end) throw new BankFeedError('response')
        const key = `${date}|${id}`
        candidates.push({
          key,
          kind: details.type,
          deposit: {
            provider_transaction_id: id,
            currency: options.currency,
            amount_cents: value,
            posted_at: date,
            memo: optionalText(details.paymentReference),
            counterparty: optionalText(details.senderName),
          },
        })
      }
      candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const remaining = candidates.filter((entry) => after === null || entry.key > after)
      const page = remaining.slice(0, 100)
      const observations: FeedObservations = Object.create(null) as FeedObservations
      for (const { deposit, kind } of page)
        observations[deposit.provider_transaction_id] = {
          status: 'unknown',
          classification: kind === 'DEPOSIT' ? 'external_credit' : 'ambiguous_credit',
          reason: 'wise_statement_finality_unverified',
        }
      return {
        deposits: page.map(({ deposit }) => deposit),
        observations,
        cursor: remaining.length > 100 ? cursorOf(scope, page[page.length - 1]!.key) : null,
      }
    },
  }
}
