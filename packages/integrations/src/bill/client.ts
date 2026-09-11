/**
 * BILL `/v3` client, narrowed to receivables: put an invoice in, send it, and
 * read what came back.
 *
 * Same posture as the QuickBooks and Deel clients: the transport is injected,
 * there is no default credential and no environment lookup, and the tests never
 * reach BILL -- a stray POST here creates a real invoice in a real ledger that
 * somebody then has to void, and a stray send emails it to a client.
 *
 * What is deliberately absent is as important as what is here. There is no
 * method that pays, charges, voids or cancels anything. BILL puts those behind
 * an MFA challenge to a registered phone, which no unattended process can
 * answer; rather than write code that would fail at that wall, the wall is the
 * boundary of the client.
 */

import { BILL_PRODUCTION_BASE_URL } from './session.js'

export class BillApiError extends Error {
  readonly status: number
  /** BILL's own error code, where the body carried one. */
  readonly code: string | null
  readonly detail: string | null

  constructor(status: number, code: string | null, detail: string | null) {
    super(
      `BILL request failed with status ${String(status)}${code === null ? '' : ` (${code})`}${
        detail === null ? '' : `: ${detail}`
      }`,
    )
    this.name = 'BillApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export class BillResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillResponseError'
  }
}

export interface BillCustomer {
  /** Begins `0cu`. */
  readonly id: string
  readonly name: string
  readonly email?: string
  readonly archived?: boolean
}

export interface BillInvoiceLineItem {
  readonly quantity: number
  readonly description?: string
  readonly price?: number
}

/**
 * `status` is how a payment is noticed without a webhook. BILL moves an invoice
 * to `PAID_IN_FULL` when it settles and reduces `dueAmount` on the way, so the
 * invoice itself answers "has this been paid" without joining anything.
 */
export type BillInvoiceStatus =
  | 'OPEN'
  | 'PAID_IN_FULL'
  | 'PARTIAL_PAYMENT'
  | 'SCHEDULED'

export interface BillInvoice {
  /** Begins `00e`. */
  readonly id: string
  readonly invoiceNumber?: string
  readonly customerId?: string
  readonly invoiceDate?: string
  readonly dueDate?: string
  readonly totalAmount?: number
  readonly dueAmount?: number
  readonly status?: BillInvoiceStatus
}

export type BillPaymentStatus = 'PAID' | 'VOID' | 'SCHEDULED' | 'CANCELED' | 'ESCHEATED'

export interface BillInvoicePaymentLine {
  /** The invoice this part of the payment settled. Begins `00e`. */
  readonly invoiceId: string
  readonly amount: number
  readonly paymentDate?: string
}

export interface BillReceivablePayment {
  /** Begins `0rp`. */
  readonly id: string
  readonly customerId?: string
  readonly amount: number
  readonly paymentDate?: string
  readonly status?: BillPaymentStatus
  readonly invoicePayments?: readonly BillInvoicePaymentLine[]
}

export interface BillPage<Item> {
  readonly results: readonly Item[]
  readonly nextPage: string | null
}

export interface BillClientOptions {
  /**
   * Supplied per call rather than held, because it expires on idle. The caller
   * owns re-authenticating and storing what came back -- a client that logged
   * in on its own would have to hold a password, and it has no business doing
   * that.
   */
  readonly sessionId: string
  readonly devKey: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly baseUrl?: string
}

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BillResponseError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * BILL's list filter grammar is `field:operator:value`, joined by commas.
 *
 * The value is not quoted or escaped by the API, so a value containing a comma
 * or a colon would be read as another clause. Everything reaching a filter here
 * is an id or an invoice number this system generated, but that is a property
 * of today's callers rather than of the grammar, so it is checked rather than
 * assumed.
 */
export const billFilter = (field: string, operator: string, value: string): string => {
  if (value.includes(',') || value.includes(':')) {
    throw new BillResponseError(
      `a BILL filter value may not contain a comma or a colon: ${value}`,
    )
  }
  return `${field}:${operator}:${value}`
}

export class BillClient {
  readonly #sessionId: string
  readonly #devKey: string
  readonly #fetch: (request: Request) => Promise<Response>
  readonly #baseUrl: string

  constructor(options: Readonly<BillClientOptions>) {
    if (options.sessionId.trim() === '') {
      throw new BillResponseError('sessionId is required')
    }
    if (options.devKey.trim() === '') {
      throw new BillResponseError('devKey is required')
    }
    this.#sessionId = options.sessionId
    this.#devKey = options.devKey
    this.#fetch = options.fetch
    this.#baseUrl = options.baseUrl ?? BILL_PRODUCTION_BASE_URL
  }

  #url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.toString()
  }

  #request(path: string, init: RequestInit, params?: Record<string, string>): Request {
    return new Request(this.#url(path, params), {
      ...init,
      headers: {
        accept: 'application/json',
        // BILL takes both on every call: the session says who is signed in, the
        // developer key says which integration is asking.
        sessionId: this.#sessionId,
        devKey: this.#devKey,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  async #send(request: Request): Promise<unknown> {
    const response = await this.#fetch(request)
    if (!response.ok) {
      let code: string | null = null
      let detail: string | null = null
      try {
        // BILL answers a failure with an array of error objects rather than one.
        const body: unknown = await response.json()
        const first = Array.isArray(body) ? body[0] : body
        if (typeof first === 'object' && first !== null) {
          const record = first as Record<string, unknown>
          if (typeof record['code'] === 'string') code = record['code']
          const message = typeof record['message'] === 'string' ? record['message'] : null
          const extra = typeof record['detail'] === 'string' ? record['detail'] : null
          detail = [message, extra].filter((part) => part !== null).join(' — ') || null
        }
      } catch {
        // A non-JSON error body is itself the diagnosis; the status says the rest.
      }
      throw new BillApiError(response.status, code, detail)
    }
    // A send answers 200 with an empty body, so this cannot assume JSON.
    const text = await response.text()
    if (text.trim() === '') return null
    return JSON.parse(text) as unknown
  }

  #page<Item>(body: unknown, field: string): BillPage<Item> {
    const record = object(body, field)
    const results = record['results']
    if (!Array.isArray(results)) {
      throw new BillResponseError(`${field} must carry a results array`)
    }
    const nextPage = record['nextPage']
    return {
      results: results as readonly Item[],
      nextPage: typeof nextPage === 'string' && nextPage !== '' ? nextPage : null,
    }
  }

  async listCustomers(
    options: { readonly filters?: readonly string[]; readonly max?: number } = {},
  ): Promise<BillPage<BillCustomer>> {
    const params: Record<string, string> = { max: String(options.max ?? 100) }
    if (options.filters !== undefined && options.filters.length > 0) {
      params['filters'] = options.filters.join(',')
    }
    return this.#page<BillCustomer>(
      await this.#send(this.#request('/v3/customers', { method: 'GET' }, params)),
      'customer list',
    )
  }

  async createCustomer(payload: Readonly<Record<string, unknown>>): Promise<BillCustomer> {
    const body = object(
      await this.#send(
        this.#request('/v3/customers', { method: 'POST', body: JSON.stringify(payload) }),
      ),
      'created customer',
    )
    if (typeof body['id'] !== 'string') {
      throw new BillResponseError('created customer has no id')
    }
    return body as unknown as BillCustomer
  }

  async listInvoices(
    options: { readonly filters?: readonly string[]; readonly max?: number } = {},
  ): Promise<BillPage<BillInvoice>> {
    const params: Record<string, string> = { max: String(options.max ?? 100) }
    if (options.filters !== undefined && options.filters.length > 0) {
      params['filters'] = options.filters.join(',')
    }
    return this.#page<BillInvoice>(
      await this.#send(this.#request('/v3/invoices', { method: 'GET' }, params)),
      'invoice list',
    )
  }

  async readInvoice(invoiceId: string): Promise<BillInvoice> {
    return object(
      await this.#send(
        this.#request(`/v3/invoices/${encodeURIComponent(invoiceId)}`, { method: 'GET' }),
      ),
      'invoice',
    ) as unknown as BillInvoice
  }

  async createInvoice(payload: Readonly<Record<string, unknown>>): Promise<BillInvoice> {
    const body = object(
      await this.#send(
        this.#request('/v3/invoices', { method: 'POST', body: JSON.stringify(payload) }),
      ),
      'created invoice',
    )
    if (typeof body['id'] !== 'string') {
      throw new BillResponseError('created invoice has no id')
    }
    return body as unknown as BillInvoice
  }

  /**
   * Emails the invoice to the client.
   *
   * The one call in this client that a person outside the instance can see the
   * result of, so it is separate from the create rather than a flag on it: an
   * invoice that failed to send is a document sitting in BILL that somebody can
   * send by hand, while a create-and-send that half-failed is neither state.
   *
   * There is no subject or body to supply. BILL sends its own invoice email;
   * the request only says who it goes to and who a reply reaches.
   */
  async sendInvoice(
    invoiceId: string,
    options: { readonly to: readonly string[]; readonly replyToUserId: string },
  ): Promise<void> {
    if (options.to.length === 0) {
      throw new BillResponseError('sending an invoice needs at least one recipient')
    }
    await this.#send(
      this.#request(`/v3/invoices/${encodeURIComponent(invoiceId)}/email`, {
        method: 'POST',
        body: JSON.stringify({
          recipient: { to: [...options.to] },
          replyTo: { userId: options.replyToUserId },
        }),
      }),
    )
  }

  async listReceivablePayments(
    options: {
      readonly filters?: readonly string[]
      readonly max?: number
      readonly page?: string
    } = {},
  ): Promise<BillPage<BillReceivablePayment>> {
    const params: Record<string, string> = { max: String(options.max ?? 100) }
    if (options.filters !== undefined && options.filters.length > 0) {
      params['filters'] = options.filters.join(',')
    }
    if (options.page !== undefined) params['page'] = options.page
    return this.#page<BillReceivablePayment>(
      await this.#send(this.#request('/v3/receivable-payments', { method: 'GET' }, params)),
      'receivable payment list',
    )
  }
}
