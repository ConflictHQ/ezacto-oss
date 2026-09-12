import {
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  recordAttachedDocument,
  resolveAttachPolicy,
} from "@ezacto/db/d1";
import { renderInvoiceDocument } from "@ezacto/core";
import type { EmailAttachmentRef, EmailAttachmentResolver } from "@ezacto/mailer";
import type { InvoiceDeliveryContext, InvoiceDocumentPort } from "@ezacto/api";

/**
 * The document half of issue 626, composed where the storage lives.
 *
 * `@ezacto/api` asks for a reference and knows nothing about PDFs or buckets;
 * `@ezacto/core` renders and knows nothing about invoices in a database. This
 * joins the two, which is what an entry is for.
 *
 * Rendered once, at the moment the message goes, and kept. A client disputing
 * what they received is answered by the file they were sent -- re-rendering
 * later would answer a different question, because the invoice may have moved
 * on since.
 */

interface DocumentSource {
  deliveryContext(invoiceId: number): Promise<InvoiceDeliveryContext | null>;
  invoiceVersion(invoiceId: number): Promise<number | null>;
  paymentUrl(invoiceId: number): Promise<string | null>;
}

interface ObjectStore {
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: BodyInit } | null>;
}

export const createInvoiceDocumentPort = (options: {
  readonly database: Parameters<typeof resolveAttachPolicy>[0];
  readonly source: DocumentSource;
  readonly objects: ObjectStore;
  readonly now: () => string;
}): InvoiceDocumentPort => ({
  async prepare({ invoiceId, invoiceMessageId }) {
    const decision = await resolveAttachPolicy(options.database, invoiceId);
    if (!decision.attach) return null;

    // Already prepared. A retried outbox delivery must attach the file that went
    // the first time rather than render a second one, and the record is keyed on
    // the message precisely so this question has an answer.
    const existing = await readAttachedDocument(options.database, invoiceMessageId);
    if (existing !== null) {
      return {
        key: existing.objectKey,
        filename: existing.filename,
        contentType: existing.contentType,
      };
    }

    const context = await options.source.deliveryContext(invoiceId);
    if (context === null) return null;
    const version = (await options.source.invoiceVersion(invoiceId)) ?? 0;
    // A link is printed only where one exists, and a failure to mint one is not
    // a reason to send no invoice at all.
    const paymentUrl = await options.source.paymentUrl(invoiceId).catch(() => null);

    const bytes = renderInvoiceDocument({
      number: context.number,
      companyName: context.organizationName,
      clientName: context.clientName,
      issueDate: context.issueDate,
      dueDate: context.dueDate,
      currency: context.currency,
      subject: context.subject,
      lines: context.lineItems,
      // The email block reconciles against the same three figures, so the
      // document and the message cannot disagree about what was billed.
      subtotalCents:
        context.amountCents +
        context.discountAmountCents -
        context.taxAmountCents -
        context.tax2AmountCents,
      discountCents: context.discountAmountCents,
      taxCents: context.taxAmountCents + context.tax2AmountCents,
      totalCents: context.amountCents,
      ...(paymentUrl === null ? {} : { paymentUrl }),
    });

    const key = invoiceDocumentKey(invoiceId, invoiceMessageId);
    const filename = invoiceDocumentFilename(context.number);
    // Stored before it is recorded. A row pointing at an object that is not
    // there would send a message naming a file the consumer cannot fetch, and
    // that refusal happens after the invoice has already been marked sent.
    await options.objects.put(key, bytes.buffer as ArrayBuffer, "application/pdf");
    await recordAttachedDocument(options.database, {
      invoiceMessageId,
      invoiceId,
      objectKey: key,
      filename,
      contentType: "application/pdf",
      byteSize: bytes.byteLength,
      invoiceVersion: version,
      now: options.now(),
    });

    return { key, filename, contentType: "application/pdf" };
  },
});

/**
 * Fetches an attachment back for the queue consumer.
 *
 * Returns null rather than throwing when the object is absent; the consumer
 * turns that into a refusal, so the decision about what a missing file means
 * stays in one place.
 */
export const createAttachmentResolver = (
  objects: ObjectStore,
): EmailAttachmentResolver => {
  return async (reference: EmailAttachmentRef) => {
    const object = await objects.get(reference.key);
    if (object === null) return null;
    return new Uint8Array(await new Response(object.body).arrayBuffer());
  };
};
