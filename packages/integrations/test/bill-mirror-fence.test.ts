import { describe, expect, it, vi } from 'vitest'
import {
  mirrorInvoice,
  type BillEffectFence,
  type BillEffectKind,
  type BillLink,
  type BillLinkKind,
  type MirrorBill,
} from '../src/bill/mirror.js'

const client = { id: 7, name: 'Kestrel Environmental', email: 'ap@kestrel.example' }
const invoice = {
  id: 1315, number: '1315', clientId: 7, currency: 'USD', issueDate: '2026-09-11',
  dueDate: '2026-10-11', subject: 'September retainer',
  lines: [{ description: 'Advisory', amountCents: 250_000, quantity: null, unitPriceCents: null }],
}

const harness = (overrides: Partial<MirrorBill> = {}) => {
  const log: string[] = []
  const rows = new Map<string, BillLink>()
  const held = new Map<string, { kind: BillEffectKind; invoiceId: number }>()
  const links = {
    readLink: async (kind: BillLinkKind, id: number) => rows.get(`${kind}:${id}`) ?? null,
    saveLink: async (kind: BillLinkKind, id: number, link: BillLink) => {
      log.push(`link:${kind}`)
      rows.set(`${kind}:${id}`, link)
    },
  }
  let next = 0
  const fence: BillEffectFence = {
    hold: async (effect) => {
      for (const [id, row] of held) if (row.kind === effect.kind && row.invoiceId === effect.invoiceId) return { effectId: id }
      const effectId = `effect-${++next}`
      held.set(effectId, { kind: effect.kind, invoiceId: effect.invoiceId })
      log.push(`hold:${effect.kind}`)
      expect(effect.requestDigest).toMatch(/^[a-f0-9]{64}$/)
      return { effectId }
    },
    release: async (effectId) => { held.delete(effectId); log.push('release') },
    releaseHeld: async (invoiceId, kinds) => {
      for (const [id, row] of held) if (row.invoiceId === invoiceId && kinds.includes(row.kind)) held.delete(id)
      log.push('releaseHeld')
    },
  }
  const bill: MirrorBill = {
    findCustomerByName: vi.fn(async () => null),
    createCustomer: vi.fn(async () => { log.push('provider:customer'); return { id: '0cu001', name: client.name } }),
    findInvoiceByNumber: vi.fn(async () => null),
    createInvoice: vi.fn(async () => { log.push('provider:invoice'); return { id: '00e001', invoiceNumber: '1315' } }),
    sendInvoice: vi.fn(async () => { log.push('provider:send') }),
    paymentLink: vi.fn(async () => 'https://app.bill.com/pay/example'),
    ...overrides,
  }
  return { log, held, links, fence, bill, rows }
}

describe('fencing BILL provider effects (issue 1252)', () => {
  it('[security] holds before each provider call and releases once the link is recorded', async () => {
    const h = harness()
    const outcome = await mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, fence: h.fence,
      delivery: { via: 'bill', replyToUserId: '006abc' } })
    expect(outcome.kind).toBe('sent')
    expect(h.log).toEqual([
      'hold:customer-create', 'provider:customer', 'link:customer', 'release',
      'hold:invoice-create', 'provider:invoice', 'link:invoice', 'release',
      'hold:invoice-send', 'provider:send', 'release',
    ])
    expect(h.held.size).toBe(0)
  })

  it('[security] fences the payment-link fetch for link delivery', async () => {
    const h = harness()
    await mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, fence: h.fence, delivery: { via: 'link' } })
    expect(h.log.slice(-3)).toEqual(['hold:invoice-link', 'link:invoice', 'release'])
    expect(h.held.size).toBe(0)
  })

  it('[security] an effect with an unknown outcome stays held and a retry never creates a second invoice', async () => {
    const h = harness({
      createInvoice: vi.fn(async () => { throw new Error('reply lost') }),
    })
    await expect(mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, fence: h.fence, delivery: { via: 'link' } }))
      .rejects.toThrow('reply lost')
    expect([...h.held.values()]).toEqual([{ kind: 'invoice-create', invoiceId: 1315 }])
    expect(h.rows.has('invoice:1315')).toBe(false)

    // The provider did create it; the retry finds it by number and adopts it.
    h.bill.findInvoiceByNumber = vi.fn(async () => ({ id: '00e001', invoiceNumber: '1315', customerId: '0cu001',
      invoiceDate: '2026-09-11', dueDate: '2026-10-11', amount: 2500, lineItems: [] } as never))
    const retry = await mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, fence: h.fence, delivery: { via: 'link' } })
    expect(h.bill.createInvoice).toHaveBeenCalledOnce()
    expect(retry).toEqual({ kind: 'adopted', billInvoiceId: '00e001', paymentLink: null })
    expect(h.held.size).toBe(0)
  })

  it('[security] a failed send leaves its hold and keeps the recorded invoice link', async () => {
    const h = harness({ sendInvoice: vi.fn(async () => { throw new Error('send failed') }) })
    await expect(mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, fence: h.fence,
      delivery: { via: 'bill', replyToUserId: '006abc' } })).rejects.toThrow('send failed')
    expect([...h.held.values()].map((row) => row.kind)).toEqual(['invoice-send'])
    expect(h.rows.get('invoice:1315')?.billId).toBe('00e001')
  })

  it('[security] an already mirrored invoice settles holds a crashed run left and sends nothing', async () => {
    const h = harness()
    h.rows.set('invoice:1315', { billId: '00e001', paymentLink: null })
    h.held.set('stale', { kind: 'invoice-send', invoiceId: 1315 })
    const outcome = await mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, fence: h.fence,
      delivery: { via: 'bill', replyToUserId: '006abc' } })
    expect(outcome.kind).toBe('adopted')
    expect(h.held.size).toBe(0)
    expect(h.bill.sendInvoice).not.toHaveBeenCalled()
  })

  it('does nothing different when no fence is supplied', async () => {
    const h = harness()
    const outcome = await mirrorInvoice({ invoice, client, links: h.links, bill: h.bill, delivery: { via: 'link' } })
    expect(outcome.kind).toBe('sent')
    expect(h.log.some((entry) => entry.startsWith('hold'))).toBe(false)
  })
})
