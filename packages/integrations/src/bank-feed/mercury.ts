import type { BankFeed, BankFeedPage, NeutralDeposit } from '@ezacto/core'
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

export interface MercuryBankFeedOptions extends ReadFeedOptions {
  accountId: string
  /** Mercury's transaction/account schemas omit currency. Must be verified by the operator. */
  currency: string
  /** Previously verified own account/recipient identities, never guessed by matching names. */
  ownCounterpartyIds?: readonly string[]
}
export type ObservedBankFeedPage = BankFeedPage & { observations: FeedObservations }
export interface ObservedBankFeed extends BankFeed {
  poll(cursor: string | null): Promise<ObservedBankFeedPage>
}
const omittedKinds = new Set([
  'internalTransfer',
  'treasuryTransfer',
  'outgoingPayment',
  'creditCardCredit',
  'creditCardTransaction',
  'debitCardCredit',
  'debitCardTransaction',
  'cardInternationalTransactionFee',
  'cardInternationalTransactionFeeRebate',
  'cardInternationalTransactionFeeReversal',
  'cardInternationalTransactionFeeRebateReversal',
  'currencyCloudReturn',
  'wireFee',
  'personalBankingSubscriptionFee',
  'billingEngineSubscriptionFee',
  'expenseReimbursement',
  'exogenousWireDrawdown',
  'interestPayment',
])
const ownReturnRelations = new Set([
  'ReturnToOriginalTransaction',
  'PaymentRefundToFailedPayment',
  'MerchantRefundToOriginalCharge',
  'MerchantRefundToFraudulentCharge',
  'ProvisionalCreditReversalToMerchantRefund',
  'GiftCompensationToOriginalTransaction',
  'FeeRebateToFeePayment',
  'FeeReversalToFeePayment',
  'FeeAtmReimbursementToAtmTransaction',
])
const reversalRelations = new Set(['OriginalTransactionToReturn', 'ProvisionalCreditToReversal'])
const externalKinds = new Set(['incomingDomesticWire', 'incomingInternationalWire', 'checkDeposit'])
/** One provider GET, at most 100 observations; terminal null intentionally permits a full rescan. */
export const createMercuryBankFeed = (
  options: Readonly<MercuryBankFeedOptions>,
): ObservedBankFeed => {
  const { start, end } = configuration(options)
  let accountId: string
  try {
    accountId = identifier(options.accountId)
  } catch {
    throw new BankFeedError('configuration')
  }
  const own = new Set(options.ownCounterpartyIds ?? [])
  const scope = `mercury:${options.environment ?? 'production'}:${accountId}:${options.currency}:${start}:${end}`
  return {
    async poll(cursor) {
      const after = cursorKey(cursor, scope)
      if (after !== null) {
        try {
          identifier(after)
        } catch {
          throw new BankFeedError('cursor')
        }
      }
      const url = new URL(
        '/api/v1/transactions',
        options.environment === 'sandbox'
          ? 'https://api-sandbox.mercury.com'
          : 'https://api.mercury.com',
      )
      url.search = new URLSearchParams({
        accountId,
        postedStart: start,
        postedEnd: end,
        order: 'asc',
        limit: '100',
        ...(after === null ? {} : { start_after: after }),
      }).toString()
      const body = object(await readJson(url, options))
      if (!Array.isArray(body.transactions) || body.transactions.length > 100)
        throw new BankFeedError('response')
      const deposits: NeutralDeposit[] = []
      const observations: FeedObservations = Object.create(null) as FeedObservations
      const seen = new Set<string>()
      for (const raw of body.transactions) {
        const row = object(raw)
        const id = identifier(row.id)
        if (seen.has(id) || row.accountId !== accountId) throw new BankFeedError('response')
        seen.add(id)
        const amount = cents(row.amount)
        if (row.relatedTransactions !== undefined && !Array.isArray(row.relatedTransactions))
          throw new BankFeedError('response')
        const relations = (row.relatedTransactions ?? []).map((relation: unknown) => {
          const kind = object(relation).relationKind
          if (typeof kind !== 'string') throw new BankFeedError('response')
          return kind
        })
        if (relations.some((relation: string) => ownReturnRelations.has(relation))) continue
        if (
          amount <= 0 ||
          omittedKinds.has(String(row.kind)) ||
          own.has(String(row.counterpartyId))
        )
          continue
        if (row.postedAt === null || row.postedAt === undefined) continue
        const postedAt = timestamp(row.postedAt)
        if (postedAt < start || postedAt > end) throw new BankFeedError('response')
        if (typeof row.kind !== 'string' || typeof row.status !== 'string')
          throw new BankFeedError('response')
        const status = relations.some((relation: string) => reversalRelations.has(relation))
          ? 'reversed'
          : row.status === 'sent'
            ? 'final'
            : row.status === 'pending'
              ? 'pending'
              : row.status === 'reversed'
                ? 'reversed'
                : 'unknown'
        // Failed/cancelled/blocked are never receipts. Unknown provider states remain visible, nonconfirmable.
        if (['failed', 'cancelled', 'blocked'].includes(row.status)) continue
        deposits.push({
          provider_transaction_id: id,
          amount_cents: amount,
          currency: options.currency,
          posted_at: postedAt,
          memo: optionalText(row.externalMemo),
          counterparty: optionalText(row.counterpartyName),
        })
        observations[id] = {
          status,
          classification:
            externalKinds.has(row.kind) && relations.length === 0
              ? 'external_credit'
              : 'ambiguous_credit',
          reason:
            externalKinds.has(row.kind) && relations.length === 0
              ? 'mercury_posted_inbound'
              : 'mercury_unclassified_credit',
        }
      }
      const page = object(body.page)
      const next =
        page.nextPage === undefined || page.nextPage === null ? null : identifier(page.nextPage)
      if (next !== null && (next === after || body.transactions.length === 0))
        throw new BankFeedError('response')
      const lastId =
        body.transactions.length === 0
          ? null
          : identifier(object(body.transactions[body.transactions.length - 1]).id)
      if (next !== null && lastId === after) throw new BankFeedError('response')
      return { deposits, observations, cursor: next === null ? null : cursorOf(scope, lastId!) }
    },
  }
}
