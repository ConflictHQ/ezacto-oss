import {
  invoiceDocumentFilename,
  invoiceDocumentKey,
  readAttachedDocument,
  readMessageAttachesPdf,
  recordAttachedDocument,
  resolveAppendPolicy,
  resolveAttachPolicy,
  resolveFilesPolicy,
  resolveJournalFormats,
  resolveJournalPolicy,
  readInvoiceJournal,
  readStagedAttachments,
  type InvoiceDocumentContext,
  type StagedAttachment,
} from "@ezacto/db/d1";
import {
  defaultJournalFormats,
  journalDocumentFor,
  journalFilename,
  journalFormatContentType,
  pdfImageFrom,
  renderInvoiceDocument,
  renderJournalFile,
  type JournalFormat,
  type PdfImage,
} from "@ezacto/core";
import type { EmailAttachmentRef, EmailAttachmentResolver } from "@ezacto/mailer";
import type {
  InvoiceAttachmentChoices,
  InvoiceAttachmentPreview,
  InvoiceDocumentPort,
} from "@ezacto/api";
import { appendPdfs, type AppendSkipReason } from "./pdf-append.js";

/**
 * The document half of issue 626, composed where the storage lives.
 *
 * `@ezacto/api` asks for a reference and knows nothing about PDFs or buckets;
 * `@ezacto/core` renders and knows nothing about invoices in a database. This
 * joins the two, which is what an entry is for.
 *
 * One composition serves the real send and its preview. The send renders the
 * invoice, binds the files its rules put behind it, and keeps the result under
 * the message's key; the preview runs exactly the same steps, stamps every page
 * PREVIEW, and keeps nothing a send keeps -- a preview that drifted from the
 * email it previews would be worse than none.
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

/** What a send would do with this invoice, every level of the rules resolved. */
interface Choices {
  readonly document: boolean;
  readonly files: boolean;
  readonly append: boolean;
  readonly journal: "detailed" | "summary" | null;
  readonly journalFormats: readonly JournalFormat[];
}

/** Why a file meant for the back of the document goes beside it instead. */
type NotAppended = AppendSkipReason | "too_large";

/** A file that goes beside the document, and why it is not inside it. */
interface Beside {
  readonly file: StagedAttachment;
  readonly notAppended: NotAppended | null;
}

interface JournalFile {
  readonly format: JournalFormat;
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

interface Composition {
  readonly document: {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly appended: readonly StagedAttachment[];
  } | null;
  readonly beside: readonly Beside[];
  readonly journal: readonly JournalFile[];
}

/**
 * How much of an invoice's files is bound into the back of its document. A
 * purchase-order letter is a few hundred kilobytes; binding costs three to four
 * times what is bound, and a Worker has 128 MB, so past this the files go
 * beside the document rather than inside it.
 */
const appendBudgetBytes = 10 * 1024 * 1024;

/** What claims to be a PDF; binding in reads it and refuses what is not. */
const claimsPdf = (file: StagedAttachment): boolean =>
  file.contentType.toLowerCase() === "application/pdf" || /\.pdf$/iu.test(file.filename);

const reference = (file: StagedAttachment): EmailAttachmentRef => ({
  key: file.key,
  filename: file.filename,
  contentType: file.contentType,
});

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
}): InvoiceDocumentPort => {
  const { database, objects } = options;

  /** The invoice's own rules, with whatever the Send dialog says laid over them. */
  const resolveChoices = async (
    invoiceId: number,
    overrides: InvoiceAttachmentChoices,
  ): Promise<Choices> => {
    const [document, files, append, journal, formats] = await Promise.all([
      resolveAttachPolicy(database, invoiceId),
      resolveFilesPolicy(database, invoiceId),
      resolveAppendPolicy(database, invoiceId),
      resolveJournalPolicy(database, invoiceId),
      resolveJournalFormats(database, invoiceId),
    ]);
    return {
      document: overrides.document ?? document.attach,
      files: overrides.files ?? files,
      append: overrides.append ?? append,
      journal:
        overrides.journal === undefined
          ? journal
          : overrides.journal === false
            ? null
            : overrides.journal,
      journalFormats: overrides.journalFormats ?? formats ?? defaultJournalFormats,
    };
  };

  const bytesOf = async (key: string): Promise<Uint8Array | null> => {
    const object = await objects.get(key);
    return object === null ? null : new Uint8Array(await new Response(object.body).arrayBuffer());
  };

  /**
   * The work behind the invoice, if it is asked for (issue 647). Rendered
   * rather than kept, because unlike the invoice document it is derived
   * entirely from entries this invoice already claimed -- there is no version
   * of it a client could dispute that re-rendering would not reproduce.
   */
  const journalFiles = async (
    invoiceId: number,
    context: InvoiceDocumentContext,
    choices: Choices,
  ): Promise<readonly JournalFile[]> => {
    if (choices.journal === null) return [];
    // Notes a client may not read are already withheld here (D20).
    const entries = await readInvoiceJournal(database, invoiceId);
    // Nothing claimed means nothing to show. An empty journal would tell a
    // client their invoice is backed by no work at all, which is a stronger
    // claim than "this invoice was not raised from tracked time".
    if (entries.length === 0) return [];
    const level = choices.journal;
    const document = journalDocumentFor(
      {
        invoiceNumber: context.number,
        companyName: context.organizationName,
        clientName: context.clientName,
        entries,
      },
      level,
    );
    return choices.journalFormats.map((format) => ({
      format,
      bytes: renderJournalFile(format, document),
      filename: journalFilename(level, context.number, format),
      contentType: journalFormatContentType[format],
    }));
  };

  /**
   * Everything an email for this invoice carries under these choices: the
   * invoice document with the files its rules bind into its back, the files
   * that go beside it, and the hours report. `watermark` stamps the document's
   * pages -- the invoice's and the ones bound in behind it -- for a preview.
   */
  const compose = async (
    invoiceId: number,
    context: InvoiceDocumentContext,
    choices: Choices,
    watermark: string | null,
  ): Promise<Composition> => {
    const staged = await readStagedAttachments(database, invoiceId);
    const journal = await journalFiles(invoiceId, context, choices);
    if (!choices.document) {
      // Nothing to bind into, so the files go as the files rule says.
      return {
        document: null,
        beside: choices.files ? staged.map((file) => ({ file, notAppended: null })) : [],
        journal,
      };
    }
    // A link is printed only where one exists, and a failure to mint one is not
    // a reason to send no invoice at all.
    const paymentUrl = await options.source.paymentUrl(invoiceId).catch(() => null);
    const rendered = renderInvoiceDocument({
      number: context.number,
      companyName: context.organizationName,
      companyAddress: context.organizationAddress,
      logo: await logoFor(context, objects),
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
      ...(watermark === null ? {} : { watermark }),
    });

    // What the rules put behind the invoice: its PDF files, in the order they
    // were attached, up to what a Worker can bind without risk.
    const meantForBack = choices.append ? staged.filter(claimsPdf) : [];
    const failed = new Map<number, NotAppended>();
    const within: { file: StagedAttachment; bytes: Uint8Array }[] = [];
    let budget = appendBudgetBytes;
    for (const file of meantForBack) {
      if (file.byteSize > budget) {
        failed.set(file.attachmentId, "too_large");
        continue;
      }
      const bytes = await bytesOf(file.key);
      if (bytes === null) {
        failed.set(file.attachmentId, "unreadable");
        continue;
      }
      budget -= file.byteSize;
      within.push({ file, bytes });
    }
    const bound =
      within.length === 0
        ? { bytes: rendered, appended: [] as number[], skipped: [] }
        : await appendPdfs(
            rendered,
            within.map(({ file, bytes }) => ({ name: file.filename, bytes })),
            watermark === null ? {} : { stamp: watermark },
          );
    for (const { index, reason } of bound.skipped) {
      const file = within[index]!.file;
      failed.set(file.attachmentId, reason);
      // Said where an operator will look for it: the file still goes, beside
      // the invoice rather than behind it, and somebody may want to know why.
      console.warn(
        `invoice ${String(invoiceId)}: ${file.filename} could not be bound into the invoice document (${reason}); it goes as its own attachment`,
      );
    }
    const appended = bound.appended.map((index) => within[index]!.file);
    const inside = new Set(appended.map(({ attachmentId }) => attachmentId));
    return {
      document: {
        bytes: bound.bytes,
        filename: invoiceDocumentFilename(context.number, context.organizationName),
        appended,
      },
      // Bound files are not sent a second time beside the invoice. A file that
      // was meant for the back and could not go there is sent beside it even
      // where other files are not, because the rule asked for it to go.
      beside: staged
        .filter(({ attachmentId }) => !inside.has(attachmentId))
        .filter(({ attachmentId }) => choices.files || failed.has(attachmentId))
        .map((file) => ({ file, notAppended: failed.get(file.attachmentId) ?? null })),
      journal,
    };
  };

  /** Stores the hours report under its keys; a retry writes the same bytes again. */
  const storeJournal = async (
    files: readonly JournalFile[],
    keyFor: (format: JournalFormat) => string,
  ): Promise<EmailAttachmentRef[]> => {
    const references: EmailAttachmentRef[] = [];
    for (const file of files) {
      const key = keyFor(file.format);
      await objects.put(key, exactBuffer(file.bytes), file.contentType);
      references.push({ key, filename: file.filename, contentType: file.contentType });
    }
    return references;
  };

  return {
    async attachesPdf(invoiceId) {
      return (await resolveAttachPolicy(database, invoiceId)).attach;
    },

    async prepare({ invoiceId, invoiceMessageId }) {
      const journalKey = (format: JournalFormat) =>
        `invoice-documents/${String(invoiceId)}/${String(invoiceMessageId)}-journal.${format}`;
      const choices = await resolveChoices(invoiceId, {});
      const context = await options.source.documentContext(invoiceId);

      // Already prepared. A retried outbox delivery must attach the file that
      // went the first time rather than render a second one, and the record is
      // keyed on the message precisely so this question has an answer -- it
      // also says which files were bound into that file, so they are not sent
      // beside it now.
      const existing = await readAttachedDocument(database, invoiceMessageId);
      if (existing !== null) {
        const staged = await readStagedAttachments(database, invoiceId);
        const inside = new Set(existing.appendedAttachmentIds);
        const meantForBack = new Set(
          (choices.append ? staged.filter(claimsPdf) : []).map(({ attachmentId }) => attachmentId),
        );
        const journal =
          context === null ? [] : await storeJournal(await journalFiles(invoiceId, context, choices), journalKey);
        return [
          { key: existing.objectKey, filename: existing.filename, contentType: existing.contentType },
          ...journal,
          ...staged
            .filter(({ attachmentId }) => !inside.has(attachmentId))
            .filter(({ attachmentId }) => choices.files || meantForBack.has(attachmentId))
            .map(reference),
        ];
      }

      // Nothing to render from, but a staged purchase order is still worth
      // sending: it was attached by a person, not derived from the invoice.
      if (context === null) {
        return choices.files ? (await readStagedAttachments(database, invoiceId)).map(reference) : [];
      }

      // The document goes exactly where the message's body said it would: the
      // decision was taken when the body was written, and an email whose text
      // promises a PDF has to carry one.
      const attachPdf = await readMessageAttachesPdf(database, invoiceMessageId);
      const composed = await compose(invoiceId, context, { ...choices, document: attachPdf }, null);
      const journal = await storeJournal(composed.journal, journalKey);
      const beside = composed.beside.map(({ file }) => reference(file));
      if (composed.document === null) return [...journal, ...beside];

      const version = (await options.source.invoiceVersion(invoiceId)) ?? 0;
      const key = invoiceDocumentKey(invoiceId, invoiceMessageId);
      // Stored before it is recorded. A row pointing at an object that is not
      // there would send a message naming a file the consumer cannot fetch, and
      // that refusal happens after the invoice has already been marked sent.
      await objects.put(key, exactBuffer(composed.document.bytes), "application/pdf");
      await recordAttachedDocument(database, {
        invoiceMessageId,
        invoiceId,
        objectKey: key,
        filename: composed.document.filename,
        contentType: "application/pdf",
        byteSize: composed.document.bytes.byteLength,
        invoiceVersion: version,
        appendedAttachmentIds: composed.document.appended.map(({ attachmentId }) => attachmentId),
        now: options.now(),
      });

      // The invoice first. It is what the message is about, and a client
      // opening the attachments in order should meet it -- with whatever is
      // bound behind it -- before the work behind it, then whatever else a
      // person attached.
      return [
        { key, filename: composed.document.filename, contentType: "application/pdf" },
        ...journal,
        ...beside,
      ];
    },

    async preview({ invoiceId, choices: overrides }) {
      const context = await options.source.documentContext(invoiceId);
      if (context === null) return [];
      const composed = await compose(invoiceId, context, await resolveChoices(invoiceId, overrides), null);
      const listed: InvoiceAttachmentPreview[] = [];
      if (composed.document !== null) {
        listed.push({
          kind: "invoice",
          filename: composed.document.filename,
          contentType: "application/pdf",
          byteSize: composed.document.bytes.byteLength,
          appended: composed.document.appended.map(({ filename }) => filename),
          notAppended: null,
        });
      }
      for (const file of composed.journal) {
        listed.push({
          kind: "journal",
          filename: file.filename,
          contentType: file.contentType,
          byteSize: file.bytes.byteLength,
          appended: [],
          notAppended: null,
        });
      }
      for (const { file, notAppended } of composed.beside) {
        listed.push({
          kind: "file",
          filename: file.filename,
          contentType: file.contentType,
          byteSize: file.byteSize,
          appended: [],
          notAppended,
        });
      }
      return listed;
    },

    async previewDocument({ invoiceId, choices: overrides }) {
      const context = await options.source.documentContext(invoiceId);
      if (context === null) return null;
      const choices = await resolveChoices(invoiceId, overrides);
      const composed = await compose(invoiceId, context, { ...choices, document: true }, "PREVIEW");
      return composed.document === null
        ? null
        : { filename: composed.document.filename, bytes: composed.document.bytes };
    },

    async stagePreview({ invoiceId, previewId, choices: overrides }) {
      const context = await options.source.documentContext(invoiceId);
      if (context === null) return [];
      const composed = await compose(
        invoiceId,
        context,
        await resolveChoices(invoiceId, overrides),
        "PREVIEW",
      );
      // Kept apart from what sends keep: a preview names keys of its own, so
      // nothing it writes can be mistaken for -- or replace -- a document a
      // client was sent.
      const base = `invoice-previews/${String(invoiceId)}/${previewId}`;
      const references: EmailAttachmentRef[] = [];
      if (composed.document !== null) {
        await objects.put(`${base}.pdf`, exactBuffer(composed.document.bytes), "application/pdf");
        references.push({
          key: `${base}.pdf`,
          filename: composed.document.filename,
          contentType: "application/pdf",
        });
      }
      references.push(...(await storeJournal(composed.journal, (format) => `${base}-journal.${format}`)));
      references.push(...composed.beside.map(({ file }) => reference(file)));
      return references;
    },
  };
};

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
