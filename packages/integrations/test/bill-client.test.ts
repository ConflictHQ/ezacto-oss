import { describe, expect, it, vi } from 'vitest'
import {
  BillApiError,
  BillClient,
  BillResponseError,
  billFilter,
} from '../src/bill/client.js'

const base = 'https://gateway.stage.bill.com/connect'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const client = (fetch: (request: Request) => Promise<Response>) =>
  new BillClient({ sessionId: 'session-1', devKey: 'dev-key', fetch, baseUrl: base })

describe('every request the client makes', () => {
  it('[security] carries the session and the developer key', async () => {
    // BILL takes both on every call: the session says who is signed in, the
    // developer key says which integration is asking.
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('sessionId')).toBe('session-1')
      expect(request.headers.get('devKey')).toBe('dev-key')
      return json({ results: [] })
    })
    await client(fetch).listCustomers()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('[api] refuses to construct without a session or a key', () => {
    const fetch = vi.fn()
    expect(() => new BillClient({ sessionId: ' ', devKey: 'k', fetch })).toThrow(
      BillResponseError,
    )
    expect(() => new BillClient({ sessionId: 's', devKey: ' ', fetch })).toThrow(
      BillResponseError,
    )
  })

  it('[api] reports BILL’s own error code and message', async () => {
    // BILL answers a failure with an array of error objects rather than one.
    const fetch = vi.fn(async () =>
      json([{ code: 'BDC_1234', message: 'Customer not found' }], 400),
    )
    const error = await client(fetch)
      .readInvoice('00e1')
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(BillApiError)
    expect((error as BillApiError).code).toBe('BDC_1234')
    expect(String(error)).toContain('Customer not found')
  })

  it('[api] survives an error body that is not JSON', async () => {
    const fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    const error = await client(fetch)
      .readInvoice('00e1')
      .catch((cause: unknown) => cause)
    expect((error as BillApiError).status).toBe(502)
    expect((error as BillApiError).code).toBeNull()
  })
})

describe('the list filter grammar', () => {
  it('[unit] builds a field:operator:value clause', () => {
    expect(billFilter('invoiceNumber', 'eq', '1315')).toBe('invoiceNumber:eq:1315')
  })

  it('[security] refuses a value that would be read as another clause', () => {
    // BILL neither quotes nor escapes filter values, so a comma or a colon in
    // one silently becomes a second filter.
    expect(() => billFilter('invoiceNumber', 'eq', '1315,deleted:eq:true')).toThrow(
      /may not contain a comma or a colon/u,
    )
    expect(() => billFilter('name', 'eq', 'a:b')).toThrow(BillResponseError)
  })
})

describe('customers', () => {
  it('[api] lists with the filters it was given', async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      expect(url.pathname).toBe('/connect/v3/customers')
      expect(url.searchParams.get('filters')).toBe('name:eq:Kestrel')
      expect(url.searchParams.get('max')).toBe('100')
      return json({ results: [{ id: '0cu1', name: 'Kestrel' }], nextPage: '' })
    })
    const page = await client(fetch).listCustomers({ filters: ['name:eq:Kestrel'] })
    expect(page.results).toEqual([{ id: '0cu1', name: 'Kestrel' }])
    // An empty nextPage is "no more", not a page token of empty string.
    expect(page.nextPage).toBeNull()
  })

  it('[api] creates and returns the new id', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST')
      expect(await request.clone().json()).toEqual({ name: 'Kestrel' })
      return json({ id: '0cu9', name: 'Kestrel' }, 201)
    })
    expect((await client(fetch).createCustomer({ name: 'Kestrel' })).id).toBe('0cu9')
  })

  it('[api] treats a create that answered without an id as a failure', async () => {
    const fetch = vi.fn(async () => json({ name: 'Kestrel' }, 201))
    await expect(client(fetch).createCustomer({ name: 'Kestrel' })).rejects.toThrow(
      /created customer has no id/u,
    )
  })

  it('[api] refuses a list response with no results array', async () => {
    const fetch = vi.fn(async () => json({ nextPage: 'x' }))
    await expect(client(fetch).listCustomers()).rejects.toThrow(/results array/u)
  })
})

describe('invoices', () => {
  it('[api] creates one and returns the id BILL assigned', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/connect/v3/invoices')
      return json({ id: '00e42', invoiceNumber: '1315', status: 'OPEN' }, 201)
    })
    const created = await client(fetch).createInvoice({ invoiceNumber: '1315' })
    expect(created.id).toBe('00e42')
    expect(created.status).toBe('OPEN')
  })

  it('[api] reads one back by id, escaping it into the path', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe('/connect/v3/invoices/00e%2F42')
      return json({ id: '00e/42' })
    })
    await client(fetch).readInvoice('00e/42')
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('sending an invoice', () => {
  it('[api] posts the recipients and the reply-to user', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('POST')
      expect(new URL(request.url).pathname).toBe('/connect/v3/invoices/00e42/email')
      expect(await request.clone().json()).toEqual({
        recipient: { to: ['ap@kestrel.example'] },
        replyTo: { userId: '006abc' },
      })
      // A send answers 200 with an empty body.
      return new Response('', { status: 200 })
    })
    await client(fetch).sendInvoice('00e42', {
      to: ['ap@kestrel.example'],
      replyToUserId: '006abc',
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('[security] refuses to send with no recipient rather than asking BILL to', async () => {
    // This call emails a real client. An empty recipient list is a mistake to
    // catch here, not a request to make.
    const fetch = vi.fn()
    await expect(
      client(fetch).sendInvoice('00e42', { to: [], replyToUserId: '006abc' }),
    ).rejects.toThrow(/at least one recipient/u)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('[api] raises when BILL refuses the send', async () => {
    const fetch = vi.fn(async () => json([{ code: 'BDC_9', message: 'No permission' }], 403))
    await expect(
      client(fetch).sendInvoice('00e42', {
        to: ['ap@kestrel.example'],
        replyToUserId: '006abc',
      }),
    ).rejects.toThrow(BillApiError)
  })
})

describe('receivable payments', () => {
  it('[api] pages through with the token BILL returned', async () => {
    const fetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      expect(url.pathname).toBe('/connect/v3/receivable-payments')
      expect(url.searchParams.get('page')).toBe('token-2')
      return json({ results: [{ id: '0rp1', amount: 10 }], nextPage: 'token-3' })
    })
    const page = await client(fetch).listReceivablePayments({ page: 'token-2' })
    expect(page.nextPage).toBe('token-3')
    expect(page.results[0]).toMatchObject({ id: '0rp1' })
  })

  it('[api] asks for no more than BILL’s page limit allows', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(new URL(request.url).searchParams.get('max')).toBe('25')
      return json({ results: [] })
    })
    await client(fetch).listReceivablePayments({ max: 25 })
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('what this client deliberately cannot do', () => {
  it('[security] answers for its whole surface, so nothing that moves money can be added quietly', () => {
    // BILL puts paying, charging and voiding behind an MFA challenge to a
    // registered phone, which no unattended process can answer. Rather than
    // ship code that would fail at that wall, the wall is the boundary of the
    // client -- and an absence only stays true if something asserts it.
    //
    // The whole surface is pinned rather than a list of forbidden words,
    // because `listReceivablePayments` contains "pay" while doing the opposite:
    // reading money that arrived is the point, and only initiating it is out.
    expect(
      Object.getOwnPropertyNames(BillClient.prototype)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual([
      'createCustomer',
      'createInvoice',
      'listCustomers',
      'listInvoices',
      'listReceivablePayments',
      'readInvoice',
      'sendInvoice',
    ])
  })
})
