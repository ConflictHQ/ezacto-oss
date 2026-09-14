import type BetterSqlite3 from 'better-sqlite3'

export type StaffMagicLinkFlow = 'app' | 'web'

export interface StaffMagicLinkRedemption {
  userId: number
  flow: StaffMagicLinkFlow
}

export interface CreateStaffMagicLinkInput {
  userId: number
  tokenHash: string
  codeHash: string
  flow: StaffMagicLinkFlow
  expiresAt: string
  createdAt: string
  /** Expired or already-consumed rows at or before this instant are swept first. */
  cleanupBefore: string
}

export type StaffMagicLinkCreation = 'created' | 'collision'

export interface StaffMagicLinkStore {
  create(input: CreateStaffMagicLinkInput): Promise<StaffMagicLinkCreation>
  /** Redeem the high-entropy link token; single-use. */
  consumeByToken(
    tokenHash: string,
    now: string
  ): Promise<StaffMagicLinkRedemption | null>
  /**
   * Redeem the low-entropy code for a user. Single-use, and a wrong code burns
   * one of the limited attempts; once attempts hit the ceiling the record is
   * unusable even with the right code, so a 6-digit code cannot be guessed
   * before it expires.
   */
  consumeByCode(
    userId: number,
    codeHash: string,
    now: string,
    maxAttempts: number
  ): Promise<StaffMagicLinkRedemption | null>
  /**
   * Whether the user already has an unconsumed, unexpired link created at or
   * after `since`. The request route uses it to collapse rapid re-requests into
   * one outstanding email, so a stranger cannot bomb someone's inbox.
   */
  hasActiveLink(userId: number, now: string, since: string): Promise<boolean>
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

interface RedemptionRow {
  userId: number
  flow: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const sha256HexPattern = /^[0-9a-f]{64}$/

const canonicalTimestamp = (value: string, field: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (
    match === null ||
    !Number.isFinite(epoch) ||
    new Date(epoch).toISOString() !== value
  ) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
  return value
}

const digest = (value: string, field: string): string => {
  if (!sha256HexPattern.test(value)) {
    throw new RangeError(`${field} is invalid`)
  }
  return value
}

const userIdentifier = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('staff magic link user id is invalid')
  }
  return value
}

const flowValue = (value: string): StaffMagicLinkFlow => {
  if (value !== 'app' && value !== 'web') {
    throw new RangeError('staff magic link flow is invalid')
  }
  return value
}

const redemption = (
  row: RedemptionRow | undefined
): StaffMagicLinkRedemption | null => {
  if (row === undefined) return null
  return { userId: userIdentifier(row.userId), flow: flowValue(row.flow) }
}

const createStaffMagicLinkStore = (
  database: PortableDatabase
): StaffMagicLinkStore => ({
  create: async (input) => {
    const userId = userIdentifier(input.userId)
    const tokenHash = digest(input.tokenHash, 'staff magic link token hash')
    const codeHash = digest(input.codeHash, 'staff magic link code hash')
    const flow = flowValue(input.flow)
    const createdAt = canonicalTimestamp(input.createdAt, 'creation time')
    const expiresAt = canonicalTimestamp(input.expiresAt, 'expiry')
    const cleanupBefore = canonicalTimestamp(input.cleanupBefore, 'cleanup threshold')
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new RangeError('staff magic link expiry must follow creation')
    }
    if (Date.parse(cleanupBefore) >= Date.parse(createdAt)) {
      throw new RangeError('staff magic link cleanup threshold must precede creation')
    }
    const rows = await database.atomic([
      {
        query: `DELETE FROM staff_magic_links
          WHERE julianday(expires_at) <= julianday(?)
            OR (consumed_at IS NOT NULL AND julianday(consumed_at) <= julianday(?))`,
        bindings: [createdAt, cleanupBefore],
      },
      {
        query: `INSERT INTO staff_magic_links (
            user_id, token_hash, code_hash, flow, attempts,
            expires_at, consumed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?)
          ON CONFLICT(token_hash) DO NOTHING
          RETURNING id`,
        bindings: [userId, tokenHash, codeHash, flow, expiresAt, createdAt, createdAt],
      },
    ])
    return rows[1]?.length === 1 ? 'created' : 'collision'
  },
  consumeByToken: async (presentedTokenHash, now) => {
    const tokenHash = digest(presentedTokenHash, 'staff magic link token hash')
    const consumedAt = canonicalTimestamp(now, 'consumption time')
    const rows = await database.atomic([
      {
        query: `UPDATE staff_magic_links
          SET consumed_at = ?, updated_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?)
          RETURNING user_id AS userId, flow`,
        bindings: [consumedAt, consumedAt, tokenHash, consumedAt],
      },
    ])
    return redemption(rows[0]?.[0] as unknown as RedemptionRow | undefined)
  },
  consumeByCode: async (presentedUserId, presentedCodeHash, now, maxAttempts) => {
    const userId = userIdentifier(presentedUserId)
    const codeHash = digest(presentedCodeHash, 'staff magic link code hash')
    const consumedAt = canonicalTimestamp(now, 'consumption time')
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError('staff magic link max attempts must be a positive integer')
    }
    const rows = await database.atomic([
      // Consume only when the code matches an active record under the attempt
      // ceiling.
      {
        query: `UPDATE staff_magic_links
          SET consumed_at = ?, updated_at = ?
          WHERE user_id = ? AND code_hash = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?) AND attempts < ?
          RETURNING user_id AS userId, flow`,
        bindings: [consumedAt, consumedAt, userId, codeHash, consumedAt, maxAttempts],
      },
      // A wrong code (nothing consumed above) burns one attempt on the still
      // active record; a consumed row no longer matches, so a success never
      // increments.
      {
        query: `UPDATE staff_magic_links
          SET attempts = attempts + 1, updated_at = ?
          WHERE user_id = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?) AND attempts < ?`,
        bindings: [consumedAt, userId, consumedAt, maxAttempts],
      },
    ])
    return redemption(rows[0]?.[0] as unknown as RedemptionRow | undefined)
  },
  hasActiveLink: async (presentedUserId, now, since) => {
    const userId = userIdentifier(presentedUserId)
    const nowTs = canonicalTimestamp(now, 'now')
    const sinceTs = canonicalTimestamp(since, 'throttle window start')
    const rows = await database.atomic([
      {
        query: `SELECT 1 AS present FROM staff_magic_links
          WHERE user_id = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?)
            AND julianday(created_at) >= julianday(?)
          LIMIT 1`,
        bindings: [userId, nowTs, sinceTs],
      },
    ])
    return (rows[0]?.length ?? 0) > 0
  },
})

export const createContainerStaffMagicLinkStore = (
  database: BetterSqlite3.Database
): StaffMagicLinkStore => {
  database.pragma('foreign_keys = ON')
  return createStaffMagicLinkStore({
    atomic: async (operations) => {
      const run = database.transaction(() =>
        operations.map(({ query, bindings }) => {
          const statement = database.prepare(query)
          if (!statement.reader) {
            statement.run(...bindings)
            return []
          }
          return statement.all(...bindings) as Record<string, unknown>[]
        })
      )
      return run()
    },
  })
}

export const createD1StaffMagicLinkStore = (
  database: D1Database
): StaffMagicLinkStore =>
  createStaffMagicLinkStore({
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) =>
          database.prepare(query).bind(...bindings)
        )
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  })
