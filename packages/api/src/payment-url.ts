/**
 * Where the client pays an invoice online, for the mail that carries it
 * (issue 838).
 *
 * Two providers can answer. BILL answers first, for a client billed through
 * it: at send time that mints the link (and the BILL invoice behind it), and
 * later mail reads the link the send stored. Stripe answers otherwise. A
 * provider that fails yields to the next rather than failing the mail -- an
 * invoice without a pay link is still an invoice, and the caller already sends
 * on an empty answer.
 */
export interface InvoicePaymentUrlProviders {
  readonly bill?: {
    /** Mints the link now; used when the invoice email body is composed. */
    paymentLinkForSend(invoiceId: number): Promise<string | null>
    /** The link a send stored; used by reminders and the thank-you. */
    paymentLink(invoiceId: number): Promise<string | null>
  }
  readonly stripe?: {
    paymentLink(invoiceId: number): Promise<{ kind: string; url?: string }>
  }
}

const quietly = async (read: () => Promise<string | null>): Promise<string | null> => {
  try {
    return await read()
  } catch {
    return null
  }
}

const stripeUrl = async (
  stripe: InvoicePaymentUrlProviders['stripe'],
  invoiceId: number,
): Promise<string | null> => {
  if (stripe === undefined) return null
  const result = await stripe.paymentLink(invoiceId)
  return result.kind === 'linked' && result.url !== undefined ? result.url : null
}

export const invoicePaymentUrlForSend =
  (providers: InvoicePaymentUrlProviders) =>
  async (invoiceId: number): Promise<string | null> =>
    (providers.bill === undefined
      ? null
      : await quietly(() => providers.bill!.paymentLinkForSend(invoiceId))) ??
    (await quietly(() => stripeUrl(providers.stripe, invoiceId)))

export const invoicePaymentUrlForMail =
  (providers: InvoicePaymentUrlProviders) =>
  async (invoiceId: number): Promise<string | null> =>
    (providers.bill === undefined
      ? null
      : await quietly(() => providers.bill!.paymentLink(invoiceId))) ??
    (await quietly(() => stripeUrl(providers.stripe, invoiceId)))
