import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { JournalDocumentInput, JournalEntry } from "../src/journal-document.js";
import { renderJournalWorkbook } from "../src/journal-xlsx.js";
import { crc32, zipStore } from "../src/zip.js";

/**
 * Issue 647. A workbook that does not open is worse than none, so the archive
 * is read back here by a reader written independently of the writer -- the
 * headers parsed by hand, every CRC checked against Node's own -- and the parts
 * are checked for what Excel, Numbers and LibreOffice each insist on.
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

interface Unzipped {
  readonly names: readonly string[];
  readonly parts: ReadonlyMap<string, string>;
}

/** Reads a stored ZIP from its end-of-central-directory record, checking as it goes. */
const unzip = (archive: Uint8Array): Unzipped => {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  expect(at + directorySize).toBe(end);
  const names: string[] = [];
  const parts = new Map<string, string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(archive.slice(at + 46, at + 46 + nameLength));
    expect(method).toBe(0);
    expect(compressed).toBe(size);

    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 18, true)).toBe(size);
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const data = archive.slice(start, start + size);
    expect(nodeCrc32(data)).toBe(crc);
    names.push(name);
    parts.set(name, decoder.decode(data));
    at += 46 + nameLength + extra + comment;
  }
  return { names, parts };
};

const part = (archive: Uint8Array, name: string): string => {
  const found = unzip(archive).parts.get(name);
  if (found === undefined) throw new Error(`missing part ${name}`);
  return found;
};

/** The shared string a cell points at, by reference, e.g. "E7". */
const cellAt = (archive: Uint8Array, reference: string): string | number | null => {
  const sheet = part(archive, "xl/worksheets/sheet1.xml");
  const strings = [...part(archive, "xl/sharedStrings.xml").matchAll(/<si><t xml:space="preserve">([\s\S]*?)<\/t><\/si>/gu)].map(
    (match) => match[1]!,
  );
  const cell = new RegExp(`<c r="${reference}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`, "u").exec(sheet);
  if (cell === null) return null;
  const value = /<v>([^<]*)<\/v>/u.exec(cell[2] ?? "")?.[1];
  if (value === undefined) return null;
  return /t="s"/u.test(cell[1]!) ? strings[Number(value)]! : Number(value);
};

describe("the archive", () => {
  it("[unit] computes the CRC-32 every ZIP reader checks", () => {
    const data = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    expect(crc32(data)).toBe(0x414fa339);
    expect(crc32(data)).toBe(nodeCrc32(data));
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("[unit] stores entries a reader written separately can read back", () => {
    const archive = zipStore([
      { name: "a.txt", data: new TextEncoder().encode("first") },
      { name: "nested/b.txt", data: new TextEncoder().encode("second") },
    ]);
    const { names, parts } = unzip(archive);
    expect(names).toEqual(["a.txt", "nested/b.txt"]);
    expect(parts.get("nested/b.txt")).toBe("second");
  });

  it("[unit] is byte-for-byte the same for the same input", () => {
    expect(renderJournalWorkbook(journal())).toEqual(renderJournalWorkbook(journal()));
  });

  it("[security] refuses an entry name that would escape the archive", () => {
    for (const name of ["/abs", "../up", "a/../b", "a\\b", "", "a b"]) {
      expect(() => zipStore([{ name, data: new Uint8Array([1]) }])).toThrow(RangeError);
    }
    expect(() =>
      zipStore([
        { name: "x", data: new Uint8Array([1]) },
        { name: "x", data: new Uint8Array([2]) },
      ]),
    ).toThrow(RangeError);
  });
});

describe("the workbook package", () => {
  it("[unit] carries the parts SpreadsheetML requires, content types first", () => {
    const { names } = unzip(renderJournalWorkbook(journal()));
    expect(names).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
    ]);
  });

  it("[unit] declares a content type for every part it relates", () => {
    const archive = renderJournalWorkbook(journal());
    const types = part(archive, "[Content_Types].xml");
    for (const name of ["/xl/workbook.xml", "/xl/worksheets/sheet1.xml", "/xl/styles.xml", "/xl/sharedStrings.xml"]) {
      expect(types).toContain(`PartName="${name}"`);
    }
    expect(part(archive, "_rels/.rels")).toContain('Target="xl/workbook.xml"');
    const relations = part(archive, "xl/_rels/workbook.xml.rels");
    for (const target of ["worksheets/sheet1.xml", "styles.xml", "sharedStrings.xml"]) {
      expect(relations).toContain(`Target="${target}"`);
    }
    expect(part(archive, "xl/workbook.xml")).toContain('<sheet name="Work detail" sheetId="1" r:id="rId1"/>');
  });

  it("[unit] styles a bold header, two-place hours and ISO dates", () => {
    const styles = part(renderJournalWorkbook(journal()), "xl/styles.xml");
    expect(styles).toContain('<numFmt numFmtId="165" formatCode="0.00"/>');
    expect(styles).toContain('<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>');
    expect(styles).toContain("<font><b/><sz val=\"11\"/>");
    // cellXfs declares as many styles as the sheet can name.
    expect(styles).toContain('<cellXfs count="13">');
    expect([...styles.matchAll(/<xf numFmtId/gu)].length).toBe(14);
  });
});

describe("the sheet", () => {
  const work = journal({
    entries: [
      entry({ seconds: 1_200 }),
      entry({ seconds: 1_200, personName: "M. Okafor", notes: null }),
      entry({ seconds: 1_200, taskName: null }),
    ],
  });

  it("[unit] opens with the invoice, client and period above the table", () => {
    const archive = renderJournalWorkbook(work);
    expect(cellAt(archive, "A1")).toBe("Work detail");
    expect(cellAt(archive, "A2")).toBe("Invoice");
    expect(cellAt(archive, "B2")).toBe("1315");
    expect(cellAt(archive, "B3")).toBe("Kestrel Environmental");
    expect(cellAt(archive, "B4")).toBe("2026-08-01 to 2026-08-31");
    expect(["A6", "B6", "C6", "D6", "E6", "F6", "G6"].map((at) => cellAt(archive, at))).toEqual([
      "Date",
      "Client",
      "Project",
      "Task",
      "Person",
      "Notes",
      "Hours",
    ]);
  });

  it("[unit] freezes the header row and sizes the columns", () => {
    const sheet = part(renderJournalWorkbook(work), "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<col min="6" max="6" width="60" customWidth="1"/>');
    expect(sheet).toContain('<dimension ref="A1:G10"/>');
  });

  it("[money] totals with a real SUM and caches the seconds' total beside it", () => {
    // Each cell holds exact hours shown to two places, so the column reads
    // 0.33 three times and the SUM is the hour the invoice billed.
    const archive = renderJournalWorkbook(work);
    const sheet = part(archive, "xl/worksheets/sheet1.xml");
    expect(sheet).toMatch(/<c r="G10" s="6"><f>SUM\(G7:G9\)<\/f><v>1<\/v><\/c>/u);
    expect(cellAt(archive, "G7")).toBeCloseTo(1 / 3, 12);
    expect(cellAt(archive, "A10")).toBe("Total");
  });

  it("[unit] writes dates as dates, so the column sorts and filters", () => {
    // 2026-08-03 is serial 46237 counting from 1899-12-30.
    expect(cellAt(renderJournalWorkbook(work), "A7")).toBe(46237);
  });

  it("[unit] leaves a missing task or note as an empty cell", () => {
    const archive = renderJournalWorkbook(work);
    expect(cellAt(archive, "F8")).toBeNull();
    expect(cellAt(archive, "D9")).toBeNull();
  });

  it("[security] escapes markup, and writes control characters as OOXML escapes", () => {
    const archive = renderJournalWorkbook(
      journal({ entries: [entry({ notes: "a < b & c > d \u000b tab\there _x0041_ 😀" })] }),
    );
    const strings = part(archive, "xl/sharedStrings.xml");
    expect(strings).toContain("a &lt; b &amp; c &gt; d _x000B_ tab\there _x005F_x0041_ 😀");
  });

  it("[unit] caps a note at Excel's cell limit rather than writing a cell it refuses", () => {
    const strings = part(
      renderJournalWorkbook(journal({ entries: [entry({ notes: "n".repeat(40_000) })] })),
      "xl/sharedStrings.xml",
    );
    const longest = Math.max(
      ...[...strings.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/gu)].map((match) => match[1]!.length),
    );
    expect(longest).toBe(32_767);
  });

  it("[money] summarises per project with SUMs over entries and hours", () => {
    const archive = renderJournalWorkbook(
      journal({
        detail: "summary",
        entries: [
          entry({ projectName: "Zephyr", seconds: 3_600 }),
          entry({ projectName: "Alpha", seconds: 1_800 }),
          entry({ projectName: "Zephyr", seconds: 5_400 }),
        ],
      }),
    );
    expect(part(archive, "xl/workbook.xml")).toContain('name="Work summary"');
    expect(["A6", "B6", "C6"].map((at) => cellAt(archive, at))).toEqual(["Project", "Entries", "Hours"]);
    expect(["A7", "B7", "C7"].map((at) => cellAt(archive, at))).toEqual(["Zephyr", 2, 2.5]);
    expect(["A8", "B8", "C8"].map((at) => cellAt(archive, at))).toEqual(["Alpha", 1, 0.5]);
    const sheet = part(archive, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<f>SUM(B7:B8)</f><v>3</v>");
    expect(sheet).toContain("<f>SUM(C7:C8)</f><v>3</v>");
  });

  it("[unit] renders an empty journal with a zero total and no formula over nothing", () => {
    const sheet = part(renderJournalWorkbook(journal({ entries: [] })), "xl/worksheets/sheet1.xml");
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('<c r="G7" s="6"><v>0</v></c>');
  });

  it("[unit] adds a role column only where somebody holds a role, the total moving with it", () => {
    const archive = renderJournalWorkbook(journal({ entries: [entry({ roles: ["Engineer", "QA"] })] }));
    expect(cellAt(archive, "E6")).toBe("Role");
    expect(cellAt(archive, "E7")).toBe("Engineer, QA");
    expect(part(archive, "xl/worksheets/sheet1.xml")).toContain("<f>SUM(H7:H7)</f>");
  });

  it("[unit] omits the period row when the journal has no period", () => {
    const archive = renderJournalWorkbook(journal({ periodStart: null, periodEnd: null }));
    expect(cellAt(archive, "A4")).toBeNull();
    expect(cellAt(archive, "A6")).toBe("Date");
  });
});
