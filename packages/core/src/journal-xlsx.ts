import {
  journalHasRoles,
  journalProjectLabel,
  summariseJournal,
  type JournalDocumentInput,
} from "./journal-document.js";
import { zipStore } from "./zip.js";

/**
 * The work journal as an Excel workbook (issue 647): the same rows as the PDF,
 * in a file a client's accounts team can sort, filter and total.
 *
 * Written by hand as the smallest valid SpreadsheetML package -- content types,
 * relationships, a workbook, one worksheet, styles and a shared-strings table
 * -- for the reason `pdf.ts` gives for writing its PDF by hand.
 *
 * Hours are numbers, not text: each cell holds the exact hours its seconds
 * make, shown to two places. So every row reads as it does on the PDF, and the
 * Total -- a real SUM over the column, with its result cached for readers that
 * do not calculate -- is the total of the seconds, which is the PDF's total and
 * the invoice's. Rounding each cell first would make the column add up to a
 * figure a hundredth away from the invoice.
 */

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** The most characters Excel holds in one cell. The PDF and CSV carry the rest. */
const CELL_LIMIT = 32_767;

/** Rows above the table: title, invoice, client, period, and a blank. */
const HEADER_ROW = 6;

/** Indexes into `cellXfs` below. */
const STYLE = {
  title: 1,
  bold: 2,
  date: 3,
  wrapped: 4,
  hours: 5,
  totalHours: 6,
  totalLabel: 7,
  totalRule: 8,
  count: 9,
  totalCount: 10,
  figureHeading: 11,
  text: 12,
} as const;

type Cell =
  | { readonly kind: "text"; readonly value: string; readonly style: number }
  | { readonly kind: "number"; readonly value: number; readonly style: number }
  | {
      readonly kind: "formula";
      readonly formula: string;
      readonly value: number;
      readonly style: number;
    }
  | { readonly kind: "blank"; readonly style: number };

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const escapeAttribute = (text: string): string => escapeXml(text).replaceAll('"', "&quot;");

/**
 * Text as a cell stores it, losing nothing a reader could see.
 *
 * Line breaks become LF, the one a cell wraps on. A character XML 1.0 cannot
 * carry -- most C0 controls, U+FFFE, U+FFFF -- is written as the `_xHHHH_`
 * escape every SpreadsheetML reader decodes, and an underscore that would
 * itself start such an escape is escaped first, so text that already contains
 * one reads back exactly as it was written.
 */
const cellText = (text: string): string => {
  let value = text.replace(/\r\n?/gu, "\n");
  if (value.length > CELL_LIMIT) {
    let cut = CELL_LIMIT - 1;
    // Never split a surrogate pair, which would leave half a character.
    const last = value.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    value = `${value.slice(0, cut)}…`;
  }
  return value
    .replace(/_(?=x[0-9A-Fa-f]{4}_)/gu, "_x005F_")
    .replace(
      // Everything outside what XML 1.0 allows: tab, LF, U+0020-U+FFFD, and the
      // astral planes.
      /[^\t\n\x20-\uFFFD\u{10000}-\u{10FFFF}]/gu,
      (character) => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
    );
};

/** `A`, `B`, ... `Z`, `AA`: the column letters a cell reference uses. */
const columnName = (index: number): string => {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
};

const figure = (value: number): string => {
  if (!Number.isFinite(value)) throw new RangeError("a workbook figure must be finite");
  return String(value);
};

/**
 * A date as the serial Excel stores, days since 1899-12-30, so the column sorts
 * and filters as dates. `null` for anything not a calendar date, which is then
 * written as the text it is.
 */
const dateSerial = (value: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const instant = Date.UTC(year, month - 1, day);
  const parsed = new Date(instant);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    year < 1900
  ) {
    return null;
  }
  return (instant - Date.UTC(1899, 11, 30)) / 86_400_000;
};

interface Sheet {
  readonly name: string;
  readonly widths: readonly number[];
  readonly rows: readonly (readonly (Cell | null)[])[];
}

const text = (value: string, style: number = STYLE.text): Cell | null =>
  value === "" ? null : { kind: "text", value, style };

const hoursOf = (seconds: number): number => seconds / 3600;

/** Sums in order, as the SUM in the cell beside it will. */
const sumOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

const sheetFor = (input: JournalDocumentInput): Sheet => {
  const detailed = input.detail === "detailed";
  const title: (Cell | null)[][] = [
    [{ kind: "text", value: detailed ? "Work detail" : "Work summary", style: STYLE.title }],
    [text("Invoice", STYLE.bold), text(input.invoiceNumber, 0)],
    [text("Client", STYLE.bold), text(input.clientName, 0)],
    input.periodStart !== null && input.periodEnd !== null
      ? [text("Period", STYLE.bold), text(`${input.periodStart} to ${input.periodEnd}`, 0)]
      : [],
    [],
  ];
  const firstData = HEADER_ROW + 1;

  if (detailed) {
    const roles = journalHasRoles(input.entries);
    const values = input.entries.map((entry) => hoursOf(entry.seconds));
    const lastData = HEADER_ROW + input.entries.length;
    const headers = ["Date", "Client", "Project", "Task", ...(roles ? ["Role"] : []), "Person", "Notes"];
    const hoursColumn = columnName(headers.length);
    const rows: (Cell | null)[][] = [
      ...title,
      [...headers.map((header) => text(header, STYLE.bold)), text("Hours", STYLE.figureHeading)],
      ...input.entries.map((entry, index): (Cell | null)[] => {
        const serial = dateSerial(entry.spentDate);
        return [
          serial === null ? text(entry.spentDate) : { kind: "number", value: serial, style: STYLE.date },
          text(entry.clientName),
          text(journalProjectLabel(entry)),
          text(entry.taskName ?? ""),
          ...(roles ? [text(entry.roles.join(", "))] : []),
          text(entry.personName),
          text(entry.notes ?? "", STYLE.wrapped),
          { kind: "number", value: values[index]!, style: STYLE.hours },
        ];
      }),
      [
        { kind: "text", value: "Total", style: STYLE.totalLabel },
        ...headers.slice(1).map((): Cell => ({ kind: "blank", style: STYLE.totalRule })),
        input.entries.length === 0
          ? { kind: "number", value: 0, style: STYLE.totalHours }
          : {
              kind: "formula",
              formula: `SUM(${hoursColumn}${String(firstData)}:${hoursColumn}${String(lastData)})`,
              value: sumOf(values),
              style: STYLE.totalHours,
            },
      ],
    ];
    return {
      name: "Work detail",
      widths: [12, 22, 28, 18, ...(roles ? [16] : []), 20, 60, 10],
      rows,
    };
  }

  const groups = summariseJournal(input.entries);
  const values = groups.map((group) => hoursOf(group.seconds));
  const lastData = HEADER_ROW + groups.length;
  const rows: (Cell | null)[][] = [
    ...title,
    [text("Project", STYLE.bold), text("Entries", STYLE.figureHeading), text("Hours", STYLE.figureHeading)],
    ...groups.map((group, index): (Cell | null)[] => [
      text(group.projectName),
      { kind: "number", value: group.entries, style: STYLE.count },
      { kind: "number", value: values[index]!, style: STYLE.hours },
    ]),
    groups.length === 0
      ? [
          { kind: "text", value: "Total", style: STYLE.totalLabel },
          { kind: "number", value: 0, style: STYLE.totalCount },
          { kind: "number", value: 0, style: STYLE.totalHours },
        ]
      : [
          { kind: "text", value: "Total", style: STYLE.totalLabel },
          {
            kind: "formula",
            formula: `SUM(B${String(firstData)}:B${String(lastData)})`,
            value: sumOf(groups.map((group) => group.entries)),
            style: STYLE.totalCount,
          },
          {
            kind: "formula",
            formula: `SUM(C${String(firstData)}:C${String(lastData)})`,
            value: sumOf(values),
            style: STYLE.totalHours,
          },
        ],
  ];
  return { name: "Work summary", widths: [40, 10, 10], rows };
};

const worksheetXml = (sheet: Sheet, strings: Map<string, number>, uses: { count: number }): string => {
  const indexOf = (value: string): number => {
    uses.count += 1;
    const known = strings.get(value);
    if (known !== undefined) return known;
    strings.set(value, strings.size);
    return strings.size - 1;
  };
  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const reference = rowIndex + 1;
      const body = cells
        .map((cell, columnIndex) => {
          if (cell === null) return "";
          const at = `${columnName(columnIndex)}${String(reference)}`;
          const style = cell.style === 0 ? "" : ` s="${String(cell.style)}"`;
          switch (cell.kind) {
            case "blank":
              return `<c r="${at}"${style}/>`;
            case "text":
              return `<c r="${at}"${style} t="s"><v>${String(indexOf(cellText(cell.value)))}</v></c>`;
            case "number":
              return `<c r="${at}"${style}><v>${figure(cell.value)}</v></c>`;
            case "formula":
              return `<c r="${at}"${style}><f>${escapeXml(cell.formula)}</f><v>${figure(cell.value)}</v></c>`;
          }
        })
        .join("");
      return body === "" ? "" : `<row r="${String(reference)}">${body}</row>`;
    })
    .join("");
  const lastColumn = columnName(sheet.widths.length - 1);
  const columns = sheet.widths
    .map(
      (width, index) =>
        `<col min="${String(index + 1)}" max="${String(index + 1)}" width="${String(width)}" customWidth="1"/>`,
    )
    .join("");
  // Frozen under the table's header row, so the column names and the title
  // block above them stay in view however long the list runs.
  const firstBody = `A${String(HEADER_ROW + 1)}`;
  return (
    XML_DECLARATION +
    `<worksheet xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">` +
    `<dimension ref="A1:${lastColumn}${String(sheet.rows.length)}"/>` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="${String(HEADER_ROW)}" topLeftCell="${firstBody}" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="${firstBody}" sqref="${firstBody}"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${columns}</cols>` +
    `<sheetData>${rows}</sheetData>` +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`
  );
};

const sharedStringsXml = (strings: Map<string, number>, uses: number): string =>
  XML_DECLARATION +
  `<sst xmlns="${MAIN}" count="${String(uses)}" uniqueCount="${String(strings.size)}">` +
  [...strings.keys()].map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join("") +
  `</sst>`;

/**
 * Bold for the title block, the header row and the Total; `0.00` for hours,
 * `0` for counts and ISO dates for the date column; a rule over the Total row.
 * Data cells sit at the top of their row, so a long wrapped note does not push
 * the date and hours of its own row down to its foot.
 */
const STYLES =
  XML_DECLARATION +
  `<styleSheet xmlns="${MAIN}">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts>` +
  `<fonts count="3">` +
  `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>` +
  `</fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="2">` +
  `<border><left/><right/><top/><bottom/><diagonal/></border>` +
  `<border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border>` +
  `</borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="13">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>` +
  `<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>` +
  `<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>` +
  `<xf numFmtId="1" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right"/></xf>` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

const CONTENT_TYPES =
  XML_DECLARATION +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
  `</Types>`;

const PACKAGE_RELS =
  XML_DECLARATION +
  `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS =
  XML_DECLARATION +
  `<Relationships xmlns="${PACKAGE_RELATIONSHIPS}">` +
  `<Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/>` +
  `<Relationship Id="rId3" Type="${RELATIONSHIPS}/sharedStrings" Target="sharedStrings.xml"/>` +
  `</Relationships>`;

const workbookXml = (sheetName: string): string =>
  XML_DECLARATION +
  `<workbook xmlns="${MAIN}" xmlns:r="${RELATIONSHIPS}">` +
  `<bookViews><workbookView/></bookViews>` +
  `<sheets><sheet name="${escapeAttribute(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
  `</workbook>`;

export const renderJournalWorkbook = (input: JournalDocumentInput): Uint8Array => {
  const sheet = sheetFor(input);
  const strings = new Map<string, number>();
  const uses = { count: 0 };
  const worksheet = worksheetXml(sheet, strings, uses);
  const encoder = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(PACKAGE_RELS) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(sheet.name)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(WORKBOOK_RELS) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(worksheet) },
    { name: "xl/styles.xml", data: encoder.encode(STYLES) },
    { name: "xl/sharedStrings.xml", data: encoder.encode(sharedStringsXml(strings, uses.count)) },
  ]);
};
