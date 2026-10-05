import { describe, expect, it } from "vitest";
import { textWidth } from "../src/pdf.js";
import { markupLines, plainLines, runsWidth, wrapMarkup, wrapRuns, wrapText } from "../src/pdf-text.js";

/**
 * Harvest's `*bold*` and `_italic_`, as its own PDFs set them -- each case
 * below was read back from the fonts Harvest used on a real invoice -- and
 * lines broken by measured width.
 */

const styled = (text: string) =>
  markupLines(text).map((line) => line.map((run) => [run.font, run.text] as const));

describe("Harvest's markup", () => {
  it("[unit] sets the wire instructions CONFLICT sends on every invoice", () => {
    const notes =
      "Beneficiary:\n*CONFLICT LLC*\n100 Example Ave STE 200\nSpringfield, IL 62701\n\n*Account details*\n" +
      "Bank: Example Bank, N.A.\nAccount number: 000123456\nRouting number: 110000000\n\n" +
      "*_For wire transfers, please use routing number 011000015._*";
    expect(styled(notes)).toEqual([
      [["regular", "Beneficiary:"]],
      [["bold", "CONFLICT LLC"]],
      [["regular", "100 Example Ave STE 200"]],
      [["regular", "Springfield, IL 62701"]],
      [],
      [["bold", "Account details"]],
      [["regular", "Bank: Example Bank, N.A."]],
      [["regular", "Account number: 000123456"]],
      [["regular", "Routing number: 110000000"]],
      [],
      [["bold_italic", "For wire transfers, please use routing number 011000015."]],
    ]);
  });

  it("[unit] nests either way round, and spans a word or part of a line", () => {
    expect(styled("_*both*_ and *_both_*")).toEqual([
      [
        ["bold_italic", "both"],
        ["regular", " and "],
        ["bold_italic", "both"],
      ],
    ]);
    expect(styled("*CREDIT 1 of 4:* $6,250.00 (_monthly credit over first 4 months until $25K_)")).toEqual([
      [
        ["bold", "CREDIT 1 of 4:"],
        ["regular", " $6,250.00 ("],
        ["italic", "monthly credit over first 4 months until $25K"],
        ["regular", ")"],
      ],
    ]);
  });

  it("[unit] prints a mark with no partner instead of swallowing the text after it", () => {
    expect(styled("5 * 3 = 15")).toEqual([[["regular", "5 * 3 = 15"]]]);
    expect(styled("file_name and *open")).toEqual([[["regular", "file_name and *open"]]]);
  });

  it("[unit] leaves underscores inside words as typed, as Harvest did", () => {
    // From Harvest invoices 822, 814, 783 and 095, all set in the regular face.
    expect(styled("max_user_instances iNotify")).toEqual([[["regular", "max_user_instances iNotify"]]]);
    expect(styled("at _stream_readable.js:920:16")).toEqual([[["regular", "at _stream_readable.js:920:16"]]]);
    expect(styled("data_science-api and Mem_Buffer")).toEqual([[["regular", "data_science-api and Mem_Buffer"]]]);
  });

  it("[unit] reads doubled and tripled stars the way Harvest's invoices show them", () => {
    // Invoice 815: bold "* 20% ... reimbursement " and a plain "*".
    expect(styled("** 20% discount to match reserved instance cost reimbursement **")).toEqual([
      [
        ["bold", "* 20% discount to match reserved instance cost reimbursement "],
        ["regular", "*"],
      ],
    ]);
    // Invoice 869: a bold star either side of plain text.
    expect(styled("*** DISCOUNT 50 HOUR CAP FOR JULY ***")).toEqual([
      [
        ["bold", "*"],
        ["regular", " DISCOUNT 50 HOUR CAP FOR JULY "],
        ["bold", "*"],
      ],
    ]);
    // Invoice 892: an opening star followed by a space still opens.
    expect(styled("* DISCOUNT 75 HOUR CAP FOR FEB2021 - LEO MATA*")).toEqual([
      [["bold", "DISCOUNT 75 HOUR CAP FOR FEB2021 - LEO MATA"]],
    ]);
  });

  it("[unit] never carries a span over a line break, so star bullets stay bullets", () => {
    // Invoice 1103's list, every line starting "* ", set plain.
    expect(styled("services include:\n* Continuation of KWS deployment\n* Monitoring of the application")).toEqual([
      [["regular", "services include:"]],
      [["regular", "* Continuation of KWS deployment"]],
      [["regular", "* Monitoring of the application"]],
    ]);
  });

  it("[unit] collapses runs of spaces and trims each line, as Harvest's HTML did", () => {
    expect(styled("    at  _stream_readable.js  \r\n\tnext")).toEqual([
      [["regular", "at _stream_readable.js"]],
      [["regular", "next"]],
    ]);
  });

  it("[unit] sets plain text with no markup at all, for a time entry's note", () => {
    expect(plainLines("*not bold* stays\nas typed", "regular").map((line) => line.map((run) => run.text))).toEqual([
      ["*not bold* stays"],
      ["as typed"],
    ]);
  });
});

describe("breaking lines by width", () => {
  it("[unit] fills each line to the measure and never past it, measuring each run in its own font", () => {
    const lines = wrapMarkup("*Blended monthly team fee (team described in Section 2 of SOW):* and the rest of it", 8.25, 150);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(runsWidth(line, 8.25)).toBeLessThanOrEqual(150);
    expect(lines[0]![0]!.font).toBe("bold");
    // Nothing lost: the words read back in order.
    expect(lines.map((line) => line.map((run) => run.text).join("")).join(" ")).toBe(
      "Blended monthly team fee (team described in Section 2 of SOW): and the rest of it",
    );
  });

  it("[unit] cuts a URL after a hyphen or slash where it must break, keeping every character", () => {
    const url = "https://tickets.example.com/p/example-workspace/TICKET-IT-OTHER-REQUESTER-NAME-37250063e11781e4b8e5cc3943535c85";
    const lines = wrapText(url, "regular", 9, 360);
    expect(lines.join("")).toBe(url);
    expect(lines.length).toBe(2);
    expect(lines[0]!.endsWith("-")).toBe(true);
    for (const line of lines) expect(textWidth(line, "regular", 9)).toBeLessThanOrEqual(360);
  });

  it("[unit] keeps a blank line and the author's line breaks", () => {
    expect(wrapText("one\n\ntwo", "regular", 9, 400)).toEqual(["one", "", "two"]);
    expect(wrapRuns([], 9, 100)).toEqual([[]]);
  });
});
