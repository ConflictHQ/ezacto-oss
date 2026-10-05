import { crc32, deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeJpeg, decodePng, pdfImageFrom } from "../src/pdf-image.js";

/**
 * Pictures for the invoice's logo. The PNGs here are built by an encoder
 * written for the test -- filtering in the encoding direction, CRCs from
 * `node:zlib` -- and what the decoder hands the PDF is inflated back with
 * `node:zlib` too, so neither half is checked against itself.
 */

const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];

const chunk = (type: string, data: readonly number[] | Uint8Array): number[] => {
  const body = [...[...type].map((character) => character.charCodeAt(0)), ...data];
  return [...u32(data.length), ...body, ...u32(crc32(Uint8Array.from(body)))];
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Filters each row with the type given for it, as an encoder would. */
const filtered = (rows: readonly (readonly number[])[], filters: readonly number[], bpp: number): Uint8Array => {
  const out: number[] = [];
  rows.forEach((row, y) => {
    const previous = y === 0 ? row.map(() => 0) : rows[y - 1]!;
    const type = filters[y % filters.length]!;
    out.push(type);
    row.forEach((value, index) => {
      const a = index >= bpp ? row[index - bpp]! : 0;
      const b = previous[index]!;
      const c = index >= bpp ? previous[index - bpp]! : 0;
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type]!;
      out.push((value - predicted) & 0xff);
    });
  });
  return Uint8Array.from(out);
};

const png = (options: {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  rows: readonly (readonly number[])[];
  filters?: readonly number[];
  bpp?: number;
  palette?: readonly number[];
  transparency?: readonly number[];
  interlace?: number;
}): Uint8Array => {
  const header = [
    ...u32(options.width),
    ...u32(options.height),
    options.depth,
    options.colourType,
    0,
    0,
    options.interlace ?? 0,
  ];
  const data = deflateSync(filtered(options.rows, options.filters ?? [0], options.bpp ?? 1));
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", header),
    ...(options.palette === undefined ? [] : chunk("PLTE", options.palette)),
    ...(options.transparency === undefined ? [] : chunk("tRNS", options.transparency)),
    ...chunk("IDAT", data),
    ...chunk("IEND", []),
  ]);
};

const samples = (bytes: Uint8Array | null): number[] => (bytes === null ? [] : Array.from(inflateSync(bytes)));

describe("PNG", () => {
  it("[unit] decodes eight-bit RGB through every row filter", async () => {
    const rows = [
      [10, 20, 30, 200, 100, 50, 7, 8, 9],
      [11, 22, 33, 201, 99, 51, 250, 0, 128],
      [0, 0, 0, 255, 255, 255, 1, 2, 3],
      [90, 80, 70, 60, 50, 40, 30, 20, 10],
      [5, 5, 5, 6, 6, 6, 7, 7, 7],
    ];
    const image = await decodePng(png({ width: 3, height: 5, depth: 8, colourType: 2, rows, filters: [0, 1, 2, 3, 4], bpp: 3 }));
    expect(image).toMatchObject({ width: 3, height: 5, colorSpace: "DeviceRGB", filter: "FlateDecode", alpha: null });
    expect(samples(image.data)).toEqual(rows.flat());
  });

  it("[unit] splits an alpha channel into a soft mask", async () => {
    const rows = [
      [255, 0, 0, 255, 0, 255, 0, 128],
      [0, 0, 255, 0, 9, 9, 9, 64],
    ];
    const image = await decodePng(png({ width: 2, height: 2, depth: 8, colourType: 6, rows, filters: [4, 1], bpp: 4 }));
    expect(samples(image.data)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
    expect(samples(image.alpha)).toEqual([255, 128, 0, 64]);
  });

  it("[unit] gives a fully opaque picture no mask at all", async () => {
    const image = await decodePng(png({ width: 1, height: 1, depth: 8, colourType: 6, rows: [[1, 2, 3, 255]], bpp: 4 }));
    expect(image.alpha).toBeNull();
  });

  it("[unit] decodes grey, with and without alpha", async () => {
    const grey = await decodePng(png({ width: 3, height: 2, depth: 8, colourType: 0, rows: [[0, 128, 255], [1, 2, 3]], filters: [2, 3] }));
    expect(grey.colorSpace).toBe("DeviceGray");
    expect(samples(grey.data)).toEqual([0, 128, 255, 1, 2, 3]);
    const withAlpha = await decodePng(png({ width: 2, height: 1, depth: 8, colourType: 4, rows: [[40, 0, 80, 255]], bpp: 2 }));
    expect(samples(withAlpha.data)).toEqual([40, 80]);
    expect(samples(withAlpha.alpha)).toEqual([0, 255]);
  });

  it("[unit] scales one-bit grey to full black and white", async () => {
    // Ten pixels, so the row runs into a second byte.
    const image = await decodePng(png({ width: 10, height: 1, depth: 1, colourType: 0, rows: [[0b10100000, 0b11000000]] }));
    expect(samples(image.data)).toEqual([255, 0, 255, 0, 0, 0, 0, 0, 255, 255]);
  });

  it("[unit] decodes a four-bit palette with tRNS transparency", async () => {
    const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255];
    const image = await decodePng(
      png({ width: 3, height: 1, depth: 4, colourType: 3, rows: [[0x01, 0x20]], palette, transparency: [255, 0] }),
    );
    expect(image.colorSpace).toBe("DeviceRGB");
    expect(samples(image.data)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    // Entry 1 is transparent; entry 2 has no tRNS value and is opaque.
    expect(samples(image.alpha)).toEqual([255, 0, 255]);
  });

  it("[unit] keeps the high byte of a sixteen-bit channel", async () => {
    const image = await decodePng(
      png({ width: 1, height: 1, depth: 16, colourType: 2, rows: [[0x12, 0x34, 0xab, 0xcd, 0xff, 0x00]], bpp: 6 }),
    );
    expect(samples(image.data)).toEqual([0x12, 0xab, 0xff]);
  });

  it("[unit] masks the one colour a tRNS chunk names in an RGB picture", async () => {
    const image = await decodePng(
      png({ width: 2, height: 1, depth: 8, colourType: 2, rows: [[1, 2, 3, 4, 5, 6]], bpp: 3, transparency: [0, 4, 0, 5, 0, 6] }),
    );
    expect(samples(image.alpha)).toEqual([255, 0]);
  });

  it("[security] refuses what it cannot decode rather than drawing something wrong", async () => {
    const valid = png({ width: 1, height: 1, depth: 8, colourType: 2, rows: [[1, 2, 3]], bpp: 3 });
    const corrupt = Uint8Array.from(valid);
    corrupt[20] = corrupt[20]! ^ 0xff;
    const cases: readonly [string, Uint8Array][] = [
      ["not a PNG", Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9])],
      ["corrupt", corrupt],
      ["interlaced", png({ width: 1, height: 1, depth: 8, colourType: 2, rows: [[1, 2, 3]], bpp: 3, interlace: 1 })],
      ["too large", png({ width: 5000, height: 5000, depth: 8, colourType: 0, rows: [[0]] })],
      ["colour type", png({ width: 1, height: 1, depth: 8, colourType: 5, rows: [[0]] })],
      ["depth", png({ width: 1, height: 1, depth: 16, colourType: 3, rows: [[0, 0]], palette: [0, 0, 0] })],
      ["palette", png({ width: 1, height: 1, depth: 8, colourType: 3, rows: [[0]] })],
      ["short", png({ width: 4, height: 4, depth: 8, colourType: 0, rows: [[0]] })],
      ["palette index", png({ width: 1, height: 1, depth: 8, colourType: 3, rows: [[5]], palette: [0, 0, 0] })],
    ];
    for (const [, bytes] of cases) {
      await expect(decodePng(bytes)).rejects.toThrow(/the picture cannot be drawn/u);
    }
  });
});

/** SOI, a JFIF APP0, a frame header, then the scan's marker and EOI. */
const jpeg = (frame: number, precision: number, height: number, width: number, components: number): Uint8Array =>
  Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, frame, 0x00, 8 + components * 3, precision, height >> 8, height & 0xff, width >> 8, width & 0xff, components,
    ...Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat(),
    0xff, 0xda, 0x00, 0x02,
    0xff, 0xd9,
  ]);

describe("JPEG", () => {
  it("[unit] passes the file through as the image stream, sized from its frame header", () => {
    const bytes = jpeg(0xc0, 8, 137, 572, 3);
    expect(decodeJpeg(bytes)).toEqual({
      width: 572,
      height: 137,
      colorSpace: "DeviceRGB",
      filter: "DCTDecode",
      data: bytes,
      alpha: null,
    });
    expect(decodeJpeg(jpeg(0xc2, 8, 10, 20, 1)).colorSpace).toBe("DeviceGray");
  });

  it("[security] refuses the frames and inks DCTDecode cannot be trusted with", () => {
    for (const bytes of [
      jpeg(0xc0, 8, 10, 10, 4),
      jpeg(0xc0, 12, 10, 10, 3),
      jpeg(0xc3, 8, 10, 10, 3),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
      Uint8Array.from([0x00, 0x01, 0x02, 0x03]),
    ]) {
      expect(() => decodeJpeg(bytes)).toThrow(/the picture cannot be drawn/u);
    }
  });
});

describe("by content type", () => {
  it("[unit] decodes the two formats a PDF can carry and refuses the rest", async () => {
    expect((await pdfImageFrom(jpeg(0xc0, 8, 1, 1, 3), "image/jpeg")).filter).toBe("DCTDecode");
    expect(
      (await pdfImageFrom(png({ width: 1, height: 1, depth: 8, colourType: 2, rows: [[1, 2, 3]], bpp: 3 }), "image/png; x=1")).filter,
    ).toBe("FlateDecode");
    await expect(pdfImageFrom(Uint8Array.from([1]), "image/webp")).rejects.toThrow(/image\/webp/u);
  });
});
