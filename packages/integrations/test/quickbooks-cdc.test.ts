import { describe, expect, it, vi } from 'vitest'
import {
  QUICKBOOKS_CDC_PAGE_SIZE,
  QuickBooksApiError,
  QuickBooksClient,
  QuickBooksResponseError,
  isVoidedPayment,
  type QuickBooksPayment,
} from '../src/index.js'

// Recorded fixtures of invented data, in the shapes Intuit documents for
// change data capture. Nothing here reaches QuickBooks.

const client = (respond: (request: Request) => Response) =>
  new QuickBooksClient({
    realmId: 'realm-a',
    accessToken: 'access-1',
    fetch: async (request) => respond(request),
  })

const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

describe('QuickBooks change data capture', () => {
  it('[unit] asks for payments since an instant, read-only, and returns changes and deletions', async () => {
    const seen: Request[] = []
    const changes = await client((request) => {
      seen.push(request)
      return answer({
        CDCResponse: [
          {
            QueryResponse: [
              {
                Payment: [
                  { Id: '501', SyncToken: '1', TotalAmt: 400 },
                  { Id: '502', status: 'Deleted', domain: 'QBO' },
                ],
                startPosition: 1,
                maxResults: 2,
              },
            ],
          },
        ],
        time: '2026-10-19T05:30:00.000-07:00',
      })
    }).paymentChangesSince('2026-10-19T11:55:00.000Z')

    expect(changes.time).toBe('2026-10-19T05:30:00.000-07:00')
    expect(changes.payments.map((payment) => payment.Id)).toEqual(['501', '502'])
    expect(changes.payments[1]).toMatchObject({ status: 'Deleted' })
    expect(changes.full).toBe(false)
    const url = new URL(seen[0]!.url)
    expect(seen[0]!.method).toBe('GET')
    expect(url.pathname).toBe('/v3/company/realm-a/cdc')
    expect(url.searchParams.get('entities')).toBe('Payment')
    expect(url.searchParams.get('changedSince')).toBe('2026-10-19T11:55:00.000Z')
  })

  it('[unit] an answer with no payments is an empty window, not an error', async () => {
    const changes = await client(() =>
      answer({ CDCResponse: [{ QueryResponse: [{}] }], time: '2026-10-19T05:30:00.000-07:00' }),
    ).paymentChangesSince('2026-10-19T11:55:00.000Z')
    expect(changes.payments).toEqual([])
  })

  it("[unit] a window at Intuit's ceiling is marked incomplete", async () => {
    const payments = Array.from({ length: QUICKBOOKS_CDC_PAGE_SIZE }, (_, index) => ({
      Id: String(index),
      SyncToken: '0',
      TotalAmt: 1,
    }))
    const changes = await client(() =>
      answer({
        CDCResponse: [{ QueryResponse: [{ Payment: payments }] }],
        time: '2026-10-19T12:00:00Z',
      }),
    ).paymentChangesSince('2026-10-19T11:55:00.000Z')
    expect(changes.full).toBe(true)
  })

  it('[unit] refuses an answer without the time the cursor is taken from', async () => {
    await expect(
      client(() => answer({ CDCResponse: [] })).paymentChangesSince('2026-10-19T11:55:00.000Z'),
    ).rejects.toBeInstanceOf(QuickBooksResponseError)
  })

  it('[unit] a throttled answer carries how long Intuit asked us to wait', async () => {
    const throttled = vi.fn(() =>
      answer({ Fault: { Error: [{ code: '3001', Message: 'ThrottleExceeded' }] } }, 429, {
        'retry-after': '7',
      }),
    )
    const error = await client(throttled)
      .paymentChangesSince('2026-10-19T11:55:00.000Z')
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(QuickBooksApiError)
    expect(error).toMatchObject({ status: 429, code: '3001', retryAfterSeconds: 7 })

    const bare = await client(() => answer({ Fault: { Error: [{ code: '3001' }] } }, 429))
      .paymentChangesSince('2026-10-19T11:55:00.000Z')
      .catch((caught: unknown) => caught)
    expect(bare).toMatchObject({ status: 429, retryAfterSeconds: null })
  })
})

describe('QuickBooks Retry-After', () => {
  const now = Date.parse('2026-10-23T12:00:00Z')
  for (const [header, expected] of [
    ['7200', 7200],
    ['Fri, 23 Oct 2026 12:02:00 GMT', 120],
    ['Fri, 23 Oct 2026 11:59:00 GMT', 0],
    ['not a date', null],
    ['999999999999', null],
    ['999999999999999999999999', null],
  ] as const) {
    it(`parses ${header} without shortening the provider delay`, async () => {
      const api = new QuickBooksClient({
        realmId: 'realm-a',
        accessToken: 'access',
        now: () => new Date(now),
        fetch: async () => answer({}, 429, { 'retry-after': header }),
      })
      const error = await api
        .paymentChangesSince('2026-10-23T11:00:00Z')
        .catch((caught: unknown) => caught)
      expect(error).toMatchObject({ status: 429, retryAfterSeconds: expected })
    })
  }
})

describe('isVoidedPayment', () => {
  const base: QuickBooksPayment = { Id: '501', SyncToken: '2', TotalAmt: 0, PrivateNote: 'Voided' }

  it('[unit] is a zeroed payment whose private note says Voided', () => {
    expect(isVoidedPayment(base)).toBe(true)
    expect(isVoidedPayment({ ...base, PrivateNote: ' voided ' })).toBe(true)
  })

  it('[unit] is not a payment entered at nothing, nor a live one with a note', () => {
    expect(isVoidedPayment({ Id: '501', SyncToken: '2', TotalAmt: 0 })).toBe(false)
    expect(isVoidedPayment({ ...base, PrivateNote: 'Check 114' })).toBe(false)
    expect(isVoidedPayment({ ...base, TotalAmt: 400 })).toBe(false)
  })
})
