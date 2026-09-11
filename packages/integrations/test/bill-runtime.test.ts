import { describe, expect, it, vi } from 'vitest'
import {
  createBillMirrorSubscriber,
  createBillRuntime,
  type BillConfig,
  type BillMirrorSource,
} from '../src/bill/runtime.js'
import type { BillLink, BillLinkKind, BillLinkStore } from '../src/bill/mirror.js'

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

const client = { id: 7, name: 'Kestrel Environmental', email: 'ap@kestrel.example' }

const fullConfig: BillConfig = {
  devKey: 'dev-key',
  organizationId: '008EXAMPLE',
  username: 'books@example.test',
  password: 'sync-token-value',
  replyToUserId: '006abc',
  environment: 'sandbox',
}

const source = (overrides: Partial<BillMirrorSource> = {}): BillMirrorSource => ({
  readInvoice: vi.fn(async () => invoice),
  readClient: vi.fn(async () => client),
  isOptedIn: vi.fn(async () => true),
  mirroredInvoices: vi.fn(async () => new Map<string, number>()),
  recordPayment: vi.fn(async () => undefined),
  ...overrides,
})

const links = (): BillLinkStore & { rows: Map<string, BillLink> } => {
  const rows = new Map<string, BillLink>()
  return {
    rows,
    readLink: vi.fn(async (kind: BillLinkKind, id: number) => rows.get(`${kind}:${id}`) ?? null),
    saveLink: vi.fn(async (kind: BillLinkKind, id: number, link: BillLink) => {
      rows.set(`${kind}:${id}`, link)
    }),
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** A BILL that answers the whole happy path, recording what it was asked. */
const billServer = () => {
  const calls: string[] = []
  const fetch = vi.fn(async (request: Request) => {
    const url = new URL(request.url)
    const key = `${request.method} ${url.pathname}`
    calls.push(key)
    if (key === 'POST /connect/v3/login') return json({ sessionId: 'session-1' })
    if (key === 'GET /connect/v3/customers') return json({ results: [] })
    if (key === 'POST /connect/v3/customers') return json({ id: '0cu001', name: client.name })
    if (key === 'GET /connect/v3/invoices') return json({ results: [] })
    if (key === 'POST /connect/v3/invoices') return json({ id: '00e001', invoiceNumber: '1315' })
    if (key === 'POST /connect/v3/invoices/00e001/email') return new Response('', { status: 200 })
    if (key === 'POST /connect/v3/invoices/00e001/payment-link') {
      return json({ paymentLink: 'https://app.bill.com/pay/example' })
    }
    if (key === 'GET /connect/v3/receivable-payments') return json({ results: [] })
    throw new Error(`unexpected call: ${key}`)
  })
  return { fetch, calls }
}

const runtime = (
  config: BillConfig = fullConfig,
  overrides: { source?: BillMirrorSource; server?: ReturnType<typeof billServer> } = {},
) => {
  const server = overrides.server ?? billServer()
  const store = links()
  const mirrorSource = overrides.source ?? source()
  return {
    server,
    store,
    source: mirrorSource,
    runtime: createBillRuntime({
      config,
      links: store,
      source: mirrorSource,
      fetch: server.fetch,
      now: () => new Date('2026-09-11T12:00:00.000Z'),
    }),
  }
}

describe('what the deployment reports about itself', () => {
  it('[unit] says it is configured only with all four credentials', () => {
    expect(runtime().runtime.status().configured).toBe(true)
    for (const field of ['devKey', 'organizationId', 'username', 'password'] as const) {
      expect(
        runtime({ ...fullConfig, [field]: undefined }).runtime.status().configured,
      ).toBe(false)
      expect(runtime({ ...fullConfig, [field]: '  ' }).runtime.status().configured).toBe(
        false,
      )
    }
  })

  it('[security] says whether BILL can send the email, because a sync token cannot', () => {
    // An operator told "BILL will email your client" when it will not is the
    // difference between the client getting one invoice and getting none.
    expect(runtime().runtime.status().canSendFromBill).toBe(true)
    expect(
      runtime({ ...fullConfig, replyToUserId: undefined }).runtime.status().canSendFromBill,
    ).toBe(false)
  })

  it('[security] only `sandbox` means sandbox; anything else is the real book', () => {
    expect(runtime().runtime.status().environment).toBe('sandbox')
    for (const environment of ['production', 'prod', 'staging', undefined, '']) {
      expect(runtime({ ...fullConfig, environment }).runtime.status().environment).toBe(
        'production',
      )
    }
  })
})

describe('mirroring an invoice', () => {
  it('[integration] signs in, creates the customer and invoice, and sends it', async () => {
    const harness = runtime()
    expect(await harness.runtime.mirror(1315)).toMatchObject({
      kind: 'sent',
      billInvoiceId: '00e001',
    })
    expect(harness.server.calls).toEqual([
      'POST /connect/v3/login',
      'GET /connect/v3/customers',
      'POST /connect/v3/customers',
      'GET /connect/v3/invoices',
      'POST /connect/v3/invoices',
      'POST /connect/v3/invoices/00e001/email',
    ])
  })

  it('[security] refuses a client who never opted in', async () => {
    // Checked in the runtime rather than by the caller, so no route into the
    // mirror can forget and send a client's invoice through a third party.
    const harness = runtime(fullConfig, {
      source: source({ isOptedIn: vi.fn(async () => false) }),
    })
    expect(await harness.runtime.mirror(1315)).toEqual({
      kind: 'refused',
      reason: 'this client is not billed through BILL',
    })
    // Nothing reached BILL at all -- not even a sign-in.
    expect(harness.server.calls).toEqual([])
  })

  it('[api] refuses rather than throwing when the deployment has no credentials', async () => {
    const harness = runtime({ ...fullConfig, devKey: undefined })
    expect(await harness.runtime.mirror(1315)).toEqual({
      kind: 'refused',
      reason: 'BILL is not configured for this deployment',
    })
    expect(harness.server.calls).toEqual([])
  })

  it('[api] refuses an invoice or client that is not there', async () => {
    expect(
      await runtime(fullConfig, {
        source: source({ readInvoice: vi.fn(async () => null) }),
      }).runtime.mirror(1315),
    ).toEqual({ kind: 'refused', reason: 'the invoice does not exist' })
    expect(
      await runtime(fullConfig, {
        source: source({ readClient: vi.fn(async () => null) }),
      }).runtime.mirror(1315),
    ).toEqual({ kind: 'refused', reason: 'the client does not exist' })
  })

  it('[security] falls back to a payment link when it cannot have BILL send', async () => {
    const harness = runtime({ ...fullConfig, replyToUserId: undefined })
    expect(await harness.runtime.mirror(1315)).toMatchObject({
      kind: 'sent',
      paymentLink: 'https://app.bill.com/pay/example',
    })
    expect(harness.server.calls).toContain('POST /connect/v3/invoices/00e001/payment-link')
    expect(harness.server.calls).not.toContain('POST /connect/v3/invoices/00e001/email')
  })

  it('[api] searches by filter rather than listing every customer', async () => {
    // An organisation with a thousand customers would otherwise page through
    // all of them to answer whether one exists.
    const harness = runtime()
    await harness.runtime.mirror(1315)
    const search = harness.server.fetch.mock.calls
      .map(([request]) => new URL((request as Request).url))
      .find((url) => url.pathname === '/connect/v3/customers')
    expect(search?.searchParams.get('filters')).toBe('name:eq:Kestrel Environmental')
  })

  it('[unit] signs in once and reuses the session across two mirrors', async () => {
    // The reason the session is modelled on idle rather than age.
    const harness = runtime()
    await harness.runtime.mirror(1315)
    harness.store.rows.clear()
    await harness.runtime.mirror(1315)
    expect(harness.server.calls.filter((call) => call.endsWith('/login'))).toHaveLength(1)
  })
})

describe('reconciling payments', () => {
  const paid = {
    id: '0rp1',
    status: 'PAID',
    invoicePayments: [{ invoiceId: '00e001', amount: 2500, paymentDate: '2026-09-20' }],
  }

  it('[money] records what settled our invoices', async () => {
    const server = billServer()
    server.fetch.mockImplementation(async (request: Request) => {
      const url = new URL(request.url)
      if (url.pathname === '/connect/v3/login') return json({ sessionId: 'session-1' })
      if (url.pathname === '/connect/v3/receivable-payments') {
        return json({ results: [paid] })
      }
      throw new Error(`unexpected ${url.pathname}`)
    })
    const mirrorSource = source({
      mirroredInvoices: vi.fn(async () => new Map([['00e001', 1315]])),
    })
    const harness = runtime(fullConfig, { server, source: mirrorSource })
    expect(await harness.runtime.reconcilePayments()).toBe(1)
    expect(mirrorSource.recordPayment).toHaveBeenCalledWith({
      invoiceId: 1315,
      billInvoiceId: '00e001',
      billPaymentId: '0rp1',
      amountCents: 250_000,
      paidOn: '2026-09-20',
    })
  })

  it('[money] pages to the end rather than stopping at the first hundred', async () => {
    // A quiet week of BILL activity can push our payment past the first page.
    // Stopping early leaves an invoice unpaid in our book and paid in theirs.
    const pages = [
      { results: [], nextPage: 'p2' },
      { results: [paid], nextPage: '' },
    ]
    let index = 0
    const server = billServer()
    server.fetch.mockImplementation(async (request: Request) => {
      const url = new URL(request.url)
      if (url.pathname === '/connect/v3/login') return json({ sessionId: 'session-1' })
      if (url.pathname === '/connect/v3/receivable-payments') return json(pages[index++]!)
      throw new Error(`unexpected ${url.pathname}`)
    })
    const mirrorSource = source({
      mirroredInvoices: vi.fn(async () => new Map([['00e001', 1315]])),
    })
    const harness = runtime(fullConfig, { server, source: mirrorSource })
    expect(await harness.runtime.reconcilePayments()).toBe(1)
    expect(index).toBe(2)
  })

  it('[unit] does nothing, and asks BILL nothing, when no invoice was mirrored', async () => {
    const harness = runtime()
    expect(await harness.runtime.reconcilePayments()).toBe(0)
    expect(harness.server.calls).toEqual([])
  })

  it('[api] does nothing when the deployment has no credentials', async () => {
    const harness = runtime({ ...fullConfig, password: undefined })
    expect(await harness.runtime.reconcilePayments()).toBe(0)
  })
})

describe('the outbox subscriber', () => {
  const mirror = vi.fn(async () => ({ kind: 'sent' as const, billInvoiceId: '00e1', paymentLink: null }))
  const subscriber = createBillMirrorSubscriber({
    status: () => ({
      configured: true,
      organizationId: '008',
      environment: 'sandbox',
      canSendFromBill: true,
    }),
    mirror,
    reconcilePayments: async () => 0,
  })

  it('[unit] fires on a sent invoice and nothing else', async () => {
    mirror.mockClear()
    await subscriber.deliver({
      aggregateType: 'invoice',
      eventType: 'invoice.sent',
      aggregateId: 1315,
    })
    expect(mirror).toHaveBeenCalledWith(1315)

    mirror.mockClear()
    for (const event of [
      { aggregateType: 'invoice', eventType: 'invoice.paid', aggregateId: 1 },
      { aggregateType: 'invoice', eventType: 'invoice.draft', aggregateId: 1 },
      { aggregateType: 'expense', eventType: 'invoice.sent', aggregateId: 1 },
    ]) {
      await subscriber.deliver(event)
    }
    expect(mirror).not.toHaveBeenCalled()
  })

  it('[unit] is named, so the outbox can record what delivered it', () => {
    expect(subscriber.id).toBe('bill_mirror')
  })
})
