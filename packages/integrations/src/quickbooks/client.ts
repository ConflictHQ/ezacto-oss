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

/** Intuit's ceiling for one query page. */
export const QUICKBOOKS_QUERY_PAGE_SIZE = 1000
/** A bound on the report's read, so a runaway company cannot exhaust the Worker. */
export const QUICKBOOKS_MAXIMUM_LISTED_INVOICES = 20_000

export class QuickBooksApiError extends Error {
  readonly status: number
  /** Intuit's own error code, where the Fault carried one. */
  readonly code: string | null
  readonly detail: string | null
  /** Seconds Intuit asked us to wait, from `Retry-After` on a throttled answer. */
  readonly retryAfterSeconds: number | null

  constructor(
    status: number,
    code: string | null,
    detail: string | null,
    retryAfterSeconds: number | null = null,
  ) {
    super(
      `QuickBooks request failed with status ${String(status)}${
        code === null ? '' : ` (${code})`
      }${detail === null ? '' : `: ${detail}`}`,
    )
    this.name = 'QuickBooksApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * QuickBooks does not answer a missing object with a 404. A read of an id
 * the company does not hold -- deleted, or never there -- is a 400 whose
 * Fault carries code 610, "Object Not Found" (seen on the sandbox,
 * 2026-09-17). A 404 is kept for the shape the docs describe.
 */
const isObjectNotFound = (error: unknown): boolean =>
  error instanceof QuickBooksApiError &&
  (error.status === 404 || (error.status === 400 && error.code === '610'))


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
  /** QuickBooks voids a payment by zeroing it and replacing this with "Voided". */
  readonly PrivateNote?: string
  readonly MetaData?: { readonly CreateTime?: string; readonly LastUpdatedTime?: string }
}

/**
 * A payment as change data capture reports it: the whole document, or -- for
 * one deleted since -- only its id and `status: 'Deleted'`.
 */
export type QuickBooksCapturedPayment =
  | (QuickBooksPayment & { readonly status?: undefined })
  | { readonly Id: string; readonly status: 'Deleted' }

/** One window of captured payments, and the instant Intuit answered at. */
export interface QuickBooksPaymentChanges {
  readonly time: string
  readonly payments: readonly QuickBooksCapturedPayment[]
  /** Intuit returns at most this many per window; a full one may have more behind it. */
  readonly full: boolean
}

/** Intuit's ceiling for the objects of one entity in one change-data-capture answer. */
export const QUICKBOOKS_CDC_PAGE_SIZE = 1000

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
      const retryAfter = Number(response.headers.get('retry-after'))
      throw new QuickBooksApiError(
        response.status,
        code,
        detail,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      )
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

  /**
   * Payments created, changed, voided or deleted since an instant, from
   * Intuit's change data capture. Read-only. Intuit answers for the last 30
   * days only; the caller checks the horizon, because an older instant is
   * refused here rather than answered partially.
   */
  async paymentChangesSince(changedSince: string): Promise<QuickBooksPaymentChanges> {
    const body = await this.#send(
      this.#request('/cdc', { method: 'GET' }, { entities: 'Payment', changedSince }),
    )
    const time = body['time']
    if (typeof time !== 'string') {
      throw new QuickBooksResponseError('the change data capture answer carries no time')
    }
    const responses = body['CDCResponse']
    if (!Array.isArray(responses)) {
      throw new QuickBooksResponseError('CDCResponse must be an array')
    }
    const payments: QuickBooksCapturedPayment[] = []
    for (const response of responses) {
      const queries = object(response, 'CDCResponse entry')['QueryResponse']
      if (queries === undefined) continue
      if (!Array.isArray(queries)) {
        throw new QuickBooksResponseError('CDCResponse.QueryResponse must be an array')
      }
      for (const query of queries) {
        const rows = object(query, 'QueryResponse entry')['Payment']
        if (rows === undefined) continue
        if (!Array.isArray(rows)) {
          throw new QuickBooksResponseError('QueryResponse.Payment must be an array')
        }
        payments.push(...(rows as QuickBooksCapturedPayment[]))
      }
    }
    return { time, payments, full: payments.length >= QUICKBOOKS_CDC_PAGE_SIZE }
  }

  async findCustomerByDisplayName(displayName: string): Promise<QuickBooksCustomer | null> {
    const rows = await this.query<QuickBooksCustomer>(
      `SELECT * FROM Customer WHERE DisplayName = ${quote(displayName)}`,
      'Customer',
    )
    return rows[0] ?? null
  }

  async readCustomer(id: string): Promise<QuickBooksCustomer | null> {
    try {
      const body = await this.#send(
        this.#request(`/customer/${encodeURIComponent(id)}`, { method: 'GET' }),
      )
      return object(body['Customer'], 'Customer') as unknown as QuickBooksCustomer
    } catch (error) {
      if (isObjectNotFound(error)) return null
      throw error
    }
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

  /**
   * Every invoice the company holds, for the reconciliation report. Read-only:
   * pages of the query endpoint, `MAXRESULTS` at Intuit's ceiling. A company
   * past `QUICKBOOKS_MAXIMUM_LISTED_INVOICES` is refused rather than reported
   * on partially -- a report that silently omits invoices would call them
   * "missing here".
   */
  async listInvoices(): Promise<readonly QuickBooksInvoice[]> {
    const all: QuickBooksInvoice[] = []
    for (;;) {
      const page = await this.query<QuickBooksInvoice>(
        `SELECT * FROM Invoice STARTPOSITION ${String(all.length + 1)} MAXRESULTS ${String(QUICKBOOKS_QUERY_PAGE_SIZE)}`,
        'Invoice',
      )
      all.push(...page)
      if (all.length > QUICKBOOKS_MAXIMUM_LISTED_INVOICES) {
        throw new QuickBooksResponseError(
          `the company holds more than ${String(QUICKBOOKS_MAXIMUM_LISTED_INVOICES)} invoices; the report cannot read them all`,
        )
      }
      if (page.length < QUICKBOOKS_QUERY_PAGE_SIZE) return all
    }
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
      if (isObjectNotFound(error)) return null
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

  /**
   * A payment this mirror made earlier, found by the reference it stamped on
   * it. Looked up before creating for the same reason invoices are found by
   * DocNumber: a run that created the payment and failed before recording the
   * link must adopt it, not make a second one.
   */
  async findPaymentByRefNumber(refNumber: string): Promise<QuickBooksPayment | null> {
    const rows = await this.query<QuickBooksPayment>(
      `SELECT * FROM Payment WHERE PaymentRefNum = ${quote(refNumber)}`,
      'Payment',
    )
    return rows[0] ?? null
  }

  async createPayment(input: Record<string, unknown>): Promise<QuickBooksPayment> {
    const body = await this.#send(
      this.#request('/payment', { method: 'POST', body: JSON.stringify(input) }),
    )
    return object(body['Payment'], 'Payment') as unknown as QuickBooksPayment
  }

  async readPayment(id: string): Promise<QuickBooksPayment | null> {
    try {
      const body = await this.#send(
        this.#request(`/payment/${encodeURIComponent(id)}`, { method: 'GET' }),
      )
      return object(body['Payment'], 'Payment') as unknown as QuickBooksPayment
    } catch (error) {
      if (isObjectNotFound(error)) return null
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
