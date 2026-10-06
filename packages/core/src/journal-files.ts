import { renderJournalCsv } from "./journal-csv.js";
import {
  renderJournalDocument,
  type JournalDetail,
  type JournalDocumentInput,
  type JournalEntry,
  type JournalReportInput,
} from "./journal-document.js";
import { renderJournalWorkbook } from "./journal-xlsx.js";

/**
 * The files the work journal can be (issue 647): the document a client reads,
 * and the two a client's accounts team loads into something else.
 *
 * One level -- detailed or summary -- is shared by every file, so the PDF and
 * the spreadsheet beside it describe the same rows. The set is any non-empty
 * subset, always held in this order, which is the order the files attach in.
 */
export const journalFormats = ["pdf", "csv", "xlsx"] as const;
export type JournalFormat = (typeof journalFormats)[number];

/** What the product sends when nobody has chosen: the PDF it always sent. */
export const defaultJournalFormats: readonly JournalFormat[] = Object.freeze(["pdf"]);

export const isJournalFormat = (value: unknown): value is JournalFormat =>
  typeof value === "string" && (journalFormats as readonly string[]).includes(value);

/**
 * A format set as the product stores and returns it, or `null` when the value
 * is not one: not an array, empty, an unknown format, or a format twice.
 *
 * A repeated format is refused rather than collapsed, because a caller that
 * sent it twice meant something this cannot know, and guessing is how a
 * setting ends up saying what nobody asked for.
 */
export const parseJournalFormats = (value: unknown): readonly JournalFormat[] | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const formats: unknown[] = value;
  if (!formats.every(isJournalFormat)) return null;
  if (new Set(formats).size !== formats.length) return null;
  return journalFormats.filter((format) => formats.includes(format));
};

export const journalFormatContentType: Readonly<Record<JournalFormat, string>> = {
  pdf: "application/pdf",
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/**
 * What any of the files is rendered from: the invoice it belongs to and the
 * entries that invoice billed, notes already reduced to those a client may
 * read (D20). The email and the download both start here, so the file a
 * client is sent and the one an operator downloads cannot describe different
 * work.
 */
export interface JournalSource {
  readonly invoiceNumber: string;
  readonly companyName: string;
  readonly clientName: string;
  /** In date order, as the invoice billed them. */
  readonly entries: readonly JournalEntry[];
}

/**
 * The period is the span of the entries rather than the invoice's own: an
 * invoice raised for a month can bill only its last week, and a journal dated
 * across the month would claim work in weeks that have none.
 */
export const journalDocumentFor = (
  source: JournalSource,
  detail: JournalDetail,
): JournalDocumentInput => ({
  detail,
  invoiceNumber: source.invoiceNumber,
  companyName: source.companyName,
  clientName: source.clientName,
  periodStart: source.entries[0]?.spentDate ?? null,
  periodEnd: source.entries.at(-1)?.spentDate ?? null,
  timeFormat: "decimal",
  entries: source.entries,
});

/**
 * `work-<level>-<number>.<format>`. The invoice number is operator text and
 * reaches the recipient's filesystem, so anything that is not a filename
 * character becomes a dash -- the rule the invoice document's own name follows,
 * and the one Mailgun enforces by refusing the message outright.
 */
export const journalFilename = (
  detail: JournalDetail,
  invoiceNumber: string,
  format: JournalFormat,
): string => `work-${detail}-${invoiceNumber.replace(/[^A-Za-z0-9._-]/gu, "-")}.${format}`;

export const renderJournalFile = (
  format: JournalFormat,
  input: JournalDocumentInput | JournalReportInput,
): Uint8Array => {
  switch (format) {
    case "pdf":
      return renderJournalDocument(input);
    case "csv":
      return renderJournalCsv(input);
    case "xlsx":
      return renderJournalWorkbook(input);
  }
};
