import { describe, expect, it } from 'vitest'
import type { QuickBooksCustomer, QuickBooksInvoice } from '../src/quickbooks/client.js'
import {
  QuickBooksMappingError,
  clientAncestry,
  customerDisplayName,
  customerMatches,
  invoicePayload,
  invoiceUpdatePayload,
  mirrorPrivateNote,
  planInvoiceMirror,
  plannedCustomer,
  type MirrorClient,
  type MirrorInvoice,
} from '../src/quickbooks/mapping.js'

const client = (
  id: number,
  name: string,
  parentClientId: number | null = null,
  currency: string | null = 'USD',
): MirrorClient => ({ id, name, parentClientId, currency })

// The fixture directory: a parent with two subsidiaries, one of them with a
// division of its own.
const directory = new Map<number, MirrorClient>(
  [
    client(1, 'Kestrel Environmental'),
    client(2, 'Northpeak', 1),
    client(3, 'Halcyon Biolabs', 1),
    client(4, 'Ridgeline IT', 2),
  ].map((row) => [row.id, row]),
)

const invoice = (overrides: Partial<MirrorInvoice> = {}): MirrorInvoice => ({
  id: 41,
  number: '1315',
  clientId: 2,
  currency: 'USD',
  issueDate: '2026-09-11',
  dueDate: '2026-10-11',
  subject: 'September retainer',
  notes: null,
  lines: [
    { description: 'Advisory', amountCents: 250_000, quantity: 10, unitPriceCents: 25_000 },
  ],
  ...overrides,
})

describe('client tree to QuickBooks customers', () => {
  it('[unit] [issue 104] walks a client to its root, roots first', () => {
    expect(clientAncestry(4, directory).map((row) => row.name)).toEqual([
      'Kestrel Environmental',
      'Northpeak',
      'Ridgeline IT',
    ])
    expect(clientAncestry(1, directory).map((row) => row.name)).toEqual([
      'Kestrel Environmental',
    ])
  })

  it('[unit] [issue 104] maps the tree to sub-customers, not to second top-level customers', () => {
    const root = plannedCustomer(clientAncestry(1, directory), null)
    expect(root.payload).toMatchObject({ DisplayName: 'Kestrel Environmental' })
    // A root has no Job flag and no parent: it is a customer, full stop.
    expect(root.payload['Job']).toBeUndefined()
    expect(root.payload['ParentRef']).toBeUndefined()

    const child = plannedCustomer(clientAncestry(2, directory), 'qb-1')
    // `Job: true` is the whole difference. Without it QuickBooks makes a second
    // top-level customer that merely looks like a subsidiary.
    expect(child.payload).toMatchObject({
      Job: true,
      ParentRef: { value: 'qb-1' },
      DisplayName: 'Kestrel Environmental — Northpeak',
    })

    const grandchild = plannedCustomer(clientAncestry(4, directory), 'qb-2')
    expect(grandchild.payload).toMatchObject({
      Job: true,
      ParentRef: { value: 'qb-2' },
      DisplayName: 'Kestrel Environmental — Northpeak — Ridgeline IT',
    })
  })

  it('[unit] names carry ancestry, because QuickBooks needs them globally unique', () => {
    // Two clients can share a name under different parents in our tree; in
    // QuickBooks that is a duplicate DisplayName and the second create fails.
    const shared = new Map<number, MirrorClient>(
      [
        client(1, 'Kestrel Environmental'),
        client(2, 'Northpeak'),
        client(3, 'Design', 1),
        client(4, 'Design', 2),
      ].map((row) => [row.id, row]),
    )
    const first = customerDisplayName(clientAncestry(3, shared))
    const second = customerDisplayName(clientAncestry(4, shared))
    expect(first).not.toBe(second)
    expect(first).toBe('Kestrel Environmental — Design')
    // `:` is QuickBooks' own separator and is refused inside a DisplayName.
    expect(first).not.toContain(':')
  })

  it('[security] refuses a sub-customer whose parent has not been mirrored', () => {
    // Creating it without a parent would silently make a top-level customer,
    // and every invoice for that subsidiary would then be filed outside the
    // account it belongs to.
    expect(() => plannedCustomer(clientAncestry(2, directory), null)).toThrow(
      QuickBooksMappingError,
    )
  })

  it('[security] will not adopt a customer of the right name under the wrong parent', () => {
    const planned = plannedCustomer(clientAncestry(2, directory), 'qb-1')
    const correct = {
      Id: 'qb-2',
      SyncToken: '0',
      DisplayName: 'Kestrel Environmental — Northpeak',
      ParentRef: { value: 'qb-1' },
    } as QuickBooksCustomer
    expect(customerMatches(correct, planned)).toBe(true)

    // Same name, different parent. Adopting this files our invoices against
    // somebody else's account, which is a money error rather than untidiness.
    const elsewhere = { ...correct, ParentRef: { value: 'qb-99' } } as QuickBooksCustomer
    expect(customerMatches(elsewhere, planned)).toBe(false)
    const orphan = { ...correct, ParentRef: undefined } as QuickBooksCustomer
    expect(customerMatches(orphan, planned)).toBe(false)
  })

  it('[unit] refuses a tree deeper than QuickBooks accepts, naming the client', () => {
    const deep = new Map<number, MirrorClient>(
      [1, 2, 3, 4, 5, 6]
        .map((id) => client(id, `Level ${String(id)}`, id === 1 ? null : id - 1))
        .map((row) => [row.id, row]),
    )
    expect(() => clientAncestry(6, deep)).toThrow(/6 levels deep; QuickBooks allows 5/u)
  })

  it('[unit] a parent cycle is refused rather than walked forever', () => {
    const cyclic = new Map<number, MirrorClient>(
      [client(1, 'A', 2), client(2, 'B', 1)].map((row) => [row.id, row]),
    )
    expect(() => clientAncestry(1, cyclic)).toThrow(/parent cycle/u)
  })
})

describe('invoice payload', () => {
  it('[unit] carries our number as DocNumber and our id as the private note', () => {
    const payload = invoicePayload(invoice(), { customerRef: { value: 'qb-2' } })
    expect(payload).toMatchObject({
      DocNumber: '1315',
      CustomerRef: { value: 'qb-2' },
      TxnDate: '2026-09-11',
      DueDate: '2026-10-11',
      CurrencyRef: { value: 'USD' },
      // The durable back-reference. Not DocNumber, which is the number a client
      // sees and which an operator may renumber.
      PrivateNote: 'ezacto invoice 41',
    })
  })

  it('[unit] converts cents to amounts without inventing a fraction', () => {
    const payload = invoicePayload(
      invoice({
        lines: [
          { description: 'Odd', amountCents: 3_333, quantity: 1, unitPriceCents: 3_333 },
          { description: 'Round', amountCents: 100_000, quantity: 4, unitPriceCents: 25_000 },
        ],
      }),
      { customerRef: { value: 'qb-2' } },
    )
    const lines = payload['Line'] as { Amount: number; SalesItemLineDetail: { UnitPrice: number } }[]
    expect(lines[0]!.Amount).toBe(33.33)
    expect(lines[0]!.SalesItemLineDetail.UnitPrice).toBe(33.33)
    expect(lines[1]!.Amount).toBe(1_000)
  })

  it('[unit] offers online payment only when asked', () => {
    // It does nothing unless the company has QuickBooks Payments, and turning
    // it on silently changes how a client is invited to pay.
    const off = invoicePayload(invoice(), { customerRef: { value: 'qb-2' } })
    expect(off['AllowOnlineACHPayment']).toBeUndefined()
    expect(off['AllowOnlineCreditCardPayment']).toBeUndefined()

    const on = invoicePayload(invoice(), {
      customerRef: { value: 'qb-2' },
      allowOnlinePayment: true,
    })
    expect(on).toMatchObject({ AllowOnlineACHPayment: true, AllowOnlineCreditCardPayment: true })
  })

  it('[unit] refuses an invoice with no lines rather than writing an empty document', () => {
    expect(() => invoicePayload(invoice({ lines: [] }), { customerRef: { value: 'qb-2' } })).toThrow(
      QuickBooksMappingError,
    )
  })

  it('[unit] an update carries the sync token QuickBooks handed us', () => {
    const payload = invoiceUpdatePayload(
      invoice(),
      { Id: 'qb-inv-7', SyncToken: '3' },
      { customerRef: { value: 'qb-2' } },
    )
    // A stale token is refused by QuickBooks rather than merged, which is what
    // stops our write silently overwriting an edit made there.
    expect(payload).toMatchObject({ Id: 'qb-inv-7', SyncToken: '3', sparse: false })
  })
})

describe('deciding what to do with one invoice', () => {
  const qboInvoice = (overrides: Partial<QuickBooksInvoice> = {}): QuickBooksInvoice =>
    ({
      Id: 'qb-inv-7',
      SyncToken: '2',
      DocNumber: '1315',
      CustomerRef: { value: 'qb-2' },
      Line: [],
      PrivateNote: mirrorPrivateNote({ id: 41 }),
      ...overrides,
    }) as QuickBooksInvoice

  it('[unit] a linked invoice updates in place', () => {
    expect(planInvoiceMirror(invoice(), { quickBooksId: 'qb-inv-7', syncToken: '2' }, null)).toEqual(
      { kind: 'update', quickBooksId: 'qb-inv-7', syncToken: '2' },
    )
  })

  it('[unit] nothing linked and nothing there means create', () => {
    expect(planInvoiceMirror(invoice(), null, null)).toEqual({ kind: 'create' })
  })

  it('[security] [issue 104] a retry adopts what the first attempt wrote', () => {
    // The case the acceptance is about. A mirror wrote the invoice, then failed
    // before storing the link. QuickBooks has no idempotency key on create, so
    // without this the retry writes a second invoice into somebody's books.
    expect(planInvoiceMirror(invoice(), null, qboInvoice())).toEqual({
      kind: 'adopt',
      quickBooksId: 'qb-inv-7',
      syncToken: '2',
    })
  })

  it('[security] refuses to overwrite an invoice this mirror did not write', () => {
    // Same number, no private note of ours: an operator raised it in QuickBooks
    // directly. Updating it would destroy a document nobody asked us to touch.
    const theirs = qboInvoice({ PrivateNote: 'Raised by hand for the September work' })
    expect(planInvoiceMirror(invoice(), null, theirs)).toMatchObject({ kind: 'conflict' })
    const unnoted = qboInvoice({ PrivateNote: undefined })
    expect(planInvoiceMirror(invoice(), null, unnoted)).toMatchObject({ kind: 'conflict' })
    // And it says which invoice, because the operator has to resolve it.
    const conflict = planInvoiceMirror(invoice(), null, theirs)
    expect(conflict.kind === 'conflict' && conflict.reason).toContain('1315')
  })

  it('[security] a note belonging to a different invoice is not ours either', () => {
    const other = qboInvoice({ PrivateNote: mirrorPrivateNote({ id: 42 }) })
    expect(planInvoiceMirror(invoice(), null, other)).toMatchObject({ kind: 'conflict' })
  })
})
