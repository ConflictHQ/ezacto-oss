import { describe, expect, it } from "vitest";
import {
  renderJournalDocument,
  summariseJournal,
  type JournalDocumentInput,
  type JournalEntry,
} from "../src/journal-document.js";

/**
 * Issue 626. An invoice line reading "Service: Advisory, 72.5 hours" summarises
 * something, and a client who wants to see the something has nowhere to look.
 */

const text = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  spentDate: "2026-08-03",
  personName: "R. Adeyemi",
  projectName: "Phase 1",
  taskName: "Advisory",
  notes: "Reviewed the forecast model",
  seconds: 5_400,
  ...overrides,
});

const journal = (overrides: Partial<JournalDocumentInput> = {}): JournalDocumentInput => ({
  detail: "detailed",
  invoiceNumber: "1315",
  companyName: "CONFLICT",
  clientName: "Kestrel Environmental",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  timeFormat: "decimal",
  entries: [entry()],
  ...overrides,
});

describe("the detailed journal", () => {
  it("[unit] lists an entry with its date, person, project and work", () => {
    const rendered = text(renderJournalDocument(journal()));
    expect(rendered).toContain("(2026-08-03  R. Adeyemi  ·  Phase 1) Tj");
    expect(rendered).toContain("(Advisory ");
    expect(rendered).toContain("(1.50) Tj");
  });

  it("[unit] says which document it is, so a summary is never mistaken for the record", () => {
    expect(text(renderJournalDocument(journal()))).toContain("(WORK DETAIL) Tj");
    expect(text(renderJournalDocument(journal({ detail: "summary" })))).toContain(
      "(WORK SUMMARY) Tj",
    );
  });

  it("[unit] falls back to whichever of task and note exists", () => {
    const only = (overrides: Partial<JournalEntry>) =>
      text(renderJournalDocument(journal({ entries: [entry(overrides)] })));
    expect(only({ notes: null })).toContain("(Advisory) Tj");
    expect(only({ taskName: null })).toContain("(Reviewed the forecast model) Tj");
    // Neither is not a crash, it is a row with an hour count and no description.
    expect(only({ taskName: null, notes: null })).toContain("(1.50) Tj");
  });
});

describe("the summary", () => {
  it("[money] totals per project and counts the entries behind each", () => {
    const rendered = text(
      renderJournalDocument(
        journal({
          detail: "summary",
          entries: [
            entry({ projectName: "Phase 1", seconds: 3_600 }),
            entry({ projectName: "Phase 2", seconds: 1_800 }),
            entry({ projectName: "Phase 1", seconds: 5_400 }),
          ],
        }),
      ),
    );
    expect(rendered).toContain("(Phase 1) Tj")
    expect(rendered).toContain("(2 entries) Tj")
    expect(rendered).toContain("(1 entry) Tj")
    // 1h + 1.5h on Phase 1
    expect(rendered).toContain("(2.50) Tj")
  });

  it("[money] keeps the order projects first appear, so it matches a detailed list", () => {
    // Alphabetical would be tidier and would stop the two agreeing, which is
    // the one thing they must do.
    const groups = summariseJournal([
      entry({ projectName: "Zephyr" }),
      entry({ projectName: "Alpha" }),
      entry({ projectName: "Zephyr" }),
    ])
    expect(groups.map((group) => group.projectName)).toEqual(["Zephyr", "Alpha"])
    expect(groups.map((group) => group.entries)).toEqual([2, 1])
  });
});

describe("how hours read", () => {
  it("[money] follows the organization's own format", () => {
    const decimal = text(renderJournalDocument(journal({ entries: [entry({ seconds: 5_400 })] })));
    expect(decimal).toContain("(1.50) Tj");
    const clock = text(
      renderJournalDocument(
        journal({ timeFormat: "hours_minutes", entries: [entry({ seconds: 5_400 })] }),
      ),
    );
    expect(clock).toContain("(1:30) Tj");
  });

  it("[money] never prints a sixtieth minute", () => {
    // 59.6 minutes rounds to 60, which is an hour rather than ":60".
    const rendered = text(
      renderJournalDocument(
        journal({ timeFormat: "hours_minutes", entries: [entry({ seconds: 3_598 })] }),
      ),
    );
    expect(rendered).toContain("(1:00) Tj");
    expect(rendered).not.toContain(":60)");
  });

  it("[money] totals from the seconds, not from the rounded rows", () => {
    // Three entries of 20 minutes are exactly one hour. Summing the displayed
    // 0.33s would print 0.99 and disagree with the invoice.
    const rendered = text(
      renderJournalDocument(
        journal({ entries: [entry({ seconds: 1_200 }), entry({ seconds: 1_200 }), entry({ seconds: 1_200 })] }),
      ),
    );
    expect(rendered).toContain("(1.00) Tj");
    expect(rendered).not.toContain("(0.99) Tj");
  });
});

describe("the document itself", () => {
  it("[unit] pages a long journal and repeats the column heading", () => {
    const entries = Array.from({ length: 120 }, (_, index) =>
      entry({ spentDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}` }),
    );
    const rendered = text(renderJournalDocument(journal({ entries })));
    const pages = Number(/\/Count (\d+)/u.exec(rendered)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(rendered.split("(HOURS) Tj").length - 1).toBeGreaterThan(1);
    expect(rendered).toContain(`(Page ${String(pages)}) Tj`);
  });

  it("[unit] renders an empty journal rather than failing", () => {
    const rendered = text(renderJournalDocument(journal({ entries: [] })));
    expect(rendered).toContain("(Total hours) Tj");
    expect(rendered).toContain("(0.00) Tj");
  });

  it("[unit] names the file so a reader says which invoice and which document", () => {
    expect(text(renderJournalDocument(journal()))).toContain(
      "/Title (Work detail for invoice 1315)",
    );
    expect(text(renderJournalDocument(journal({ detail: "summary" })))).toContain(
      "/Title (Work summary for invoice 1315)",
    );
  });
});
