import { describe, expect, it, vi } from 'vitest'
import {
  inboundPayments,
  mirrorInvoice,
  type BillDelivery,
  type BillLink,
  type BillLinkKind,
  type BillMirrorInput,
  type MirrorBill,
} from '../src/bill/mirror.js'

const client = { id: 7, name: 'Kestrel Environmental', email: 'ap@kestrel.example' }

const invoice = {
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
}

const linkStore = (seed: Record<string, BillLink> = {}) => {
  const rows = new Map<string, BillLink>(Object.entries(seed))
  return {
    rows,
    readLink: vi.fn(async (kind: BillLinkKind, id: number) => rows.get(`${kind}:${id}`) ?? null),
    saveLink: vi.fn(async (kind: BillLinkKind, id: number, link: BillLink) => {
      rows.set(`${kind}:${id}`, link)
    }),
  }
}

const bill = (overrides: Partial<MirrorBill> = {}): MirrorBill => ({
  findCustomerByName: vi.fn(async () => null),
  createCustomer: vi.fn(async () => ({ id: '0cu001', name: client.name })),
  findInvoiceByNumber: vi.fn(async () => null),
  createInvoice: vi.fn(async () => ({ id: '00e001', invoiceNumber: '1315' })),
  sendInvoice: vi.fn(async () => undefined),
  paymentLink: vi.fn(async () => 'https://app.bill.com/pay/example'),
  ...overrides,
})

const run = (
  overrides: Partial<BillMirrorInput> & { links?: ReturnType<typeof linkStore> } = {},
  delivery: BillDelivery = { via: 'bill', replyToUserId: '006abc' },
) => {
  const links = overrides.links ?? linkStore()
  const api = overrides.bill ?? bill()
  return {
    links,
    bill: api,
    result: mirrorInvoice({
      invoice,
      client,
      links,
      bill: api,
      delivery,
      ...overrides,
    } as BillMirrorInput),
  }
}

describe('putting an invoice into BILL', () => {
  it('[integration] creates the customer, the invoice, and sends it', async () => {
    const harness = run()
    expect(await harness.result).toEqual({
      kind: 'sent',
      billInvoiceId: '00e001',
      paymentLink: null,
    })
    expect(harness.bill.createCustomer).toHaveBeenCalledOnce()
    expect(harness.bill.sendInvoice).toHaveBeenCalledWith('00e001', {
      to: ['ap@kestrel.example'],
      replyToUserId: '006abc',
    })
  })

  it('[security] records the link before attempting delivery', async () => {
    // The ordering that matters. BILL has no idempotency key, so a created
    // invoice we failed to record is one a retry creates again -- the client is
    // invoiced twice. A recorded invoice we failed to send is one an operator
    // can send by hand, which is smaller and visible.
    const api = bill({
      sendInvoice: vi.fn(async () => {
        throw new Error('BILL refused the send')
      }),
    })
    const links = linkStore()
    await expect(
      mirrorInvoice({ invoice, client, links, bill: api, delivery: { via: 'bill', replyToUserId: '006abc' } }),
    ).rejects.toThrow(/refused the send/u)
    expect(links.rows.get('invoice:1315')?.billId).toBe('00e001')
  })

  it('[security] does not create a second invoice when one is already linked', async () => {
    const links = linkStore({
      'invoice:1315': { billId: '00e999', paymentLink: null },
    })
    const harness = run({ links })
    expect(await harness.result).toEqual({
      kind: 'adopted',
      billInvoiceId: '00e999',
      paymentLink: null,
    })
    expect(harness.bill.createInvoice).not.toHaveBeenCalled()
    // An invoice the client already has is not improved by arriving again.
    expect(harness.bill.sendInvoice).not.toHaveBeenCalled()
  })

  it('[security] adopts an invoice BILL already carries under our number', async () => {
    // The retry case: a previous attempt created it and failed before recording.
    const api = bill({
      findInvoiceByNumber: vi.fn(async () => ({ id: '00e042', invoiceNumber: '1315' })),
    })
    const harness = run({ bill: api })
    expect(await harness.result).toMatchObject({ kind: 'adopted', billInvoiceId: '00e042' })
    expect(api.createInvoice).not.toHaveBeenCalled()
    expect(api.sendInvoice).not.toHaveBeenCalled()
  })

  it('[unit] reuses a customer that is already linked', async () => {
    const links = linkStore({ 'customer:7': { billId: '0cu777', paymentLink: null } })
    const harness = run({ links })
    await harness.result
    expect(harness.bill.createCustomer).not.toHaveBeenCalled()
    expect(harness.bill.findCustomerByName).not.toHaveBeenCalled()
  })

  it('[security] adopts a customer BILL already has rather than making a second', async () => {
    // Two customers of the same name leave an operator unable to tell which one
    // their invoices are going to.
    const api = bill({
      findCustomerByName: vi.fn(async () => ({ id: '0cu555', name: client.name })),
    })
    const harness = run({ bill: api })
    await harness.result
    expect(api.createCustomer).not.toHaveBeenCalled()
    expect(harness.links.rows.get('customer:7')?.billId).toBe('0cu555')
  })

  it('[api] refuses when BILL has a customer of that name that is not this one', async () => {
    const api = bill({
      findCustomerByName: vi.fn(async () => ({
        id: '0cu555',
        name: client.name,
        archived: true,
      })),
    })
    expect(await run({ bill: api }).result).toEqual({
      kind: 'refused',
      reason: expect.stringContaining('does not match this client') as unknown as string,
    })
  })

  it('[security] refuses an invoice that does not belong to the client it was given', async () => {
    // A mismatch here would file one client's invoice under another's customer,
    // which is a disclosure rather than a bug.
    const harness = run({ client: { ...client, id: 8 } })
    expect(await harness.result).toEqual({
      kind: 'refused',
      reason: 'the invoice does not belong to that client',
    })
    expect(harness.bill.createInvoice).not.toHaveBeenCalled()
  })
})

describe('when BILL cannot send the email itself', () => {
  const delivery: BillDelivery = { via: 'link' }

  it('[integration] fetches a payment link and records it instead', async () => {
    const harness = run({}, delivery)
    expect(await harness.result).toEqual({
      kind: 'sent',
      billInvoiceId: '00e001',
      paymentLink: 'https://app.bill.com/pay/example',
    })
    expect(harness.bill.sendInvoice).not.toHaveBeenCalled()
    expect(harness.links.rows.get('invoice:1315')?.paymentLink).toBe(
      'https://app.bill.com/pay/example',
    )
  })

  it('[unit] leaves no payment link of ours when BILL sent its own email', async () => {
    // BILL owns the link inside the email it sent, so recording one of ours
    // would be a second place to pay that nobody was told about.
    const harness = run()
    await harness.result
    expect(harness.links.rows.get('invoice:1315')?.paymentLink).toBeNull()
  })
})

describe('sending to a client with no email', () => {
  it('[api] refuses rather than asking BILL to send to nobody', async () => {
    const harness = run({ client: { ...client, email: null } })
    // The customer could not have been created either -- BILL requires an
    // email -- so this is caught before anything is sent.
    await expect(harness.result).rejects.toThrow(/has no email address/u)
  })
})

describe('reading payments back', () => {
  it('[money] records only the invoices this instance mirrored', async () => {
    const mirrored = new Map([['00e001', 1315]])
    expect(
      inboundPayments({
        payments: [
          {
            id: '0rp1',
            status: 'PAID',
            invoicePayments: [
              { invoiceId: '00e001', amount: 2500, paymentDate: '2026-09-20' },
              // The operator's own BILL org raises invoices outside ezacto.
              { invoiceId: '00e-someone-elses', amount: 100 },
            ],
          },
        ],
        mirrored,
      }),
    ).toEqual([
      {
        billPaymentId: '0rp1',
        billInvoiceId: '00e001',
        amountCents: 250_000,
        paidOn: '2026-09-20',
        invoiceId: 1315,
      },
    ])
  })

  it('[money] ignores money that has not actually arrived', async () => {
    expect(
      inboundPayments({
        payments: [
          {
            id: '0rp1',
            status: 'SCHEDULED',
            invoicePayments: [{ invoiceId: '00e001', amount: 2500 }],
          },
        ],
        mirrored: new Map([['00e001', 1315]]),
      }),
    ).toEqual([])
  })
})
