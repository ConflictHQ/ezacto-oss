import {
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  recordAttachedDocument,
  resolveAttachPolicy,
  resolveFilesPolicy,
  resolveJournalFormats,
  resolveJournalPolicy,
  readInvoiceJournal,
  readStagedAttachments,
  type InvoiceDocumentContext,
} from "@ezacto/db/d1";
import {
  defaultJournalFormats,
  journalDocumentFor,
  journalFilename,
  journalFormatContentType,
  pdfImageFrom,
  renderInvoiceDocument,
  renderJournalFile,
  type PdfImage,
} from "@ezacto/core";
import type { EmailAttachmentRef, EmailAttachmentResolver } from "@ezacto/mailer";
import type { InvoiceDocumentPort } from "@ezacto/api";

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
  documentContext(invoiceId: number): Promise<InvoiceDocumentContext | null>;
  invoiceVersion(invoiceId: number): Promise<number | null>;
  paymentUrl(invoiceId: number): Promise<string | null>;
}

interface ObjectStore {
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: BodyInit } | null>;
}

/**
 * The organization's light-ground wordmark, ready to draw, or `null` -- in
 * which case the document sets the company's name in its place. Any failure
 * to fetch or decode it lands here too: a logo is never why an invoice does
 * not go.
 */
const logoFor = async (
  context: InvoiceDocumentContext,
  objects: ObjectStore,
): Promise<PdfImage | null> => {
  if (context.logo === null) return null;
  try {
    const object = await objects.get(context.logo.fileKey);
    if (object === null) return null;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    return await pdfImageFrom(bytes, context.logo.contentType);
  } catch {
    return null;
  }
};

/** The bytes alone: a view's buffer can be larger than the view. */
const exactBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);

export const createInvoiceDocumentPort = (options: {
  readonly database: Parameters<typeof resolveAttachPolicy>[0];
  readonly source: DocumentSource;
  readonly objects: ObjectStore;
  readonly now: () => string;
}): InvoiceDocumentPort => ({
  async prepare({ invoiceId, invoiceMessageId }) {
    // The files an operator staged against the invoice -- a purchase order, a
    // signed order form. A separate choice from the document, because wanting
    // a purchase order returned is not the same as wanting the invoice as a
    // PDF, and the client's own files are already named by whoever staged them.
    const staged = (await resolveFilesPolicy(options.database, invoiceId))
      ? (await readStagedAttachments(options.database, invoiceId)).map((file) => ({
          key: file.key,
          filename: file.filename,
          contentType: file.contentType,
        }))
      : [];

    // The work behind the invoice, if it was asked for (issue 647). Rendered
    // here rather than stored, because unlike the invoice document it is
    // derived entirely from entries this invoice already claimed -- there is no
    // version of it a client could dispute that re-rendering would not
    // reproduce. One file per format asked for, every one at the same level;
    // the PDF keeps the key and name it always had, so an organization that
    // never chose a format sends exactly what it sent before.
    const journalLevel = await resolveJournalPolicy(options.database, invoiceId);
    const journal = async (
      context: InvoiceDocumentContext,
    ): Promise<readonly EmailAttachmentRef[]> => {
      if (journalLevel === null) return [];
      // Notes a client may not read are already withheld here (D20).
      const entries = await readInvoiceJournal(options.database, invoiceId);
      // Nothing claimed means nothing to show. An empty journal would tell a
      // client their invoice is backed by no work at all, which is a stronger
      // claim than "this invoice was not raised from tracked time".
      if (entries.length === 0) return [];
      const formats =
        (await resolveJournalFormats(options.database, invoiceId)) ?? defaultJournalFormats;
      const document = journalDocumentFor(
        {
          invoiceNumber: context.number,
          companyName: context.organizationName,
          clientName: context.clientName,
          entries,
        },
        journalLevel,
      );
      const references: EmailAttachmentRef[] = [];
      for (const format of formats) {
        const bytes = renderJournalFile(format, document);
        const key = `invoice-documents/${String(invoiceId)}/${String(invoiceMessageId)}-journal.${format}`;
        const contentType = journalFormatContentType[format];
        // A retried delivery renders the same bytes to the same key, so the
        // object a first attempt wrote is replaced by its own copy.
        await options.objects.put(key, exactBuffer(bytes), contentType);
        references.push({
          key,
          filename: journalFilename(journalLevel, context.number, format),
          contentType,
        });
      }
      return references;
    };

    const decision = await resolveAttachPolicy(options.database, invoiceId);
    if (!decision.attach) {
      const context = await options.source.documentContext(invoiceId);
      return context === null ? staged : [...(await journal(context)), ...staged];
    }

    // Already prepared. A retried outbox delivery must attach the file that went
    // the first time rather than render a second one, and the record is keyed on
    // the message precisely so this question has an answer.
    const existing = await readAttachedDocument(options.database, invoiceMessageId);
    if (existing !== null) {
      return [
        {
          key: existing.objectKey,
          filename: existing.filename,
          contentType: existing.contentType,
        },
        ...staged,
      ];
    }

    const context = await options.source.documentContext(invoiceId);
    // Nothing to render from, but a staged purchase order is still worth
    // sending: it was attached by a person, not derived from the invoice.
    if (context === null) return staged;
    const version = (await options.source.invoiceVersion(invoiceId)) ?? 0;
    // A link is printed only where one exists, and a failure to mint one is not
    // a reason to send no invoice at all.
    const paymentUrl = await options.source.paymentUrl(invoiceId).catch(() => null);

    const bytes = renderInvoiceDocument({
      number: context.number,
      companyName: context.organizationName,
      companyAddress: context.organizationAddress,
      logo: await logoFor(context, options.objects),
      clientName: context.clientName,
      clientAddress: context.clientAddress,
      issueDate: context.issueDate,
      dueDate: context.dueDate,
      paymentTerms: context.paymentTerms,
      purchaseOrder: context.purchaseOrder,
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
      discountRatePpm: context.discountRatePpm,
      taxCents: context.taxAmountCents,
      taxRatePpm: context.taxRatePpm,
      tax2Cents: context.tax2AmountCents,
      tax2RatePpm: context.tax2RatePpm,
      totalCents: context.amountCents,
      paidCents: context.paidAmountCents,
      dueAmountCents: context.dueAmountCents,
      notes: context.notes,
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

    // The invoice first. It is what the message is about, and a client opening
    // the attachments in order should meet it before what supports it, then the
    // work behind it, then whatever a person staged.
    return [
      { key, filename, contentType: "application/pdf" },
      ...(await journal(context)),
      ...staged,
    ];
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
