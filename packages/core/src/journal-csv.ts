import {
  journalDecimalHours,
  journalHasRoles,
  journalProjectLabel,
  summariseJournal,
  type JournalDocumentInput,
} from "./journal-document.js";

/**
 * The work journal as a CSV (issue 647), for a client who loads the hours into
 * something of their own rather than reading them.
 *
 * Machine-readable first, so there is no title block: one header row, the rows,
 * and a Total row, with the invoice it belongs to carried by the filename. The
 * columns are the PDF's, with the person a column rather than a band.
 * UTF-8 with a byte-order mark, because Excel reads a BOM-less file as the
 * system code page and turns every accented name into mojibake; CRLF and
 * RFC 4180 quoting, because that is what every importer agrees on.
 *
 * Hours are decimal to two places whatever the organization shows on screen,
 * rounded exactly as the PDF rounds them: each row on its own, the total from
 * the summed seconds. A total re-added from the rounded rows can differ from it
 * by a hundredth, and the total is the one that matches the invoice.
 */

/**
 * A text cell. One beginning with `=`, `+`, `-`, `@`, a tab or a carriage
 * return is read by a spreadsheet as a formula, and a note is text a client
 * did not write -- so it is prefixed with a single quote and stays text.
 */
const textCell = (value: string): string => {
  const guarded = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
};

/**
 * A figure this module computed. Never guarded: a correction's `-1.00` is a
 * number, and quoting it into text would break the column for the one reader
 * who sums it.
 */
const numberCell = (value: string): string => {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value)) throw new RangeError("a CSV figure must be a decimal number");
  return value;
};

export const renderJournalCsv = (input: JournalDocumentInput): Uint8Array => {
  const total = input.entries.reduce((sum, entry) => sum + entry.seconds, 0);
  const rows: string[][] = [];
  if (input.detail === "detailed") {
    // The PDF's columns, with the person as a column of its own rather than a
    // band, and the role column only where somebody holds a role.
    const roles = journalHasRoles(input.entries);
    const header = ["Date", "Client", "Project", "Task", ...(roles ? ["Role"] : []), "Person", "Notes", "Hours"];
    rows.push(header.map(textCell));
    for (const entry of input.entries) {
      rows.push([
        textCell(entry.spentDate),
        textCell(entry.clientName),
        textCell(journalProjectLabel(entry)),
        textCell(entry.taskName ?? ""),
        ...(roles ? [textCell(entry.roles.join(", "))] : []),
        textCell(entry.personName),
        textCell(entry.notes ?? ""),
        numberCell(journalDecimalHours(entry.seconds)),
      ]);
    }
    rows.push([
      textCell("Total"),
      ...header.slice(1, -1).map(() => ""),
      numberCell(journalDecimalHours(total)),
    ]);
  } else {
    rows.push(["Project", "Entries", "Hours"].map(textCell));
    for (const group of summariseJournal(input.entries)) {
      rows.push([
        textCell(group.projectName),
        numberCell(String(group.entries)),
        numberCell(journalDecimalHours(group.seconds)),
      ]);
    }
    rows.push([
      textCell("Total"),
      numberCell(String(input.entries.length)),
      numberCell(journalDecimalHours(total)),
    ]);
  }
  return new TextEncoder().encode(`\uFEFF${rows.map((row) => row.join(",")).join("\r\n")}\r\n`);
};
