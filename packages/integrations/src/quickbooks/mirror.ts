/**
 * Copying one invoice into QuickBooks, and reading one payment back.
 *
 * Driven by two narrow interfaces -- somewhere to keep links, and something
 * that talks to QuickBooks -- so the whole decision sequence can be tested with
 * fakes. The runner never reaches for a client or a database itself.
 */

import type {
  QuickBooksCustomer,
  QuickBooksInvoice,
  QuickBooksPayment,
} from './client.js'
import {
  clientAncestry,
  customerMatches,
  invoicePayload,
  invoiceUpdatePayload,
  planInvoiceMirror,
  plannedCustomer,
  type MirrorClient,
  type MirrorInvoice,
} from './mapping.js'

export type MirrorLinkKind = 'customer' | 'invoice'

export interface MirrorLink {
  readonly quickBooksId: string
  readonly syncToken: string
}

export interface MirrorLinkStore {
  readLink(kind: MirrorLinkKind, ezactoId: number): Promise<MirrorLink | null>
  saveLink(
    kind: MirrorLinkKind,
    ezactoId: number,
    link: MirrorLink,
  ): Promise<void>
}

/** The half of the QuickBooks client a mirror uses. */
export interface MirrorQuickBooks {
  findCustomerByDisplayName(displayName: string): Promise<QuickBooksCustomer | null>
  createCustomer(input: Record<string, unknown>): Promise<QuickBooksCustomer>
  findInvoiceByDocNumber(docNumber: string): Promise<QuickBooksInvoice | null>
  readInvoice(id: string): Promise<QuickBooksInvoice | null>
  createInvoice(input: Record<string, unknown>): Promise<QuickBooksInvoice>
  updateInvoice(input: Record<string, unknown>): Promise<QuickBooksInvoice>
}

export type MirrorOutcome =
  | { readonly kind: 'created'; readonly quickBooksId: string }
  | { readonly kind: 'updated'; readonly quickBooksId: string }
  | { readonly kind: 'adopted'; readonly quickBooksId: string }
  | { readonly kind: 'refused'; readonly reason: string }

export interface MirrorInvoiceInput {
  readonly invoice: MirrorInvoice
  /** Every client the invoice's ancestry touches, by id. */
  readonly clients: ReadonlyMap<number, MirrorClient>
  readonly links: MirrorLinkStore
  readonly quickBooks: MirrorQuickBooks
  readonly allowOnlinePayment: boolean
}

const centsOf = (amount: number | undefined): number | null =>
  amount === undefined ? null : Math.round(amount * 100)

/**
 * Make sure every client from the root down to this one exists in QuickBooks,
 * and answer with the customer the invoice should be filed against.
 *
 * Walked root first because a sub-customer cannot be created before its parent:
 * `ParentRef` has to name something. Each level is linked as it is made, so a
 * failure halfway leaves the levels already done recorded rather than repeated.
 */
const ensureCustomer = async (
  input: Pick<MirrorInvoiceInput, 'clients' | 'links' | 'quickBooks'>,
  clientId: number,
): Promise<{ quickBooksId: string } | { refused: string }> => {
  const ancestry = clientAncestry(clientId, input.clients)
  let parentId: string | null = null
  for (let depth = 1; depth <= ancestry.length; depth += 1) {
    const chain = ancestry.slice(0, depth)
    const current = chain[chain.length - 1]!
    const existingLink = await input.links.readLink('customer', current.id)
    if (existingLink !== null) {
      parentId = existingLink.quickBooksId
      continue
    }
    const planned = plannedCustomer(chain, parentId)
    // Adopt before creating, for the same reason invoices do: a previous run may
    // have made this customer and failed before recording the link, and
    // DisplayName is unique in QuickBooks so a second create would be refused
    // anyway -- with an error that says nothing useful.
    const found = await input.quickBooks.findCustomerByDisplayName(planned.displayName)
    if (found !== null) {
      if (!customerMatches(found, planned)) {
        return {
          refused: `QuickBooks already has a customer named ${planned.displayName} under a different parent`,
        }
      }
      await input.links.saveLink('customer', current.id, {
        quickBooksId: found.Id,
        syncToken: found.SyncToken,
      })
      parentId = found.Id
      continue
    }
    const created = await input.quickBooks.createCustomer(planned.payload)
    await input.links.saveLink('customer', current.id, {
      quickBooksId: created.Id,
      syncToken: created.SyncToken,
    })
    parentId = created.Id
  }
  return parentId === null
    ? { refused: 'the client tree produced no customer' }
    : { quickBooksId: parentId }
}

export const mirrorInvoice = async (
  input: Readonly<MirrorInvoiceInput>,
): Promise<MirrorOutcome> => {
  // The invoice is looked up before any customer is made. A number QuickBooks
  // already holds is decided here, and deciding it after `ensureCustomer` left
  // a customer in the books for an invoice that was then refused.
  const link = await input.links.readLink('invoice', input.invoice.id)
  // Only looked up where there is no link. With one, the id is known and a query
  // by number would be a round trip to learn something already recorded.
  const existing =
    link === null ? await input.quickBooks.findInvoiceByDocNumber(input.invoice.number) : null
  const action = planInvoiceMirror(input.invoice, link, existing)

  if (action.kind === 'conflict') {
    // An invoice QuickBooks already holds under our number that this mirror
    // did not write: the books came through Harvest and hold every invoice
    // already (issue 825), and everything here is meant to reach QuickBooks
    // (issue 853) -- a receipt recorded here or a payment made there, on an
    // invoice sent before this mirror existed. Adopted when the totals agree
    // to the cent, on every path, not only the Sync button: adoption writes
    // nothing to the document, so there is nothing to protect by refusing.
    if (existing === null) {
      return { kind: 'refused', reason: action.reason }
    }
    const theirs = centsOf(existing.TotalAmt)
    if (theirs !== input.invoice.amountCents) {
      return {
        kind: 'refused',
        reason: `QuickBooks already holds invoice ${input.invoice.number} for ${theirs === null ? 'an unknown amount' : (theirs / 100).toFixed(2)}, and this one is ${(input.invoice.amountCents / 100).toFixed(2)}; they must agree before it can be adopted`,
      }
    }
    // Only the invoice is linked. The customer it is filed under stays as the
    // books have it: Harvest filed one client of ours under a sub-customer per
    // project, so there is no one customer the client's link could name, and a
    // receipt names the customer the invoice carries (see mirrorPayment's
    // caller), not the link.
    await input.links.saveLink('invoice', input.invoice.id, {
      quickBooksId: existing.Id,
      syncToken: existing.SyncToken,
    })
    return { kind: 'adopted', quickBooksId: existing.Id }
  }

  if (action.kind === 'create') {
    const customer = await ensureCustomer(input, input.invoice.clientId)
    if ('refused' in customer) return { kind: 'refused', reason: customer.refused }
    const created = await input.quickBooks.createInvoice(
      invoicePayload(input.invoice, {
        customerRef: { value: customer.quickBooksId },
        ...(input.allowOnlinePayment ? { allowOnlinePayment: true } : {}),
      }),
    )
    await input.links.saveLink('invoice', input.invoice.id, {
      quickBooksId: created.Id,
      syncToken: created.SyncToken,
    })
    return { kind: 'created', quickBooksId: created.Id }
  }

  // The token the link holds is the one our last write returned, and
  // QuickBooks moves it on every change to the document -- a payment applied
  // against the invoice included. Written back as stored it is a Stale Object
  // Error on every press after the first receipt, so the current document is
  // read first. Its customer is kept as well: the customer is set when the
  // invoice is created, and an update never moves a document between
  // customers -- one adopted from Harvest sits under the sub-customer Harvest
  // filed it with, and a receipt already applied there names that customer.
  // An adopt already holds the current document from the lookup by number.
  const current =
    action.kind === 'adopt' ? existing : await input.quickBooks.readInvoice(action.quickBooksId)
  if (current === null) {
    // Deleted in QuickBooks since it was mirrored. Re-creating it silently
    // would put back a document somebody chose to remove.
    return {
      kind: 'refused',
      reason: `QuickBooks no longer holds invoice ${input.invoice.number}; it was deleted there since it was mirrored`,
    }
  }
  const updated = await input.quickBooks.updateInvoice(
    invoiceUpdatePayload(
      input.invoice,
      { Id: action.quickBooksId, SyncToken: current.SyncToken },
      {
        customerRef: { value: current.CustomerRef.value },
        ...(input.allowOnlinePayment ? { allowOnlinePayment: true } : {}),
      },
    ),
  )
  await input.links.saveLink('invoice', input.invoice.id, {
    quickBooksId: updated.Id,
    syncToken: updated.SyncToken,
  })
  return {
    kind: action.kind === 'adopt' ? 'adopted' : 'updated',
    quickBooksId: updated.Id,
  }
}

/** A payment recorded here, as the mirror needs to see it. */
export interface MirrorPayment {
  readonly id: number
  readonly amountCents: number
  /** The day the money arrived, where the record carries one. */
  readonly paidOn: string | null
  /** Which system recorded it: `manual`, `stripe`, `quickbooks`, ... */
  readonly provider: string
}

export interface MirrorPaymentLinkStore {
  readPaymentLink(paymentId: number): Promise<MirrorLink | null>
  savePaymentLink(paymentId: number, link: MirrorLink): Promise<void>
}

/** The half of the QuickBooks client a payment mirror uses. */
export interface MirrorPaymentQuickBooks {
  findPaymentByRefNumber(refNumber: string): Promise<QuickBooksPayment | null>
  createPayment(input: Record<string, unknown>): Promise<QuickBooksPayment>
}

export type MirrorPaymentOutcome =
  | MirrorOutcome
  /** Already mirrored by an earlier delivery; nothing was sent. */
  | { readonly kind: 'linked'; readonly quickBooksId: string }

export interface MirrorPaymentInput {
  readonly payment: MirrorPayment
  /** The QuickBooks invoice the payment settles, already mirrored. */
  readonly invoiceQuickBooksId: string
  /** The QuickBooks customer that invoice is filed against. */
  readonly customerQuickBooksId: string
  readonly links: MirrorPaymentLinkStore
  readonly quickBooks: MirrorPaymentQuickBooks
}

/**
 * The reference stamped on the QuickBooks payment. Ours, so a retry can find
 * what an earlier run made, and visible in QuickBooks so a bookkeeper can tell
 * which receipt here it came from.
 */
export const paymentRefNumber = (paymentId: number): string => `ez-${String(paymentId)}`

/**
 * Our receipt id from a QuickBooks payment's reference, where the reference is
 * one `paymentRefNumber` wrote, and null for anything else. The webhook reads
 * it to know a payment this instance put into QuickBooks before the link that
 * records it has been saved.
 */
export const receiptIdFromRefNumber = (refNumber: string | undefined): number | null => {
  const match = /^ez-([1-9][0-9]*)$/u.exec(refNumber ?? '')
  if (match === null) return null
  const id = Number(match[1])
  return Number.isSafeInteger(id) ? id : null
}

/** Cents to the decimal QuickBooks reads, exactly: 12345 -> 123.45. */
const decimalAmount = (cents: number): number => Number((cents / 100).toFixed(2))

export const paymentPayload = (
  input: Pick<MirrorPaymentInput, 'payment' | 'invoiceQuickBooksId' | 'customerQuickBooksId'>,
): Record<string, unknown> => ({
  CustomerRef: { value: input.customerQuickBooksId },
  TotalAmt: decimalAmount(input.payment.amountCents),
  ...(input.payment.paidOn === null ? {} : { TxnDate: input.payment.paidOn }),
  PaymentRefNum: paymentRefNumber(input.payment.id),
  Line: [
    {
      Amount: decimalAmount(input.payment.amountCents),
      LinkedTxn: [{ TxnId: input.invoiceQuickBooksId, TxnType: 'Invoice' }],
    },
  ],
})

/**
 * Copying one payment recorded here onto the mirrored invoice in QuickBooks.
 *
 * A payment QuickBooks itself recorded is refused: it arrived through the
 * webhook and sending it back would settle the invoice twice. Everything else
 * follows the invoice's own sequence -- link, then adopt by reference, then
 * create -- so a redelivery after a crash finds what the first run made.
 */
export const mirrorPayment = async (
  input: Readonly<MirrorPaymentInput>,
): Promise<MirrorPaymentOutcome> => {
  if (input.payment.provider === 'quickbooks') {
    return { kind: 'refused', reason: 'the payment came from QuickBooks' }
  }
  if (input.payment.amountCents <= 0) {
    return { kind: 'refused', reason: 'QuickBooks takes receipts, not refunds' }
  }
  const link = await input.links.readPaymentLink(input.payment.id)
  if (link !== null) return { kind: 'linked', quickBooksId: link.quickBooksId }

  const found = await input.quickBooks.findPaymentByRefNumber(paymentRefNumber(input.payment.id))
  if (found !== null) {
    await input.links.savePaymentLink(input.payment.id, {
      quickBooksId: found.Id,
      syncToken: found.SyncToken,
    })
    return { kind: 'adopted', quickBooksId: found.Id }
  }

  const created = await input.quickBooks.createPayment(paymentPayload(input))
  await input.links.savePaymentLink(input.payment.id, {
    quickBooksId: created.Id,
    syncToken: created.SyncToken,
  })
  return { kind: 'created', quickBooksId: created.Id }
}

/**
 * QuickBooks voids a payment as it voids an invoice: the document stays, its
 * total goes to zero and its private note becomes "Voided". The note is what
 * separates a void from a payment entered at nothing. The shape is the
 * documented one, not yet seen on an owned sandbox (issue 1013).
 */
export const isVoidedPayment = (payment: Readonly<QuickBooksPayment>): boolean =>
  payment.TotalAmt === 0 && /^voided\b/iu.test((payment.PrivateNote ?? '').trim())

export interface InboundPayment {
  /** Our invoice, resolved from the QuickBooks invoice the payment is against. */
  readonly ezactoInvoiceId: number
  readonly amountCents: number
  readonly paidOn: string | null
  readonly quickBooksPaymentId: string
  readonly quickBooksInvoiceId: string
}

/**
 * What a QuickBooks payment means for us, or nothing where it means nothing.
 *
 * A payment can settle several invoices at once, and can include an amount that
 * settles none of them -- an unapplied credit. Only the lines that name an
 * invoice we mirrored are ours to record; the rest belong to books we do not
 * keep.
 */
export const inboundPayments = (
  payment: Readonly<QuickBooksPayment>,
  ezactoInvoiceFor: (quickBooksInvoiceId: string) => number | null,
): readonly InboundPayment[] => {
  const results: InboundPayment[] = []
  for (const line of payment.Line ?? []) {
    for (const linked of line.LinkedTxn ?? []) {
      if (linked.TxnType !== 'Invoice') continue
      const invoiceId = ezactoInvoiceFor(linked.TxnId)
      if (invoiceId === null) continue
      results.push({
        ezactoInvoiceId: invoiceId,
        // Cents, from QuickBooks' decimal. Rounded rather than truncated: a
        // payment of 33.33 must not become 3332 cents.
        amountCents: Math.round(line.Amount * 100),
        paidOn: payment.TxnDate ?? null,
        quickBooksPaymentId: payment.Id,
        quickBooksInvoiceId: linked.TxnId,
      })
    }
  }
  return results
}
