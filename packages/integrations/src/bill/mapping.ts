/**
 * What an ezacto client and invoice look like once BILL has them, and how a
 * second attempt finds the first one's work instead of duplicating it.
 *
 * BILL has no idempotency key on create, exactly as QuickBooks has none. A
 * retried delivery -- a queue redelivering, an operator pressing send twice, a
 * timeout that actually succeeded -- must therefore be made safe by something
 * already in the payload. Our invoice number is unique in our own book and BILL
 * accepts it as `invoiceNumber`, so it is the natural key: look for it, and
 * create only when it is genuinely absent.
 *
 * That is weaker than a real idempotency key and the weakness is worth naming.
 * Two simultaneous first attempts can both look, both find nothing and both
 * create. What it does cover is the common case, which is sequential retries.
 */

export class BillMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillMappingError'
  }
}

export interface BillMirrorClient {
  readonly id: number
  readonly name: string
  /**
   * Where the invoice is emailed. BILL requires an email on a customer, and an
   * invoice sent to nobody is the failure this integration exists to avoid.
   */
  readonly email: string | null
}

export interface BillMirrorInvoiceLine {
  readonly description: string
  /** Cents, as everything money is stored here. */
  readonly amountCents: number
  readonly quantity: number | null
  readonly unitPriceCents: number | null
}

export interface BillMirrorInvoice {
  readonly id: number
  /** Our invoice number. Unique in our book, so it is what BILL is told. */
  readonly number: string
  readonly clientId: number
  readonly currency: string
  readonly issueDate: string
  readonly dueDate: string | null
  readonly subject: string | null
  readonly lines: readonly BillMirrorInvoiceLine[]
}

/**
 * BILL takes money as a decimal number, and everything here is cents.
 *
 * Rounded rather than truncated, and rounded once at the boundary: a line
 * total that arrived as cents is already exact, and the only thing this can get
 * wrong is inventing a fraction of a cent to lose.
 */
const centsToAmount = (cents: number): number => Math.round(cents) / 100

const requireText = (value: string, field: string): string => {
  const trimmed = value.trim()
  if (trimmed === '') throw new BillMappingError(`${field} is required`)
  return trimmed
}

/**
 * BILL caps a customer name at 100 characters and refuses a longer one, so the
 * name is cut here rather than at the API. Cutting loses the tail of a long
 * client name, which is visible and survivable; the refusal would stop the
 * invoice, which is neither.
 */
export const BILL_CUSTOMER_NAME_LIMIT = 100
export const BILL_LINE_DESCRIPTION_LIMIT = 4000
export const BILL_INVOICE_NUMBER_LIMIT = 100

const clamp = (value: string, limit: number): string =>
  value.length <= limit ? value : value.slice(0, limit)

export const customerPayload = (
  client: Readonly<BillMirrorClient>,
): Record<string, unknown> => {
  if (client.email === null || client.email.trim() === '') {
    // Caught here rather than at BILL, because the message BILL returns for a
    // missing email does not say which client it was.
    throw new BillMappingError(
      `client ${String(client.id)} has no email address, and BILL needs one to send an invoice`,
    )
  }
  return {
    name: clamp(requireText(client.name, 'client name'), BILL_CUSTOMER_NAME_LIMIT),
    email: client.email.trim(),
    accountType: 'BUSINESS',
  }
}

/**
 * Whether a customer BILL already holds is the one we would have created.
 *
 * Matched on name rather than email: BILL does not require a customer name to
 * be unique, so the name is what an operator reading their BILL customer list
 * will use to tell two apart, and matching on something they cannot see would
 * make a duplicate invisible until it had already been invoiced twice.
 */
export const customerMatches = (
  candidate: Readonly<{ name?: string; archived?: boolean }>,
  client: Readonly<BillMirrorClient>,
): boolean => {
  if (candidate.archived === true) return false
  const wanted = clamp(client.name.trim(), BILL_CUSTOMER_NAME_LIMIT)
  return (candidate.name ?? '').trim() === wanted
}

export const invoicePayload = (
  invoice: Readonly<BillMirrorInvoice>,
  customerId: string,
): Record<string, unknown> => {
  if (invoice.lines.length === 0) {
    throw new BillMappingError(
      `invoice ${invoice.number} has no lines, and BILL requires at least one`,
    )
  }
  return {
    customer: { id: requireText(customerId, 'customer id') },
    invoiceNumber: clamp(
      requireText(invoice.number, 'invoice number'),
      BILL_INVOICE_NUMBER_LIMIT,
    ),
    invoiceDate: invoice.issueDate,
    // BILL defaults a missing due date to the creation date, which would make
    // an undated invoice look overdue the moment it arrives. Ours is the issue
    // date in that case, which is the same default with an honest reason.
    dueDate: invoice.dueDate ?? invoice.issueDate,
    invoiceLineItems: invoice.lines.map((line) => {
      // BILL requires a quantity, and multiplies it by `price` to get the line
      // total. A line billed as a lump sum has no quantity, and the sum is then
      // the price of one of it.
      const quantity = line.quantity ?? 1
      return {
        quantity,
        description: clamp(
          line.description.trim() === '' ? invoice.subject ?? 'Services' : line.description,
          BILL_LINE_DESCRIPTION_LIMIT,
        ),
        // `price` is per unit, not the line total. Deriving it by dividing the
        // total is what keeps a line of three at 20.00 from being sent as three
        // at 60.00 -- BILL would multiply it out and the client would be
        // invoiced three times what we billed.
        price: centsToAmount(line.unitPriceCents ?? line.amountCents / quantity),
      }
    }),
  }
}

export type BillInvoicePlan =
  | { readonly action: 'create' }
  | { readonly action: 'adopt'; readonly billInvoiceId: string }

/**
 * What to do about an invoice BILL may or may not already hold.
 *
 * `adopt` is the retry case: an invoice carrying our number is already there,
 * so the previous attempt succeeded even if we never heard so, and the right
 * move is to record the link rather than create a second document. There is no
 * `update` here on purpose -- this integration sends an invoice once, and
 * editing a sent invoice in somebody else's system is a decision nobody asked
 * for.
 */
export const planInvoice = (
  invoice: Readonly<BillMirrorInvoice>,
  existing: readonly Readonly<{ id: string; invoiceNumber?: string }>[],
): BillInvoicePlan => {
  const wanted = clamp(invoice.number.trim(), BILL_INVOICE_NUMBER_LIMIT)
  const match = existing.find((candidate) => (candidate.invoiceNumber ?? '').trim() === wanted)
  return match === undefined ? { action: 'create' } : { action: 'adopt', billInvoiceId: match.id }
}

export interface BillSettledPayment {
  readonly billPaymentId: string
  readonly billInvoiceId: string
  readonly amountCents: number
  readonly paidOn: string | null
}

const amountToCents = (amount: number): number => Math.round(amount * 100)

/**
 * The parts of a BILL payment that settled invoices we mirrored.
 *
 * A BILL payment can cover several invoices at once, so it is flattened to one
 * settlement per invoice -- recording the payment's whole amount against one of
 * them would overstate what that invoice received.
 *
 * Only `PAID` counts. A scheduled payment has not arrived, and a voided,
 * cancelled or escheated one never will; treating any of those as money
 * received would mark an invoice paid that is still owed.
 */
export const settledPayments = (
  payments: readonly Readonly<{
    id: string
    status?: string
    invoicePayments?: readonly Readonly<{
      invoiceId: string
      amount: number
      paymentDate?: string
    }>[]
  }>[],
  knownBillInvoiceIds: ReadonlySet<string>,
): readonly BillSettledPayment[] =>
  payments
    .filter((payment) => payment.status === 'PAID')
    .flatMap((payment) =>
      (payment.invoicePayments ?? [])
        .filter((line) => knownBillInvoiceIds.has(line.invoiceId))
        .map((line) => ({
          billPaymentId: payment.id,
          billInvoiceId: line.invoiceId,
          amountCents: amountToCents(line.amount),
          paidOn: line.paymentDate ?? null,
        })),
    )
