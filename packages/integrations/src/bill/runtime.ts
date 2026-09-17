import { BillClient, billFilter, type BillCustomer, type BillInvoice } from './client.js'
import {
  BILL_PRODUCTION_BASE_URL,
  BILL_SANDBOX_BASE_URL,
  login,
  sessionIsStale,
  touchSession,
  type BillCredentials,
  type BillSession,
} from './session.js'
import {
  inboundPayments,
  mirrorInvoice,
  type BillDelivery,
  type BillLinkStore,
  type BillMirrorOutcome,
  type MirrorBill,
} from './mirror.js'
import { amountToCents, type BillMirrorClient, type BillMirrorInvoice } from './mapping.js'

/**
 * Everything above the transport: hold a session, decide how an invoice is
 * delivered, and answer the two questions the rest of the system asks -- send
 * this invoice, and what has been paid.
 *
 * The types the API and the entries use are declared structurally here so that
 * this package keeps depending on nothing. `@ezacto/db` supplies the store and
 * the source; `@ezacto/api` mounts the routes; neither imports the other.
 */

export interface BillConfig {
  readonly devKey: string | undefined
  readonly companyId: string | undefined
  /**
   * The username half of the login. Either an operator's BILL email, or the
   * NAME of an AP/AR sync token -- BILL takes both in the same field.
   */
  readonly username: string | undefined
  /** The password half: an operator's password, or the sync token's value. */
  readonly password: string | undefined
  /**
   * The BILL user a reply to a sent invoice reaches. Required only to have BILL
   * send its own invoice email; without it the mirror falls back to carrying a
   * payment link in ezacto's own email, which needs no such permission.
   */
  readonly replyToUserId: string | undefined
  /** `sandbox` reaches BILL's test organisation only; anything else is the real book. */
  readonly environment: string | undefined
}

export interface BillConnectionStatus {
  readonly configured: boolean
  readonly companyId: string | null
  readonly environment: 'sandbox' | 'production'
  /**
   * Whether this deployment's credential can have BILL send the invoice email.
   * A sync token cannot, and an operator seeing "we will send it" when BILL
   * will is the difference between a client getting one email and none.
   */
  readonly canSendFromBill: boolean
}

/**
 * Reading an invoice and its client, for the mirror. Narrow on purpose: this
 * needs one invoice and one client, not the money repository.
 */
export interface BillMirrorSource {
  readInvoice(invoiceId: number): Promise<BillMirrorInvoice | null>
  readClient(clientId: number): Promise<BillMirrorClient | null>
  /** Whether this client asked to be billed through BILL. */
  isOptedIn(clientId: number): Promise<boolean>
  /** Our invoice id for each BILL invoice id we have mirrored. */
  mirroredInvoices(): Promise<ReadonlyMap<string, number>>
  /**
   * Open invoices here with no BILL link yet: the ones a reconciliation may
   * still find in BILL under our number and adopt (issue 836). Bounded by
   * what is unpaid, so an instance with nothing outstanding asks nothing.
   */
  unsettledInvoices(): Promise<
    readonly { id: number; number: string; issueDate: string; amountCents: number }[]
  >
  recordPayment(input: {
    invoiceId: number
    billInvoiceId: string
    billPaymentId: string
    amountCents: number
    paidOn: string | null
  }): Promise<void>
}

export interface BillRuntimeOptions {
  readonly config: BillConfig
  readonly links: BillLinkStore
  readonly source: BillMirrorSource
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => Date
}

export interface BillRuntime {
  status(): BillConnectionStatus
  /** Mirrors one invoice, or says why it did not. Used by the outbox subscriber. */
  mirror(invoiceId: number): Promise<BillMirrorOutcome>
  /** Reads BILL's receivables and records what settled our invoices. */
  reconcilePayments(): Promise<number>
}

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim()
  return text === undefined || text === '' ? null : text
}

/**
 * BILL's v3 list refuses `invoiceNumber` as a filter field ("field
 * [invoiceNumber] is not supported in filter field"), which the first version
 * of this asked for and which every deployment would have failed on at the
 * first adopt. It does take `invoiceDate:gte`, so the window from the day our
 * invoice was issued is read and the number matched here. A document with our
 * number carries our issue date -- BILL is told it, and Harvest wrote the same
 * date into both books -- so the window holds the match and stays short.
 */
const findInvoiceByNumber = async (
  client: BillClient,
  invoiceNumber: string,
  issueDate: string,
): Promise<BillInvoice | null> => {
  const wanted = invoiceNumber.trim()
  let page: string | undefined
  do {
    const result = await client.listInvoices({
      filters: [billFilter('invoiceDate', 'gte', issueDate)],
      ...(page === undefined ? {} : { page }),
    })
    const match = result.results.find(
      (candidate) => (candidate.invoiceNumber ?? '').trim() === wanted,
    )
    if (match !== undefined) return match
    page = result.nextPage ?? undefined
  } while (page !== undefined)
  return null
}

export const createBillRuntime = (
  options: Readonly<BillRuntimeOptions>,
): BillRuntime => {
  const { config, links, source } = options
  const devKey = trimmed(config.devKey)
  const companyId = trimmed(config.companyId)
  const username = trimmed(config.username)
  const password = trimmed(config.password)
  const replyToUserId = trimmed(config.replyToUserId)
  const sandbox = config.environment?.trim().toLowerCase() === 'sandbox'
  const baseUrl = sandbox ? BILL_SANDBOX_BASE_URL : BILL_PRODUCTION_BASE_URL

  const credentials: BillCredentials | null =
    devKey === null || companyId === null || username === null || password === null
      ? null
      : { devKey, companyId, username, password }

  // A single session, reused. BILL expires on idle rather than age, so a
  // deployment that mirrors regularly signs in once and a quiet one signs in
  // again when it wakes -- which is the behaviour "last used" buys.
  let session: BillSession | null = null

  const signedIn = async (): Promise<BillClient> => {
    if (credentials === null) {
      throw new Error('BILL is not configured for this deployment')
    }
    const now = options.now().toISOString()
    if (session === null || sessionIsStale(session, now)) {
      session = await login({ credentials, fetch: options.fetch, baseUrl, now })
    } else {
      session = touchSession(session, now)
    }
    return new BillClient({
      sessionId: session.sessionId,
      devKey: credentials.devKey,
      fetch: options.fetch,
      baseUrl,
    })
  }

  /**
   * The client's lookups, expressed as the mirror wants them.
   *
   * The two `find` calls are filtered searches rather than list-and-scan: an
   * organisation with a thousand customers would otherwise page through all of
   * them to answer whether one exists.
   */
  const mirrorBill = (client: BillClient): MirrorBill => ({
    findCustomerByName: async (name: string): Promise<BillCustomer | null> => {
      const page = await client.listCustomers({
        filters: [billFilter('name', 'eq', name)],
        max: 2,
      })
      return page.results[0] ?? null
    },
    createCustomer: (input) => client.createCustomer(input),
    findInvoiceByNumber: (invoiceNumber, issueDate) =>
      findInvoiceByNumber(client, invoiceNumber, issueDate),
    createInvoice: (input) => client.createInvoice(input),
    sendInvoice: (invoiceId, sendOptions) => client.sendInvoice(invoiceId, sendOptions),
    paymentLink: (invoiceId) => client.paymentLink(invoiceId),
  })

  /**
   * How this deployment can deliver.
   *
   * Having BILL send its own email needs a credential that can also move money;
   * a sync token is refused, and so is a deployment that never set a reply-to
   * user. Rather than fail at that wall, the mirror falls back to a payment
   * link in ezacto's own invoice email, which reaches the same client at the
   * same place to pay.
   */
  const delivery = (): BillDelivery =>
    replyToUserId === null ? { via: 'link' } : { via: 'bill', replyToUserId }

  return {
    status: () => ({
      configured: credentials !== null,
      companyId,
      environment: sandbox ? 'sandbox' : 'production',
      canSendFromBill: replyToUserId !== null,
    }),

    mirror: async (invoiceId: number): Promise<BillMirrorOutcome> => {
      if (credentials === null) {
        return { kind: 'refused', reason: 'BILL is not configured for this deployment' }
      }
      const invoice = await source.readInvoice(invoiceId)
      if (invoice === null) {
        return { kind: 'refused', reason: 'the invoice does not exist' }
      }
      // The opt-in is checked here rather than by the caller, so every path into
      // the mirror answers to it -- a client who did not ask for this must not
      // have their invoice sent through a third party by a route that forgot.
      if (!(await source.isOptedIn(invoice.clientId))) {
        return { kind: 'refused', reason: 'this client is not billed through BILL' }
      }
      const client = await source.readClient(invoice.clientId)
      if (client === null) {
        return { kind: 'refused', reason: 'the client does not exist' }
      }
      return mirrorInvoice({
        invoice,
        client,
        links,
        bill: mirrorBill(await signedIn()),
        delivery: delivery(),
      })
    },

    reconcilePayments: async (): Promise<number> => {
      if (credentials === null) return 0
      // Invoices BILL already holds under our number -- sent from Harvest
      // before the cutover, or here before BILL was configured -- are adopted
      // when their totals agree (issue 836). Only the link is written: nothing
      // is sent, and the client need not be opted in, because this records
      // that a document in the books is ours rather than sending one. Once
      // linked, a payment against it lands below like any other.
      const unsettled = await source.unsettledInvoices()
      let client: Awaited<ReturnType<typeof signedIn>> | null = null
      for (const ours of unsettled) {
        client ??= await signedIn()
        const theirs = await findInvoiceByNumber(client, ours.number, ours.issueDate)
        if (theirs === null) continue
        if (theirs.totalAmount === undefined || amountToCents(theirs.totalAmount) !== ours.amountCents) {
          continue
        }
        await links.saveLink('invoice', ours.id, { billId: theirs.id, paymentLink: null })
      }
      const mirrored = await source.mirroredInvoices()
      if (mirrored.size === 0) return 0
      client ??= await signedIn()

      const collected: Parameters<typeof inboundPayments>[0]['payments'][number][] = []
      let page: string | undefined
      // Paged to the end rather than to the first page: a quiet week of BILL
      // activity can push our payment past the first hundred, and stopping
      // early would leave an invoice unpaid in our book and paid in theirs.
      do {
        const result = await client.listReceivablePayments(
          page === undefined ? {} : { page },
        )
        collected.push(...result.results)
        page = result.nextPage ?? undefined
      } while (page !== undefined)

      const settled = inboundPayments({ payments: collected, mirrored })
      for (const payment of settled) {
        // Recorded one at a time and keyed on the payment/invoice pair, so a
        // second pass over the same page records nothing.
        await source.recordPayment({
          invoiceId: payment.invoiceId,
          billInvoiceId: payment.billInvoiceId,
          billPaymentId: payment.billPaymentId,
          amountCents: payment.amountCents,
          paidOn: payment.paidOn,
        })
      }
      return settled.length
    },
  }
}

/**
 * The outbox subscriber. Fires on `invoice.sent` and nothing else.
 *
 * A refusal is a decision, not a failure: not configured, not opted in, already
 * mirrored. Retrying cannot change any of those, so it returns rather than
 * throwing -- the outbox would otherwise retry a correct decision until it gave
 * up and called it an error.
 *
 * Failures do throw. The outbox retries, and the mirror is safe to retry: that
 * is what the adopt path and the link table are for.
 */
export const createBillMirrorSubscriber = (
  runtime: Readonly<BillRuntime>,
): {
  readonly id: 'bill_mirror'
  deliver(
    event: Readonly<{ eventType: string; aggregateType: string; aggregateId: number }>,
  ): Promise<void>
} => ({
  id: 'bill_mirror',
  async deliver(event) {
    if (event.aggregateType !== 'invoice' || event.eventType !== 'invoice.sent') return
    await runtime.mirror(event.aggregateId)
  },
})
