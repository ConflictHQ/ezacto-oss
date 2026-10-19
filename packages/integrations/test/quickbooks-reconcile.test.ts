import { describe, expect, it, vi } from 'vitest'
import {
  QUICKBOOKS_QUERY_PAGE_SIZE,
  QuickBooksClient,
  reconcileInvoices,
  type QuickBooksInvoice,
  type ReconcileLocalInvoice,
} from '../src/index.js'

const ours = (overrides: Partial<ReconcileLocalInvoice> = {}): ReconcileLocalInvoice => ({
  id: 1,
  number: '1001',
  currency: 'USD',
  amountCents: 100_000,
  paidCents: 0,
  quickBooksId: 'q1',
  ...overrides,
})

const theirs = (overrides: Partial<QuickBooksInvoice> = {}): QuickBooksInvoice => ({
  Id: 'q1',
  SyncToken: '0',
  DocNumber: '1001',
  CustomerRef: { value: 'c' },
  TotalAmt: 1000,
  Balance: 1000,
  Line: [],
  ...overrides,
})

const one = (local: ReconcileLocalInvoice, remote: QuickBooksInvoice) =>
  reconcileInvoices([local], [remote]).rows[0]!

describe('classifying one invoice', () => {
  it('matched where total, currency and received money agree', () => {
    expect(one(ours(), theirs())).toMatchObject({ status: 'matched', issues: [], detail: '' })
  })

  it('amount_differs on a total that disagrees by a cent', () => {
    expect(one(ours(), theirs({ TotalAmt: 999.99, Balance: 999.99 }))).toMatchObject({
      status: 'amount_differs',
      ezactoAmountCents: 100_000,
      quickBooksAmountCents: 99_999,
    })
  })

  it('currency_differs only where QuickBooks states a currency', () => {
    expect(one(ours(), theirs({ CurrencyRef: { value: 'EUR' } })).status).toBe('currency_differs')
    // A single-currency company states none; that is not a difference.
    expect(one(ours(), theirs()).status).toBe('matched')
  })

  it('payments_differ where QuickBooks has received more, and says it is partial', () => {
    const row = one(ours(), theirs({ Balance: 600 }))
    expect(row).toMatchObject({
      status: 'payments_differ',
      ezactoPaidCents: 0,
      quickBooksPaidCents: 40_000,
    })
    expect(row.detail).toContain('partly paid there')
  })

  it('payments_differ where we recorded money QuickBooks does not hold', () => {
    expect(one(ours({ paidCents: 100_000 }), theirs()).status).toBe('payments_differ')
  })

  it('a fully paid invoice on both sides matches', () => {
    expect(one(ours({ paidCents: 100_000 }), theirs({ Balance: 0 })).status).toBe('matched')
  })

  it('does not guess about money when QuickBooks states no balance', () => {
    const withoutBalance: QuickBooksInvoice = { ...theirs() }
    delete (withoutBalance as { Balance?: number }).Balance
    expect(one(ours({ paidCents: 5_000 }), withoutBalance).status).toBe('matched')
  })

  it('voided_in_quickbooks on a zeroed document whose note says so', () => {
    expect(
      one(ours(), theirs({ TotalAmt: 0, Balance: 0, PrivateNote: 'Voided' })).status,
    ).toBe('voided_in_quickbooks')
    // A zero total without the note is an amount difference, not a void.
    expect(one(ours(), theirs({ TotalAmt: 0, Balance: 0 })).status).toBe('amount_differs')
  })

  it('lists every difference, led by the first', () => {
    const row = one(
      ours(),
      theirs({ TotalAmt: 900, Balance: 400, CurrencyRef: { value: 'EUR' } }),
    )
    expect(row.issues).toEqual(['amount_differs', 'currency_differs', 'payments_differ'])
    expect(row.status).toBe('amount_differs')
  })
})

describe('pairing', () => {
  it('missing_in_quickbooks for a link whose document is gone, and for an unlinked number', () => {
    const report = reconcileInvoices(
      [ours({ quickBooksId: 'gone' }), ours({ id: 2, number: '1002', quickBooksId: null })],
      [],
    )
    expect(report.rows.map((row) => row.status)).toEqual([
      'missing_in_quickbooks',
      'missing_in_quickbooks',
    ])
    expect(report.rows[0]!.detail).toContain('no longer holds')
  })

  it('pairs an unlinked invoice with its number and reports that it is not linked', () => {
    const row = one(ours({ quickBooksId: null }), theirs({ Id: 'q77' }))
    expect(row).toMatchObject({ status: 'matched', linked: false, quickBooksId: 'q77' })
  })

  it('prefers the link over a number that now names another document', () => {
    const report = reconcileInvoices(
      [ours()],
      [theirs({ Id: 'other', DocNumber: '1001' }), theirs({ Id: 'q1', DocNumber: 'renumbered' })],
    )
    expect(report.rows[0]).toMatchObject({ quickBooksId: 'q1', status: 'matched' })
    // The document the number names is claimed by nobody.
    expect(report.rows[1]).toMatchObject({ status: 'missing_here', quickBooksId: 'other' })
  })

  it('missing_here for a QuickBooks invoice nothing here claims, and counts every status', () => {
    const report = reconcileInvoices([ours()], [theirs(), theirs({ Id: 'q2', DocNumber: '77' })])
    expect(report.counts).toEqual({
      matched: 1,
      voided_in_quickbooks: 0,
      missing_in_quickbooks: 0,
      amount_differs: 0,
      currency_differs: 0,
      payments_differ: 0,
      missing_here: 1,
    })
    expect(report.rows[1]).toMatchObject({ number: '77', ezactoInvoiceId: null })
  })
})

describe('reading the company\'s invoices', () => {
  const page = (count: number, from: number) => ({
    QueryResponse: {
      Invoice: Array.from({ length: count }, (_, index) =>
        theirs({ Id: String(from + index), DocNumber: String(from + index) }),
      ),
    },
  })

  it('pages with STARTPOSITION until a short page, using GET only', async () => {
    const requests: Request[] = []
    const bodies = [page(QUICKBOOKS_QUERY_PAGE_SIZE, 1), page(3, QUICKBOOKS_QUERY_PAGE_SIZE + 1)]
    const client = new QuickBooksClient({
      realmId: 'realm-a',
      accessToken: 'token',
      fetch: vi.fn(async (request: Request) => {
        requests.push(request)
        return new Response(JSON.stringify(bodies.shift()), { status: 200 })
      }),
    })
    const all = await client.listInvoices()
    expect(all).toHaveLength(QUICKBOOKS_QUERY_PAGE_SIZE + 3)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    const statements = requests.map((request) => new URL(request.url).searchParams.get('query'))
    expect(statements[0]).toContain('STARTPOSITION 1 ')
    expect(statements[1]).toContain(`STARTPOSITION ${String(QUICKBOOKS_QUERY_PAGE_SIZE + 1)} `)
  })

  it('surfaces a failed page instead of reporting on a partial list', async () => {
    const client = new QuickBooksClient({
      realmId: 'realm-a',
      accessToken: 'token',
      fetch: vi.fn(async () => new Response(JSON.stringify({ Fault: { Error: [{ code: '429' }] } }), { status: 429 })),
    })
    await expect(client.listInvoices()).rejects.toThrow(/429/u)
  })
})
