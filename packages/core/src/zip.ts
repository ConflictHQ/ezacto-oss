/**
 * A store-only ZIP writer, for the workbook the work journal renders (issue 647).
 *
 * An `.xlsx` is a ZIP of XML parts. A compression library would be the usual
 * answer and is the wrong one here for the reason `pdf.ts` gives: this package
 * ships to an edge runtime with one dependency, and a journal's parts are tens
 * of kilobytes. Stored entries need nothing but the CRC-32 and the two headers
 * every reader understands, and every consumer of a workbook reads them.
 *
 * Deterministic, like the PDF: entries keep their order, and every timestamp is
 * the format's earliest (1980-01-01 00:00), so the same parts are byte-for-byte
 * the same archive.
 */

export interface ZipEntry {
  /** Forward-slash path inside the archive. ASCII, because nothing here needs more. */
  readonly name: string;
  readonly data: Uint8Array;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 as ZIP defines it: reflected polynomial 0xEDB88320, inverted in and out. */
export const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** 1980-01-01 00:00, the earliest instant a ZIP header can carry. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const VERSION = 20;

export const zipStore = (entries: readonly ZipEntry[]): Uint8Array => {
  if (entries.length === 0 || entries.length > 0xffff) {
    throw new RangeError("a ZIP archive needs between one and 65535 entries");
  }
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  const seen = new Set<string>();
  let offset = 0;
  for (const entry of entries) {
    if (
      !/^[\x21-\x7e]+$/u.test(entry.name) ||
      entry.name.includes("\\") ||
      !entry.name
        .split("/")
        .every((segment) => segment !== "" && segment !== "." && segment !== "..")
    ) {
      throw new RangeError("a ZIP entry name must be a relative ASCII path");
    }
    if (seen.has(entry.name)) throw new RangeError("a ZIP entry name must be unique");
    seen.add(entry.name);
    const name = encoder.encode(entry.name);
    const size = entry.data.byteLength;
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.byteLength + size);
    const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, VERSION, true);
    header.setUint16(6, 0, true); // no flags: sizes are known up front
    header.setUint16(8, 0, true); // stored
    header.setUint16(10, DOS_TIME, true);
    header.setUint16(12, DOS_DATE, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, size, true);
    header.setUint32(22, size, true);
    header.setUint16(26, name.byteLength, true);
    header.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.byteLength);

    const central = new Uint8Array(46 + name.byteLength);
    const record = new DataView(central.buffer);
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, VERSION, true);
    record.setUint16(6, VERSION, true);
    record.setUint16(8, 0, true);
    record.setUint16(10, 0, true);
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, size, true);
    record.setUint32(24, size, true);
    record.setUint16(28, name.byteLength, true);
    record.setUint16(30, 0, true); // extra
    record.setUint16(32, 0, true); // comment
    record.setUint16(34, 0, true); // disk
    record.setUint16(36, 0, true); // internal attributes
    record.setUint32(38, 0, true); // external attributes
    record.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const directorySize = centrals.reduce((sum, central) => sum + central.byteLength, 0);
  if (offset + directorySize > 0xffffffff) throw new RangeError("a ZIP archive must stay under 4 GiB");

  const end = new Uint8Array(22);
  const trailer = new DataView(end.buffer);
  trailer.setUint32(0, 0x06054b50, true);
  trailer.setUint16(4, 0, true);
  trailer.setUint16(6, 0, true);
  trailer.setUint16(8, entries.length, true);
  trailer.setUint16(10, entries.length, true);
  trailer.setUint32(12, directorySize, true);
  trailer.setUint32(16, offset, true);
  trailer.setUint16(20, 0, true);

  const archive = new Uint8Array(offset + directorySize + end.byteLength);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    archive.set(part, at);
    at += part.byteLength;
  }
  return archive;
};
