import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  monospacedWidth,
  renderPdf,
  type PdfOperation,
  type PdfPage,
} from "./pdf.js";

/**
 * The work behind an invoice, as a document (issue 626).
 *
 * An invoice line reading "Service: Advisory, 72.5 hours" is a summary of
 * something, and a client who wants to see the something has nowhere to look.
 * This is that: either every entry that was billed, or the same hours totalled
 * per project.
 *
 * Two levels rather than one because they answer different questions. A client
 * checking an unexpected total wants the entries; a client filing the invoice
 * wants a page, not forty. Which one goes is the operator's choice, and the
 * document says which it is so nobody mistakes a summary for the whole record.
 */

export type JournalDetail = "detailed" | "summary";

/** How hours read, matching the organization's own setting. */
export type JournalTimeFormat = "decimal" | "hours_minutes";

export interface JournalEntry {
  readonly spentDate: string;
  readonly personName: string;
  readonly projectName: string;
  readonly taskName: string | null;
  readonly notes: string | null;
  readonly seconds: number;
}

export interface JournalDocumentInput {
  readonly detail: JournalDetail;
  readonly invoiceNumber: string;
  readonly companyName: string;
  readonly clientName: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly timeFormat: JournalTimeFormat;
  readonly entries: readonly JournalEntry[];
}

const LEFT = 56;
const RIGHT = PDF_PAGE_WIDTH - 56;
const HEADER_HEIGHT = 96;
const BOTTOM = 86;

/**
 * Rounded to a hundredth of an hour, which is how the product already shows
 * decimal time. Summing the rounded values rather than rounding the sum would
 * drift from the invoice by a few minutes across a long list.
 */
const hours = (seconds: number, format: JournalTimeFormat): string => {
  if (format === "hours_minutes") {
    const whole = Math.trunc(seconds / 3600);
    const minutes = Math.round((seconds - whole * 3600) / 60);
    // 59.6 minutes rounds to 60, which is an hour rather than ":60".
    return minutes === 60
      ? `${String(whole + 1)}:00`
      : `${String(whole)}:${String(minutes).padStart(2, "0")}`;
  }
  return (Math.round((seconds / 3600) * 100) / 100).toFixed(2);
};

const DESCRIPTION_LIMIT = 52;

const trimmed = (text: string, limit = DESCRIPTION_LIMIT): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

const describe = (entry: JournalEntry): string => {
  const task = entry.taskName === null || entry.taskName.trim() === "" ? "" : entry.taskName.trim();
  const note = entry.notes === null || entry.notes.trim() === "" ? "" : entry.notes.trim();
  if (task !== "" && note !== "") return `${task} — ${note}`;
  return task !== "" ? task : note;
};

interface Group {
  readonly projectName: string;
  readonly seconds: number;
  readonly entries: number;
}

/**
 * Totals per project, in the order the projects first appear.
 *
 * Alphabetical would be tidier and would stop the summary matching the detailed
 * list a client may also have, which is the one thing the two must agree about.
 */
export const summariseJournal = (
  entries: readonly JournalEntry[],
): readonly Group[] => {
  const groups = new Map<string, { projectName: string; seconds: number; entries: number }>();
  for (const entry of entries) {
    const existing = groups.get(entry.projectName);
    if (existing === undefined) {
      groups.set(entry.projectName, {
        projectName: entry.projectName,
        seconds: entry.seconds,
        entries: 1,
      });
    } else {
      existing.seconds += entry.seconds;
      existing.entries += 1;
    }
  }
  return [...groups.values()];
};

export const renderJournalDocument = (input: JournalDocumentInput): Uint8Array => {
  const pages: PdfPage[] = [];
  let operations: PdfOperation[] = [];
  let y = 0;
  let pageNumber = 0;
  const size = 9;

  const total = input.entries.reduce((sum, entry) => sum + entry.seconds, 0);
  const widest = (values: readonly string[]): number =>
    values.reduce((wide, value) => Math.max(wide, monospacedWidth(value, size)), 0);
  const hoursColumn = RIGHT;
  const hoursWidth = Math.max(
    widest(input.entries.map((entry) => hours(entry.seconds, input.timeFormat))),
    monospacedWidth(hours(total, input.timeFormat), size),
  );

  const startPage = (): void => {
    pageNumber += 1;
    operations = [];
    operations.push({
      kind: "rect",
      x: 0,
      y: PDF_PAGE_HEIGHT - HEADER_HEIGHT,
      width: PDF_PAGE_WIDTH,
      height: HEADER_HEIGHT,
      grey: 0.11,
    });
    operations.push({
      kind: "text",
      x: LEFT,
      y: PDF_PAGE_HEIGHT - 58,
      size: 15,
      font: "bold",
      text: input.companyName,
      grey: 1,
    });
    operations.push({
      kind: "text",
      x: RIGHT,
      y: PDF_PAGE_HEIGHT - 58,
      size: 11,
      font: "mono",
      // Which document this is, so a summary is never mistaken for the whole
      // record of what was billed.
      text: input.detail === "detailed" ? "WORK DETAIL" : "WORK SUMMARY",
      align: "right",
      grey: 1,
    });
    y = PDF_PAGE_HEIGHT - HEADER_HEIGHT - 36;
  };

  const endPage = (): void => {
    operations.push({
      kind: "text",
      x: RIGHT,
      y: 52,
      size: 8,
      font: "mono",
      text: `Page ${String(pageNumber)}`,
      align: "right",
      grey: 0.55,
    });
    pages.push({ operations });
  };

  const heading = (first: string): void => {
    operations.push(
      { kind: "text", x: LEFT, y, size: 7.5, font: "bold", text: first, grey: 0.45 },
      {
        kind: "text",
        x: hoursColumn,
        y,
        size: 7.5,
        font: "mono_bold",
        text: "HOURS",
        align: "right",
        grey: 0.45,
      },
    );
    y -= 8;
    operations.push({ kind: "line", x1: LEFT, y1: y, x2: RIGHT, y2: y, width: 0.75, grey: 0.75 });
    y -= 15;
  };

  startPage();
  operations.push({
    kind: "text",
    x: LEFT,
    y,
    size: 8,
    font: "regular",
    text: `INVOICE ${input.invoiceNumber}  ·  ${trimmed(input.clientName, 40).toUpperCase()}`,
    grey: 0.45,
  });
  y -= 22;
  operations.push({
    kind: "text",
    x: LEFT,
    y,
    size: 16,
    font: "bold",
    text: input.detail === "detailed" ? "Work detail" : "Work summary",
  });
  y -= 16;
  if (input.periodStart !== null && input.periodEnd !== null) {
    operations.push({
      kind: "text",
      x: LEFT,
      y,
      size: 9,
      font: "regular",
      text: `${input.periodStart} to ${input.periodEnd}`,
      grey: 0.45,
    });
    y -= 14;
  }
  y -= 12;

  const row = (label: string, seconds: number, secondary: string | null): void => {
    if (y < BOTTOM + 40) {
      endPage();
      startPage();
      heading(input.detail === "detailed" ? "DATE · PERSON · WORK" : "PROJECT");
    }
    operations.push(
      { kind: "text", x: LEFT, y, size, font: "regular", text: trimmed(label) },
      {
        kind: "text",
        x: hoursColumn,
        y,
        size,
        font: "mono",
        text: hours(seconds, input.timeFormat),
        align: "right",
      },
    );
    if (secondary !== null && secondary !== "") {
      y -= 11;
      operations.push({
        kind: "text",
        x: LEFT + 12,
        y,
        size: 8,
        font: "regular",
        text: trimmed(secondary, 68),
        grey: 0.45,
      });
    }
    y -= 15;
  };

  if (input.detail === "detailed") {
    heading("DATE · PERSON · WORK");
    for (const entry of input.entries) {
      row(
        `${entry.spentDate}  ${entry.personName}  ·  ${entry.projectName}`,
        entry.seconds,
        describe(entry),
      );
    }
  } else {
    heading("PROJECT");
    for (const group of summariseJournal(input.entries)) {
      row(
        group.projectName,
        group.seconds,
        `${String(group.entries)} ${group.entries === 1 ? "entry" : "entries"}`,
      );
    }
  }

  y -= 4;
  operations.push({ kind: "line", x1: LEFT, y1: y, x2: RIGHT, y2: y, width: 0.75, grey: 0.75 });
  y -= 18;
  operations.push(
    { kind: "text", x: RIGHT - hoursWidth - 120, y, size: 11, font: "bold", text: "Total hours" },
    {
      kind: "text",
      x: hoursColumn,
      y,
      size: 11,
      font: "mono_bold",
      text: hours(total, input.timeFormat),
      align: "right",
    },
  );

  endPage();
  return renderPdf({
    pages,
    title: `${input.detail === "detailed" ? "Work detail" : "Work summary"} for invoice ${input.invoiceNumber}`,
  });
};
