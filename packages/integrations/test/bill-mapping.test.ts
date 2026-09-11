import { describe, expect, it } from 'vitest'
import {
  BillMappingError,
  customerMatches,
  customerPayload,
  invoicePayload,
  planInvoice,
  settledPayments,
  type BillMirrorInvoice,
} from '../src/bill/mapping.js'

const client = {
  id: 7,
  name: 'Kestrel Environmental',
  email: 'ap@kestrel.example',
}

const invoice = (overrides: Partial<BillMirrorInvoice> = {}): BillMirrorInvoice => ({
  id: 1315,
  number: '1315',
  clientId: 7,
  currency: 'USD',
  issueDate: '2026-09-11',
  dueDate: '2026-10-11',
  subject: 'September retainer',
  lines: [
    { description: 'Advisory', amountCents: 250_000, quantity: null, unitPriceCents: null },
  ],
  ...overrides,
})

describe('the customer BILL is given', () => {
  it('[unit] carries the name and the email an invoice is sent to', () => {
    expect(customerPayload(client)).toEqual({
      name: 'Kestrel Environmental',
      email: 'ap@kestrel.example',
      accountType: 'BUSINESS',
    })
  })

  it('[api] says which client has no email rather than letting BILL refuse it', () => {
    // BILL's own message for a missing email does not name the client, and a
    // failure an operator cannot attribute is one they cannot fix.
    expect(() => customerPayload({ ...client, email: null })).toThrow(
      /client 7 has no email address/u,
    )
    expect(() => customerPayload({ ...client, email: '   ' })).toThrow(BillMappingError)
  })

  it('[unit] cuts a name at the length BILL accepts', () => {
    const long = 'N'.repeat(140)
    expect((customerPayload({ ...client, name: long })['name'] as string).length).toBe(100)
  })
})

describe('recognising a customer BILL already holds', () => {
  it('[unit] matches on the name an operator can actually see', () => {
    expect(customerMatches({ name: 'Kestrel Environmental' }, client)).toBe(true)
    expect(customerMatches({ name: 'Northpeak' }, client)).toBe(false)
  })

  it('[unit] ignores surrounding whitespace on either side', () => {
    expect(customerMatches({ name: '  Kestrel Environmental ' }, client)).toBe(true)
  })

  it('[unit] never matches an archived customer', () => {
    // Adopting an archived customer would file the invoice somewhere the
    // operator has deliberately put out of the way.
    expect(
      customerMatches({ name: 'Kestrel Environmental', archived: true }, client),
    ).toBe(false)
  })

  it('[unit] compares against the cut name, so a long one still matches itself', () => {
    const long = 'N'.repeat(140)
    const stored = { name: 'N'.repeat(100) }
    expect(customerMatches(stored, { ...client, name: long })).toBe(true)
  })
})

describe('the invoice BILL is given', () => {
  it('[unit] sends our own invoice number, because it is the retry key', () => {
    expect(invoicePayload(invoice(), '0cu01')['invoiceNumber']).toBe('1315')
  })

  it('[money] sends a unit price, not the line total', () => {
    // The bug this pins: BILL multiplies quantity by price to get the line
    // total. Sending the total as the price invoices the client three times
    // what we billed.
    const payload = invoicePayload(
      invoice({
        lines: [
          { description: 'Advisory', amountCents: 60_000, quantity: 3, unitPriceCents: null },
        ],
      }),
      '0cu01',
    )
    const lines = payload['invoiceLineItems'] as { quantity: number; price: number }[]
    expect(lines[0]).toMatchObject({ quantity: 3, price: 200 })
    expect(lines[0]!.quantity * lines[0]!.price).toBe(600)
  })

  it('[money] prefers the unit price we hold over deriving one', () => {
    const payload = invoicePayload(
      invoice({
        lines: [
          { description: 'Advisory', amountCents: 60_000, quantity: 3, unitPriceCents: 20_000 },
        ],
      }),
      '0cu01',
    )
    expect((payload['invoiceLineItems'] as { price: number }[])[0]?.price).toBe(200)
  })

  it('[money] bills a lump-sum line as one of it', () => {
    const lines = invoicePayload(invoice(), '0cu01')['invoiceLineItems'] as {
      quantity: number
      price: number
    }[]
    expect(lines[0]).toMatchObject({ quantity: 1, price: 2500 })
  })

  it('[money] converts cents without inventing a fraction of one', () => {
    const lines = invoicePayload(
      invoice({
        lines: [{ description: 'x', amountCents: 1, quantity: null, unitPriceCents: null }],
      }),
      '0cu01',
    )['invoiceLineItems'] as { price: number }[]
    expect(lines[0]?.price).toBe(0.01)
  })

  it('[unit] dates an invoice with no due date at its issue date', () => {
    // BILL would default it to the creation date, which makes an undated
    // invoice look overdue the moment it lands.
    const payload = invoicePayload(invoice({ dueDate: null }), '0cu01')
    expect(payload['dueDate']).toBe('2026-09-11')
    expect(payload['invoiceDate']).toBe('2026-09-11')
  })

  it('[api] refuses an invoice with no lines rather than sending an empty one', () => {
    expect(() => invoicePayload(invoice({ lines: [] }), '0cu01')).toThrow(/has no lines/u)
  })

  it('[api] refuses a blank customer id', () => {
    expect(() => invoicePayload(invoice(), '  ')).toThrow(BillMappingError)
  })

  it('[unit] falls back to the subject for a line with no description', () => {
    const lines = invoicePayload(
      invoice({
        lines: [{ description: '  ', amountCents: 100, quantity: null, unitPriceCents: null }],
      }),
      '0cu01',
    )['invoiceLineItems'] as { description: string }[]
    expect(lines[0]?.description).toBe('September retainer')
  })
})

describe('deciding whether BILL already has this invoice', () => {
  it('[unit] creates when nothing carries our number', () => {
    expect(planInvoice(invoice(), [])).toEqual({ action: 'create' })
    expect(planInvoice(invoice(), [{ id: '00e9', invoiceNumber: '1314' }])).toEqual({
      action: 'create',
    })
  })

  it('[security] adopts rather than creating a second document on a retry', () => {
    // The whole idempotency story. BILL has no idempotency key, so a redelivered
    // queue message would otherwise invoice a client twice for the same work.
    expect(planInvoice(invoice(), [{ id: '00e42', invoiceNumber: '1315' }])).toEqual({
      action: 'adopt',
      billInvoiceId: '00e42',
    })
  })

  it('[unit] adopts through whitespace, which a hand-typed number can carry', () => {
    expect(planInvoice(invoice(), [{ id: '00e42', invoiceNumber: ' 1315 ' }])).toEqual({
      action: 'adopt',
      billInvoiceId: '00e42',
    })
  })
})

describe('reading what was actually paid', () => {
  const known = new Set(['00e42', '00e43'])

  it('[money] records one settlement per invoice a payment covered', () => {
    // A single BILL payment can settle several invoices. Recording its whole
    // amount against one of them would overstate what that invoice received.
    const settled = settledPayments(
      [
        {
          id: '0rp1',
          status: 'PAID',
          invoicePayments: [
            { invoiceId: '00e42', amount: 1000, paymentDate: '2026-09-20' },
            { invoiceId: '00e43', amount: 500, paymentDate: '2026-09-20' },
          ],
        },
      ],
      known,
    )
    expect(settled).toEqual([
      {
        billPaymentId: '0rp1',
        billInvoiceId: '00e42',
        amountCents: 100_000,
        paidOn: '2026-09-20',
      },
      {
        billPaymentId: '0rp1',
        billInvoiceId: '00e43',
        amountCents: 50_000,
        paidOn: '2026-09-20',
      },
    ])
  })

  it('[money] counts only money that actually arrived', () => {
    // Scheduled has not arrived; void, cancelled and escheated never will.
    // Treating any of them as received marks an invoice paid that is still owed.
    for (const status of ['SCHEDULED', 'VOID', 'CANCELED', 'ESCHEATED']) {
      expect(
        settledPayments(
          [{ id: '0rp1', status, invoicePayments: [{ invoiceId: '00e42', amount: 10 }] }],
          known,
        ),
      ).toEqual([])
    }
  })

  it('[unit] ignores invoices this instance never mirrored', () => {
    // The operator's BILL org has its own invoices, raised outside ezacto.
    // Recording a payment against one of those would be inventing a receipt.
    expect(
      settledPayments(
        [
          {
            id: '0rp1',
            status: 'PAID',
            invoicePayments: [{ invoiceId: '00e-not-ours', amount: 10 }],
          },
        ],
        known,
      ),
    ).toEqual([])
  })

  it('[unit] survives a payment with no invoice lines at all', () => {
    expect(settledPayments([{ id: '0rp1', status: 'PAID' }], known)).toEqual([])
  })

  it('[money] converts a decimal amount to whole cents', () => {
    const settled = settledPayments(
      [{ id: '0rp1', status: 'PAID', invoicePayments: [{ invoiceId: '00e42', amount: 10.07 }] }],
      known,
    )
    expect(settled[0]?.amountCents).toBe(1007)
  })

  it('[unit] reports a missing payment date as unknown rather than inventing one', () => {
    const settled = settledPayments(
      [{ id: '0rp1', status: 'PAID', invoicePayments: [{ invoiceId: '00e42', amount: 1 }] }],
      known,
    )
    expect(settled[0]?.paidOn).toBeNull()
  })
})
