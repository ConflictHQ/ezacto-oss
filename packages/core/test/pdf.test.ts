import { describe, expect, it } from "vitest";
import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  isPdfEncodable,
  monospacedWidth,
  renderPdf,
  textWidth,
  type PdfDocument,
  type PdfImage,
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

  it("[money] measures proportional text with Adobe's widths, so it right-aligns exactly", () => {
    // "$99,935.00 USD" in Helvetica at 10pt: $ 556, seven digits at 556, a
    // comma and a point at 278, a space at 278, then U 722, S 667, D 722.
    const figure = "$99,935.00 USD";
    const width = (556 + 7 * 556 + 278 + 278 + 278 + 722 + 667 + 722) / 100;
    expect(textWidth(figure, "regular", 10)).toBeCloseTo(width, 9);
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 570, y: 100, size: 10, font: "regular", text: figure, align: "right" }])),
    );
    expect(rendered).toContain(`${String(Number((570 - width).toFixed(3)))} 100 Td`);
  });

  it("[unit] measures bold wider than regular where Adobe's widths say so", () => {
    expect(textWidth("b", "bold", 1000)).toBe(611);
    expect(textWidth("b", "regular", 1000)).toBe(556);
    // The obliques share their upright widths; Courier is 600 throughout.
    expect(textWidth("b", "italic", 1000)).toBe(556);
    expect(textWidth("b", "bold_italic", 1000)).toBe(611);
    expect(textWidth("b", "mono", 1000)).toBe(600);
    expect(monospacedWidth("$1.00", 10)).toBe(textWidth("$1.00", "mono", 10));
  });

  it("[unit] measures a character it cannot encode as the question mark it draws", () => {
    expect(textWidth("日", "regular", 1000)).toBe(textWidth("?", "regular", 1000));
    expect(textWidth("—", "regular", 1000)).toBe(1000);
    expect(textWidth("•", "regular", 1000)).toBe(350);
  });

  it("[unit] centres text on its middle", () => {
    const label = "Page 1 of 2";
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 306, y: 30, size: 9, font: "regular", text: label, align: "center" }])),
    );
    const start = 306 - textWidth(label, "regular", 9) / 2;
    expect(rendered).toContain(`${String(Number(start.toFixed(3)))} 30 Td`);
  });

  it("[unit] declares all four Helvetica styles and both Couriers, under fixed names", () => {
    const rendered = text(
      renderPdf(page([{ kind: "text", x: 10, y: 10, size: 9, font: "bold_italic", text: "x" }])),
    );
    for (const name of ["Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"]) {
      expect(rendered).toContain(`/BaseFont /${name} /Encoding /WinAnsiEncoding`);
    }
    expect(rendered).toContain("/F6 9 Tf");
  });

  it("[unit] says whether text survives the encoding unchanged", () => {
    expect(isPdfEncodable("$1,000.00 — café • “ok”")).toBe(true);
    expect(isPdfEncodable("₹1,000.00")).toBe(false);
    expect(isPdfEncodable("what?")).toBe(true);
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

describe("pictures", () => {
  const picture = (overrides: Partial<PdfImage> = {}): PdfImage => ({
    width: 2,
    height: 1,
    colorSpace: "DeviceRGB",
    filter: "FlateDecode",
    data: new Uint8Array([0x78, 0x9c, 0x01, 0x02]),
    alpha: null,
    ...overrides,
  });

  it("[unit] stores a picture once as an image XObject and draws it where it is placed", () => {
    const image = picture();
    const rendered = text(
      renderPdf({
        pages: [
          { operations: [{ kind: "image", x: 39, y: 700, width: 220, height: 110, image }] },
          { operations: [{ kind: "image", x: 39, y: 700, width: 220, height: 110, image }] },
        ],
      }),
    );
    expect(rendered.split("/Subtype /Image").length - 1).toBe(1);
    expect(rendered).toContain("/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length 4 >>");
    expect(rendered).toContain("/XObject << /Im0 9 0 R >>");
    expect(rendered.split("q\n220 0 0 110 39 700 cm\n/Im0 Do\nQ").length - 1).toBe(2);
  });

  it("[unit] gives a picture with transparency a soft mask", () => {
    const rendered = text(
      renderPdf(page([{ kind: "image", x: 0, y: 0, width: 2, height: 1, image: picture({ alpha: new Uint8Array([1, 2, 3]) }) }])),
    );
    expect(rendered).toContain("/SMask 10 0 R /Length 4 >>");
    expect(rendered).toContain("/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length 3 >>");
  });

  it("[unit] keeps the cross-reference exact around binary picture data", () => {
    const binary = new Uint8Array(256).map((_, index) => index);
    const rendered = text(
      renderPdf(page([{ kind: "image", x: 0, y: 0, width: 16, height: 16, image: picture({ width: 16, height: 16, data: binary, filter: "DCTDecode" }) }])),
    );
    const startxref = Number(/startxref\n(\d+)/u.exec(rendered)![1]);
    expect(rendered.slice(startxref, startxref + 4)).toBe("xref");
    const entries = [...rendered.matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) => Number(match[1]));
    entries.forEach((offset, index) => {
      expect(rendered.slice(offset, offset + `${String(index + 1)} 0 obj`.length)).toBe(`${String(index + 1)} 0 obj`);
    });
    // Every byte of the picture survives, nothing re-encoded on the way out.
    const at = rendered.indexOf("stream\n", rendered.indexOf("/Filter /DCTDecode")) + "stream\n".length;
    expect(Array.from(rendered.slice(at, at + 256), (character) => character.charCodeAt(0))).toEqual(Array.from(binary));
  });

  it("[unit] refuses a picture with no pixels or drawn at no size", () => {
    expect(() => renderPdf(page([{ kind: "image", x: 0, y: 0, width: 1, height: 1, image: picture({ width: 0 }) }]))).toThrow(RangeError);
    expect(() => renderPdf(page([{ kind: "image", x: 0, y: 0, width: 0, height: 1, image: picture() }]))).toThrow(RangeError);
  });
});
