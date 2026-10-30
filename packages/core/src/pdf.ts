/**
 * A very small PDF writer (issue 626).
 *
 * An invoice has to arrive as a document, and there is no headless browser on a
 * Worker to print one with. A PDF library would be the obvious answer and is
 * the wrong one here: `@ezacto/core` carries a single dependency today and this
 * bundle is shipped to an edge runtime, so a megabyte of general-purpose
 * typesetting to draw a few pages of text is a poor trade.
 *
 * What this does instead is emit the PDF by hand, which is tractable because an
 * invoice needs very little of the format: text, rules, filled bands, one
 * picture and, on a preview, a watermark. Two choices keep it small.
 *
 * The first is fonts. The standard fourteen are guaranteed present in every
 * conforming reader, so nothing is embedded and there is no font program to
 * subset: Helvetica in its four styles for prose, Courier for anything that
 * must line up by character.
 *
 * The second is measurement. Setting proportional type -- breaking a line before
 * the margin, ending a figure exactly at its column -- needs the width of every
 * glyph drawn. Adobe publishes those widths for the standard fonts, and the
 * WinAnsi range of them is the two tables below. Measuring the byte that is
 * actually drawn, after encoding, is what makes the arithmetic exact: a
 * character the encoding cannot carry is measured as the `?` that replaces it.
 *
 * Output is deterministic: the same input renders byte-for-byte the same file,
 * which is what lets a stored attachment be compared with a re-render.
 */

export type PdfFont = "regular" | "bold" | "italic" | "bold_italic" | "mono" | "mono_bold";

/**
 * A picture ready to place: eight bits a sample, already encoded. Built by
 * `pdf-image.ts` from a PNG or a JPEG, so this module never decodes anything.
 */
export interface PdfImage {
  /** In pixels. */
  readonly width: number;
  readonly height: number;
  readonly colorSpace: "DeviceRGB" | "DeviceGray";
  readonly filter: "FlateDecode" | "DCTDecode";
  readonly data: Uint8Array;
  /** Eight-bit coverage, Flate-encoded, for a picture with transparency. */
  readonly alpha: Uint8Array | null;
}

export type PdfOperation =
  | {
      readonly kind: "text";
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly font: PdfFont;
      readonly text: string;
      /** Where `x` is: the start of the text, its end, or its middle. */
      readonly align?: "left" | "right" | "center";
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
      /** Red, green and blue, each 0 to 1; takes the place of `grey`. */
      readonly rgb?: readonly [number, number, number];
    }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly grey: number;
    }
  | {
      readonly kind: "image";
      /** The lower-left corner and the size it is drawn at, in points. */
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly image: PdfImage;
    }
  | {
      /**
       * Text across the middle of the page, turned and see-through, over
       * whatever is drawn before it: what marks a copy that is not the one
       * sent. The middle of its capitals is the middle of the page, whatever
       * the page's size.
       */
      readonly kind: "watermark";
      readonly text: string;
      readonly font: PdfFont;
      readonly size: number;
      /** Degrees anticlockwise from level: 45 runs it up from the lower left. */
      readonly angle: number;
      /** How much of the fill shows, 0 to 1: low, so what is under it still reads. */
      readonly opacity: number;
      /** Red, green and blue, each 0 to 1. */
      readonly rgb: readonly [number, number, number];
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

/** In object order. F1 to F4 kept the names they had before the styles arrived. */
const fonts: readonly PdfFont[] = ["regular", "bold", "mono", "mono_bold", "italic", "bold_italic"];

const fontBaseName: Readonly<Record<PdfFont, string>> = {
  regular: "Helvetica",
  bold: "Helvetica-Bold",
  mono: "Courier",
  mono_bold: "Courier-Bold",
  italic: "Helvetica-Oblique",
  bold_italic: "Helvetica-BoldOblique",
};

const fontResource = (font: PdfFont): string => `F${String(fonts.indexOf(font) + 1)}`;

/**
 * Advance widths in thousandths of an em for WinAnsi bytes 0x20 to 0xFF, from
 * Adobe's Core 14 AFM files (Copyright 1985-1997 Adobe Systems Incorporated;
 * Helvetica is a trademark of Linotype-Hell AG). The oblique styles share their
 * upright widths, as the AFM files do. Codes WinAnsi leaves undefined are zero
 * and are never drawn: the encoder below never produces them.
 */
const HELVETICA: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const HELVETICA_BOLD: readonly number[] = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
  556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

/** Every Courier glyph is this fraction of an em. */
const courierAdvance = 0.6;

export const isMonospaced = (font: PdfFont): boolean =>
  font === "mono" || font === "mono_bold";

/**
 * The width of a monospaced string, exactly. Kept beside `textWidth` because a
 * figure column laid out in Courier is measured by arithmetic alone.
 */
export const monospacedWidth = (text: string, size: number): number =>
  [...text].length * size * courierAdvance;

/**
 * A handful of characters that appear in real invoice data and are not ASCII.
 *
 * WinAnsiEncoding is a superset of Latin-1 with printable characters in the
 * 0x80-0x9f range, which is where the dashes, quotes and bullet live. Line
 * descriptions arrive with all of them -- "Forecasting — Lodging", a list
 * of roles each starting with a bullet -- so the mapping is not hypothetical, and
 * a dash rendered as `?` in a document sent to a client looks like a defect.
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

/** Whether every character of `text` is drawn as itself rather than as `?`. */
export const isPdfEncodable = (text: string): boolean =>
  [...text].every((character) => character === "?" || winAnsiByte(character.codePointAt(0)!) !== 0x3f);

const advance = (font: PdfFont, byte: number): number => {
  if (isMonospaced(font)) return 600;
  const table = font === "bold" || font === "bold_italic" ? HELVETICA_BOLD : HELVETICA;
  return table[byte - 0x20]!;
};

/** How wide `text` is set in `font` at `size` points: exactly what is drawn. */
export const textWidth = (text: string, font: PdfFont, size: number): number => {
  let thousandths = 0;
  for (const character of text) thousandths += advance(font, winAnsiByte(character.codePointAt(0)!));
  return (thousandths * size) / 1000;
};

/**
 * How far a capital stands above the baseline in `font` at `size` points, from
 * the same AFM files: 718 thousandths of an em in every Helvetica, 562 in
 * Courier. It is what centres a line of capitals on a point, not its baseline.
 */
export const capHeight = (font: PdfFont, size: number): number =>
  ((isMonospaced(font) ? 562 : 718) * size) / 1000;

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

const channel = (value: number): number => {
  if (!(value >= 0 && value <= 1)) throw new RangeError("a PDF colour channel must be between 0 and 1");
  return value;
};

/** Checked and written as it appears in the page's graphics state. */
const opacity = (value: number): string => {
  if (!(value >= 0 && value <= 1)) throw new RangeError("a PDF opacity must be between 0 and 1");
  return number(value);
};

/**
 * The page's drawing. `opacities` are the fill opacities it draws at, in the
 * order the page names them as graphics states; the page's size is for what is
 * centred on it.
 */
const contentStream = (
  page: PdfPage,
  images: ReadonlyMap<PdfImage, number>,
  opacities: readonly string[],
  pageWidth: number,
  pageHeight: number,
): string => {
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
        operation.rgb === undefined
          ? `${number(grey(operation.grey))} G`
          : `${operation.rgb.map((value) => number(channel(value))).join(" ")} RG`,
        `${number(operation.width ?? 1)} w`,
        `${number(operation.x1)} ${number(operation.y1)} m ${number(operation.x2)} ${number(operation.y2)} l S`,
      );
      continue;
    }
    if (operation.kind === "image") {
      if (!(operation.width > 0 && operation.height > 0)) {
        throw new RangeError("a PDF image must be drawn at a positive size");
      }
      parts.push(
        "q",
        `${number(operation.width)} 0 0 ${number(operation.height)} ${number(operation.x)} ${number(operation.y)} cm`,
        `/Im${String(images.get(operation.image)!)} Do`,
        "Q",
      );
      continue;
    }
    if (operation.kind === "watermark") {
      if (operation.size <= 0) throw new RangeError("a PDF font size must be positive");
      const turn = (operation.angle * Math.PI) / 180;
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      // Back from the middle of the page along the baseline by half the text's
      // width, and down from it by half a capital's height, so the middle of
      // what is drawn is the middle of the page at any angle. Saved and
      // restored around it, so its opacity and colour end with it.
      const along = textWidth(operation.text, operation.font, operation.size) / 2;
      const up = capHeight(operation.font, operation.size) / 2;
      parts.push(
        "q",
        `/GS${String(opacities.indexOf(opacity(operation.opacity)))} gs`,
        "BT",
        `${operation.rgb.map((value) => number(channel(value))).join(" ")} rg`,
        `/${fontResource(operation.font)} ${number(operation.size)} Tf`,
        `${number(cos)} ${number(sin)} ${number(-sin)} ${number(cos)} ` +
          `${number(pageWidth / 2 - along * cos + up * sin)} ${number(pageHeight / 2 - along * sin - up * cos)} Tm`,
        `${pdfString(operation.text)} Tj`,
        "ET",
        "Q",
      );
      continue;
    }
    if (operation.size <= 0) throw new RangeError("a PDF font size must be positive");
    const width =
      operation.align === "right" || operation.align === "center"
        ? textWidth(operation.text, operation.font, operation.size)
        : 0;
    const x =
      operation.align === "right"
        ? operation.x - width
        : operation.align === "center"
          ? operation.x - width / 2
          : operation.x;
    parts.push(
      "BT",
      `${number(grey(operation.grey))} g`,
      `/${fontResource(operation.font)} ${number(operation.size)} Tf`,
      `${number(x)} ${number(operation.y)} Td`,
      `${pdfString(operation.text)} Tj`,
      "ET",
    );
  }
  return parts.join("\n");
};

/** Latin-1 out, because every byte of the syntax this module emits is below 256. */
const latin1 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
};

/** An object is either plain syntax or a dictionary heading a binary stream. */
type PdfObject = string | { readonly dictionary: string; readonly stream: Uint8Array };

const imageDictionary = (image: PdfImage, mask: number | null): string => {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1
  ) {
    throw new RangeError("a PDF image needs whole, positive pixel dimensions");
  }
  if (image.data.byteLength === 0) throw new RangeError("a PDF image needs its samples");
  return (
    `<< /Type /XObject /Subtype /Image /Width ${String(image.width)} /Height ${String(image.height)} ` +
    `/ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter}` +
    `${mask === null ? "" : ` /SMask ${String(mask)} 0 R`} /Length ${String(image.data.byteLength)} >>`
  );
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

  // Numbered in the order they are first drawn, so the output is deterministic
  // and a picture drawn on every page is stored once.
  const images: PdfImage[] = [];
  for (const page of document.pages) {
    for (const operation of page.operations) {
      if (operation.kind === "image" && !images.includes(operation.image)) images.push(operation.image);
    }
  }
  const imageIndex = new Map(images.map((image, index) => [image, index] as const));

  // 1 catalog, 2 page tree, the fonts, each picture and its mask, then a page
  // and a stream for each page.
  const firstFontId = 3;
  let next = firstFontId + fonts.length;
  const imageIds: number[] = [];
  const maskIds: (number | null)[] = [];
  for (const image of images) {
    imageIds.push(next);
    next += 1;
    maskIds.push(image.alpha === null ? null : next);
    if (image.alpha !== null) next += 1;
  }
  const firstPageId = next;
  const pageCount = document.pages.length;
  const pageId = (index: number): number => firstPageId + index * 2;
  const streamId = (index: number): number => pageId(index) + 1;

  const objects: PdfObject[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] =
    `<< /Type /Pages /Count ${String(pageCount)} /Kids [` +
    document.pages.map((_, index) => `${String(pageId(index))} 0 R`).join(" ") +
    "] >>";
  fonts.forEach((font, index) => {
    objects[firstFontId + index] =
      `<< /Type /Font /Subtype /Type1 /BaseFont /${fontBaseName[font]} /Encoding /WinAnsiEncoding >>`;
  });
  images.forEach((image, index) => {
    const mask = maskIds[index]!;
    objects[imageIds[index]!] = { dictionary: imageDictionary(image, mask), stream: image.data };
    if (mask !== null && image.alpha !== null) {
      if (image.alpha.byteLength === 0) throw new RangeError("a PDF image mask needs its samples");
      objects[mask] = {
        dictionary:
          `<< /Type /XObject /Subtype /Image /Width ${String(image.width)} /Height ${String(image.height)} ` +
          `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${String(image.alpha.byteLength)} >>`,
        stream: image.alpha,
      };
    }
  });
  const xobjects =
    images.length === 0
      ? ""
      : ` /XObject << ${images.map((_, index) => `/Im${String(index)} ${String(imageIds[index]!)} 0 R`).join(" ")} >>`;
  const resources = (states: string): string =>
    "<< /Font << " +
    fonts.map((font, index) => `/${fontResource(font)} ${String(firstFontId + index)} 0 R`).join(" ") +
    ` >>${xobjects}${states} >>`;
  document.pages.forEach((page, index) => {
    // Each opacity the page draws at is a graphics state it names, and only a
    // page that draws something see-through carries any: every other page is
    // written exactly as it was before there were watermarks.
    const opacities = [
      ...new Set(page.operations.flatMap((operation) => (operation.kind === "watermark" ? [opacity(operation.opacity)] : []))),
    ];
    const states =
      opacities.length === 0
        ? ""
        : ` /ExtGState << ${opacities.map((alpha, at) => `/GS${String(at)} << /Type /ExtGState /ca ${alpha} >>`).join(" ")} >>`;
    objects[pageId(index)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] ` +
      `/Resources ${resources(states)} /Contents ${String(streamId(index))} 0 R >>`;
    const stream = latin1(contentStream(page, imageIndex, opacities, width, height));
    objects[streamId(index)] = { dictionary: `<< /Length ${String(stream.byteLength)} >>`, stream };
  });

  // The title was declared on the document and, until this was written, ignored
  // -- a field a caller sets that changes nothing is a setting that lies. It is
  // what a reader shows in its window and what a saved file is called.
  const infoId = streamId(pageCount - 1) + 1;
  const hasTitle = document.title !== undefined && document.title.trim() !== "";
  if (hasTitle) objects[infoId] = `<< /Title ${pdfString(document.title!.trim())} >>`;
  const total = hasTitle ? infoId : streamId(pageCount - 1);

  // A comment of high bytes after the header, so a transfer that sniffs for
  // binary treats the file as binary now that streams may carry pictures.
  const parts: Uint8Array[] = [latin1("%PDF-1.4\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), latin1("\n")];
  let length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const push = (part: Uint8Array): void => {
    parts.push(part);
    length += part.byteLength;
  };
  const offsets: number[] = [];
  for (let id = 1; id <= total; id += 1) {
    offsets[id] = length;
    const object = objects[id]!;
    if (typeof object === "string") {
      push(latin1(`${String(id)} 0 obj\n${object}\nendobj\n`));
    } else {
      push(latin1(`${String(id)} 0 obj\n${object.dictionary}\nstream\n`));
      push(object.stream);
      push(latin1("\nendstream\nendobj\n"));
    }
  }

  const xrefOffset = length;
  let xref = `xref\n0 ${String(total + 1)}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id += 1) {
    xref += `${String(offsets[id]!).padStart(10, "0")} 00000 n \n`;
  }
  push(
    latin1(
      xref +
        `trailer\n<< /Size ${String(total + 1)} /Root 1 0 R` +
        `${hasTitle ? ` /Info ${String(infoId)} 0 R` : ""} >>\n` +
        `startxref\n${String(xrefOffset)}\n%%EOF\n`,
    ),
  );

  const output = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.byteLength;
  }
  return output;
};
