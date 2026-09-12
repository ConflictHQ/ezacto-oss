/**
 * A very small PDF writer (issue 626).
 *
 * An invoice has to arrive as a document, and there is no headless browser on a
 * Worker to print one with. A PDF library would be the obvious answer and is
 * the wrong one here: `@ezacto/core` carries a single dependency today and this
 * bundle is shipped to an edge runtime, so a megabyte of general-purpose
 * typesetting to draw forty lines of text is a poor trade.
 *
 * What this does instead is emit the PDF by hand, which is tractable because an
 * invoice needs very little of the format: text, rules, and a filled band. The
 * two simplifications that make it small are deliberate.
 *
 * The first is fonts. The base fourteen are guaranteed present in every
 * conforming reader, so nothing is embedded and there is no font program to
 * subset -- `Helvetica` for prose and `Courier` for figures.
 *
 * The second follows from the first. Right-aligning a column needs the width of
 * the string being drawn, which for a proportional face means carrying a table
 * of per-glyph widths. Courier is monospaced at exactly 600/1000 em, so every
 * figure's width is its length times the size times 0.6 -- exact integer
 * arithmetic, no table. Money is set in Courier for that reason as much as for
 * how it reads, and it is the same choice the invoice screen already makes with
 * `--ez-font-mono`.
 *
 * Output is deterministic: the same input renders byte-for-byte the same file,
 * which is what lets a stored attachment be compared with a re-render.
 */

export type PdfFont = "regular" | "bold" | "mono" | "mono_bold";

export type PdfOperation =
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly font: PdfFont;
      readonly text: string;
      /** Right-aligned text must be monospaced, so its width is known exactly. */
      readonly align?: "left" | "right";
      readonly grey?: number;
    }
  | {
      readonly kind: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly width?: number;
      readonly grey?: number;
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly grey: number;
    };

export interface PdfPage {
  readonly operations: readonly PdfOperation[];
}

export interface PdfDocument {
  readonly pages: readonly PdfPage[];
  /** US Letter unless a caller says otherwise. Points, 72 to the inch. */
  readonly width?: number;
  readonly height?: number;
  readonly title?: string;
}

/** US Letter, in points. */
export const PDF_PAGE_WIDTH = 612;
export const PDF_PAGE_HEIGHT = 792;

const fontResource: Readonly<Record<PdfFont, string>> = {
  regular: "F1",
  bold: "F2",
  mono: "F3",
  mono_bold: "F4",
};

const fontBaseName: Readonly<Record<PdfFont, string>> = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  mono: "Courier",
  mono_bold: "Courier-Bold",
};

/** Every Courier glyph is this fraction of an em. The whole reason money is mono. */
const courierAdvance = 0.6;

export const isMonospaced = (font: PdfFont): boolean =>
  font === "mono" || font === "mono_bold";

/**
 * The width of a monospaced string, exactly.
 *
 * Exported because a caller laying out a column needs to know where the column
 * starts, and deriving that from the same arithmetic the renderer uses is what
 * keeps the two from disagreeing.
 */
export const monospacedWidth = (text: string, size: number): number =>
  [...text].length * size * courierAdvance;

/**
 * A handful of characters that appear in real invoice data and are not ASCII.
 *
 * WinAnsiEncoding is a superset of Latin-1 with printable characters in the
 * 0x80-0x9f range, which is where the dashes and quotes live. Line descriptions
 * arrive with em dashes in them -- "Forecasting — Lodging" -- so the mapping is
 * not hypothetical, and a dash rendered as `?` in a document sent to a client
 * looks like a defect.
 */
const winAnsiOverrides: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], // euro
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85], // ellipsis
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91], // curly quotes
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95], // bullet
  [0x2013, 0x96], // en dash
  [0x2014, 0x97], // em dash
  [0x02dc, 0x98],
  [0x2122, 0x99], // trademark
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/**
 * A character the encoding cannot carry becomes a question mark rather than
 * throwing. A document that is sent with one glyph wrong is better than an
 * invoice that fails to send, and the alternative -- dropping it silently --
 * changes what the line says without saying so.
 */
const winAnsiByte = (codePoint: number): number => {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint;
  return winAnsiOverrides.get(codePoint) ?? 0x3f;
};

/** PDF string literals escape the delimiters and the escape character itself. */
const pdfString = (text: string): string => {
  let out = "(";
  for (const character of text) {
    const byte = winAnsiByte(character.codePointAt(0)!);
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
};

/** Trailing zeroes make the output noisier to diff and no more accurate. */
const number = (value: number): string => {
  if (!Number.isFinite(value)) throw new RangeError("a PDF coordinate must be finite");
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
};

const grey = (value: number | undefined): number => {
  const level = value ?? 0;
  if (!(level >= 0 && level <= 1)) throw new RangeError("a PDF grey level must be between 0 and 1");
  return level;
};

const contentStream = (page: PdfPage): string => {
  const parts: string[] = [];
  for (const operation of page.operations) {
    if (operation.kind === "rect") {
      parts.push(
        `${number(grey(operation.grey))} g`,
        `${number(operation.x)} ${number(operation.y)} ${number(operation.width)} ${number(operation.height)} re f`,
      );
      continue;
    }
    if (operation.kind === "line") {
      parts.push(
        `${number(grey(operation.grey))} G`,
        `${number(operation.width ?? 1)} w`,
        `${number(operation.x1)} ${number(operation.y1)} m ${number(operation.x2)} ${number(operation.y2)} l S`,
      );
      continue;
    }
    if (operation.size <= 0) throw new RangeError("a PDF font size must be positive");
    if (operation.align === "right" && !isMonospaced(operation.font)) {
      // Proportional widths would need a glyph table this module deliberately
      // does not carry, and guessing the width would misalign a money column.
      throw new RangeError("right-aligned PDF text must use a monospaced font");
    }
    const x =
      operation.align === "right"
        ? operation.x - monospacedWidth(operation.text, operation.size)
        : operation.x;
    parts.push(
      "BT",
      `${number(grey(operation.grey))} g`,
      `/${fontResource[operation.font]} ${number(operation.size)} Tf`,
      `${number(x)} ${number(operation.y)} Td`,
      `${pdfString(operation.text)} Tj`,
      "ET",
    );
  }
  return parts.join("\n");
};

/** Latin-1 out, because every byte this module emits is already below 256. */
const latin1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
};

/**
 * Renders the document.
 *
 * The cross-reference table records a byte offset for every object, so the
 * body is assembled first and measured as it goes rather than formatted twice.
 */
export const renderPdf = (document: PdfDocument): Uint8Array => {
  if (document.pages.length === 0) throw new RangeError("a PDF needs at least one page");
  const width = document.width ?? PDF_PAGE_WIDTH;
  const height = document.height ?? PDF_PAGE_HEIGHT;

  const fonts = Object.keys(fontResource) as PdfFont[];
  const pageCount = document.pages.length;
  // 1 catalog, 1 page tree, 4 fonts, then a page and a stream for each page.
  const firstFontId = 3;
  const firstPageId = firstFontId + fonts.length;
  const pageId = (index: number): number => firstPageId + index * 2;
  const streamId = (index: number): number => pageId(index) + 1;

  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${String(pageCount)} /Kids [` +
    document.pages.map((_, index) => `${String(pageId(index))} 0 R`).join(" ") +
    "] >>";
  fonts.forEach((font, index) => {
    objects[firstFontId + index] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${fontBaseName[font]} /Encoding /WinAnsiEncoding >>`;
  });
  const resources =
    "<< /Font << " +
    fonts
      .map((font, index) => `/${fontResource[font]} ${String(firstFontId + index)} 0 R`)
      .join(" ") +
    " >> >>";
  document.pages.forEach((page, index) => {
    objects[pageId(index)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] ` +
      `/Resources ${resources} /Contents ${String(streamId(index))} 0 R >>`;
    const stream = contentStream(page);
    objects[streamId(index)] =
      `<< /Length ${String(latin1(stream).byteLength)} >>\nstream\n${stream}\nendstream`;
  });

  const total = streamId(pageCount - 1);
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id <= total; id += 1) {
    offsets[id] = latin1(body).byteLength;
    body += `${String(id)} 0 obj\n${objects[id]!}\nendobj\n`;
  }

  const xrefOffset = latin1(body).byteLength;
  let xref = `xref\n0 ${String(total + 1)}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id += 1) {
    xref += `${String(offsets[id]!).padStart(10, "0")} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${String(total + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;

  return latin1(body + xref + trailer);
};
