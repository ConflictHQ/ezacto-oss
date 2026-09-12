import { StripeClient } from './client.js'
import { readCheckoutCompletion, verifyStripeSignature } from './webhook.js'

/**
 * Stripe, above the transport (#102): mint the link an invoice is paid at, and
 * turn a verified delivery into a recorded payment.
 *
 * The types the API and the entries need are declared structurally so this
 * package keeps depending on nothing.
 */

export interface StripeConfig {
  readonly apiKey: string | undefined
  /** The `whsec_` secret for the endpoint Stripe posts to. */
  readonly webhookSecret: string | undefined
}

export interface StripeInvoice {
  readonly id: number
  readonly number: string
  readonly currency: string
  /** What is still owed. A link for the whole invoice would over-collect. */
  readonly dueAmountCents: number
}

export interface StripeLink {
  readonly paymentLinkId: string
  readonly url: string
}

/** What the runtime needs from the database, supplied by the entry. */
export interface StripeSource {
  readInvoice(invoiceId: number): Promise<StripeInvoice | null>
  readLink(invoiceId: number): Promise<StripeLink | null>
  saveLink(invoiceId: number, link: StripeLink): Promise<StripeLink>
  /** For a payment that arrives without our metadata. */
  invoiceForLink(paymentLinkId: string): Promise<number | null>
  recordPayment(input: {
    invoiceId: number
    paymentIntentId: string
    amountCents: number
  }): Promise<void>
}

export interface StripeRuntimeOptions {
  readonly config: StripeConfig
  readonly source: StripeSource
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => Date
}

export type StripeLinkOutcome =
  | { readonly kind: 'linked'; readonly url: string }
  | { readonly kind: 'refused'; readonly reason: string }

export type StripeWebhookOutcome =
  | { readonly kind: 'recorded'; readonly invoiceId: number }
  | { readonly kind: 'ignored'; readonly reason: string }
  | { readonly kind: 'unverified' }

export interface StripeRuntime {
  configured(): boolean
  /** The URL this invoice is paid at, minted once and then reused. */
  paymentLink(invoiceId: number): Promise<StripeLinkOutcome>
  receiveWebhook(input: {
    payload: string
    signature: string | null
  }): Promise<StripeWebhookOutcome>
}

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim()
  return text === undefined || text === '' ? null : text
}

export const createStripeRuntime = (
  options: Readonly<StripeRuntimeOptions>,
): StripeRuntime => {
  const apiKey = trimmed(options.config.apiKey)
  const webhookSecret = trimmed(options.config.webhookSecret)
  const { source } = options

  return {
    configured: () => apiKey !== null,

    paymentLink: async (invoiceId) => {
      if (apiKey === null) {
        return { kind: 'refused', reason: 'Stripe is not configured for this deployment' }
      }
      // Reused rather than re-minted. The URL that went out in an email has to
      // keep working, and a second mint would leave a second Price on the
      // account for every time somebody opened the invoice.
      const existing = await source.readLink(invoiceId)
      if (existing !== null) return { kind: 'linked', url: existing.url }

      const invoice = await source.readInvoice(invoiceId)
      if (invoice === null) {
        return { kind: 'refused', reason: 'the invoice does not exist' }
      }
      if (invoice.dueAmountCents <= 0) {
        // Nothing is owed. A link for zero is one Stripe refuses and a link for
        // the original total would collect money that is not due.
        return { kind: 'refused', reason: 'this invoice has nothing left to pay' }
      }

      const client = new StripeClient({ apiKey, fetch: options.fetch })
      // Derived from the invoice so a retry returns Stripe's first result
      // rather than making a second price and a second link.
      const priceId = await client.createPrice({
        currency: invoice.currency,
        unitAmountCents: invoice.dueAmountCents,
        productName: `Invoice ${invoice.number}`,
        idempotencyKey: `ezacto-invoice-${String(invoice.id)}-price`,
      })
      const link = await client.createPaymentLink({
        priceId,
        // The thread back. Stripe copies this onto the checkout session, and
        // the webhook reads it there.
        metadata: { ezacto_invoice_id: String(invoice.id) },
        // Names the invoice, because "a payment to CONFLICT LLC" does not.
        confirmationMessage: `Thank you. Invoice ${invoice.number} is settled in full.`,
        idempotencyKey: `ezacto-invoice-${String(invoice.id)}-link`,
      })
      const saved = await source.saveLink(invoice.id, {
        paymentLinkId: link.id,
        url: link.url,
      })
      return { kind: 'linked', url: saved.url }
    },

    receiveWebhook: async (input) => {
      if (webhookSecret === null) {
        // Without a secret nothing can tell a real delivery from a forged one,
        // so everything is refused rather than trusted.
        return { kind: 'unverified' }
      }
      if (input.signature === null) return { kind: 'unverified' }
      const verified = await verifyStripeSignature({
        payload: input.payload,
        header: input.signature,
        secret: webhookSecret,
        nowSeconds: Math.floor(options.now().getTime() / 1000),
      })
      if (!verified) return { kind: 'unverified' }

      const completion = readCheckoutCompletion(input.payload)
      if (completion === null) {
        return { kind: 'ignored', reason: 'not a paid checkout session' }
      }
      const invoiceId =
        completion.invoiceId ?? (await source.invoiceForLink(completion.paymentIntentId))
      if (invoiceId === null) {
        // Stripe takes money for things other than our invoices. Guessing which
        // one this settled would credit somebody else's.
        return { kind: 'ignored', reason: 'the payment names no invoice of ours' }
      }
      await source.recordPayment({
        invoiceId,
        paymentIntentId: completion.paymentIntentId,
        amountCents: completion.amountCents,
      })
      return { kind: 'recorded', invoiceId }
    },
  }
}
