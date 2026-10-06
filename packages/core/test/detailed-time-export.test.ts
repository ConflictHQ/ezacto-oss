import { describe, expect, it } from "vitest";
import {
  detailedTimeDocument,
  detailedTimeFilename,
  detailedTimeHoursLabel,
  detailedTimeRecap,
  type DetailedTimeExportScope,
} from "../src/detailed-time-export.js";
import { renderJournalCsv } from "../src/journal-csv.js";
import {
  layoutJournalDocument,
  renderJournalDocument,
  type JournalDocumentInput,
  type JournalEntry,
} from "../src/journal-document.js";
import { renderJournalFile } from "../src/journal-files.js";
import { renderJournalWorkbook } from "../src/journal-xlsx.js";
import { textWidth, type PdfOperation } from "../src/pdf.js";

/**
 * The detailed time report, exported as the file Harvest's "Detailed time
 * report" was: the PDF a client is sent every month, and the two files their
 * accounts team loads instead. Every name here is fictional.
 */

type TextOperation = Extract<PdfOperation, { kind: "text" }>;

const raw = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const scope = (overrides: Partial<DetailedTimeExportScope> = {}): DetailedTimeExportScope => ({
  from: "2026-09-01",
  to: "2026-09-30",
  hours: "all",
  invoiceState: "all",
  client: null,
  project: null,
  task: null,
  person: null,
  role: null,
  tag: null,
  manager: null,
  contractorsOnly: false,
  fixedFeeExcluded: false,
  currency: null,
  projectStatus: "all",
  activeProjectsOnly: false,
  billingMethod: null,
  ...overrides,
});

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  spentDate: "2026-09-01",
  personName: "Julia Fictional",
  clientName: "Kestrel Holdings",
  projectName: "Kestrel Support",
  projectCode: "kst-sup",
  taskName: "DevOps",
  roles: ["Engineer"],
  notes: "Support queue:\nhttps://tickets.example.test/p/kestrel/TICKET-QUEUE-ALDO-SAMPLE-5f0c1a9e2b7d4c38a6e1f0b2d9c47a13",
  seconds: 4_104,
  billable: true,
  ...overrides,
});

const texts = (input: Parameters<typeof layoutJournalDocument>[0]): { page: number; op: TextOperation }[] =>
  layoutJournalDocument(input).pages.flatMap((page, index) =>
    page.operations
      .filter((op): op is TextOperation => op.kind === "text")
      .map((op) => ({ page: index + 1, op })),
  );
const strings = (input: Parameters<typeof layoutJournalDocument>[0]): string[] =>
  texts(input).map(({ op }) => op.text);

/** The parts of a stored (uncompressed) ZIP, read from its central directory. */
const parts = (archive: Uint8Array): Map<string, string> => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.byteLength - 22;
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const found = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.slice(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    found.set(name, decoder.decode(archive.slice(start, start + size)));
    at += 46 + nameLength + extra + comment;
  }
  return found;
};

describe("which hours the total adds up", () => {
  it("[money] says what the Show filter selected, as Harvest writes it after the figure", () => {
    expect(detailedTimeHoursLabel("all", "all")).toBe("Hours");
    expect(detailedTimeHoursLabel("billable", "all")).toBe("Billable hours");
    expect(detailedTimeHoursLabel("non_billable", "all")).toBe("Non-billable hours");
    expect(detailedTimeHoursLabel("uninvoiced", "all")).toBe("Uninvoiced billable hours");
    expect(detailedTimeHoursLabel("claimed", "all")).toBe("Claimed hours");
    expect(detailedTimeHoursLabel("unclaimed", "all")).toBe("Unclaimed hours");
  });

  it("[money] narrows by the invoice state where Show has not already said it", () => {
    expect(detailedTimeHoursLabel("all", "invoiced")).toBe("Invoiced hours");
    expect(detailedTimeHoursLabel("billable", "invoiced")).toBe("Invoiced billable hours");
    expect(detailedTimeHoursLabel("non_billable", "uninvoiced")).toBe("Uninvoiced non-billable hours");
    // Already on one side of an invoice: qualifying again would say it twice.
    expect(detailedTimeHoursLabel("uninvoiced", "uninvoiced")).toBe("Uninvoiced billable hours");
    expect(detailedTimeHoursLabel("claimed", "invoiced")).toBe("Claimed hours");
    expect(detailedTimeHoursLabel("unclaimed", "uninvoiced")).toBe("Unclaimed hours");
  });
});

describe("the recap", () => {
  it("[unit] states an unfiltered report in Harvest's words", () => {
    expect(detailedTimeRecap(scope()).scope).toEqual([
      ["Clients", "All clients"],
      ["Projects", "All projects"],
      ["Tasks", "All tasks"],
      ["Team", "Everyone"],
    ]);
  });

  it("[unit] names each filter that was set, as Harvest counts a selection", () => {
    const recap = detailedTimeRecap(
      scope({ client: "Kestrel Holdings", project: "Kestrel Support", task: "DevOps", person: "Julia Fictional" }),
    );
    expect(recap.scope).toEqual([
      ["1 Client", "Kestrel Holdings"],
      ["1 Project", "Kestrel Support"],
      ["1 Task", "DevOps"],
      ["Team", "Julia Fictional"],
    ]);
    expect(detailedTimeRecap(scope({ contractorsOnly: true })).scope).toContainEqual(["Team", "Contractors only"]);
  });

  it("[unit] says every filter Harvest lacks once it narrows the report, and none that does not", () => {
    const narrowed = detailedTimeRecap(
      scope({
        role: "Engineer",
        tag: "Retained",
        manager: "Marta Example",
        billingMethod: "time_materials",
        fixedFeeExcluded: true,
        currency: "EUR",
        projectStatus: "archived",
      }),
    ).scope;
    expect(narrowed.slice(4)).toEqual([
      ["Role", "Engineer"],
      ["Tag", "Retained"],
      ["Project manager", "Marta Example"],
      ["Billing method", "Time & materials"],
      ["Fixed-fee projects", "Excluded"],
      ["Currency", "EUR"],
      ["Project status", "Archived only"],
    ]);
    expect(detailedTimeRecap(scope({ activeProjectsOnly: true })).scope.at(-1)).toEqual([
      "Project status",
      "Active only",
    ]);
    expect(detailedTimeRecap(scope()).scope).toHaveLength(4);
  });

  it("[unit] keeps every label clear of the value beside it", () => {
    // The PDF sets the block's labels at x=311 and its values at x=408, in
    // 10pt. A label that ran into its value would print over the client's name.
    const every = detailedTimeRecap(
      scope({
        client: "Kestrel Holdings",
        project: "Kestrel Support",
        task: "DevOps",
        role: "Engineer",
        tag: "Retained",
        manager: "Marta Example",
        billingMethod: "non_billable",
        fixedFeeExcluded: true,
        currency: "EUR",
        projectStatus: "active",
      }),
    ).scope;
    for (const [label] of every) expect(textWidth(label, "regular", 10), label).toBeLessThan(408 - 311 - 6);
  });
});

describe("the exported document", () => {
  const ticketMonth = Array.from({ length: 24 }, (_, index) =>
    entry({
      spentDate: `2026-09-${String(index + 1).padStart(2, "0")}`,
      seconds: 1_800 + index * 611,
      notes: [
        index % 2 === 0 ? "Support queue:" : "Reworked the usage charts, then the support queue:",
        ...Array.from(
          { length: (index % 5) + 1 },
          (_, line) =>
            `https://tickets.example.test/p/kestrel/TICKET-QUEUE-SAMPLE-PERSON-${String(index)}${String(line)}-5f0c1a9e2b7d4c38a6e1f0b2d9c47a13`,
        ),
      ].join("\n"),
    }),
  );

  it("[unit] heads the report as Harvest does and recaps the filters, naming no invoice", () => {
    const input = detailedTimeDocument({
      companyName: "Fictional Studio",
      scope: scope({ client: "Kestrel Holdings", project: "Kestrel Support", hours: "uninvoiced" }),
      entries: ticketMonth,
    });
    const rendered = texts(input);
    expect(rendered[0]!.op).toMatchObject({ text: "Detailed time report", font: "bold", size: 22 });
    expect(rendered.find(({ op }) => op.text === "Kestrel Holdings" && op.size === 18)?.op.align).toBe("right");
    const total = ticketMonth.reduce((sum, item) => sum + item.seconds, 0);
    const words = strings(input);
    const hours = (Math.round((total / 3600) * 100) / 100).toFixed(2);
    expect(words).toEqual(
      expect.arrayContaining([
        "Timeframe",
        "2026-09-01 – 2026-09-30",
        "Total",
        `${hours} Uninvoiced billable hours`,
        "1 Client",
        "1 Project",
        "Tasks",
        "All tasks",
        "Team",
        "Everyone",
      ]),
    );
    expect(words).not.toContain("Invoice");
    expect(words.some((word) => /invoiced? hours/iu.test(word) && !word.includes("Uninvoiced"))).toBe(false);
    // The viewer's title bar, and the file a client saves: the report, not an invoice.
    expect(raw(renderJournalDocument(input))).toContain(
      "/Title (Detailed time report: Kestrel Holdings, 2026-09-01 \u0096 2026-09-30)",
    );
  });

  it("[unit] is the organization's own report when it spans clients", () => {
    const input = detailedTimeDocument({ companyName: "Fictional Studio", scope: scope(), entries: ticketMonth });
    expect(input.clientName).toBe("Fictional Studio");
    expect(strings(input)).toEqual(expect.arrayContaining(["Fictional Studio", "Clients", "All clients"]));
  });

  it("[unit] is dated by the report's period, not by the span of the work it found", () => {
    const input = detailedTimeDocument({
      companyName: "Fictional Studio",
      scope: scope(),
      entries: [entry({ spentDate: "2026-09-14" })],
    });
    expect(strings(input)).toContain("2026-09-01 – 2026-09-30");
  });

  it("[unit] prints every note line and every URL in full, with the person's hours on their band", () => {
    const input = detailedTimeDocument({ companyName: "Fictional Studio", scope: scope(), entries: ticketMonth });
    const words = strings(input);
    const url = "https://tickets.example.test/p/kestrel/TICKET-QUEUE-SAMPLE-PERSON-30-5f0c1a9e2b7d4c38a6e1f0b2d9c47a13";
    // Wrapped where it must be, but every character kept and in order.
    expect(words.join("")).toContain(url);
    const band = words.indexOf("Julia Fictional");
    const total = ticketMonth.reduce((sum, item) => sum + item.seconds, 0);
    expect(words[band + 1]).toBe((Math.round((total / 3600) * 100) / 100).toFixed(2));
    expect(layoutJournalDocument(input).pages.length).toBeGreaterThan(1);
  });

  it("[unit] bands several people alphabetically, the way the multi-person report reads", () => {
    const team = ["Zeno Placeholder", "Ana Example", "Mika Sample"].flatMap((personName, index) =>
      [1, 2].map((day) => entry({ personName, spentDate: `2026-09-0${String(day + index)}`, notes: null })),
    );
    const words = strings(detailedTimeDocument({ companyName: "Fictional Studio", scope: scope(), entries: team }));
    const order = ["Ana Example", "Mika Sample", "Zeno Placeholder"].map((name) => words.indexOf(name));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("[unit] renders an empty month as a report of nothing rather than failing", () => {
    const input = detailedTimeDocument({ companyName: "Fictional Studio", scope: scope({ client: "Kestrel Holdings" }), entries: [] });
    expect(strings(input)).toEqual(expect.arrayContaining(["0.00 Hours", "Page 1 of 1", "2026-09-01 – 2026-09-30"]));
    expect(raw(renderJournalDocument(input)).startsWith("%PDF-")).toBe(true);
  });

  it("[unit] gives the workbook the same recap above its table, with the panes frozen under it", () => {
    const input = detailedTimeDocument({
      companyName: "Fictional Studio",
      scope: scope({ client: "Kestrel Holdings", hours: "billable", fixedFeeExcluded: true }),
      entries: ticketMonth.slice(0, 3),
    });
    const files = parts(renderJournalWorkbook(input));
    const sheet = files.get("xl/worksheets/sheet1.xml")!;
    const shared = files.get("xl/sharedStrings.xml")!;
    for (const value of [
      "Detailed time report",
      "Timeframe",
      "2026-09-01 – 2026-09-30",
      "Billable hours",
      "1 Client",
      "Kestrel Holdings",
      "Fixed-fee projects",
      "Excluded",
    ]) {
      expect(shared).toContain(value);
    }
    expect(shared).not.toContain("Invoice");
    expect(files.get("xl/workbook.xml")).toContain('name="Detailed time report"');
    // Title, timeframe, total, four scope lines, the fixed-fee line and a
    // blank: the column names are row 10, the entries 11 to 13.
    expect(sheet).toContain('<pane ySplit="10" topLeftCell="A11"');
    expect(sheet).toContain("<f>SUM(H11:H13)</f>");
    expect(sheet).toContain('<row r="10">');
  });

  it("[unit] writes the CSV a report and an invoice journal share, with no title block", () => {
    const entries = ticketMonth.slice(0, 4);
    const report = detailedTimeDocument({ companyName: "Fictional Studio", scope: scope(), entries });
    const journal: JournalDocumentInput = {
      detail: "detailed",
      invoiceNumber: "1315",
      companyName: "Fictional Studio",
      clientName: "Kestrel Holdings",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-04",
      timeFormat: "decimal",
      entries,
    };
    expect(renderJournalCsv(report)).toEqual(renderJournalCsv(journal));
    // Kept rather than consumed, so the byte-order mark Excel needs is checked too.
    const csv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(renderJournalFile("csv", report));
    expect(csv.split("\r\n")[0]).toBe("\uFEFFDate,Client,Project,Task,Role,Person,Notes,Hours");
  });
});

describe("the file's name", () => {
  it("[unit] is the period, then the client a one-client report is for", () => {
    expect(detailedTimeFilename(scope(), "pdf")).toBe("detailed-time-2026-09-01-to-2026-09-30.pdf");
    expect(detailedTimeFilename(scope({ client: "Kestrel Holdings" }), "xlsx")).toBe(
      "detailed-time-2026-09-01-to-2026-09-30-kestrel-holdings.xlsx",
    );
  });

  it("[security] reduces the client to characters every filesystem and header accepts", () => {
    expect(detailedTimeFilename(scope({ client: 'Café "Ñandú", S.A. / Sucursal\\Norte' }), "csv")).toBe(
      "detailed-time-2026-09-01-to-2026-09-30-cafe-nandu-s-a-sucursal-norte.csv",
    );
    // Nothing left of it: no trailing dash, no empty segment.
    expect(detailedTimeFilename(scope({ client: "株式会社" }), "pdf")).toBe("detailed-time-2026-09-01-to-2026-09-30.pdf");
    const long = detailedTimeFilename(scope({ client: `${"Kestrel Holdings ".repeat(10)}Ltd` }), "pdf");
    expect(long).toMatch(/^detailed-time-2026-09-01-to-2026-09-30-[a-z0-9-]{1,60}\.pdf$/u);
    expect(long).not.toMatch(/-\.pdf$/u);
  });
});
