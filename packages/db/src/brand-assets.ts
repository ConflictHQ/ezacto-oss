import type BetterSqlite3 from 'better-sqlite3'

/**
 * The metadata half of an uploaded brand mark (#489). The bytes live in the
 * object store under a content-addressed key, exactly as an attachment's do;
 * this store answers the two questions the render path and the download route
 * ask -- which marks exist, and which object is the current one for a slot.
 *
 * Which slot is which is a decision, not a preference: `wordmark_light` is the
 * mark drawn on a light ground (the document shell, which is where an invoice
 * is read) and `wordmark_dark` the mark drawn on a dark ground (the app topbar
 * and the sign-in splash, both painted with `--ez-ink`). Naming them after the
 * ground rather than after the ink is the only reading under which an operator
 * can tell which file to upload where.
 */
export type BrandAssetSlot = 'wordmark_light' | 'wordmark_dark' | 'favicon'

export const brandAssetSlots: readonly BrandAssetSlot[] = [
  'wordmark_light',
  'wordmark_dark',
  'favicon',
]

export interface BrandAssetRecord {
  slot: BrandAssetSlot
  contentHash: string
  fileKey: string
  contentType: string
  byteSize: number
  uploadedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export interface BrandAssetWrite {
  slot: BrandAssetSlot
  contentHash: string
  fileKey: string
  contentType: string
  byteSize: number
  uploadedByUserId: number | null
  now: string
}

export interface BrandAssetStore {
  list(): Promise<readonly BrandAssetRecord[]>
  /**
   * Replaces whatever the slot held. An upsert rather than an insert because a
   * slot holds one current mark and "upload a new logo" is that same slot
   * saying something different, not a second row competing to be the live one.
   */
  put(input: BrandAssetWrite): Promise<BrandAssetRecord>
  /** Returns whether a row was there to remove, so the route can answer 404. */
  remove(slot: BrandAssetSlot): Promise<boolean>
}

interface Row {
  slot: BrandAssetSlot
  content_hash: string
  file_key: string
  content_type: string
  byte_size: number
  uploaded_by_user_id: number | null
  created_at: string
  updated_at: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string): string => {
  const epoch = Date.parse(value)
  if (
    canonicalTimestampPattern.exec(value) === null ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== value
  ) {
    throw new RangeError('brand asset clock must return a canonical UTC timestamp')
  }
  return value
}

const record = (row: Row): BrandAssetRecord => ({
  slot: row.slot,
  contentHash: row.content_hash,
  fileKey: row.file_key,
  contentType: row.content_type,
  byteSize: row.byte_size,
  uploadedByUserId: row.uploaded_by_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const columns = `slot, content_hash, file_key, content_type, byte_size,
    uploaded_by_user_id, created_at, updated_at`

const listQuery = `SELECT ${columns} FROM brand_assets ORDER BY slot`

// `created_at` is held at its original value on replacement: it records when
// this instance first put a mark in the slot, which is a different fact from
// when the current file was uploaded, and the settings screen shows the latter.
const putQuery = `INSERT INTO brand_assets (
    slot, content_hash, file_key, content_type, byte_size,
    uploaded_by_user_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(slot) DO UPDATE SET
    content_hash = excluded.content_hash,
    file_key = excluded.file_key,
    content_type = excluded.content_type,
    byte_size = excluded.byte_size,
    uploaded_by_user_id = excluded.uploaded_by_user_id,
    updated_at = excluded.updated_at
  RETURNING ${columns}`

const deleteQuery = `DELETE FROM brand_assets WHERE slot = ? RETURNING slot`

const bindings = (input: BrandAssetWrite): readonly unknown[] => {
  const timestamp = assertCanonicalTimestamp(input.now)
  return [
    input.slot,
    input.contentHash,
    input.fileKey,
    input.contentType,
    input.byteSize,
    input.uploadedByUserId,
    timestamp,
    timestamp,
  ]
}

export const createContainerBrandAssetStore = (
  database: BetterSqlite3.Database,
): BrandAssetStore => {
  database.pragma('foreign_keys = ON')
  return {
    list: async () => (database.prepare(listQuery).all() as Row[]).map(record),
    put: async (input) =>
      record(database.prepare(putQuery).get(...bindings(input)) as Row),
    remove: async (slot) =>
      (database.prepare(deleteQuery).get(slot) as { slot: string } | undefined) !== undefined,
  }
}

export const createD1BrandAssetStore = (database: D1Database): BrandAssetStore => ({
  list: async () => (await database.prepare(listQuery).all<Row>()).results.map(record),
  put: async (input) =>
    record(
      (await database
        .prepare(putQuery)
        .bind(...bindings(input))
        .first<Row>())!,
    ),
  remove: async (slot) =>
    (await database.prepare(deleteQuery).bind(slot).first<{ slot: string }>()) !== null,
})
