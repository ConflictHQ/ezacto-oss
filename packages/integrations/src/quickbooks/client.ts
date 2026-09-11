/**
 * QuickBooks Online `/v3` client, narrowed to what a one-way invoice mirror and
 * a payment read need.
 *
 * Same posture as the Deel client: the transport is injected, there is no
 * default credential and no environment lookup, and the tests never reach
 * Intuit -- a stray POST here creates an invoice in somebody's books, which is
 * a real document in a real ledger that somebody then has to void.
 */

/** Sandbox and production differ only by host; the path shape is identical. */
export const QUICKBOOKS_SANDBOX_BASE_URL = 'https://sandbox-quickbooks.api.intuit.com'
export const QUICKBOOKS_PRODUCTION_BASE_URL = 'https://quickbooks.api.intuit.com'

/**
 * The API minor version this client was written against.
 *
 * Sending none does not mean "no version": it means Intuit picks, and what it
 * picks moves. Pinning it is what stops a field changing shape on a day nobody
 * deployed anything. Raising it is a deliberate act with a changelog to read.
 */
export const QUICKBOOKS_MINOR_VERSION = '75'

export class QuickBooksApiError extends Error {
  readonly status: number
  /** Intuit's own error code, where the Fault carried one. */
  readonly code: string | null
  readonly detail: string | null

  constructor(status: number, code: string | null, detail: string | null) {
    super(
      `QuickBooks request failed with status ${String(status)}${
        code === null ? '' : ` (${code})`
      }${detail === null ? '' : `: ${detail}`}`,
    )
    this.name = 'QuickBooksApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export class QuickBooksResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickBooksResponseError'
  }
}

/** A QuickBooks entity reference: `{ value }` is the id, `name` is decoration. */
export interface QuickBooksRef {
  readonly value: string
  readonly name?: string
}

export interface QuickBooksCustomer {
  readonly Id: string
  readonly SyncToken: string
  readonly DisplayName: string
  readonly Active?: boolean
  readonly Job?: boolean
  readonly ParentRef?: QuickBooksRef
  readonly CurrencyRef?: QuickBooksRef
}

export interface QuickBooksInvoiceLine {
  readonly Amount: number
  readonly DetailType: 'SalesItemLineDetail' | 'DescriptionOnly'
  readonly Description?: string
  readonly SalesItemLineDetail?: {
    readonly ItemRef?: QuickBooksRef
    readonly Qty?: number
    readonly UnitPrice?: number
  }
}

export interface QuickBooksInvoice {
  readonly Id: string
  readonly SyncToken: string
  readonly DocNumber?: string
  readonly CustomerRef: QuickBooksRef
  readonly TotalAmt?: number
  readonly Balance?: number
  readonly TxnDate?: string
  readonly DueDate?: string
  readonly Line: readonly QuickBooksInvoiceLine[]
  readonly PrivateNote?: string
  readonly CurrencyRef?: QuickBooksRef
  readonly AllowOnlineACHPayment?: boolean
  readonly AllowOnlineCreditCardPayment?: boolean
}

export interface QuickBooksPaymentLine {
  readonly Amount: number
  readonly LinkedTxn?: readonly { readonly TxnId: string; readonly TxnType: string }[]
}

export interface QuickBooksPayment {
  readonly Id: string
  readonly SyncToken: string
  readonly TotalAmt: number
  readonly TxnDate?: string
  readonly CustomerRef?: QuickBooksRef
  readonly Line?: readonly QuickBooksPaymentLine[]
  readonly PaymentRefNum?: string
}

export interface QuickBooksClientOptions {
  readonly realmId: string
  /**
   * Supplied per call rather than held, because it expires. The caller owns
   * refreshing it and storing what came back -- a client that refreshed on its
   * own would have to write the rotated refresh token somewhere, and it has no
   * business knowing where that is.
   */
  readonly accessToken: string
  readonly fetch: (request: Request) => Promise<Response>
  readonly baseUrl?: string
}

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new QuickBooksResponseError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * `'` is the only character QuickBooks' query language escapes, and it escapes
 * it by doubling. Everything reaching these queries is a name or a document
 * number an operator typed, so this is the boundary where a client called
 * `O'Brien & Sons` either works or breaks the statement around it.
 */
const quote = (value: string): string => `'${value.replaceAll("'", "\\'")}'`

export class QuickBooksClient {
  readonly #realmId: string
  readonly #accessToken: string
  readonly #fetch: (request: Request) => Promise<Response>
  readonly #baseUrl: string

  constructor(options: Readonly<QuickBooksClientOptions>) {
    if (options.realmId.trim() === '') {
      throw new QuickBooksResponseError('realmId is required')
    }
    if (options.accessToken.trim() === '') {
      throw new QuickBooksResponseError('accessToken is required')
    }
    this.#realmId = options.realmId
    this.#accessToken = options.accessToken
    this.#fetch = options.fetch
    this.#baseUrl = options.baseUrl ?? QUICKBOOKS_PRODUCTION_BASE_URL
  }

  #url(path: string, params: Record<string, string> = {}): string {
    const url = new URL(
      `/v3/company/${encodeURIComponent(this.#realmId)}${path}`,
      this.#baseUrl,
    )
    url.searchParams.set('minorversion', QUICKBOOKS_MINOR_VERSION)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return url.toString()
  }

  async #send(request: Request): Promise<Record<string, unknown>> {
    const response = await this.#fetch(request)
    if (!response.ok) {
      let code: string | null = null
      let detail: string | null = null
      try {
        const body = (await response.json()) as Record<string, unknown>
        const fault = body['Fault']
        if (typeof fault === 'object' && fault !== null) {
          const errors = (fault as Record<string, unknown>)['Error']
          if (Array.isArray(errors) && errors.length > 0) {
            const first = errors[0] as Record<string, unknown>
            if (typeof first['code'] === 'string') code = first['code']
            const message = typeof first['Message'] === 'string' ? first['Message'] : null
            const extra = typeof first['Detail'] === 'string' ? first['Detail'] : null
            detail = [message, extra].filter((part) => part !== null).join(' — ') || null
          }
        }
      } catch {
        // A non-JSON error body is itself the diagnosis; the status says the rest.
      }
      throw new QuickBooksApiError(response.status, code, detail)
    }
    return object(await response.json(), 'response body')
  }

  #request(path: string, init: RequestInit, params?: Record<string, string>): Request {
    return new Request(this.#url(path, params), {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.#accessToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  /**
   * A read-only query. Everything that looks something up goes through here, so
   * there is one place that knows how QuickBooks wraps results.
   */
  async query<Entity>(statement: string, entity: string): Promise<readonly Entity[]> {
    const body = await this.#send(
      this.#request('/query', { method: 'GET' }, { query: statement }),
    )
    const response = body['QueryResponse']
    if (response === undefined) return []
    const rows = object(response, 'QueryResponse')[entity]
    if (rows === undefined) return []
    if (!Array.isArray(rows)) {
      throw new QuickBooksResponseError(`QueryResponse.${entity} must be an array`)
    }
    return rows as Entity[]
  }

  async findCustomerByDisplayName(displayName: string): Promise<QuickBooksCustomer | null> {
    const rows = await this.query<QuickBooksCustomer>(
      `SELECT * FROM Customer WHERE DisplayName = ${quote(displayName)}`,
      'Customer',
    )
    return rows[0] ?? null
  }

  async createCustomer(input: Record<string, unknown>): Promise<QuickBooksCustomer> {
    const body = await this.#send(
      this.#request('/customer', { method: 'POST', body: JSON.stringify(input) }),
    )
    return object(body['Customer'], 'Customer') as unknown as QuickBooksCustomer
  }

  /**
   * A full update. QuickBooks requires the current `SyncToken` and rejects a
   * stale one, which is optimistic concurrency and the reason the link table
   * stores the token beside the id.
   */
  async updateCustomer(input: Record<string, unknown>): Promise<QuickBooksCustomer> {
    const body = await this.#send(
      this.#request('/customer', { method: 'POST', body: JSON.stringify(input) }),
    )
    return object(body['Customer'], 'Customer') as unknown as QuickBooksCustomer
  }

  /**
   * The adopt half of "a retry never duplicates".
   *
   * QuickBooks has no idempotency key on create. If a mirror wrote an invoice
   * and then failed before its local link was stored, the retry has to find
   * what the first attempt made rather than make a second one. `DocNumber`
   * carries our invoice number, which is unique in our book, so it is the
   * handle to find it by.
   */
  async findInvoiceByDocNumber(docNumber: string): Promise<QuickBooksInvoice | null> {
    const rows = await this.query<QuickBooksInvoice>(
      `SELECT * FROM Invoice WHERE DocNumber = ${quote(docNumber)}`,
      'Invoice',
    )
    return rows[0] ?? null
  }

  async readInvoice(id: string): Promise<QuickBooksInvoice | null> {
    try {
      const body = await this.#send(
        this.#request(`/invoice/${encodeURIComponent(id)}`, { method: 'GET' }),
      )
      return object(body['Invoice'], 'Invoice') as unknown as QuickBooksInvoice
    } catch (error) {
      // A mirrored invoice deleted in QuickBooks is a real state, not a failure:
      // the link is stale and the caller decides whether to re-create.
      if (error instanceof QuickBooksApiError && error.status === 404) return null
      throw error
    }
  }

  async createInvoice(input: Record<string, unknown>): Promise<QuickBooksInvoice> {
    const body = await this.#send(
      this.#request('/invoice', { method: 'POST', body: JSON.stringify(input) }),
    )
    return object(body['Invoice'], 'Invoice') as unknown as QuickBooksInvoice
  }

  async updateInvoice(input: Record<string, unknown>): Promise<QuickBooksInvoice> {
    const body = await this.#send(
      this.#request('/invoice', { method: 'POST', body: JSON.stringify(input) }),
    )
    return object(body['Invoice'], 'Invoice') as unknown as QuickBooksInvoice
  }

  async readPayment(id: string): Promise<QuickBooksPayment | null> {
    try {
      const body = await this.#send(
        this.#request(`/payment/${encodeURIComponent(id)}`, { method: 'GET' }),
      )
      return object(body['Payment'], 'Payment') as unknown as QuickBooksPayment
    } catch (error) {
      if (error instanceof QuickBooksApiError && error.status === 404) return null
      throw error
    }
  }

  /** The company's own record, used to confirm a connection actually works. */
  async companyName(): Promise<string | null> {
    const body = await this.#send(
      this.#request(`/companyinfo/${encodeURIComponent(this.#realmId)}`, { method: 'GET' }),
    )
    const info = object(body['CompanyInfo'], 'CompanyInfo')
    return typeof info['CompanyName'] === 'string' ? info['CompanyName'] : null
  }
}
