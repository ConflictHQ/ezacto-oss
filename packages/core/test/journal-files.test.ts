import { describe, expect, it } from "vitest";
import type { JournalEntry } from "../src/journal-document.js";
import {
  defaultJournalFormats,
  journalDocumentFor,
  journalFilename,
  journalFormatContentType,
  journalFormats,
  parseJournalFormats,
  renderJournalFile,
} from "../src/journal-files.js";

/** Issue 647: which files the journal goes as, and what each is called. */

const entry = (spentDate: string): JournalEntry => ({
  spentDate,
  personName: "R. Adeyemi",
  clientName: "Kestrel Environmental",
  projectName: "Phase 1",
  projectCode: "",
  taskName: "Advisory",
  roles: [],
  notes: null,
  seconds: 3_600,
  billable: true,
});

const source = {
  invoiceNumber: "1315",
  companyName: "CONFLICT",
  clientName: "Kestrel Environmental",
  entries: [entry("2026-08-03"), entry("2026-08-19")],
};

describe("the format set", () => {
  it("[unit] defaults to the PDF the journal always was", () => {
    expect(defaultJournalFormats).toEqual(["pdf"]);
  });

  it("[unit] accepts any non-empty subset and holds it in one order", () => {
    // The order is the order the files attach in, so it is the product's, not
    // whichever order a caller happened to send.
    expect(parseJournalFormats(["xlsx", "pdf"])).toEqual(["pdf", "xlsx"]);
    expect(parseJournalFormats(["csv"])).toEqual(["csv"]);
    expect(parseJournalFormats(["xlsx", "csv", "pdf"])).toEqual(journalFormats);
  });

  it("[unit] refuses an empty set, a repeat, an unknown format or anything not a list", () => {
    for (const value of [[], ["pdf", "pdf"], ["docx"], ["PDF"], "pdf", null, undefined, [1], {}]) {
      expect(parseJournalFormats(value)).toBeNull();
    }
  });
});

describe("naming and typing each file", () => {
  it("[unit] names a file by level, invoice and format", () => {
    expect(journalFilename("detailed", "1315", "pdf")).toBe("work-detailed-1315.pdf");
    expect(journalFilename("summary", "1315", "xlsx")).toBe("work-summary-1315.xlsx");
  });

  it("[security] strips anything from the invoice number that is not a filename", () => {
    // Mailgun refuses a message whose attachment name holds a path separator,
    // and a saved file must land where the person chose.
    expect(journalFilename("detailed", "2026/09 #7", "csv")).toBe("work-detailed-2026-09--7.csv");
    expect(journalFilename("detailed", "../../etc", "pdf")).toBe("work-detailed-..-..-etc.pdf");
  });

  it("[unit] gives each format the content type a mail client opens it with", () => {
    expect(journalFormatContentType).toEqual({
      pdf: "application/pdf",
      csv: "text/csv; charset=utf-8",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  });

  it("[unit] renders each format from the same source", () => {
    const input = journalDocumentFor(source, "detailed");
    const head = (format: (typeof journalFormats)[number]) =>
      Array.from(renderJournalFile(format, input).slice(0, 4));
    expect(head("pdf")).toEqual([0x25, 0x50, 0x44, 0x46]); // %PDF
    expect(head("csv")).toEqual([0xef, 0xbb, 0xbf, 0x44]); // BOM, "D"ate
    expect(head("xlsx")).toEqual([0x50, 0x4b, 0x03, 0x04]); // PK\3\4
  });
});

describe("the document every format renders", () => {
  it("[unit] dates the journal by the span of the work it lists", () => {
    expect(journalDocumentFor(source, "summary")).toMatchObject({
      detail: "summary",
      periodStart: "2026-08-03",
      periodEnd: "2026-08-19",
      timeFormat: "decimal",
    });
  });

  it("[unit] has no period when there is no work", () => {
    expect(journalDocumentFor({ ...source, entries: [] }, "detailed")).toMatchObject({
      periodStart: null,
      periodEnd: null,
    });
  });
});
