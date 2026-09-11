import {
  customerMatches,
  customerPayload,
  invoicePayload,
  planInvoice,
  settledPayments,
  type BillMirrorClient,
  type BillMirrorInvoice,
  type BillSettledPayment,
} from './mapping.js'
import type { BillCustomer, BillInvoice } from './client.js'

/**
 * Putting an invoice into BILL and getting it in front of the client.
 *
 * Flatter than the QuickBooks mirror: BILL has no sub-customers, so there is no
 * ancestry to walk -- one client becomes one customer. What this has instead is
 * a fork in how the invoice is delivered, and that fork is the whole reason
 * this module exists rather than a straight line of client calls.
 */

export type BillLinkKind = 'customer' | 'invoice'

export interface BillLink {
  readonly billId: string
  readonly paymentLink: string | null
}

export interface BillLinkStore {
  readLink(kind: BillLinkKind, ezactoId: number): Promise<BillLink | null>
  saveLink(kind: BillLinkKind, ezactoId: number, link: BillLink): Promise<void>
}

/** The half of the BILL client a mirror uses. */
export interface MirrorBill {
  findCustomerByName(name: string): Promise<BillCustomer | null>
  createCustomer(input: Record<string, unknown>): Promise<BillCustomer>
  findInvoiceByNumber(invoiceNumber: string): Promise<BillInvoice | null>
  createInvoice(input: Record<string, unknown>): Promise<BillInvoice>
  sendInvoice(
    invoiceId: string,
    options: { readonly to: readonly string[]; readonly replyToUserId: string },
  ): Promise<void>
  paymentLink(invoiceId: string): Promise<string>
}

/**
 * How the client is told about the invoice.
 *
 * `bill` is BILL sending its own invoice email, which needs a credential that
 * can also move money -- the AP/AR sync token is refused. `link` is us fetching
 * a payment URL and letting ezacto's own invoice email carry it, which needs
 * nothing of the sort. The credential the deployment holds decides which is
 * available; this type is how that decision reaches the mirror rather than
 * being rediscovered inside it.
 */
export type BillDelivery =
  | { readonly via: 'bill'; readonly replyToUserId: string }
  | { readonly via: 'link' }

export type BillMirrorOutcome =
  | {
      readonly kind: 'sent' | 'adopted'
      readonly billInvoiceId: string
      readonly paymentLink: string | null
    }
  | { readonly kind: 'refused'; readonly reason: string }

export interface BillMirrorInput {
  readonly invoice: BillMirrorInvoice
  readonly client: BillMirrorClient
  readonly links: BillLinkStore
  readonly bill: MirrorBill
  readonly delivery: BillDelivery
}

/**
 * The customer this invoice is filed against, made if it is not there.
 *
 * Adopted before created, for the same reason an invoice is: a previous run may
 * have made this customer and failed before recording the link, and a second
 * create would leave the operator with two customers of the same name and no
 * way to tell which one their invoices are going to.
 */
const ensureCustomer = async (
  input: Pick<BillMirrorInput, 'client' | 'links' | 'bill'>,
): Promise<{ billId: string } | { refused: string }> => {
  const existing = await input.links.readLink('customer', input.client.id)
  if (existing !== null) return { billId: existing.billId }

  const found = await input.bill.findCustomerByName(input.client.name)
  if (found !== null) {
    if (!customerMatches(found, input.client)) {
      return {
        refused: `BILL already has a customer named ${input.client.name} that does not match this client`,
      }
    }
    await input.links.saveLink('customer', input.client.id, {
      billId: found.id,
      paymentLink: null,
    })
    return { billId: found.id }
  }

  const created = await input.bill.createCustomer(customerPayload(input.client))
  await input.links.saveLink('customer', input.client.id, {
    billId: created.id,
    paymentLink: null,
  })
  return { billId: created.id }
}

/**
 * Deliver an invoice through BILL.
 *
 * The link is recorded before delivery is attempted, and that order is
 * deliberate. A created invoice we failed to record is one a retry would create
 * again -- BILL has no idempotency key, so the client would be invoiced twice.
 * A recorded invoice we failed to deliver is one an operator can send by hand
 * from BILL, which is a smaller problem with a visible fix.
 */
export const mirrorInvoice = async (
  input: Readonly<BillMirrorInput>,
): Promise<BillMirrorOutcome> => {
  if (input.invoice.clientId !== input.client.id) {
    return { kind: 'refused', reason: 'the invoice does not belong to that client' }
  }

  const existingLink = await input.links.readLink('invoice', input.invoice.id)
  if (existingLink !== null) {
    // Already mirrored. Not re-sent: an invoice a client has already been sent
    // is not improved by arriving again.
    return {
      kind: 'adopted',
      billInvoiceId: existingLink.billId,
      paymentLink: existingLink.paymentLink,
    }
  }

  const customer = await ensureCustomer(input)
  if ('refused' in customer) return { kind: 'refused', reason: customer.refused }

  const found = await input.bill.findInvoiceByNumber(input.invoice.number)
  const plan = planInvoice(input.invoice, found === null ? [] : [found])

  let billInvoiceId: string
  if (plan.action === 'adopt') {
    billInvoiceId = plan.billInvoiceId
  } else {
    const created = await input.bill.createInvoice(
      invoicePayload(input.invoice, customer.billId),
    )
    billInvoiceId = created.id
  }

  // Recorded before delivery, so a failure past this point costs a send and not
  // a duplicate document.
  await input.links.saveLink('invoice', input.invoice.id, {
    billId: billInvoiceId,
    paymentLink: null,
  })

  if (plan.action === 'adopt') {
    return { kind: 'adopted', billInvoiceId, paymentLink: null }
  }

  if (input.delivery.via === 'bill') {
    const to = input.client.email === null ? [] : [input.client.email]
    if (to.length === 0) {
      return { kind: 'refused', reason: 'the client has no email address to send to' }
    }
    await input.bill.sendInvoice(billInvoiceId, {
      to,
      replyToUserId: input.delivery.replyToUserId,
    })
    // BILL sent its own email and owns the link inside it, so there is none of
    // ours to record.
    return { kind: 'sent', billInvoiceId, paymentLink: null }
  }

  const paymentLink = await input.bill.paymentLink(billInvoiceId)
  await input.links.saveLink('invoice', input.invoice.id, {
    billId: billInvoiceId,
    paymentLink,
  })
  return { kind: 'sent', billInvoiceId, paymentLink }
}

export interface BillInboundPaymentInput {
  readonly payments: readonly Parameters<typeof settledPayments>[0][number][]
  /** BILL invoice id to our invoice id, for the invoices this instance mirrored. */
  readonly mirrored: ReadonlyMap<string, number>
}

export interface BillInboundPayment extends BillSettledPayment {
  readonly invoiceId: number
}

/**
 * The payments that settled invoices we sent, ready to record.
 *
 * Everything else BILL reports is left alone: the operator's own BILL
 * organisation raises invoices outside ezacto, and recording a payment against
 * one of those would be inventing a receipt for a document this system has
 * never seen.
 */
export const inboundPayments = (
  input: Readonly<BillInboundPaymentInput>,
): readonly BillInboundPayment[] =>
  settledPayments(input.payments, new Set(input.mirrored.keys())).map((settled) => ({
    ...settled,
    invoiceId: input.mirrored.get(settled.billInvoiceId)!,
  }))
