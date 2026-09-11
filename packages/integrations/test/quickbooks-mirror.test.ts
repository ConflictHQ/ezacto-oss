import { describe, expect, it, vi } from 'vitest'
import type { QuickBooksCustomer, QuickBooksInvoice, QuickBooksPayment } from '../src/quickbooks/client.js'
import type { MirrorClient, MirrorInvoice } from '../src/quickbooks/mapping.js'
import { mirrorPrivateNote } from '../src/quickbooks/mapping.js'
import {
  inboundPayments,
  mirrorInvoice,
  type MirrorLink,
  type MirrorLinkKind,
  type MirrorQuickBooks,
} from '../src/quickbooks/mirror.js'

const clients = new Map<number, MirrorClient>(
  [
    { id: 1, name: 'Kestrel Environmental', parentClientId: null, currency: 'USD' },
    { id: 2, name: 'Northpeak', parentClientId: 1, currency: 'USD' },
  ].map((row) => [row.id, row]),
)

const invoice: MirrorInvoice = {
  id: 41,
  number: '1315',
  clientId: 2,
  currency: 'USD',
  issueDate: '2026-09-11',
  dueDate: '2026-10-11',
  subject: 'September retainer',
  notes: null,
  lines: [{ description: 'Advisory', amountCents: 250_000, quantity: 10, unitPriceCents: 25_000 }],
}

/** A link store that keeps what it is told, like the real one. */
const linkStore = (seed: Record<string, MirrorLink> = {}) => {
  const rows = new Map<string, MirrorLink>(Object.entries(seed))
  return {
    rows,
    readLink: vi.fn(async (kind: MirrorLinkKind, id: number) =>
      rows.get(`${kind}:${String(id)}`) ?? null,
    ),
    saveLink: vi.fn(async (kind: MirrorLinkKind, id: number, link: MirrorLink) => {
      rows.set(`${kind}:${String(id)}`, link)
    }),
  }
}

const customer = (id: string, displayName: string, parent?: string): QuickBooksCustomer =>
  ({
    Id: id,
    SyncToken: '0',
    DisplayName: displayName,
    ...(parent === undefined ? {} : { ParentRef: { value: parent }, Job: true }),
  }) as QuickBooksCustomer

const qbInvoice = (overrides: Partial<QuickBooksInvoice> = {}): QuickBooksInvoice =>
  ({
    Id: 'qb-inv-7',
    SyncToken: '2',
    DocNumber: '1315',
    CustomerRef: { value: 'qb-2' },
    Line: [],
    PrivateNote: mirrorPrivateNote({ id: 41 }),
    ...overrides,
  }) as QuickBooksInvoice

const quickBooks = (overrides: Partial<MirrorQuickBooks> = {}): MirrorQuickBooks => ({
  findCustomerByDisplayName: vi.fn(async () => null),
  createCustomer: vi.fn(async (input: Record<string, unknown>) =>
    customer(
      input['DisplayName'] === 'Kestrel Environmental' ? 'qb-1' : 'qb-2',
      String(input['DisplayName']),
    ),
  ),
  findInvoiceByDocNumber: vi.fn(async () => null),
  readInvoice: vi.fn(async () => null),
  createInvoice: vi.fn(async () => qbInvoice({ SyncToken: '0' })),
  updateInvoice: vi.fn(async () => qbInvoice({ SyncToken: '3' })),
  ...overrides,
})

describe('mirroring an invoice', () => {
  it('[unit] [issue 104] builds the customer chain root first, then files the invoice', async () => {
    const links = linkStore()
    const api = quickBooks()
    const outcome = await mirrorInvoice({
      invoice,
      clients,
      links,
      quickBooks: api,
      allowOnlinePayment: false,
    })

    expect(outcome).toEqual({ kind: 'created', quickBooksId: 'qb-inv-7' })
    // Root before child: a sub-customer cannot be created before its parent,
    // because ParentRef has to name something.
    const created = vi.mocked(api.createCustomer).mock.calls.map((call) => call[0]['DisplayName'])
    expect(created).toEqual(['Kestrel Environmental', 'Kestrel Environmental — Northpeak'])
    expect(vi.mocked(api.createCustomer).mock.calls[1]![0]).toMatchObject({
      Job: true,
      ParentRef: { value: 'qb-1' },
    })
    // Every level is linked as it is made, so a failure halfway leaves the work
    // already done recorded rather than repeated.
    expect(links.rows.get('customer:1')).toMatchObject({ quickBooksId: 'qb-1' })
    expect(links.rows.get('customer:2')).toMatchObject({ quickBooksId: 'qb-2' })
    expect(links.rows.get('invoice:41')).toMatchObject({ quickBooksId: 'qb-inv-7' })
    // And the invoice went to the leaf, not the root.
    expect(vi.mocked(api.createInvoice).mock.calls[0]![0]).toMatchObject({
      CustomerRef: { value: 'qb-2' },
      DocNumber: '1315',
    })
  })

  it('[security] [issue 104] a retried delivery adopts rather than creating a second invoice', async () => {
    // The acceptance. QuickBooks has no idempotency key on create, so a mirror
    // that wrote the invoice and died before recording the link must find what
    // it made.
    const links = linkStore({
      'customer:1': { quickBooksId: 'qb-1', syncToken: '0' },
      'customer:2': { quickBooksId: 'qb-2', syncToken: '0' },
    })
    const api = quickBooks({ findInvoiceByDocNumber: vi.fn(async () => qbInvoice()) })

    const outcome = await mirrorInvoice({
      invoice,
      clients,
      links,
      quickBooks: api,
      allowOnlinePayment: false,
    })

    expect(outcome).toEqual({ kind: 'adopted', quickBooksId: 'qb-inv-7' })
    expect(api.createInvoice).not.toHaveBeenCalled()
    // It writes the current state over what is there, and records the link so
    // the next run is an ordinary update.
    expect(vi.mocked(api.updateInvoice).mock.calls[0]![0]).toMatchObject({
      Id: 'qb-inv-7',
      SyncToken: '2',
    })
    expect(links.rows.get('invoice:41')).toMatchObject({ syncToken: '3' })
  })

  it('[unit] a linked invoice updates without looking it up by number', async () => {
    const links = linkStore({
      'customer:1': { quickBooksId: 'qb-1', syncToken: '0' },
      'customer:2': { quickBooksId: 'qb-2', syncToken: '0' },
      'invoice:41': { quickBooksId: 'qb-inv-7', syncToken: '2' },
    })
    const api = quickBooks()
    const outcome = await mirrorInvoice({
      invoice,
      clients,
      links,
      quickBooks: api,
      allowOnlinePayment: false,
    })
    expect(outcome).toEqual({ kind: 'updated', quickBooksId: 'qb-inv-7' })
    // The id is already known; a query by number would be a round trip to learn
    // something recorded.
    expect(api.findInvoiceByDocNumber).not.toHaveBeenCalled()
    expect(api.createCustomer).not.toHaveBeenCalled()
  })

  it('[security] refuses an invoice number QuickBooks holds for somebody else', async () => {
    const links = linkStore({
      'customer:1': { quickBooksId: 'qb-1', syncToken: '0' },
      'customer:2': { quickBooksId: 'qb-2', syncToken: '0' },
    })
    const api = quickBooks({
      findInvoiceByDocNumber: vi.fn(async () =>
        qbInvoice({ PrivateNote: 'Raised by hand in QuickBooks' }),
      ),
    })
    const outcome = await mirrorInvoice({
      invoice,
      clients,
      links,
      quickBooks: api,
      allowOnlinePayment: false,
    })
    // Updating it would destroy a document nobody asked us to touch.
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(api.updateInvoice).not.toHaveBeenCalled()
    expect(api.createInvoice).not.toHaveBeenCalled()
  })

  it('[security] refuses when the customer name is taken under a different parent', async () => {
    const links = linkStore()
    const api = quickBooks({
      findCustomerByDisplayName: vi.fn(async (name: string) =>
        name === 'Kestrel Environmental' ? customer('qb-9', name, 'qb-other') : null,
      ),
    })
    const outcome = await mirrorInvoice({
      invoice,
      clients,
      links,
      quickBooks: api,
      allowOnlinePayment: false,
    })
    // Adopting it would file our invoices against somebody else's account.
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(api.createInvoice).not.toHaveBeenCalled()
    expect(links.rows.size).toBe(0)
  })

  it('[unit] adopts a customer a previous run already made', async () => {
    const links = linkStore()
    const api = quickBooks({
      findCustomerByDisplayName: vi.fn(async (name: string) =>
        name === 'Kestrel Environmental' ? customer('qb-1', name) : null,
      ),
    })
    await mirrorInvoice({
      invoice,
      clients,
      links,
      quickBooks: api,
      allowOnlinePayment: false,
    })
    // DisplayName is unique in QuickBooks, so a second create would be refused
    // anyway -- with an error that says nothing useful.
    expect(vi.mocked(api.createCustomer).mock.calls.map((call) => call[0]['DisplayName'])).toEqual([
      'Kestrel Environmental — Northpeak',
    ])
    expect(links.rows.get('customer:1')).toMatchObject({ quickBooksId: 'qb-1' })
  })

  it('[unit] passes the online-payment choice through to the document', async () => {
    const links = linkStore({
      'customer:1': { quickBooksId: 'qb-1', syncToken: '0' },
      'customer:2': { quickBooksId: 'qb-2', syncToken: '0' },
    })
    const api = quickBooks()
    await mirrorInvoice({ invoice, clients, links, quickBooks: api, allowOnlinePayment: true })
    expect(vi.mocked(api.createInvoice).mock.calls[0]![0]).toMatchObject({
      AllowOnlineACHPayment: true,
    })
  })
})

describe('reading a payment back', () => {
  const payment = (overrides: Partial<QuickBooksPayment> = {}): QuickBooksPayment =>
    ({
      Id: 'qb-pay-1',
      SyncToken: '0',
      TotalAmt: 2_500,
      TxnDate: '2026-09-20',
      Line: [
        { Amount: 2_500, LinkedTxn: [{ TxnId: 'qb-inv-7', TxnType: 'Invoice' }] },
      ],
      ...overrides,
    }) as QuickBooksPayment

  const resolve = (id: string): number | null => (id === 'qb-inv-7' ? 41 : null)

  it('[unit] turns a payment against a mirrored invoice into one of ours', () => {
    expect(inboundPayments(payment(), resolve)).toEqual([
      {
        ezactoInvoiceId: 41,
        amountCents: 250_000,
        paidOn: '2026-09-20',
        quickBooksPaymentId: 'qb-pay-1',
      },
    ])
  })

  it('[unit] ignores the parts of a payment that are not ours', () => {
    // One payment can settle several invoices and can carry an unapplied
    // credit. Lines naming an invoice we never mirrored belong to books we do
    // not keep.
    const mixed = payment({
      Line: [
        { Amount: 2_500, LinkedTxn: [{ TxnId: 'qb-inv-7', TxnType: 'Invoice' }] },
        { Amount: 1_000, LinkedTxn: [{ TxnId: 'qb-inv-99', TxnType: 'Invoice' }] },
        { Amount: 500, LinkedTxn: [{ TxnId: 'qb-est-3', TxnType: 'Estimate' }] },
        { Amount: 750 },
      ],
    })
    expect(inboundPayments(mixed, resolve).map((row) => row.ezactoInvoiceId)).toEqual([41])
  })

  it('[unit] rounds cents rather than truncating them', () => {
    const odd = payment({
      Line: [{ Amount: 33.33, LinkedTxn: [{ TxnId: 'qb-inv-7', TxnType: 'Invoice' }] }],
    })
    // 33.33 * 100 is 3332.9999... in binary floating point. Truncating loses a
    // cent on a real payment.
    expect(inboundPayments(odd, resolve)[0]!.amountCents).toBe(3_333)
  })
})
