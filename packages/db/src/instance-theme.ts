import type BetterSqlite3 from 'better-sqlite3'

/**
 * The palette this instance wears (#591), stored beside the brand marks it is
 * set with.
 *
 * One row, written whole. The palette is a set of colours that have to answer
 * to each other -- the contrast rule is a property of the palette, not of any
 * one slot in it -- so a partial write is a state no reader should ever see.
 * Clearing the palette removes the row rather than storing an empty object, so
 * "is this instance themed?" is a row existing and not a JSON object's length.
 *
 * The store does not know what a slot is. Which names exist is the web shell's
 * token contract and is enforced where that contract lives; the schema holds
 * the values to being colours, which is the half that matters for bytes
 * destined for a stylesheet. See `0049_instance_theme`.
 */
export interface InstanceThemeRecord {
  palette: Readonly<Record<string, string>>
  updatedByUserId: number | null
  createdAt: string
  updatedAt: string
}

export interface InstanceThemeWrite {
  palette: Readonly<Record<string, string>>
  updatedByUserId: number | null
  now: string
}

export interface InstanceThemeStore {
  read(): Promise<InstanceThemeRecord | null>
  /**
   * Replaces the palette. An upsert rather than an insert: there is one palette
   * and "change the colours" is that same row saying something different.
   */
  put(input: InstanceThemeWrite): Promise<InstanceThemeRecord>
  /** Returns whether a palette was there to clear, so the route can answer 404. */
  clear(): Promise<boolean>
}

interface Row {
  palette: string
  updated_by_user_id: number | null
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
    throw new RangeError('instance theme clock must return a canonical UTC timestamp')
  }
  return value
}

/**
 * A stored palette, or nothing.
 *
 * A row whose JSON will not parse, or parses to something that is not an
 * object, is read as no palette rather than thrown. This is read on the page
 * path: a palette that cannot be understood should cost the instance its
 * colours, not its ability to render.
 */
const parsePalette = (value: string): Readonly<Record<string, string>> => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

const record = (row: Row): InstanceThemeRecord => ({
  palette: parsePalette(row.palette),
  updatedByUserId: row.updated_by_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const columns = 'palette, updated_by_user_id, created_at, updated_at'

const readQuery = `SELECT ${columns} FROM instance_theme WHERE id = 1`

// `created_at` keeps its original value: it records when this instance first
// set colours of its own, which is a different fact from when the current
// palette was saved.
const putQuery = `INSERT INTO instance_theme (
    id, palette, updated_by_user_id, created_at, updated_at
  ) VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    palette = excluded.palette,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = excluded.updated_at
  RETURNING ${columns}`

const clearQuery = 'DELETE FROM instance_theme WHERE id = 1 RETURNING id'

/**
 * Keys are sorted on the way in so one palette is always the same bytes. The
 * stylesheet a browser caches is derived from this column, and two saves of the
 * same colours differing only in key order would read as a change.
 */
const bindings = (input: InstanceThemeWrite): readonly unknown[] => {
  const timestamp = assertCanonicalTimestamp(input.now)
  const ordered = Object.fromEntries(
    Object.entries(input.palette).sort(([first], [second]) => first.localeCompare(second)),
  )
  return [JSON.stringify(ordered), input.updatedByUserId, timestamp, timestamp]
}

export const createContainerInstanceThemeStore = (
  database: BetterSqlite3.Database,
): InstanceThemeStore => {
  database.pragma('foreign_keys = ON')
  return {
    read: async () => {
      const row = database.prepare(readQuery).get() as Row | undefined
      return row === undefined ? null : record(row)
    },
    put: async (input) => record(database.prepare(putQuery).get(...bindings(input)) as Row),
    clear: async () =>
      (database.prepare(clearQuery).get() as { id: number } | undefined) !== undefined,
  }
}

export const createD1InstanceThemeStore = (database: D1Database): InstanceThemeStore => ({
  read: async () => {
    const row = await database.prepare(readQuery).first<Row>()
    return row === null ? null : record(row)
  },
  put: async (input) =>
    record(
      (await database
        .prepare(putQuery)
        .bind(...bindings(input))
        .first<Row>())!,
    ),
  clear: async () =>
    (await database.prepare(clearQuery).first<{ id: number }>()) !== null,
})
