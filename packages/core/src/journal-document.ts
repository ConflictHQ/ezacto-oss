import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  renderPdf,
  textWidth,
  type PdfDocument,
  type PdfOperation,
  type PdfPage,
} from "./pdf.js";
import { plainLines, wrapRuns, wrapText } from "./pdf-text.js";

/**
 * The work behind an invoice, as a document (issues 626, 647).
 *
 * An invoice line reading "Service: Advisory, 72.5 hours" is a summary of
 * something, and a client who wants to see the something has nowhere to look.
 * This is that: either every entry that was billed, or the same hours totalled
 * per project and per person.
 *
 * Laid out as Harvest's own "Detailed time report", which is what a client who
 * has been receiving these for years expects to open: the title and the client
 * across the top, a recap of what the report covers, then one band per person
 * with their entries under it, every note in full beneath its entry, and the
 * total at the foot of every page so a page read on its own still says what
 * it adds up to.
 */

export type JournalDetail = "detailed" | "summary";

/** How hours read, matching the organization's own setting. */
export type JournalTimeFormat = "decimal" | "hours_minutes";

export interface JournalEntry {
  readonly spentDate: string;
  readonly personName: string;
  /** The project's client, as Harvest's report prints on every row. */
  readonly clientName: string;
  readonly projectName: string;
  /** `''` when the project has none. */
  readonly projectCode: string;
  readonly taskName: string | null;
  /** The person's roles, name-ordered; empty when they hold none. */
  readonly roles: readonly string[];
  /** Only a note the client may read; the caller withholds an internal one (D20). */
  readonly notes: string | null;
  readonly seconds: number;
  readonly billable: boolean;
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

/**
 * Rounded to a hundredth of an hour, which is how the product already shows
 * decimal time. Each row is rounded on its own and a total is rounded from the
 * summed seconds: summing the rounded rows would drift from the invoice by a
 * few minutes across a long list.
 */
export const journalDecimalHours = (seconds: number): string =>
  (Math.round((seconds / 3600) * 100) / 100).toFixed(2);

const hours = (seconds: number, format: JournalTimeFormat): string => {
  if (format === "hours_minutes") {
    const whole = Math.trunc(seconds / 3600);
    const minutes = Math.round((seconds - whole * 3600) / 60);
    // 59.6 minutes rounds to 60, which is an hour rather than ":60".
    return minutes === 60
      ? `${String(whole + 1)}:00`
      : `${String(whole)}:${String(minutes).padStart(2, "0")}`;
  }
  return journalDecimalHours(seconds);
};

/** Harvest's "[code] Name", so a project reads the same here as on the invoice. */
export const journalProjectLabel = (
  entry: Pick<JournalEntry, "projectCode" | "projectName">,
): string =>
  entry.projectCode.trim() === ""
    ? entry.projectName
    : `[${entry.projectCode.trim()}] ${entry.projectName}`;

interface Tally {
  readonly name: string;
  readonly seconds: number;
  readonly entries: number;
}

/** In the order each name first appears, for the reason `summariseJournal` gives. */
const tally = (
  entries: readonly JournalEntry[],
  nameOf: (entry: JournalEntry) => string,
): readonly Tally[] => {
  const groups = new Map<string, { name: string; seconds: number; entries: number }>();
  for (const entry of entries) {
    const name = nameOf(entry);
    const existing = groups.get(name);
    if (existing === undefined) {
      groups.set(name, { name, seconds: entry.seconds, entries: 1 });
    } else {
      existing.seconds += entry.seconds;
      existing.entries += 1;
    }
  }
  return [...groups.values()];
};

/**
 * Totals per project, in the order the projects first appear.
 *
 * Alphabetical would be tidier and would stop the summary matching the detailed
 * list a client may also have, which is the one thing the two must agree about.
 */
export const summariseJournal = (
  entries: readonly JournalEntry[],
): readonly { readonly projectName: string; readonly seconds: number; readonly entries: number }[] =>
  tally(entries, journalProjectLabel).map(({ name, seconds, entries: count }) => ({
    projectName: name,
    seconds,
    entries: count,
  }));

/**
 * The same hours totalled per person, alphabetically by name, which is the
 * order Harvest's report gives its people and so the order a client finds
 * them in.
 */
export const summariseJournalByPerson = (
  entries: readonly JournalEntry[],
): readonly { readonly personName: string; readonly seconds: number; readonly entries: number }[] =>
  [...tally(entries, (entry) => entry.personName)]
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map(({ name, seconds, entries: count }) => ({
      personName: name,
      seconds,
      entries: count,
    }));

/** Whether any entry names a role, which decides whether the column exists at all. */
export const journalHasRoles = (entries: readonly JournalEntry[]): boolean =>
  entries.some((entry) => entry.roles.length > 0);

const MARGIN = 28;
const RIGHT = PDF_PAGE_WIDTH - MARGIN;
const TOP = PDF_PAGE_HEIGHT - MARGIN;
/** Rows stop here; below sit the page's total and its number. */
export const JOURNAL_FLOOR = 74;
const SIZE = 9;
const LINE = 11;
const PAD = 6;
const BAND = 20;
/** From the top of a row to its first baseline, and from its last to its rule. */
const ROW_FIRST = 13.5;
const ROW_LAST = 8;
/** Between an entry's own line and its note. A note's own lines sit at the leading, as Harvest's do. */
const NOTE_GAP = 6;

type ColumnKey = "date" | "client" | "project" | "task" | "role" | "hours";

interface Column {
  readonly key: ColumnKey;
  readonly label: string;
  readonly left: number;
  readonly right: number;
}

const labels: Readonly<Record<ColumnKey, string>> = {
  date: "Date",
  client: "Client",
  project: "Project",
  task: "Task",
  role: "Roles",
  hours: "Hours",
};

const cellValue = (entry: JournalEntry, key: ColumnKey, time: (seconds: number) => string): string => {
  switch (key) {
    case "date":
      return entry.spentDate;
    case "client":
      return entry.clientName;
    case "project":
      return journalProjectLabel(entry);
    case "task":
      return entry.taskName ?? "";
    case "role":
      return entry.roles.join(", ");
    case "hours":
      return time(entry.seconds);
  }
};

/**
 * Harvest's columns, sized from what they hold, as its HTML table sizes them:
 * each column wants its widest value and needs at least its longest word; a
 * page with room to spare gives the spare to the text columns, and one without
 * takes the shortfall from the columns that can wrap. The role column exists
 * only where somebody holds a role -- a column of blanks is a question the
 * client cannot answer.
 */
const columnsFor = (
  entries: readonly JournalEntry[],
  time: (seconds: number) => string,
  totals: readonly string[],
): readonly Column[] => {
  const keys: readonly ColumnKey[] = journalHasRoles(entries)
    ? ["date", "client", "project", "task", "role", "hours"]
    : ["date", "client", "project", "task", "hours"];
  const width = (value: string): number => textWidth(value, "regular", SIZE);
  const fixed = (key: ColumnKey): boolean => key === "date" || key === "hours";
  const natural = keys.map((key) => {
    const values =
      key === "hours"
        ? [...entries.map((entry) => time(entry.seconds)), ...totals]
        : key === "date"
          ? ["0000-00-00"]
          : entries.map((entry) => cellValue(entry, key, time));
    return Math.max(textWidth(labels[key], "regular", 8.5), ...values.map(width)) + PAD * 2;
  });
  const minimum = keys.map((key, index) => {
    if (fixed(key)) return natural[index]!;
    const words = entries.flatMap((entry) => cellValue(entry, key, time).split(/\s+/u));
    return Math.min(
      natural[index]!,
      Math.max(textWidth(labels[key], "regular", 8.5), ...words.map(width)) + PAD * 2,
    );
  });
  const available = RIGHT - MARGIN;
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  let widths: number[];
  if (sum(natural) <= available) {
    const share = sum(natural.filter((_, index) => !fixed(keys[index]!)));
    const slack = available - sum(natural);
    widths = natural.map((value, index) => (fixed(keys[index]!) ? value : value + (slack * value) / share));
  } else if (sum(minimum) < available) {
    const stretch = sum(natural) - sum(minimum);
    const room = available - sum(minimum);
    widths = minimum.map((value, index) => value + (room * (natural[index]! - value)) / stretch);
  } else {
    widths = minimum.map((value) => (value * available) / sum(minimum));
  }
  let left = MARGIN;
  return keys.map((key, index) => {
    const column = { key, label: labels[key], left, right: left + widths[index]! };
    left = column.right;
    return column;
  });
};

/** Up to three names in alphabetical order, then how many more, so a recap stays a recap. */
const names = (values: readonly string[]): string => {
  const unique = [...new Set(values.filter((value) => value.trim() !== ""))].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
  if (unique.length === 0) return "None";
  return unique.length <= 3
    ? unique.join(", ")
    : `${unique.slice(0, 3).join(", ")} and ${String(unique.length - 3)} more`;
};

const counted = (count: number, singular: string, plural: string): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

/**
 * The pages, before they are written out.
 *
 * Public so pagination can be asserted on positions rather than by parsing a
 * PDF back: a test can say no line sits below the floor and no note lost a
 * character, which is what a client reading the document needs to be true.
 */
export const layoutJournalDocument = (input: JournalDocumentInput): PdfDocument => {
  const time = (seconds: number): string => hours(seconds, input.timeFormat);
  const total = input.entries.reduce((sum, entry) => sum + entry.seconds, 0);
  const detailed = input.detail === "detailed";
  const pages: PdfOperation[][] = [];
  let operations: PdfOperation[] = [];
  let y = TOP;
  // The band a continuation page repeats at its top, so a page read on its own
  // still says what its columns are.
  let heading: (() => void) | null = null;

  const text = (
    x: number,
    baseline: number,
    value: string,
    options: {
      readonly size?: number;
      readonly font?: "regular" | "bold";
      readonly align?: "left" | "right" | "center";
    } = {},
  ): void => {
    if (value === "") return;
    operations.push({
      kind: "text",
      x,
      y: baseline,
      size: options.size ?? SIZE,
      font: options.font ?? "regular",
      text: value,
      ...(options.align === undefined ? {} : { align: options.align }),
    });
  };
  const rule = (at: number, grey = 0.85): void => {
    operations.push({ kind: "line", x1: MARGIN, y1: at, x2: RIGHT, y2: at, width: 0.6, grey });
  };
  const band = (top: number, shade: number): void => {
    operations.push({
      kind: "rect",
      x: MARGIN,
      y: top - BAND,
      width: RIGHT - MARGIN,
      height: BAND,
      grey: shade,
    });
  };
  const nextPage = (): void => {
    pages.push(operations);
    operations = [];
    y = TOP;
    if (heading !== null) heading();
  };
  /** Starts a new page unless `height` more points fit above the floor. */
  const room = (height: number): void => {
    if (y - height < JOURNAL_FLOOR) nextPage();
  };

  // The title and the client, a rule, and the recap: page one only, as Harvest
  // sets them. A client name too long to sit beside the title is set smaller
  // rather than over it.
  const title = detailed ? "Detailed time report" : "Summary time report";
  text(MARGIN, TOP - 22, title, { size: 22, font: "bold" });
  const nameRoom = RIGHT - (MARGIN + textWidth(title, "bold", 22) + 24);
  const nameWidth = textWidth(input.clientName, "regular", 18);
  text(RIGHT, TOP - 22, input.clientName, {
    size: nameWidth <= nameRoom ? 18 : Math.max(8, (18 * nameRoom) / nameWidth),
    align: "right",
  });
  rule(TOP - 40, 0.8);

  const clients = input.entries.map((entry) => entry.clientName);
  const projects = input.entries.map((entry) => entry.projectName);
  const tasks = input.entries.flatMap((entry) => (entry.taskName === null ? [] : [entry.taskName]));
  const distinct = (values: readonly string[]): number =>
    new Set(values.filter((value) => value.trim() !== "")).size;
  const allBillable = input.entries.every((entry) => entry.billable);
  const recapTop = TOP - 82;
  let recapBottom = recapTop;
  const recap = (
    rows: readonly (readonly [string, string])[],
    labelX: number,
    valueX: number,
    measure: number,
  ): void => {
    let baseline = recapTop;
    for (const [label, value] of rows) {
      text(labelX, baseline, label, { size: 10 });
      const lines = wrapText(value, "bold", 10, measure);
      lines.forEach((line, index) => text(valueX, baseline - index * 12.5, line, { size: 10, font: "bold" }));
      baseline -= 12.5 * lines.length + 5.5;
    }
    recapBottom = Math.min(recapBottom, baseline);
  };
  recap(
    [
      ["Invoice", input.invoiceNumber],
      [
        "Timeframe",
        input.periodStart === null || input.periodEnd === null
          ? "None"
          : input.periodStart === input.periodEnd
            ? input.periodStart
            : `${input.periodStart} – ${input.periodEnd}`,
      ],
      ["Total", `${time(total)} ${allBillable ? "Invoiced billable hours" : "Invoiced hours"}`],
    ],
    MARGIN,
    MARGIN + 73,
    300 - (MARGIN + 73),
  );
  recap(
    [
      [counted(distinct(clients), "Client", "Clients"), names(clients)],
      [counted(distinct(projects), "Project", "Projects"), names(projects)],
      [counted(distinct(tasks), "Task", "Tasks"), names(tasks)],
      ["Team", names(input.entries.map((entry) => entry.personName))],
    ],
    311,
    408,
    RIGHT - 408,
  );
  y = recapBottom - 14;

  /** A band naming a group and its hours, as Harvest heads each person. */
  const groupBand = (name: string, seconds: number, hoursRight: number): void => {
    band(y, 0.965);
    text(MARGIN + PAD, y - ROW_FIRST, name);
    text(hoursRight, y - ROW_FIRST, time(seconds), { align: "right" });
    y -= BAND;
  };

  if (detailed) {
    const people = summariseJournalByPerson(input.entries);
    const columns = columnsFor(input.entries, time, [
      ...people.map((person) => time(person.seconds)),
      time(total),
    ]);
    const hoursRight = RIGHT - PAD;
    const notesLeft = columns[1]!.left + PAD;
    const notesMeasure = hoursRight - notesLeft;
    heading = () => {
      band(y, 0.93);
      for (const column of columns) {
        if (column.key === "hours") text(hoursRight, y - ROW_FIRST, column.label, { size: 8.5, align: "right" });
        else text(column.left + PAD, y - ROW_FIRST, column.label, { size: 8.5 });
      }
      y -= BAND;
    };
    room(BAND * 3);
    heading();
    for (const person of people) {
      // A person's band never sits alone at the foot of a page.
      room(BAND + ROW_FIRST + ROW_LAST + LINE);
      groupBand(person.personName === "" ? "Unnamed person" : person.personName, person.seconds, hoursRight);
      for (const entry of input.entries.filter((candidate) => candidate.personName === person.personName)) {
        const cells = columns.map((column) => {
          const value = cellValue(entry, column.key, time);
          return {
            column,
            lines:
              column.key === "hours"
                ? [value]
                : wrapText(value, "regular", SIZE, column.right - column.left - PAD * 2),
          };
        });
        const cellLines = Math.max(...cells.map((cell) => cell.lines.length));
        // Every word of the note, as typed: wrapped to the row, its line breaks
        // kept, a URL cut where it must be rather than shortened.
        const paragraphs =
          entry.notes === null || entry.notes.trim() === ""
            ? []
            : plainLines(entry.notes.trim(), "regular").map((line) =>
                wrapRuns(line, SIZE, notesMeasure).map((runs) => runs.map((run) => run.text).join("")),
              );
        const noteLines = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
        const head = ROW_FIRST + LINE * (cellLines - 1) + ROW_LAST;
        const height = head + (noteLines === 0 ? 0 : NOTE_GAP + LINE * noteLines);
        // Kept whole where it fits on a page. A row longer than a page carries
        // its note over the break, under the repeated header.
        room(height <= TOP - BAND - JOURNAL_FLOOR ? height : head + LINE);
        const first = y - ROW_FIRST;
        for (const cell of cells) {
          cell.lines.forEach((line, index) => {
            if (cell.column.key === "hours") text(hoursRight, first - index * LINE, line, { align: "right" });
            else text(cell.column.left + PAD, first - index * LINE, line);
          });
        }
        let baseline = first - LINE * (cellLines - 1);
        if (noteLines > 0) baseline -= NOTE_GAP;
        paragraphs.forEach((paragraph) => {
          for (const line of paragraph) {
            baseline -= LINE;
            if (baseline - ROW_LAST < JOURNAL_FLOOR) {
              nextPage();
              baseline = y - ROW_FIRST;
            }
            text(notesLeft, baseline, line);
          }
        });
        y = baseline - ROW_LAST;
        rule(y);
      }
    }
  } else {
    const hoursRight = RIGHT - PAD;
    const countRight = RIGHT - 96;
    const nameMeasure = countRight - 60 - (MARGIN + PAD);
    const summaryTable = (label: string, groups: readonly Tally[]): void => {
      heading = () => {
        band(y, 0.93);
        text(MARGIN + PAD, y - ROW_FIRST, label, { size: 8.5 });
        text(countRight, y - ROW_FIRST, "Entries", { size: 8.5, align: "right" });
        text(hoursRight, y - ROW_FIRST, "Hours", { size: 8.5, align: "right" });
        y -= BAND;
      };
      room(BAND + ROW_FIRST + ROW_LAST);
      heading();
      for (const group of groups) {
        const lines = wrapText(group.name, "regular", SIZE, nameMeasure);
        const height = ROW_FIRST + LINE * (lines.length - 1) + ROW_LAST;
        room(height);
        lines.forEach((line, index) => text(MARGIN + PAD, y - ROW_FIRST - index * LINE, line));
        text(countRight, y - ROW_FIRST, String(group.entries), { align: "right" });
        text(hoursRight, y - ROW_FIRST, time(group.seconds), { align: "right" });
        y -= height;
        rule(y);
      }
      heading = null;
      y -= 22;
    };
    summaryTable("Project", tally(input.entries, journalProjectLabel));
    summaryTable(
      "Person",
      summariseJournalByPerson(input.entries).map((person) => ({
        name: person.personName,
        seconds: person.seconds,
        entries: person.entries,
      })),
    );
  }
  pages.push(operations);

  // Every page closes with the total and its number, set once the count of
  // pages is known: the total under the last rule on the page, as Harvest's
  // table footer is, and never below the floor reserved for it.
  const numbered = pages.map((page, index): PdfPage => {
    const rules = page.filter(
      (operation): operation is Extract<PdfOperation, { kind: "line" }> => operation.kind === "line",
    );
    const lastRule = rules.length === 0 ? JOURNAL_FLOOR : rules[rules.length - 1]!.y1;
    const totalAt = Math.max(JOURNAL_FLOOR - 26, lastRule - 22);
    return {
      operations: [
        ...page,
        { kind: "text", x: RIGHT - 96, y: totalAt, size: 10, font: "bold", text: "Total", align: "right" },
        { kind: "text", x: RIGHT - PAD, y: totalAt, size: 10, font: "bold", text: time(total), align: "right" },
        {
          kind: "text",
          x: PDF_PAGE_WIDTH / 2,
          y: 22,
          size: 9,
          font: "regular",
          text: `Page ${String(index + 1)} of ${String(pages.length)}`,
          align: "center",
        },
      ],
    };
  });
  return { pages: numbered, title: `${title} for invoice ${input.invoiceNumber}` };
};

export const renderJournalDocument = (input: JournalDocumentInput): Uint8Array =>
  renderPdf(layoutJournalDocument(input));
