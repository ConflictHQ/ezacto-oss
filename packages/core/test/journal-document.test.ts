import { describe, expect, it } from "vitest";
import {
  JOURNAL_FLOOR,
  journalDecimalHours,
  journalProjectLabel,
  layoutJournalDocument,
  renderJournalDocument,
  summariseJournal,
  summariseJournalByPerson,
  type JournalDocumentInput,
  type JournalEntry,
} from "../src/journal-document.js";
import { textWidth, type PdfOperation } from "../src/pdf.js";

/**
 * Issues 626 and 647. An invoice line reading "Service: Advisory, 72.5 hours"
 * summarises something, and a client who wants to see the something has
 * nowhere to look. Laid out as Harvest's detailed time report, which is what
 * a client of a migrated instance has been opening for years.
 */

type TextOperation = Extract<PdfOperation, { kind: "text" }>;

const raw = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  spentDate: "2026-08-03",
  personName: "R. Adeyemi",
  clientName: "Kestrel Environmental",
  projectName: "Phase 1",
  projectCode: "p1",
  taskName: "Advisory",
  roles: [],
  notes: "Reviewed the forecast model",
  seconds: 5_400,
  billable: true,
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

const texts = (input: JournalDocumentInput): { page: number; op: TextOperation }[] =>
  layoutJournalDocument(input).pages.flatMap((page, index) =>
    page.operations
      .filter((op): op is TextOperation => op.kind === "text")
      .map((op) => ({ page: index + 1, op })),
  );

const strings = (input: JournalDocumentInput): string[] => texts(input).map(({ op }) => op.text);
const joined = (input: JournalDocumentInput): string => strings(input).join(" ");

const sentence = (words: number, seed = "forecast"): string =>
  Array.from({ length: words }, (_, index) => `${seed}${String(index)}`).join(" ");

/** The page's total and number sit below the floor by design; nothing else may. */
const isFooter = (op: TextOperation): boolean =>
  /^Page \d+ of \d+$/u.test(op.text) || (op.size === 10 && op.font === "bold");

describe("the head of the report", () => {
  it("[unit] says what it is and whose it is, as Harvest's does", () => {
    const rendered = texts(journal());
    expect(rendered[0]!.op).toMatchObject({ text: "Detailed time report", font: "bold", size: 22 });
    expect(rendered.find(({ op }) => op.text === "Kestrel Environmental" && op.size === 18)?.op.align).toBe("right");
    expect(strings(journal({ detail: "summary" }))[0]).toBe("Summary time report");
    expect(raw(renderJournalDocument(journal()))).toContain("/Title (Detailed time report for invoice 1315)");
  });

  it("[money] recaps the invoice, the timeframe and the hours it billed", () => {
    const input = journal({
      entries: [
        entry({ personName: "M. Okafor", projectName: "Phase 2", taskName: "Field work" }),
        entry({ seconds: 1_800 }),
        entry({ personName: "Z. Ali", clientName: "Kestrel North" }),
      ],
    });
    expect(strings(input)).toEqual(
      expect.arrayContaining(["Invoice", "1315", "Timeframe", "2026-08-01 – 2026-08-31", "Total", "Team"]),
    );
    const text = joined(input);
    for (const phrase of [
      "3.50 Invoiced billable hours",
      "2 Clients Kestrel Environmental, Kestrel North",
      "2 Projects Phase 1, Phase 2",
      "2 Tasks Advisory, Field work",
      "M. Okafor, R. Adeyemi, Z. Ali",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("[money] says invoiced hours, not billable ones, when any of them were not billable", () => {
    expect(joined(journal({ entries: [entry(), entry({ billable: false })] }))).toContain("3.00 Invoiced hours");
  });

  it("[unit] keeps a long recap a recap", () => {
    const people = ["A", "B", "C", "D", "E"].map((name) => entry({ personName: `${name}. Person` }));
    expect(joined(journal({ entries: people }))).toContain("A. Person, B. Person, C. Person and 2 more");
  });
});

describe("the detailed table", () => {
  const work = [
    entry({ personName: "R. Adeyemi", spentDate: "2026-08-01", seconds: 3_600 }),
    entry({ personName: "M. Okafor", spentDate: "2026-08-02", seconds: 1_800, notes: null }),
    entry({ personName: "R. Adeyemi", spentDate: "2026-08-03", seconds: 5_400 }),
  ];

  it("[money] heads each person with a band of their hours, people in alphabetical order", () => {
    const rendered = strings(journal({ entries: work }));
    const okafor = rendered.indexOf("M. Okafor");
    const adeyemi = rendered.indexOf("R. Adeyemi");
    expect(okafor).toBeGreaterThan(-1);
    expect(okafor).toBeLessThan(adeyemi);
    expect(rendered[okafor + 1]).toBe("0.50");
    expect(rendered[adeyemi + 1]).toBe("2.50");
  });

  it("[unit] sets Harvest's columns, and a role column only where somebody has a role", () => {
    const without = strings(journal({ entries: work }));
    expect(without).toEqual(expect.arrayContaining(["Date", "Client", "Project", "Task", "Hours"]));
    expect(without).not.toContain("Roles");
    expect(joined(journal({ entries: [entry({ roles: ["Engineer", "QA"] })] }))).toContain("Roles");
    expect(joined(journal({ entries: [entry({ roles: ["Engineer", "QA"] })] }))).toContain("Engineer, QA");
  });

  it("[unit] prints each row's date, client, project with its code, task and hours", () => {
    expect(strings(journal())).toEqual(
      expect.arrayContaining(["2026-08-03", "Kestrel Environmental", "[p1] Phase 1", "Advisory", "1.50"]),
    );
    expect(journalProjectLabel({ projectCode: "", projectName: "Phase 1" })).toBe("Phase 1");
  });

  it("[unit] prints every note in full under its entry, its line breaks and URLs intact", () => {
    // A note is evidence of the work, not a preview of it.
    const url = "https://github.com/example-org/example-repo/pull/4706";
    const note = `- Attending questions, prs, other miscellaneous tasks.\n- Check, updated and merged: ${url}\n${sentence(70)}`;
    const rendered = strings(journal({ entries: [entry({ notes: note })] }));
    expect(rendered).toContain("- Attending questions, prs, other miscellaneous tasks.");
    expect(rendered).toContain(`- Check, updated and merged: ${url}`);
    expect(rendered.filter((value) => value.startsWith("forecast")).join(" ")).toBe(sentence(70));
    expect(rendered.some((value) => value.includes("…"))).toBe(false);
  });

  it("[unit] keeps a row that fits on one page together rather than splitting it", () => {
    // Every start position from the top of page 1 to well into page 2, so at
    // some of them the long row begins a line or two above the foot.
    const long = entry({ spentDate: "2026-08-30", notes: sentence(70, "kept") });
    let straddled = 0;
    for (let filler = 0; filler <= 30; filler += 1) {
      const entries = [...Array.from({ length: filler }, () => entry({ notes: "Short note" })), long];
      const rows = texts(journal({ entries })).filter(
        ({ op }) => op.text === "2026-08-30" || op.text.includes("kept"),
      );
      if (new Set(rows.map(({ page }) => page)).size !== 1) straddled += 1;
      expect(rows.length).toBeGreaterThan(3);
    }
    expect(straddled).toBe(0);
  });

  it("[unit] carries a note longer than a page over the break, losing nothing", () => {
    const note = sentence(2_500, "w");
    const rendered = texts(journal({ entries: [entry({ notes: note })] }));
    const lines = rendered.filter(({ op }) => op.text.startsWith("w"));
    expect(new Set(lines.map(({ page }) => page)).size).toBeGreaterThan(1);
    expect(lines.map(({ op }) => op.text).join(" ")).toBe(note);
  });

  it("[unit] repeats the column header on every page and sets nothing below the floor", () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry({
        spentDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}`,
        personName: index % 2 === 0 ? "R. Adeyemi" : "M. Okafor",
        notes: index % 3 === 0 ? sentence(40 + (index % 7) * 9) : "Short note",
      }),
    );
    const input = journal({ entries });
    const count = layoutJournalDocument(input).pages.length;
    expect(count).toBeGreaterThan(1);
    const rendered = texts(input);
    for (let page = 1; page <= count; page += 1) {
      expect(rendered.some(({ op, page: at }) => at === page && op.text === "Date")).toBe(true);
    }
    expect(rendered.filter(({ op }) => !isFooter(op)).every(({ op }) => op.y >= JOURNAL_FLOOR)).toBe(true);
  });

  it("[money] closes every page with the report's total and its number", () => {
    const entries = Array.from({ length: 60 }, () => entry({ notes: sentence(30) }));
    const input = journal({ entries });
    const count = layoutJournalDocument(input).pages.length;
    expect(count).toBeGreaterThan(1);
    const rendered = texts(input);
    for (let page = 1; page <= count; page += 1) {
      const onPage = rendered.filter(({ page: at }) => at === page).map(({ op }) => op);
      const total = onPage.find((op) => op.text === "Total" && op.font === "bold")!;
      expect(total).toBeDefined();
      expect(onPage.some((op) => op.text === "90.00" && op.y === total.y)).toBe(true);
      expect(onPage.some((op) => op.text === `Page ${String(page)} of ${String(count)}` && op.align === "center")).toBe(true);
    }
  });

  it("[unit] keeps every cell inside the page, wrapping rather than cutting", () => {
    const rendered = texts(
      journal({
        entries: [
          entry({
            clientName: "Kestrel Environmental Services of the Greater Watershed District",
            projectName: "Watershed restoration programme, phase two: monitoring and reporting",
            roles: ["Engineer", "Quality Assurance"],
          }),
        ],
      }),
    ).map(({ op }) => op);
    const right = (op: TextOperation): number =>
      op.align === "right" ? op.x : op.x + textWidth(op.text, op.font, op.size);
    expect(rendered.every((op) => right(op) <= 612 - 28 + 0.001)).toBe(true);
    expect(rendered.map((op) => op.text).join(" ")).toContain("monitoring and reporting");
  });

  it("[unit] renders an empty journal rather than failing", () => {
    const rendered = strings(journal({ entries: [], periodStart: null, periodEnd: null }));
    expect(rendered).toEqual(expect.arrayContaining(["Total", "0.00", "Page 1 of 1", "None"]));
  });
});

describe("the summary", () => {
  it("[money] totals per project and per person, with the entries behind each", () => {
    const entries = [
      entry({ projectName: "Phase 1", personName: "R. Adeyemi", seconds: 3_600 }),
      entry({ projectName: "Phase 2", projectCode: "", personName: "M. Okafor", seconds: 1_800 }),
      entry({ projectName: "Phase 1", personName: "M. Okafor", seconds: 5_400 }),
    ];
    const rendered = strings(journal({ detail: "summary", entries }));
    const projects = rendered.indexOf("Project");
    const people = rendered.indexOf("Person");
    expect(projects).toBeGreaterThan(-1);
    expect(people).toBeGreaterThan(projects);
    expect(rendered.slice(projects, people)).toEqual(
      expect.arrayContaining(["[p1] Phase 1", "2", "2.50", "Phase 2", "1", "0.50"]),
    );
    expect(rendered.slice(people)).toEqual(expect.arrayContaining(["M. Okafor", "2.00", "R. Adeyemi", "1.00"]));
    // A summary is not the record: no entry rows.
    expect(rendered).not.toContain("Date");
  });

  it("[money] keeps the order projects first appear, and people alphabetical", () => {
    const groups = summariseJournal([
      entry({ projectName: "Zephyr", projectCode: "" }),
      entry({ projectName: "Alpha", projectCode: "" }),
      entry({ projectName: "Zephyr", projectCode: "" }),
    ]);
    expect(groups.map((group) => group.projectName)).toEqual(["Zephyr", "Alpha"]);
    expect(groups.map((group) => group.entries)).toEqual([2, 1]);
    expect(
      summariseJournalByPerson([entry({ personName: "Zoë" }), entry({ personName: "Ana" })]).map(
        (person) => person.personName,
      ),
    ).toEqual(["Ana", "Zoë"]);
  });
});

describe("how hours read", () => {
  it("[money] follows the organization's own format", () => {
    expect(strings(journal())).toContain("1.50");
    expect(strings(journal({ timeFormat: "hours_minutes" }))).toContain("1:30");
  });

  it("[money] never prints a sixtieth minute", () => {
    const rendered = strings(journal({ timeFormat: "hours_minutes", entries: [entry({ seconds: 3_598 })] }));
    expect(rendered).toContain("1:00");
    expect(rendered.some((value) => value.endsWith(":60"))).toBe(false);
  });

  it("[money] totals from the seconds, not from the rounded rows", () => {
    // Three entries of 20 minutes are exactly one hour. Summing the displayed
    // 0.33s would print 0.99 and disagree with the invoice.
    const rendered = strings(
      journal({ entries: [entry({ seconds: 1_200 }), entry({ seconds: 1_200 }), entry({ seconds: 1_200 })] }),
    );
    expect(rendered).toContain("1.00");
    expect(rendered).not.toContain("0.99");
  });

  it("[money] rounds a row to the hundredth the way every format does", () => {
    expect(journalDecimalHours(1_200)).toBe("0.33");
    expect(journalDecimalHours(5_400)).toBe("1.50");
    expect(journalDecimalHours(-3_600)).toBe("-1.00");
    expect(journalDecimalHours(0)).toBe("0.00");
  });
});
