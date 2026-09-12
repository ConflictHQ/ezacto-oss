import { describe, expect, it } from "vitest";
import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  monospacedWidth,
  renderPdf,
  type PdfDocument,
} from "../src/pdf.js";

const text = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

const page = (operations: PdfDocument["pages"][number]["operations"]) => ({
  pages: [{ operations }],
});

describe("the document it emits", () => {
  it("[unit] is a PDF a reader will open", () => {
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 40, y: 700, size: 12, font: "regular", text: "Invoice 1315" }])),
    );
    expect(rendered.startsWith("%PDF-1.4\n")).toBe(true);
    expect(rendered.endsWith("%%EOF\n")).toBe(true);
    expect(rendered).toContain("/Type /Catalog");
    expect(rendered).toContain(`/MediaBox [0 0 ${String(PDF_PAGE_WIDTH)} ${String(PDF_PAGE_HEIGHT)}]`);
    expect(rendered).toContain("(Invoice 1315) Tj");
  });

  it("[unit] points the cross-reference table at where each object really starts", () => {
    // A wrong offset here is the difference between a file that opens in one
    // reader and fails in another, and nothing about the bytes looks wrong.
    const rendered = text(renderPdf(page([{ kind: "text", x: 10, y: 10, size: 9, font: "mono", text: "x" }])));
    const startxref = Number(/startxref\n(\d+)/u.exec(rendered)![1]);
    expect(rendered.slice(startxref, startxref + 4)).toBe("xref");

    const entries = [...rendered.matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) => Number(match[1]));
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((offset, index) => {
      expect(rendered.slice(offset, offset + `${String(index + 1)} 0 obj`.length)).toBe(
        `${String(index + 1)} 0 obj`,
      );
    });
  });

  it("[unit] declares a stream length that matches the stream", () => {
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 40, y: 700, size: 12, font: "bold", text: "Total" }])),
    );
    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/u.exec(rendered)!;
    expect(match[2]!.length).toBe(Number(match[1]));
  });

  it("[unit] renders the same bytes for the same document", () => {
    // A stored attachment is only evidence of what was sent if re-rendering the
    // same invoice produces the same file.
    const document = page([
      { kind: "rect", x: 0, y: 0, width: 10, height: 10, grey: 0.9 },
      { kind: "text", x: 5, y: 5, size: 8, font: "mono", text: "$1,234.56", align: "right" },
    ]);
    expect(renderPdf(document)).toEqual(renderPdf(document));
  });
});

describe("what it puts on the page", () => {
  it("[money] right-aligns a figure by its exact monospaced width", () => {
    // Courier is 600/1000 em, so the width is arithmetic rather than a guess.
    const size = 10;
    const figure = "$19,389.80";
    expect(monospacedWidth(figure, size)).toBe(figure.length * size * 0.6);

    const rendered = text(
      renderPdf(page([{ kind: "text", x: 500, y: 100, size, font: "mono", text: figure, align: "right" }])),
    );
    expect(rendered).toContain(`${String(500 - figure.length * size * 0.6)} 100 Td`);
  });

  it("[money] refuses to right-align a proportional font rather than misalign it", () => {
    // Helvetica widths would need a glyph table this module does not carry, and
    // a guessed width puts a money column subtly out of line.
    expect(() =>
      renderPdf(page([{ kind: "text", x: 500, y: 100, size: 10, font: "regular", text: "x", align: "right" }])),
    ).toThrow(/monospaced/u);
  });

  it("[unit] escapes the characters that would end a string early", () => {
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 10, y: 10, size: 9, font: "regular", text: "Phase 1 (a) \\ b) c" }])),
    );
    expect(rendered).toContain("(Phase 1 \\(a\\) \\\\ b\\) c) Tj");
  });

  it("[unit] carries the em dash real line descriptions contain", () => {
    // "Forecasting — Lodging" is the shape the imported data actually has, and
    // a dash rendered as `?` in a client's invoice reads as a defect.
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 10, y: 10, size: 9, font: "regular", text: "Forecasting — Lodging" }])),
    );
    expect(rendered).toContain(`(Forecasting ${String.fromCharCode(0x97)} Lodging) Tj`);
    expect(rendered).toContain("/Encoding /WinAnsiEncoding");
  });

  it("[unit] substitutes a character the encoding cannot carry rather than failing to send", () => {
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 10, y: 10, size: 9, font: "regular", text: "ok 日本 ok" }])),
    );
    expect(rendered).toContain("(ok ?? ok) Tj");
  });

  it("[unit] gives every page its own content stream", () => {
    const rendered = text(
      renderPdf({
        pages: [
          { operations: [{ kind: "text", x: 10, y: 10, size: 9, font: "regular", text: "one" }] },
          { operations: [{ kind: "text", x: 10, y: 10, size: 9, font: "regular", text: "two" }] },
        ],
      }),
    );
    expect(rendered).toContain("/Count 2");
    expect(rendered).toContain("(one) Tj");
    expect(rendered).toContain("(two) Tj");
  });

  it("[unit] refuses a document with no pages and a font size of zero", () => {
    expect(() => renderPdf({ pages: [] })).toThrow(/at least one page/u);
    expect(() =>
      renderPdf(page([{ kind: "text", x: 0, y: 0, size: 0, font: "regular", text: "x" }])),
    ).toThrow(/positive/u);
  });
});
