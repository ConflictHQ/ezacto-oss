import type { PdfImage } from "./pdf.js";
import { crc32 } from "./zip.js";

/**
 * Pictures for the PDF writer: the organization's uploaded wordmark on an
 * invoice (issue 647).
 *
 * JPEG passes straight through -- PDF's DCTDecode is a JPEG decoder, so the
 * file's own bytes are the image stream. PNG does not: PDF has no PNG filter,
 * and an alpha channel interleaved with the colour has to become a separate
 * soft mask. So a PNG is decoded here -- inflated with the platform's own
 * `DecompressionStream`, which both runtimes have, unfiltered, split -- and
 * the colour and the coverage are deflated back as two streams.
 *
 * Small on purpose: non-interlaced PNG in every colour type at eight bits,
 * grey and palette also at one, two and four, sixteen-bit channels reduced to
 * their high byte, transparency from an alpha channel or a tRNS chunk. Anything
 * else is refused with a reason, and the caller sets the company name where the
 * picture would have gone -- a logo is never the reason an invoice fails.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * A few kilobytes of PNG can inflate to gigabytes, so the size is checked
 * before anything is inflated. Four megapixels is a wordmark drawn at several
 * times print resolution, and its decoded colour and coverage stay under
 * twenty megabytes.
 */
const MAX_PIXELS = 4_000_000;
const MAX_SIDE = 8_192;

const refuse = (reason: string): never => {
  throw new RangeError(`the picture cannot be drawn: ${reason}`);
};

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const u16 = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;

const through = async (
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Response(data as BodyInit).body!.pipeThrough(stream)).arrayBuffer());

const inflate = (data: Uint8Array): Promise<Uint8Array> => through(data, new DecompressionStream("deflate"));
const deflate = (data: Uint8Array): Promise<Uint8Array> => through(data, new CompressionStream("deflate"));

const paeth = (left: number, up: number, upLeft: number): number => {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
};

/** Channels per pixel, and the bit depths the format allows, for each colour type. */
const colourTypes: Readonly<Record<number, { channels: number; depths: readonly number[] }>> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

export const decodePng = async (bytes: Uint8Array): Promise<PdfImage> => {
  if (bytes.byteLength < 8 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    refuse("not a PNG");
  }
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  let at = 8;
  let ended = false;
  while (!ended) {
    if (at + 12 > bytes.byteLength) refuse("the PNG ends inside a chunk");
    const length = u32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > bytes.byteLength) refuse("a PNG chunk runs past the file");
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32(bytes, at + 8 + length)) {
      refuse(`the PNG ${type} chunk is corrupt`);
    }
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) refuse("the PNG header is malformed");
      width = u32(body, 0);
      height = u32(body, 4);
      depth = body[8]!;
      colourType = body[9]!;
      if (body[10] !== 0 || body[11] !== 0) refuse("the PNG uses an unknown compression or filter");
      if (body[12] !== 0) refuse("interlaced PNGs are not supported");
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      transparency = body;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      ended = true;
    }
    at = end;
  }
  const format = colourTypes[colourType];
  if (format === undefined) refuse("the PNG colour type is unknown");
  if (!format!.depths.includes(depth)) refuse(`a ${String(depth)}-bit PNG of this colour type`);
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    refuse("the PNG is too large to place on a page");
  }
  if (colourType === 3 && (palette === null || palette.byteLength % 3 !== 0)) {
    refuse("the PNG palette is missing");
  }
  const { channels } = format!;

  const compressed = new Uint8Array(data.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  data.reduce((offset, chunk) => {
    compressed.set(chunk, offset);
    return offset + chunk.byteLength;
  }, 0);
  const raw = await inflate(compressed);
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);
  if (raw.byteLength < height * (stride + 1)) refuse("the PNG image data is short");

  // Unfiltered into one buffer, row after row.
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) refuse("the PNG uses an unknown row filter");
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let index = 0; index < stride; index += 1) {
      const left = index >= step ? rows[row + index - step]! : 0;
      const up = y > 0 ? rows[row - stride + index]! : 0;
      const upLeft = y > 0 && index >= step ? rows[row - stride + index - step]! : 0;
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? (left + up) >> 1
                : paeth(left, up, upLeft);
      rows[row + index] = (raw[source + index]! + predicted) & 0xff;
    }
  }

  // A channel's value at its own depth; sixteen bits keep their high byte.
  const sample = (y: number, x: number, channel: number): number => {
    const row = y * stride;
    if (depth === 8) return rows[row + x * channels + channel]!;
    if (depth === 16) return rows[row + (x * channels + channel) * 2]!;
    const bit = x * depth;
    return (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const wide = (y: number, x: number, channel: number): number =>
    depth === 16 ? u16(rows, y * stride + (x * channels + channel) * 2) : sample(y, x, channel);
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;

  const grey = colourType === 0 || colourType === 4;
  const colour = new Uint8Array(width * height * (grey ? 1 : 3));
  const alpha = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (colourType === 3) {
        const entry = sample(y, x, 0);
        if (entry * 3 + 2 >= palette!.byteLength) refuse("a PNG pixel names a colour the palette lacks");
        colour.set(palette!.subarray(entry * 3, entry * 3 + 3), pixel * 3);
        if (transparency !== null && entry < transparency.byteLength) alpha[pixel] = transparency[entry]!;
      } else if (grey) {
        colour[pixel] = Math.round(sample(y, x, 0) * scale);
        if (colourType === 4) alpha[pixel] = sample(y, x, 1);
        else if (transparency !== null && transparency.byteLength >= 2 && wide(y, x, 0) === u16(transparency, 0)) {
          alpha[pixel] = 0;
        }
      } else {
        colour[pixel * 3] = sample(y, x, 0);
        colour[pixel * 3 + 1] = sample(y, x, 1);
        colour[pixel * 3 + 2] = sample(y, x, 2);
        if (colourType === 6) alpha[pixel] = sample(y, x, 3);
        else if (
          transparency !== null &&
          transparency.byteLength >= 6 &&
          wide(y, x, 0) === u16(transparency, 0) &&
          wide(y, x, 1) === u16(transparency, 2) &&
          wide(y, x, 2) === u16(transparency, 4)
        ) {
          alpha[pixel] = 0;
        }
      }
    }
  }
  const opaque = alpha.every((value) => value === 255);
  return {
    width,
    height,
    colorSpace: grey ? "DeviceGray" : "DeviceRGB",
    filter: "FlateDecode",
    data: await deflate(colour),
    alpha: opaque ? null : await deflate(alpha),
  };
};

/**
 * A JPEG's own bytes, after reading its size from the frame header. Baseline,
 * extended and progressive frames only -- the three DCTDecode reads -- in grey
 * or RGB: a CMYK JPEG would need Adobe's inverted-ink convention detected and
 * undone, and printing a logo in negative is worse than printing the name.
 */
export const decodeJpeg = (bytes: Uint8Array): PdfImage => {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) refuse("not a JPEG");
  let at = 2;
  while (at + 4 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) refuse("the JPEG markers are malformed");
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = u16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.byteLength) refuse("a JPEG segment runs past the file");
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (marker > 0xc2) refuse("lossless and arithmetic-coded JPEGs are not supported");
      if (length < 8 || bytes[at + 4] !== 8) refuse("only eight-bit JPEGs are supported");
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      const components = bytes[at + 9]!;
      if (width < 1 || height < 1) refuse("the JPEG has no size");
      if (components !== 1 && components !== 3) refuse("only grey and RGB JPEGs are supported");
      return {
        width,
        height,
        colorSpace: components === 1 ? "DeviceGray" : "DeviceRGB",
        filter: "DCTDecode",
        data: bytes,
        alpha: null,
      };
    }
    at += 2 + length;
  }
  return refuse("the JPEG has no frame header");
};

/** A stored picture, by the content type it was stored under. */
export const pdfImageFrom = async (bytes: Uint8Array, contentType: string): Promise<PdfImage> => {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type === "image/png") return decodePng(bytes);
  if (type === "image/jpeg") return decodeJpeg(bytes);
  return refuse(`${type} is not a format a PDF can carry`);
};
