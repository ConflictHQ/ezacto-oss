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
  const customer = await ensureCustomer(input, input.invoice.clientId)
  if ('refused' in customer) return { kind: 'refused', reason: customer.refused }

  const options = {
    customerRef: { value: customer.quickBooksId },
    ...(input.allowOnlinePayment ? { allowOnlinePayment: true } : {}),
  }

  const link = await input.links.readLink('invoice', input.invoice.id)
  // Only looked up where there is no link. With one, the id is known and a query
  // by number would be a round trip to learn something already recorded.
  const existing =
    link === null ? await input.quickBooks.findInvoiceByDocNumber(input.invoice.number) : null
  const action = planInvoiceMirror(input.invoice, link, existing)

  if (action.kind === 'conflict') return { kind: 'refused', reason: action.reason }

  if (action.kind === 'create') {
    const created = await input.quickBooks.createInvoice(invoicePayload(input.invoice, options))
    await input.links.saveLink('invoice', input.invoice.id, {
      quickBooksId: created.Id,
      syncToken: created.SyncToken,
    })
    return { kind: 'created', quickBooksId: created.Id }
  }

  // Adopt and update differ only in what is being recorded afterwards: both
  // write the current state over what QuickBooks holds.
  const updated = await input.quickBooks.updateInvoice(
    invoiceUpdatePayload(
      input.invoice,
      { Id: action.quickBooksId, SyncToken: action.syncToken },
      options,
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

export interface InboundPayment {
  /** Our invoice, resolved from the QuickBooks invoice the payment is against. */
  readonly ezactoInvoiceId: number
  readonly amountCents: number
  readonly paidOn: string | null
  readonly quickBooksPaymentId: string
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
      })
    }
  }
  return results
}
