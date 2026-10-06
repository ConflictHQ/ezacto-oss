import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  capHeight,
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

  it("[unit] writes what it drew before watermarks existed to the same bytes", () => {
    // Recorded from the writer before the watermark was added. Invoices already
    // stored are compared with a re-render, so a new kind of operation must not
    // move a byte of the ones already in use: every kind, alignment, font and
    // optional field is here, over two pages, with a title and a page size.
    const logo: PdfImage = {
      width: 2,
      height: 1,
      colorSpace: "DeviceRGB",
      filter: "FlateDecode",
      data: new Uint8Array([0x78, 0x9c, 0x01, 0x02]),
      alpha: null,
    };
    const masked: PdfImage = { ...logo, colorSpace: "DeviceGray", alpha: new Uint8Array([1, 2, 3]) };
    const document: PdfDocument = {
      width: 595.28,
      height: 841.89,
      title: "  Invoice 1315 (draft)  ",
      pages: [
        {
          operations: [
            { kind: "rect", x: 39, y: 600.25, width: 534, height: 17.125, grey: 0.95 },
            { kind: "line", x1: 39, y1: 600, x2: 573, y2: 600 },
            { kind: "line", x1: 101.5, y1: 700, x2: 101.5, y2: 650.3333, width: 0.6, grey: 0.82 },
            { kind: "image", x: 39, y: 643, width: 220, height: 110, image: logo },
            { kind: "text", x: 39, y: 760.5, size: 15, font: "bold", text: "INVOICE" },
            { kind: "text", x: 415.3, y: 709.3, size: 8.25, font: "regular", text: "From", align: "right", grey: 0.38 },
            { kind: "text", x: 40, y: 500, size: 8.25, font: "italic", text: "Phase 1 (a) \\ b) — café • “ok” 日本", align: "left" },
            { kind: "text", x: 40, y: 480, size: 8.25, font: "bold_italic", text: "€1,000.00 EUR" },
            { kind: "text", x: 570, y: 460, size: 10, font: "mono", text: "$19,389.80", align: "right" },
            { kind: "text", x: 570, y: 440, size: 10, font: "mono_bold", text: "-$6,250.00", align: "right", grey: 0 },
            { kind: "text", x: 297.64, y: 33.4, size: 9.4, font: "regular", text: "Page 1 of 2", align: "center", grey: 0.11 },
          ],
        },
        {
          operations: [
            { kind: "image", x: 39, y: 643, width: 220, height: 110, image: logo },
            { kind: "image", x: 300, y: 643, width: 2, height: 1, image: masked },
            { kind: "text", x: 297.64, y: 33.4, size: 9.4, font: "regular", text: "Page 2 of 2", align: "center", grey: 0.11 },
          ],
        },
      ],
    };
    const rendered = renderPdf(document);
    expect(text(rendered)).not.toContain("/ExtGState");
    expect(createHash("sha256").update(rendered).digest("hex")).toBe(
      "12881111d85923cb5d469bd2ab53a8d777df2fedd3b8222b35ba75234d7f29a5",
    );
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

  it("[unit] stands a capital as tall as Adobe's metrics say", () => {
    // CapHeight from the same AFM files: every Helvetica style 718, Courier 562.
    expect(capHeight("bold", 1000)).toBe(718);
    expect(capHeight("italic", 100)).toBe(71.8);
    expect(capHeight("mono_bold", 1000)).toBe(562);
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

describe("watermarks", () => {
  const stamp = {
    kind: "watermark",
    text: "PREVIEW",
    font: "bold",
    size: 120,
    angle: 45,
    opacity: 0.15,
    rgb: [0.75, 0.1, 0.1],
  } as const;
  const state = " /ExtGState << /GS0 << /Type /ExtGState /ca 0.15 >> >>";

  /** Each page's dictionary and its content stream, in page order. */
  const pagesOf = (document: PdfDocument): { dictionaries: string[]; streams: string[] } => {
    const rendered = text(renderPdf(document));
    return {
      dictionaries: rendered.split("\n").filter((line) => line.startsWith("<< /Type /Page /Parent")),
      streams: [...rendered.matchAll(/<< \/Length \d+ >>\nstream\n([\s\S]*?)\nendstream/gu)].map((match) => match[1]!),
    };
  };

  it("[unit] sets its text across the middle of the page, turned, in its colour and at its opacity", () => {
    const { dictionaries, streams } = pagesOf(page([stamp]));
    expect(dictionaries[0]).toContain(state);
    const drawn = /^q\n\/GS0 gs\nBT\n0\.75 0\.1 0\.1 rg\n\/F2 120 Tf\n(\S+) (\S+) (\S+) (\S+) (\S+) (\S+) Tm\n\(PREVIEW\) Tj\nET\nQ$/u.exec(
      streams[0]!,
    );
    if (drawn === null) throw new Error(`not a watermark: ${streams[0]!}`);
    const [a, b, c, d, e, f] = drawn.slice(1).map(Number) as [number, number, number, number, number, number];
    // Turned 45 degrees anticlockwise, without being stretched or slanted...
    expect((Math.atan2(b, a) * 180) / Math.PI).toBeCloseTo(45, 6);
    expect([c, d]).toEqual([-b, a]);
    // ...about the middle of its capitals, which lands on the middle of the page.
    const across = textWidth("PREVIEW", "bold", 120) / 2;
    const up = capHeight("bold", 120) / 2;
    expect(e + a * across + c * up).toBeCloseTo(PDF_PAGE_WIDTH / 2, 1);
    expect(f + b * across + d * up).toBeCloseTo(PDF_PAGE_HEIGHT / 2, 1);
  });

  it("[unit] centres on the page it is drawn on, whatever its size", () => {
    // Unturned, the text starts half its width left of the middle of a 400 by
    // 300 page, its baseline half a capital's height below it.
    const { streams } = pagesOf({ width: 400, height: 300, pages: [{ operations: [{ ...stamp, angle: 0, size: 40 }] }] });
    const x = 200 - textWidth("PREVIEW", "bold", 40) / 2;
    const y = 150 - capHeight("bold", 40) / 2;
    expect(streams[0]).toContain(`1 0 0 1 ${String(Number(x.toFixed(3)))} ${String(Number(y.toFixed(3)))} Tm`);
  });

  it("[unit] gives the opacity state only to a page that draws at it, and changes nothing else on the page", () => {
    const words = { kind: "text", x: 40, y: 700, size: 12, font: "regular", text: "Invoice 1315" } as const;
    const { dictionaries, streams } = pagesOf({ pages: [{ operations: [words, stamp] }, { operations: [words] }] });
    expect(dictionaries[0]).toContain(state);
    expect(dictionaries[1]).not.toContain("/ExtGState");
    expect(streams[1]).not.toMatch(/ gs$/mu);
    // The state is the only difference between the two pages' resources.
    const resources = (dictionary: string): string => /\/Resources (.*) \/Contents/u.exec(dictionary)![1]!;
    expect(resources(dictionaries[0]!).replace(state, "")).toBe(resources(dictionaries[1]!));
  });

  it("[unit] keeps its opacity and colour to itself, between the operations around it, which it leaves as they were", () => {
    const before = { kind: "text", x: 40, y: 700, size: 12, font: "regular", text: "Total" } as const;
    const after = { kind: "rect", x: 39, y: 600, width: 534, height: 17, grey: 0.95 } as const;
    const [alone] = pagesOf(page([stamp])).streams;
    const [first] = pagesOf(page([before])).streams;
    const [last] = pagesOf(page([after])).streams;
    // Saved before it and restored after it, so what follows is drawn solid
    // and in its own colour, byte for byte as it would be without it.
    expect(alone!.startsWith("q\n")).toBe(true);
    expect(alone!.endsWith("\nQ")).toBe(true);
    expect(pagesOf(page([before, stamp, after])).streams[0]).toBe(`${first!}\n${alone!}\n${last!}`);
  });

  it("[unit] gives each opacity on a page one state, shared by everything drawn at it", () => {
    const { dictionaries, streams } = pagesOf(page([stamp, { ...stamp, opacity: 0.3 }, { ...stamp, text: "DRAFT" }]));
    expect(dictionaries[0]).toContain(
      "/ExtGState << /GS0 << /Type /ExtGState /ca 0.15 >> /GS1 << /Type /ExtGState /ca 0.3 >> >>",
    );
    expect(streams[0]!.match(/^\/GS\d gs$/gmu)).toEqual(["/GS0 gs", "/GS1 gs", "/GS0 gs"]);
  });

  it("[unit] refuses a watermark it cannot draw", () => {
    expect(() => renderPdf(page([{ ...stamp, opacity: 1.5 }]))).toThrow(/opacity/u);
    expect(() => renderPdf(page([{ ...stamp, opacity: -0.1 }]))).toThrow(/opacity/u);
    expect(() => renderPdf(page([{ ...stamp, opacity: Number.NaN }]))).toThrow(/opacity/u);
    expect(() => renderPdf(page([{ ...stamp, rgb: [0, 1.2, 0] }]))).toThrow(/colour/u);
    expect(() => renderPdf(page([{ ...stamp, size: 0 }]))).toThrow(/positive/u);
    expect(() => renderPdf(page([{ ...stamp, angle: Number.POSITIVE_INFINITY }]))).toThrow(/finite/u);
  });
});
