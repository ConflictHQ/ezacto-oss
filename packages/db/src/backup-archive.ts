/**
 * Issue 39, operator export: a completed backup run, streamed as one ZIP.
 *
 * The nightly export leaves a bundle as many R2 objects under a prefix. A way
 * out for the operator needs it as a single file that opens with standard
 * tools. This module is that file and nothing else: no link, no route, no
 * destination. Whatever hands the stream to somebody owns who may ask for it.
 *
 * Three decisions worth knowing about:
 *
 * - Trust comes from D1, not from R2. The run row holds the manifest as it was
 *   at export time. The manifest object in R2 must still say the same thing, and
 *   every table object must still hash to what that manifest recorded. A bundle
 *   that fails either check is not served: a damaged backup that looks fine is
 *   worse than one that refuses to download.
 * - Each object is read, hashed and checksummed before any of its bytes leave.
 *   A mismatch therefore errors the stream with nothing from the bad object
 *   already sent. Memory is bounded by the largest single object (the exporter
 *   itself holds a whole table as one string), never by the bundle.
 * - Entries are stored, not deflated, and carry their sizes and CRC-32 in the
 *   local header, so readers that stream the file and readers that seek to the
 *   central directory agree. Zip64 is not written; a bundle that needs it is
 *   refused rather than silently corrupted.
 */
import { workerBackupFiles, WORKER_BACKUP_FILE_MAX_BYTES } from '@ezacto/core'
import type { BackupManifest, BackupRunRecord } from './backup.js'

/** Reads one object of a bundle by key; null when it does not exist. */
export interface BackupObjectSource {
  get(key: string): Promise<Uint8Array | null>
}

export type BackupArchiveErrorCode =
  'run_not_exportable' | 'manifest_mismatch' | 'object_missing' | 'checksum_mismatch' | 'too_large'

export class BackupArchiveError extends Error {
  constructor(
    readonly code: BackupArchiveErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BackupArchiveError'
  }
}

/** The R2 bucket the nightly export writes to, as an archive source. */
export const r2BackupSource = (bucket: R2Bucket): BackupObjectSource => ({
  async get(key) {
    const object = await bucket.get(key)
    return object === null ? null : new Uint8Array(await object.arrayBuffer())
  },
})

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff
const SAFE_TABLE_NAME = /^[A-Za-z0-9_]+$/u

interface Entry {
  nameBytes: Uint8Array
  data: Uint8Array
  crc: number
}

interface CentralRecord {
  nameBytes: Uint8Array
  crc: number
  size: number
  offset: number
}

interface PlanItem {
  name: string
  key: string
  /** The hash the manifest demands; null for files it does not cover. */
  sha256: string | null
  byteSize: number | null
}

const dosStamp = (iso: string): { time: number; date: number } => {
  const when = new Date(iso)
  const valid = Number.isFinite(when.getTime()) && when.getUTCFullYear() >= 1980
  const d = valid ? when : new Date(Date.UTC(1980, 0, 1))
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const header = (size: number, write: (view: DataView) => void): Uint8Array => {
  const bytes = new Uint8Array(size)
  write(new DataView(bytes.buffer))
  return bytes
}

const sha256Of = async (data: Uint8Array): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

const canonical = (json: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(json))
  } catch {
    return null
  }
}

/**
 * Opens the archive of a completed run. Rejects before producing any byte when
 * the run cannot be exported or its manifest object has drifted from the one
 * D1 recorded; per-table failures surface as an error on the returned stream.
 */
export const openBackupArchive = async (
  run: Pick<BackupRunRecord, 'id' | 'status' | 'r2_prefix' | 'manifest_json'>,
  source: BackupObjectSource,
): Promise<ReadableStream<Uint8Array>> => {
  if (run.status !== 'completed' || run.r2_prefix === null || run.manifest_json === null) {
    throw new BackupArchiveError(
      'run_not_exportable',
      `Backup run ${run.id} did not complete, so there is no bundle to export.`,
    )
  }
  const prefix = run.r2_prefix
  const recorded = canonical(run.manifest_json)
  const manifestBytes = await source.get(`${prefix}manifest.json`)
  if (manifestBytes === null) {
    throw new BackupArchiveError('object_missing', `${prefix}manifest.json is missing.`)
  }
  const stored = canonical(new TextDecoder().decode(manifestBytes))
  if (recorded === null || stored === null || recorded !== stored) {
    throw new BackupArchiveError(
      'manifest_mismatch',
      `${prefix}manifest.json does not match the manifest recorded for run ${run.id}.`,
    )
  }
  const manifest = JSON.parse(run.manifest_json) as BackupManifest
  const tableNames = Object.keys(manifest.tables).sort()
  for (const name of tableNames) {
    if (!SAFE_TABLE_NAME.test(name)) {
      throw new BackupArchiveError('manifest_mismatch', `Manifest names an unsafe table: ${name}.`)
    }
  }
  let files: ReturnType<typeof workerBackupFiles>
  try {
    files = workerBackupFiles((manifest as BackupManifest & { files?: unknown }).files)
  } catch {
    throw new BackupArchiveError(
      'manifest_mismatch',
      'The manifest contains invalid backup file receipts.',
    )
  }
  if (tableNames.length + files.length + 2 > MAX_ENTRIES) {
    throw new BackupArchiveError('too_large', 'The bundle has too many files for a ZIP.')
  }

  const encoder = new TextEncoder()
  const stamp = dosStamp(manifest.exported_at)
  const plan: PlanItem[] = [
    { name: 'manifest.json', key: `${prefix}manifest.json`, sha256: null, byteSize: null },
    { name: 'RESTORE.md', key: `${prefix}RESTORE.md`, sha256: null, byteSize: null },
    ...tableNames.map((table) => ({
      name: `tables/${table}.csv`,
      key: `${prefix}tables/${table}.csv`,
      sha256: manifest.tables[table]!.sha256,
      byteSize: null,
    })),
    ...files.map((file) => ({
      name: file.name,
      key: `${prefix}${file.name}`,
      sha256: file.sha256,
      byteSize: file.byte_size,
    })),
  ]

  const central: CentralRecord[] = []
  let offset = 0
  let index = 0
  let finished = false

  const load = async (item: PlanItem): Promise<Entry> => {
    const data = item.name === 'manifest.json' ? manifestBytes : await source.get(item.key)
    if (data === null) {
      throw new BackupArchiveError('object_missing', `${item.key} is missing.`)
    }
    if (data.length > (item.byteSize === null ? MAX_BYTES : WORKER_BACKUP_FILE_MAX_BYTES)) {
      throw new BackupArchiveError('too_large', `${item.key} is too large for a ZIP.`)
    }
    if (
      (item.byteSize !== null && data.length !== item.byteSize) ||
      (item.sha256 !== null && (await sha256Of(data)) !== item.sha256)
    ) {
      throw new BackupArchiveError(
        'checksum_mismatch',
        `${item.key} does not match the checksum in the manifest.`,
      )
    }
    return { nameBytes: encoder.encode(item.name), data, crc: crc32(data) }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (finished) return
        const item = plan[index]
        if (item !== undefined) {
          index += 1
          const entry = await load(item)
          const local = header(30, (v) => {
            v.setUint32(0, 0x04034b50, true)
            v.setUint16(4, 20, true)
            v.setUint16(6, 0x0800, true)
            v.setUint16(10, stamp.time, true)
            v.setUint16(12, stamp.date, true)
            v.setUint32(14, entry.crc, true)
            v.setUint32(18, entry.data.length, true)
            v.setUint32(22, entry.data.length, true)
            v.setUint16(26, entry.nameBytes.length, true)
          })
          central.push({
            nameBytes: entry.nameBytes,
            crc: entry.crc,
            size: entry.data.length,
            offset,
          })
          offset += local.length + entry.nameBytes.length + entry.data.length
          if (offset > MAX_BYTES) {
            throw new BackupArchiveError('too_large', 'The bundle is too large for a ZIP.')
          }
          controller.enqueue(concat([local, entry.nameBytes, entry.data]))
          return
        }
        const directory = concat(
          central.flatMap((record) => [
            header(46, (v) => {
              v.setUint32(0, 0x02014b50, true)
              v.setUint16(4, 20, true)
              v.setUint16(6, 20, true)
              v.setUint16(8, 0x0800, true)
              v.setUint16(12, stamp.time, true)
              v.setUint16(14, stamp.date, true)
              v.setUint32(16, record.crc, true)
              v.setUint32(20, record.size, true)
              v.setUint32(24, record.size, true)
              v.setUint16(28, record.nameBytes.length, true)
              v.setUint32(42, record.offset, true)
            }),
            record.nameBytes,
          ]),
        )
        const end = header(22, (v) => {
          v.setUint32(0, 0x06054b50, true)
          v.setUint16(8, central.length, true)
          v.setUint16(10, central.length, true)
          v.setUint32(12, directory.length, true)
          v.setUint32(16, offset, true)
        })
        finished = true
        controller.enqueue(concat([directory, end]))
        controller.close()
      } catch (error) {
        finished = true
        controller.error(error)
      }
    },
  })
}

/** Reads a run by id; null when there is none. */
export const getBackupRun = async (
  database: D1Database,
  runId: number,
): Promise<BackupRunRecord | null> =>
  database
    .prepare(
      `SELECT id, status, trigger, started_at, completed_at, r2_prefix,
       manifest_json, table_count, total_rows, error_message, created_at, updated_at
       FROM backup_runs WHERE id = ?`,
    )
    .bind(runId)
    .first<BackupRunRecord>()
