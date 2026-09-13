import type { ThankYouInvoice } from "@ezacto/core";
import type { SenderBoundQueuedMailer } from "@ezacto/mailer";
import type { InvoiceDeliveryContext } from "./money-resources.js";

/**
 * Sending the thank-you when an invoice settles (issue 545).
 *
 * An outbox subscriber rather than something bolted to the payment write, for
 * three reasons that all matter here.
 *
 * `invoice.paid` already means exactly the right thing. The reducer emits it
 * only when the payment status *changes* to paid, so a $10 payment against a
 * $10,000 invoice produces `invoice.partially_paid` and nothing is sent. The
 * partial-payment rule the issue asks for is not implemented here; it was
 * already true, and this subscribes to it.
 *
 * The outbox retries. A queue that is briefly unavailable must not cost a
 * client their thank-you, and must not cost them two either -- so the port
 * records the intent before this enqueues, and a redelivery finds it recorded
 * and does nothing.
 *
 * It leaves the payment write alone. Recording money and sending mail are
 * different failures, and an email provider having a bad afternoon must never
 * be able to fail a payment.
 */

export interface ThankYouOutboxEvent {
  readonly eventType: string;
  readonly aggregateId: number;
}

/**
 * What to send, or nothing.
 *
 * `null` covers every ordinary reason there is nothing to do -- the feature is
 * off, this invoice opted out, nobody was ever emailed the invoice, the
 * thank-you is already recorded -- and the port is what distinguishes them. A
 * subscriber that had to tell them apart would be a second place for the
 * precedence rules to live and disagree.
 */
export interface ThankYouMessage {
  readonly deliveryId: number;
  readonly senderIdentityId: number;
  readonly senderIdentityVersion: number;
  readonly senderEvidenceVersion: number;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly replyToEmail: string | null;
  readonly to: readonly { readonly name: string; readonly email: string }[];
  readonly templateVersion: number;
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string | null;
}

export interface ThankYouPort {
  /**
   * Decides, renders and records. Returns what to queue, or `null`.
   *
   * Recording happens here rather than after the enqueue, because the queue is
   * the part that can fail twice. A record written first and a send that never
   * happened costs one thank-you; a send written after costs a client two.
   */
  prepare(invoiceId: number): Promise<ThankYouMessage | null>;
}

export const createInvoiceThankYouSubscriber = (
  port: ThankYouPort,
  mailer?: SenderBoundQueuedMailer,
): {
  readonly id: "invoice_thank_you";
  deliver(event: Readonly<ThankYouOutboxEvent>): Promise<void>;
} => ({
  id: "invoice_thank_you",
  async deliver(event) {
    if (event.eventType !== "invoice.paid") return;
    const message = await port.prepare(event.aggregateId);
    if (message === null) return;
    if (mailer?.enqueuePersisted === undefined) {
      // Loud rather than quiet. The intent is already recorded, so staying
      // silent here would leave the book saying a client was thanked when
      // nothing was ever queued. Throwing returns the event to the outbox.
      throw new Error("thank-you durable enqueue is unavailable");
    }
    await mailer.enqueuePersisted(
      message.deliveryId,
      {
        senderIdentityId: message.senderIdentityId,
        senderIdentityVersion: message.senderIdentityVersion,
        senderEvidenceVersion: message.senderEvidenceVersion,
        from: { email: message.fromEmail, name: message.fromName },
        ...(message.replyToEmail === null
          ? {}
          : { replyTo: [{ email: message.replyToEmail }] }),
      },
      {
        to: message.to.map((person) =>
          person.name === "" ? { email: person.email } : { email: person.email, name: person.name },
        ),
        template: `thank_you:${String(message.templateVersion)}`,
        subject: message.subject,
        text: message.textBody,
        ...(message.htmlBody === null ? {} : { html: message.htmlBody }),
        related: { type: "invoice", id: event.aggregateId },
      },
    );
  },
});

/**
 * The invoice a thank-you template needs, from the context a send already has.
 *
 * The two want the same invoice, and reading it consistently -- header and
 * lines from one snapshot, differently for D1 and the container -- is already
 * solved once in the money resources. A second reader here would be a second
 * chance to disagree with the invoice the client was sent.
 *
 * Everything but the settlement date, which is not a delivery concern and is
 * read alongside the payment that produced it.
 */
export const thankYouInvoiceFromDeliveryContext = (
  context: Readonly<InvoiceDeliveryContext>,
): Omit<ThankYouInvoice, "paidDate"> => ({
  invoiceId: context.invoiceId,
  number: context.number,
  subject: context.subject,
  currency: context.currency,
  amountCents: context.amountCents,
  discountAmountCents: context.discountAmountCents,
  taxAmountCents: context.taxAmountCents,
  tax2AmountCents: context.tax2AmountCents,
  issueDate: context.issueDate,
  dueDate: context.dueDate,
  organizationName: context.organizationName,
  clientName: context.clientName,
  lineItems: context.lineItems,
});
