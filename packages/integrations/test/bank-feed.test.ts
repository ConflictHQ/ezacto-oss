import { describe, expect, it, vi } from 'vitest'
import { isNeutralDeposit, matchDeposit } from '@ezacto/core'
import { createMercuryBankFeed } from '../src/bank-feed/mercury.js'
import { createWiseBankFeed } from '../src/bank-feed/wise.js'
import { BankFeedError } from '../src/bank-feed/shared.js'

// Synthetic fixtures based on official response schemas; not captured provider data.
const common = {
  token: 'synthetic-private-token',
  currency: 'USD',
  intervalStart: '2026-09-01T00:00:00.000Z',
  intervalEnd: '2026-09-30T23:59:59.999Z',
}
const transaction = (extra: Record<string, unknown> = {}) => ({
  id: 'txn-1',
  accountId: 'account-1',
  amount: 12.34,
  postedAt: '2026-09-02T03:04:05.678Z',
  status: 'sent',
  kind: 'incomingDomesticWire',
  counterpartyId: 'other-party',
  counterpartyName: 'Example client',
  externalMemo: 'EZ-AABBCCDDEEFF',
  ...extra,
})
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
const mercury = (transactions: unknown[], page: unknown = {}) => response({ transactions, page })
const wiseTransaction = (extra: Record<string, unknown> = {}) => ({
  referenceNumber: 'DEPOSIT-1',
  type: 'CREDIT',
  date: '2026-09-02T03:04:05.678Z',
  amount: { value: 12.34, currency: 'USD' },
  details: {
    type: 'DEPOSIT',
    paymentReference: 'EZ-AABBCCDDEEFF',
    senderName: 'Example client',
    senderAccount: 'DO-NOT-STORE',
  },
  ...extra,
})
const statement = (transactions: unknown[], extra: Record<string, unknown> = {}) =>
  response({
    query: {
      currency: 'USD',
      accountId: 12,
      intervalStart: common.intervalStart,
      intervalEnd: common.intervalEnd,
    },
    bankDetails: { accountNumber: 'DO-NOT-STORE' },
    transactions,
    ...extra,
  })

describe('Mercury read-only bank feed', () => {
  it('reads posted credits with exact cents, verified currency, classification and no bank detail leakage', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(mercury([transaction({ details: { accountNumber: 'DO-NOT-STORE' } })]))
    const feed = createMercuryBankFeed({ ...common, accountId: 'account-1', fetchImplementation })
    const result = await feed.poll(null)
    expect(result.deposits).toEqual([
      {
        provider_transaction_id: 'txn-1',
        currency: 'USD',
        amount_cents: 1234,
        posted_at: '2026-09-02T03:04:05.678Z',
        memo: 'EZ-AABBCCDDEEFF',
        counterparty: 'Example client',
      },
    ])
    expect(result.deposits.every(isNeutralDeposit)).toBe(true)
    expect(result.observations['txn-1']).toMatchObject({
      status: 'final',
      classification: 'external_credit',
    })
    expect(JSON.stringify(result)).not.toContain('DO-NOT-STORE')
    const [url, request] = fetchImplementation.mock.calls[0]!
    expect(String(url)).toContain('postedStart=')
    expect(String(url)).toContain('limit=100')
    expect(request).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(result.cursor).toBeNull()
  })
  it('omits own payouts/internal moves/debits but retains ambiguous, pending, reversed and unknown credits', async () => {
    const rows = [
      transaction({ id: 'negative', amount: -12 }),
      transaction({ id: 'internal', kind: 'internalTransfer' }),
      transaction({ id: 'treasury', kind: 'treasuryTransfer' }),
      transaction({ id: 'own', counterpartyId: 'own-id' }),
      transaction({ id: 'outgoing', kind: 'outgoingPayment', amount: 12 }),
      transaction({ id: 'ambiguous', kind: 'externalTransfer' }),
      transaction({ id: 'pending', status: 'pending' }),
      transaction({ id: 'reversed', status: 'reversed' }),
      transaction({ id: 'unknown', status: 'new_provider_state' }),
      transaction({ id: 'failed', status: 'failed' }),
      transaction({ id: 'unposted', postedAt: null }),
    ]
    const feed = createMercuryBankFeed({
      ...common,
      accountId: 'account-1',
      ownCounterpartyIds: ['own-id'],
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(mercury(rows)),
    })
    const result = await feed.poll(null)
    expect(result.deposits.map((d) => d.provider_transaction_id)).toEqual([
      'ambiguous',
      'pending',
      'reversed',
      'unknown',
    ])
    expect(result.observations.ambiguous!.classification).toBe('ambiguous_credit')
    expect(result.observations.pending!.status).toBe('pending')
    expect(result.observations.reversed!.status).toBe('reversed')
    expect(result.observations.unknown!.status).toBe('unknown')
  })
  it('replays a page and binds the pagination cursor to account/currency/window/environment', async () => {
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () =>
      mercury([transaction(), transaction({ id: 'filtered-tail', amount: -5 })], {
        nextPage: 'first-unseen-txn',
      }),
    )
    const feed = createMercuryBankFeed({ ...common, accountId: 'account-1', fetchImplementation })
    const first = await feed.poll(null)
    expect(await feed.poll(null)).toEqual(first)
    fetchImplementation.mockResolvedValueOnce(mercury([transaction({ id: 'txn-2' })]))
    expect((await feed.poll(first.cursor)).deposits[0]!.provider_transaction_id).toBe('txn-2')
    expect(String(fetchImplementation.mock.calls[2]![0])).toContain('start_after=filtered-tail')
    const other = createMercuryBankFeed({ ...common, accountId: 'account-2', fetchImplementation })
    await expect(other.poll(first.cursor)).rejects.toMatchObject({ code: 'cursor' })
  })
  it.each([
    { accountId: 'wrong' },
    { amount: 1.001 },
    { postedAt: '2026-09-31T00:00:00Z' },
    { postedAt: '2026-10-01T00:00:00Z' },
  ])('rejects corrupted identity/money/date without advancing (%j)', async (change) => {
    const feed = createMercuryBankFeed({
      ...common,
      accountId: 'account-1',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(mercury([transaction(change)])),
    })
    await expect(feed.poll(null)).rejects.toMatchObject({ code: 'response' })
  })
})

describe('Wise public statement feed', () => {
  it('carries deposits as nonconfirmable until finality can be independently proven', async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(statement([wiseTransaction()]))
    const result = await createWiseBankFeed({
      ...common,
      profileId: '99',
      balanceId: '12',
      fetchImplementation,
    }).poll(null)
    expect(result.deposits[0]).toMatchObject({
      amount_cents: 1234,
      provider_transaction_id: 'DEPOSIT-1',
    })
    expect(result.deposits.every(isNeutralDeposit)).toBe(true)
    expect(result.observations['DEPOSIT-1']).toEqual({
      status: 'unknown',
      classification: 'external_credit',
      reason: 'wise_statement_finality_unverified',
    })
    expect(JSON.stringify(result)).not.toContain('DO-NOT-STORE')
    expect(String(fetchImplementation.mock.calls[0]![0])).toContain(
      '/2026Q4/profiles/99/balance-statements/12/statement.json',
    )
  })
  it('excludes internal/topup/conversion/refund types and outgoing entries while retaining ambiguous credits', async () => {
    const types = [
      'CONVERSION',
      'MONEY_ADDED',
      'INCOMING_CROSS_BALANCE',
      'OUTGOING_CROSS_BALANCE',
      'CARD',
      'BALANCE_INTEREST',
      'TRANSFER',
      'UNKNOWN',
    ]
    const rows = types.map((type, index) =>
      wiseTransaction({ referenceNumber: `ref-${index}`, details: { type } }),
    )
    rows.push(
      wiseTransaction({
        referenceNumber: 'outgoing',
        type: 'DEBIT',
        amount: { currency: 'USD', value: -30 },
      }),
    )
    const result = await createWiseBankFeed({
      ...common,
      profileId: '99',
      balanceId: '12',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(statement(rows)),
    }).poll(null)
    expect(result.deposits.map((d) => d.provider_transaction_id)).toEqual(['ref-6', 'ref-7'])
    expect(
      result.deposits
        .map((deposit) => result.observations[deposit.provider_transaction_id]!)
        .every((o) => o.status === 'unknown' && o.classification === 'ambiguous_credit'),
    ).toBe(true)
  })
  it('paginates by stable date+reference, replays deterministically, and completes a 201-row statement', async () => {
    const rows = Array.from({ length: 201 }, (_, i) =>
      wiseTransaction({ referenceNumber: `ref-${String(i).padStart(3, '0')}` }),
    )
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => statement([...rows].reverse()))
    const feed = createWiseBankFeed({
      ...common,
      profileId: '99',
      balanceId: '12',
      fetchImplementation,
    })
    const first = await feed.poll(null)
    expect(await feed.poll(null)).toEqual(first)
    const second = await feed.poll(first.cursor)
    const last = await feed.poll(second.cursor)
    expect([first.deposits.length, second.deposits.length, last.deposits.length]).toEqual([
      100, 100, 1,
    ])
    expect(last.cursor).toBeNull()
    expect(
      new Set(
        [...first.deposits, ...second.deposits, ...last.deposits].map(
          (d) => d.provider_transaction_id,
        ),
      ).size,
    ).toBe(201)
  })
  it('rejects currency and balance identity mismatches rather than creating a wrong receipt', async () => {
    for (const body of [
      statement([wiseTransaction({ amount: { value: 1, currency: 'EUR' } })]),
      statement([], {
        query: {
          currency: 'USD',
          accountId: 13,
          intervalStart: common.intervalStart,
          intervalEnd: common.intervalEnd,
        },
      }),
    ]) {
      const feed = createWiseBankFeed({
        ...common,
        profileId: '99',
        balanceId: '12',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(body),
      })
      await expect(feed.poll(null)).rejects.toMatchObject({ code: 'response' })
    }
  })
})

describe('bank feed boundaries', () => {
  it.each([401, 403, 429, 500])(
    'preserves HTTP %s while withholding provider body and token',
    async (status) => {
      const feed = createMercuryBankFeed({
        ...common,
        accountId: 'account-1',
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('private-provider-body', { status })),
      })
      const error = await feed.poll(null).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(BankFeedError)
      expect(error).toMatchObject({ code: 'provider', status })
      expect(String(error)).not.toMatch(/private-provider-body|synthetic-private-token/)
    },
  )
  it('rejects oversized, invalid JSON and network errors safely', async () => {
    for (const value of [new Response('x'.repeat(2 * 1024 * 1024 + 1)), new Response('not-json')]) {
      const feed = createMercuryBankFeed({
        ...common,
        accountId: 'account-1',
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(value),
      })
      await expect(feed.poll(null)).rejects.toMatchObject({ code: 'response' })
    }
    const feed = createMercuryBankFeed({
      ...common,
      accountId: 'account-1',
      fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(new Error(common.token)),
    })
    await expect(feed.poll(null)).rejects.toMatchObject({
      code: 'transport',
      message: 'Bank feed transport',
    })
  })
  it('refuses unsupported minor units, invalid currency, and oversized/inverted windows', () => {
    for (const changes of [
      { currency: 'JPY' },
      { currency: 'BHD' },
      { currency: 'XXX' },
      { intervalEnd: common.intervalStart },
      { intervalStart: '2026-01-01T00:00:00Z' },
    ]) {
      expect(() =>
        createMercuryBankFeed({ ...common, accountId: 'account-1', ...changes }),
      ).toThrow(BankFeedError)
    }
  })
})

it('matches synthetic inbound reference fixtures from both providers without crossing currencies', async () => {
  const feeds = [
    createMercuryBankFeed({
      ...common,
      accountId: 'account-1',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(mercury([transaction()])),
    }),
    createWiseBankFeed({
      ...common,
      profileId: '99',
      balanceId: '12',
      fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(statement([wiseTransaction()])),
    }),
  ]
  const candidates = [
    {
      invoice_id: 1,
      reference_token: 'EZ-AABBCCDDEEFF',
      currency: 'USD',
      due_cents: 1234,
      issue_date: '2026-09-01',
    },
    {
      invoice_id: 2,
      reference_token: 'EZ-AABBCCDDEEFF',
      currency: 'EUR',
      due_cents: 1234,
      issue_date: '2026-09-01',
    },
  ]
  for (const feed of feeds) {
    const deposit = (await feed.poll(null)).deposits[0]!
    expect(matchDeposit(deposit, candidates)).toEqual({
      state: 'suggested',
      invoice_id: 1,
      basis: 'token_and_amount',
    })
    expect(matchDeposit(deposit, [candidates[1]!])).toEqual({
      state: 'unmatched',
      reason: 'no_candidate',
    })
  }
})

it('does not treat returned payouts as receipts and records explicit later reversal', async () => {
  const rows = [
    transaction({
      id: 'return',
      relatedTransactions: [{ relationKind: 'ReturnToOriginalTransaction' }],
    }),
    transaction({
      id: 'reversed-original',
      relatedTransactions: [{ relationKind: 'OriginalTransactionToReturn' }],
    }),
    transaction({
      id: 'unknown-relation',
      relatedTransactions: [{ relationKind: 'NEW_PROVIDER_RELATION' }],
    }),
  ]
  const result = await createMercuryBankFeed({
    ...common,
    accountId: 'account-1',
    fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(mercury(rows)),
  }).poll(null)
  expect(result.deposits.map((d) => d.provider_transaction_id)).toEqual([
    'reversed-original',
    'unknown-relation',
  ])
  expect(result.observations['reversed-original']!.status).toBe('reversed')
  expect(result.observations['unknown-relation']!.classification).toBe('ambiguous_credit')
})

it('rejects a malformed Wise same-scope cursor before making another request', async () => {
  const rows = Array.from({ length: 101 }, (_, i) =>
    wiseTransaction({ referenceNumber: `ref-${i}` }),
  )
  const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => statement(rows))
  const feed = createWiseBankFeed({
    ...common,
    profileId: '99',
    balanceId: '12',
    fetchImplementation,
  })
  const page = await feed.poll(null)
  const cursor = JSON.parse(page.cursor!) as { key: string }
  cursor.key = 'zzzzz'
  await expect(feed.poll(JSON.stringify(cursor))).rejects.toMatchObject({ code: 'cursor' })
  expect(fetchImplementation).toHaveBeenCalledTimes(1)
})

it('returns observation-only invalidations when a previously seen credit becomes ineligible', async () => {
  const mercuryResponse = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(mercury([transaction()]))
    .mockResolvedValueOnce(mercury([transaction({ status: 'failed' })]))
  const mercuryFeed = createMercuryBankFeed({
    ...common,
    accountId: 'account-1',
    fetchImplementation: mercuryResponse,
  })
  expect((await mercuryFeed.poll(null)).observations['txn-1']!.status).toBe('final')
  const changed = await mercuryFeed.poll(null)
  expect(changed.deposits).toEqual([])
  expect(changed.observations['txn-1']).toMatchObject({
    status: 'ineligible',
    reason: 'mercury_not_receivable',
  })
  const wiseFeed = createWiseBankFeed({
    ...common,
    profileId: '99',
    balanceId: '12',
    fetchImplementation: vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        statement([wiseTransaction({ type: 'DEBIT', amount: { value: -12.34, currency: 'USD' } })]),
      ),
  })
  const wiseChanged = await wiseFeed.poll(null)
  expect(wiseChanged.deposits).toEqual([])
  expect(wiseChanged.observations['DEPOSIT-1']).toMatchObject({
    classification: 'internal_transfer',
    reason: 'wise_non_receipt',
  })
})

it('bounds observation-only invalidations across Wise statement pages', async () => {
  const rows = Array.from({ length: 201 }, (_, i) =>
    wiseTransaction({
      referenceNumber: `ref-${String(i).padStart(3, '0')}`,
      type: 'DEBIT',
      amount: { currency: 'USD', value: -1 },
    }),
  )
  const feed = createWiseBankFeed({
    ...common,
    profileId: '99',
    balanceId: '12',
    fetchImplementation: vi.fn<typeof fetch>().mockImplementation(async () => statement(rows)),
  })
  const first = await feed.poll(null),
    second = await feed.poll(first.cursor),
    third = await feed.poll(second.cursor)
  expect([first, second, third].map((page) => Object.keys(page.observations).length)).toEqual([
    100, 100, 1,
  ])
  expect([first, second, third].every((page) => page.deposits.length === 0)).toBe(true)
  expect(third.cursor).toBeNull()
})

it('does not turn cancelled unposted funds into a verifiable unknown credit', async () => {
  const feed = createMercuryBankFeed({
    ...common,
    accountId: 'account-1',
    fetchImplementation: vi
      .fn<typeof fetch>()
      .mockResolvedValue(mercury([transaction({ status: 'cancelled', postedAt: null })])),
  })
  const result = await feed.poll(null)
  expect(result.deposits).toEqual([])
  expect(result.observations['txn-1']!.status).toBe('ineligible')
})

it('preserves known reversal even when the posting date is absent', async () => {
  for (const changes of [
    { status: 'reversed' },
    { relatedTransactions: [{ relationKind: 'OriginalTransactionToReturn' }] },
  ]) {
    const feed = createMercuryBankFeed({
      ...common,
      accountId: 'account-1',
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(mercury([transaction({ ...changes, postedAt: null })])),
    })
    const result = await feed.poll(null)
    expect(result.deposits).toEqual([])
    expect(result.observations['txn-1']!.status).toBe('reversed')
  }
})
