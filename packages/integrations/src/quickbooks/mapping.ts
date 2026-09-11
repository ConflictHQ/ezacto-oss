/**
 * What an ezacto invoice looks like once it is a QuickBooks document.
 *
 * Pure functions over narrow inputs, deliberately: none of this knows how to
 * reach QuickBooks or the database, so the decisions -- which customer, create
 * or update, what changed -- can be tested without either.
 */

import type { QuickBooksCustomer, QuickBooksInvoice, QuickBooksRef } from './client.js'

/** A client as the mirror needs it, root or not. */
export interface MirrorClient {
  readonly id: number
  readonly name: string
  readonly parentClientId: number | null
  readonly currency: string | null
}

export interface MirrorInvoiceLine {
  readonly description: string
  /** Cents, as everything money is stored here. */
  readonly amountCents: number
  readonly quantity: number | null
  readonly unitPriceCents: number | null
}

export interface MirrorInvoice {
  readonly id: number
  /** Our invoice number. Unique in our book, so it is what QuickBooks is told. */
  readonly number: string
  readonly clientId: number
  readonly currency: string
  readonly issueDate: string
  readonly dueDate: string | null
  readonly subject: string | null
  readonly notes: string | null
  readonly lines: readonly MirrorInvoiceLine[]
}

/**
 * QuickBooks allows a parent and four levels beneath it. Past that it refuses
 * the create, so the mirror says which client it was and stops rather than
 * letting the API produce the error two calls later.
 */
export const QUICKBOOKS_MAXIMUM_CUSTOMER_DEPTH = 5

export class QuickBooksMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickBooksMappingError'
  }
}

/**
 * The chain from a root down to this client, roots first.
 *
 * A cycle in the tree would otherwise walk forever. `clients` is a lookup rather
 * than a list because callers already hold one.
 */
export const clientAncestry = (
  clientId: number,
  clients: ReadonlyMap<number, MirrorClient>,
): readonly MirrorClient[] => {
  const chain: MirrorClient[] = []
  const seen = new Set<number>()
  let current = clients.get(clientId) ?? null
  while (current !== null) {
    if (seen.has(current.id)) {
      throw new QuickBooksMappingError(
        `client ${String(clientId)} sits in a parent cycle and cannot be mapped`,
      )
    }
    seen.add(current.id)
    chain.unshift(current)
    current = current.parentClientId === null ? null : (clients.get(current.parentClientId) ?? null)
  }
  if (chain.length === 0) {
    throw new QuickBooksMappingError(`client ${String(clientId)} is not in the directory`)
  }
  if (chain.length > QUICKBOOKS_MAXIMUM_CUSTOMER_DEPTH) {
    throw new QuickBooksMappingError(
      `client ${String(clientId)} is ${String(chain.length)} levels deep; QuickBooks allows ${String(QUICKBOOKS_MAXIMUM_CUSTOMER_DEPTH)}`,
    )
  }
  return chain
}

/**
 * QuickBooks requires `DisplayName` to be unique across every customer in the
 * company, sub-customers included -- two clients called "Design" under different
 * parents collide even though the tree keeps them apart.
 *
 * So the name carries its ancestry. `:` is QuickBooks' own separator in
 * `FullyQualifiedName` and is not accepted inside a `DisplayName`, which is why
 * this uses ` — ` instead: distinct from anything likely to be in a client name,
 * and it reads as a path to a person looking at the customer list.
 */
export const customerDisplayName = (ancestry: readonly MirrorClient[]): string => {
  if (ancestry.length === 0) throw new QuickBooksMappingError('ancestry cannot be empty')
  return ancestry.map((client) => client.name.trim()).join(' — ')
}

export interface PlannedCustomer {
  readonly clientId: number
  readonly displayName: string
  /** Null for a root customer; the QuickBooks id of the parent otherwise. */
  readonly parentQuickBooksId: string | null
  readonly payload: Record<string, unknown>
}

/**
 * The customer payload for one client, given its parent already exists.
 *
 * `Job: true` is what makes QuickBooks treat it as a sub-customer rather than a
 * second top-level customer that happens to be named after one.
 */
export const plannedCustomer = (
  ancestry: readonly MirrorClient[],
  parentQuickBooksId: string | null,
): PlannedCustomer => {
  const client = ancestry[ancestry.length - 1]!
  const isChild = ancestry.length > 1
  if (isChild && parentQuickBooksId === null) {
    throw new QuickBooksMappingError(
      `client ${String(client.id)} is a sub-customer and needs its parent mirrored first`,
    )
  }
  const displayName = customerDisplayName(ancestry)
  return {
    clientId: client.id,
    displayName,
    parentQuickBooksId,
    payload: {
      DisplayName: displayName,
      ...(client.currency === null ? {} : { CurrencyRef: { value: client.currency } }),
      ...(isChild
        ? { Job: true, ParentRef: { value: parentQuickBooksId } }
        : {}),
    },
  }
}

/**
 * Whether an existing QuickBooks customer is the one this client maps to.
 *
 * Name alone is not enough. A customer with the right name under the wrong
 * parent is a different customer, and adopting it would file our invoices
 * against somebody else's account -- which is a money error, not a tidiness one.
 */
export const customerMatches = (
  customer: Readonly<QuickBooksCustomer>,
  planned: Readonly<PlannedCustomer>,
): boolean => {
  if (customer.DisplayName !== planned.displayName) return false
  const parent = customer.ParentRef?.value ?? null
  return parent === planned.parentQuickBooksId
}

const centsToAmount = (cents: number): number => Math.round(cents) / 100

/**
 * `PrivateNote` is where our id goes.
 *
 * Not `DocNumber`, which carries the invoice *number* a client sees and which an
 * operator may change. This is the durable back-reference: it survives a
 * renumbering, it is visible to anyone reading the invoice in QuickBooks, and it
 * is what tells a human why this document exists.
 */
export const mirrorPrivateNote = (invoice: Pick<MirrorInvoice, 'id'>): string =>
  `ezacto invoice ${String(invoice.id)}`

export interface InvoicePayloadOptions {
  readonly customerRef: QuickBooksRef
  /**
   * Offer QuickBooks' own payment links on the mirrored invoice. Off unless the
   * operator asked: it only does anything when the company has QuickBooks
   * Payments, and turning it on silently would change how a client is invited
   * to pay without anybody deciding to.
   */
  readonly allowOnlinePayment?: boolean
}

export const invoicePayload = (
  invoice: Readonly<MirrorInvoice>,
  options: Readonly<InvoicePayloadOptions>,
): Record<string, unknown> => {
  if (invoice.lines.length === 0) {
    throw new QuickBooksMappingError(
      `invoice ${String(invoice.id)} has no lines and would be an empty document`,
    )
  }
  return {
    DocNumber: invoice.number,
    CustomerRef: options.customerRef,
    TxnDate: invoice.issueDate,
    ...(invoice.dueDate === null ? {} : { DueDate: invoice.dueDate }),
    CurrencyRef: { value: invoice.currency },
    PrivateNote: mirrorPrivateNote(invoice),
    ...(invoice.subject === null ? {} : { CustomerMemo: { value: invoice.subject } }),
    ...(options.allowOnlinePayment === true
      ? { AllowOnlineACHPayment: true, AllowOnlineCreditCardPayment: true }
      : {}),
    Line: invoice.lines.map((line) => ({
      Amount: centsToAmount(line.amountCents),
      DetailType: 'SalesItemLineDetail',
      Description: line.description,
      SalesItemLineDetail: {
        ...(line.quantity === null ? {} : { Qty: line.quantity }),
        ...(line.unitPriceCents === null
          ? {}
          : { UnitPrice: centsToAmount(line.unitPriceCents) }),
      },
    })),
  }
}

/**
 * A full update carries the id and the sync token QuickBooks handed us. A stale
 * token is refused rather than merged, which is the concurrency guarantee: if
 * somebody edited the invoice in QuickBooks since we last looked, our write does
 * not silently overwrite theirs.
 */
export const invoiceUpdatePayload = (
  invoice: Readonly<MirrorInvoice>,
  existing: Pick<QuickBooksInvoice, 'Id' | 'SyncToken'>,
  options: Readonly<InvoicePayloadOptions>,
): Record<string, unknown> => ({
  ...invoicePayload(invoice, options),
  Id: existing.Id,
  SyncToken: existing.SyncToken,
  sparse: false,
})

/**
 * What the mirror should do with one invoice, decided before anything is sent.
 *
 * `adopt` is the case that makes a retry safe: we have no link, but QuickBooks
 * already holds an invoice with this number carrying our private note, which
 * means a previous attempt wrote it and failed before recording the link.
 * Creating again would be the duplicate the acceptance forbids.
 */
export type MirrorAction =
  | { readonly kind: 'create' }
  | { readonly kind: 'update'; readonly quickBooksId: string; readonly syncToken: string }
  | { readonly kind: 'adopt'; readonly quickBooksId: string; readonly syncToken: string }
  | { readonly kind: 'conflict'; readonly reason: string }

export const planInvoiceMirror = (
  invoice: Readonly<MirrorInvoice>,
  link: { readonly quickBooksId: string; readonly syncToken: string } | null,
  existing: Readonly<QuickBooksInvoice> | null,
): MirrorAction => {
  if (link !== null) {
    return { kind: 'update', quickBooksId: link.quickBooksId, syncToken: link.syncToken }
  }
  if (existing === null) return { kind: 'create' }
  // The number matched. Whether it is *ours* is a different question: an
  // operator may have raised an invoice in QuickBooks that happens to share a
  // number, and overwriting that would destroy a document nobody asked us to
  // touch.
  if (existing.PrivateNote !== mirrorPrivateNote(invoice)) {
    return {
      kind: 'conflict',
      reason: `QuickBooks already holds invoice ${invoice.number}, and it was not written by this mirror`,
    }
  }
  return { kind: 'adopt', quickBooksId: existing.Id, syncToken: existing.SyncToken }
}
