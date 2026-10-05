import { describe, expect, it } from "vitest";
import { renderJournalCsv } from "../src/journal-csv.js";
import type { JournalDocumentInput, JournalEntry } from "../src/journal-document.js";

/**
 * Issue 647. The journal as a file a client loads rather than reads, so the
 * properties that matter are the ones an importer depends on.
 */

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  spentDate: "2026-08-03",
  personName: "R. Adeyemi",
  clientName: "Kestrel Environmental",
  projectName: "Phase 1",
  projectCode: "",
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

const bytes = (input: JournalDocumentInput): Uint8Array => renderJournalCsv(input);
const decoded = (input: JournalDocumentInput): string => new TextDecoder().decode(bytes(input));
/** The records, split on CRLF only -- a bare LF belongs to a quoted field. */
const records = (input: JournalDocumentInput): string[] =>
  decoded(input).replace(/^\uFEFF/u, "").split("\r\n").slice(0, -1);

describe("the file an importer opens", () => {
  it("[unit] starts with a UTF-8 byte-order mark and ends every record with CRLF", () => {
    const rendered = bytes(journal());
    expect([...rendered.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(rendered);
    expect(text.endsWith("\r\n")).toBe(true);
    // No LF that is not part of a CRLF.
    expect(text.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);
  });

  it("[unit] carries no title block, only the header, the rows and a total", () => {
    // Machine-readable first: the invoice is named by the file, not a preamble
    // an importer has to be told to skip.
    expect(records(journal())).toEqual([
      "Date,Client,Project,Task,Person,Notes,Hours",
      "2026-08-03,Kestrel Environmental,Phase 1,Advisory,R. Adeyemi,Reviewed the forecast model,1.50",
      "Total,,,,,,1.50",
    ]);
  });

  it("[unit] keeps accented names as UTF-8 rather than a code page", () => {
    expect(decoded(journal({ entries: [entry({ personName: "Zoë Ñúñez" })] }))).toContain(
      "Zoë Ñúñez",
    );
  });

  it("[unit] leaves a missing task or note as an empty field", () => {
    expect(records(journal({ entries: [entry({ taskName: null, notes: null })] }))[1]).toBe(
      "2026-08-03,Kestrel Environmental,Phase 1,,R. Adeyemi,,1.50",
    );
  });
});

describe("quoting", () => {
  it("[unit] quotes a field holding a comma, a quote or a line break, and doubles the quote", () => {
    const rows = records(
      journal({
        entries: [
          entry({ notes: "Calls, emails" }),
          entry({ notes: 'Said "ship it"' }),
          entry({ notes: "Line one\nline two" }),
        ],
      }),
    );
    const head = "2026-08-03,Kestrel Environmental,Phase 1,Advisory,R. Adeyemi";
    expect(rows[1]).toBe(`${head},"Calls, emails",1.50`);
    expect(rows[2]).toBe(`${head},"Said ""ship it""",1.50`);
    expect(rows[3]).toBe(`${head},"Line one\nline two",1.50`);
  });

  it("[unit] keeps a CRLF typed into a note inside its quotes", () => {
    const text = decoded(journal({ entries: [entry({ notes: "a\r\nb" })] }));
    expect(text).toContain('"a\r\nb"');
  });
});

describe("formula injection", () => {
  it("[security] turns a note a spreadsheet would execute into text", () => {
    // A note is text a client did not write. Opened in Excel, `=HYPERLINK(...)`
    // is a live link and `@SUM(...)` a formula; the leading quote keeps both text.
    const guarded = (notes: string): string =>
      records(journal({ entries: [entry({ notes })] }))[1]!.split(",").slice(5, -1).join(",");
    expect(guarded('=HYPERLINK("https://x.test")')).toBe(`"'=HYPERLINK(""https://x.test"")"`);
    expect(guarded("+1 for the client")).toBe("'+1 for the client");
    expect(guarded("-2 hours correction")).toBe("'-2 hours correction");
    expect(guarded("@SUM(A1:A9)")).toBe("'@SUM(A1:A9)");
    expect(guarded("\tindented")).toBe("'\tindented");
    expect(guarded("\rleading return")).toBe(`"'\rleading return"`);
    // Only a leading one: an equals sign mid-sentence is prose.
    expect(guarded("a = b")).toBe("a = b");
  });

  it("[security] guards every text field, not just the notes", () => {
    const row = records(
      journal({ entries: [entry({ personName: "=cmd", projectName: "+p", taskName: "@t" })] }),
    )[1];
    expect(row).toBe("2026-08-03,Kestrel Environmental,'+p,'@t,'=cmd,Reviewed the forecast model,1.50");
  });

  it("[money] leaves hours numeric, a correction's negative included", () => {
    // Quoting "-1.00" into text would break the column for whoever sums it.
    const rows = records(
      journal({ entries: [entry({ seconds: 7_200 }), entry({ seconds: -3_600, notes: null })] }),
    );
    expect(rows[2]!.endsWith(",-1.00")).toBe(true);
    expect(rows.at(-1)).toBe("Total,,,,,,1.00");
  });
});

describe("hours", () => {
  it("[money] rounds each row as the PDF does and totals from the seconds", () => {
    // Three 20-minute entries: each row reads 0.33, the total is the hour the
    // invoice billed, not the 0.99 a re-sum of the rows would give.
    const rows = records(
      journal({ entries: [entry({ seconds: 1_200 }), entry({ seconds: 1_200 }), entry({ seconds: 1_200 })] }),
    );
    expect(rows.slice(1, 4).map((row) => row.split(",").at(-1))).toEqual(["0.33", "0.33", "0.33"]);
    expect(rows.at(-1)).toBe("Total,,,,,,1.00");
  });

  it("[money] writes decimal hours even where the organization shows clock time", () => {
    expect(records(journal({ timeFormat: "hours_minutes" }))[1]!.endsWith(",1.50")).toBe(true);
  });
});

describe("the columns", () => {
  it("[unit] adds a role column only where somebody holds a role, and prints projects with their code", () => {
    expect(records(journal({ entries: [entry({ roles: ["Engineer", "QA"], projectCode: "p1" })] }))).toEqual([
      "Date,Client,Project,Task,Role,Person,Notes,Hours",
      '2026-08-03,Kestrel Environmental,[p1] Phase 1,Advisory,"Engineer, QA",R. Adeyemi,Reviewed the forecast model,1.50',
      "Total,,,,,,,1.50",
    ]);
  });
});

describe("the summary", () => {
  it("[money] lists hours and entries per project in first-seen order, then the total", () => {
    expect(
      records(
        journal({
          detail: "summary",
          entries: [
            entry({ projectName: "Zephyr", seconds: 3_600 }),
            entry({ projectName: "Alpha", seconds: 1_800 }),
            entry({ projectName: "Zephyr", seconds: 5_400 }),
          ],
        }),
      ),
    ).toEqual(["Project,Entries,Hours", "Zephyr,2,2.50", "Alpha,1,0.50", "Total,3,3.00"]);
  });

  it("[unit] renders an empty journal as a header and a zero total", () => {
    expect(records(journal({ detail: "summary", entries: [] }))).toEqual([
      "Project,Entries,Hours",
      "Total,0,0.00",
    ]);
    expect(records(journal({ entries: [] }))).toEqual([
      "Date,Client,Project,Task,Person,Notes,Hours",
      "Total,,,,,,0.00",
    ]);
  });
});
