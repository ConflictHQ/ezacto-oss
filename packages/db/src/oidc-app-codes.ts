import type BetterSqlite3 from 'better-sqlite3'

export interface OidcAppCode {
  id: number
  provider: string
  userId: number
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

export interface CreateOidcAppCodeInput {
  provider: string
  codeHash: string
  userId: number
  expiresAt: string
  createdAt: string
  /** Expired or already-consumed rows at or before this instant are swept first. */
  cleanupBefore: string
}

export type OidcAppCodeCreation = 'created' | 'collision'

export interface OidcAppCodeStore {
  create(input: CreateOidcAppCodeInput): Promise<OidcAppCodeCreation>
  /** Verify-and-consume a code by its digest; single-use, returns null if unusable. */
  consume(codeHash: string, now: string): Promise<OidcAppCode | null>
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

interface AppCodeRow {
  id: number
  provider: string
  userId: number
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const providerPattern = /^[a-z][a-z0-9._-]{0,99}$/
const sha256HexPattern = /^[0-9a-f]{64}$/

const canonicalTimestamp = (value: string, field: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
  return value
}

const providerKey = (value: string): string => {
  if (!providerPattern.test(value)) {
    throw new RangeError('OIDC provider key is invalid')
  }
  return value
}

const codeDigest = (value: string): string => {
  if (!sha256HexPattern.test(value)) {
    throw new RangeError('OIDC app code digest is invalid')
  }
  return value
}

const userIdentifier = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('OIDC app code user id is invalid')
  }
  return value
}

const rowColumns = `id, provider, user_id AS userId,
  expires_at AS expiresAt, consumed_at AS consumedAt, created_at AS createdAt`

const appCode = (row: AppCodeRow | undefined): OidcAppCode => {
  if (row === undefined || !Number.isSafeInteger(row.id) || row.id < 1) {
    throw new Error('OIDC app code store returned malformed identity')
  }
  providerKey(row.provider)
  userIdentifier(row.userId)
  canonicalTimestamp(row.expiresAt, 'OIDC app code expiry')
  canonicalTimestamp(row.createdAt, 'OIDC app code creation time')
  if (row.consumedAt !== null) {
    canonicalTimestamp(row.consumedAt, 'OIDC app code consumption time')
  }
  return { ...row }
}

const createOidcAppCodeStore = (database: PortableDatabase): OidcAppCodeStore => ({
  create: async (input) => {
    const provider = providerKey(input.provider)
    const codeHash = codeDigest(input.codeHash)
    const userId = userIdentifier(input.userId)
    const createdAt = canonicalTimestamp(input.createdAt, 'OIDC app code creation time')
    const expiresAt = canonicalTimestamp(input.expiresAt, 'OIDC app code expiry')
    const cleanupBefore = canonicalTimestamp(input.cleanupBefore, 'OIDC cleanup threshold')
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new RangeError('OIDC app code expiry must follow creation')
    }
    if (Date.parse(cleanupBefore) >= Date.parse(createdAt)) {
      throw new RangeError('OIDC cleanup threshold must precede creation')
    }
    const rows = await database.atomic([
      {
        query: `DELETE FROM oidc_app_codes
          WHERE julianday(expires_at) <= julianday(?)
            OR (consumed_at IS NOT NULL AND julianday(consumed_at) <= julianday(?))`,
        bindings: [createdAt, cleanupBefore],
      },
      {
        query: `INSERT INTO oidc_app_codes (
            provider, code_hash, user_id, expires_at, consumed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(code_hash) DO NOTHING
          RETURNING id`,
        bindings: [provider, codeHash, userId, expiresAt, createdAt, createdAt],
      },
    ])
    return rows[1]?.length === 1 ? 'created' : 'collision'
  },
  consume: async (presentedCodeHash, now) => {
    const codeHash = codeDigest(presentedCodeHash)
    const consumedAt = canonicalTimestamp(now, 'OIDC app code consumption time')
    const rows = await database.atomic([
      {
        query: `UPDATE oidc_app_codes
          SET consumed_at = ?, updated_at = ?
          WHERE code_hash = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?)
          RETURNING ${rowColumns}`,
        bindings: [consumedAt, consumedAt, codeHash, consumedAt],
      },
    ])
    const row = rows[0]?.[0] as unknown as AppCodeRow | undefined
    return row === undefined ? null : appCode(row)
  },
})

export const createContainerOidcAppCodeStore = (
  database: BetterSqlite3.Database,
): OidcAppCodeStore => {
  database.pragma('foreign_keys = ON')
  return createOidcAppCodeStore({
    atomic: async (operations) => {
      const run = database.transaction(() =>
        operations.map(({ query, bindings }) => {
          const statement = database.prepare(query)
          if (!statement.reader) {
            statement.run(...bindings)
            return []
          }
          return statement.all(...bindings) as Record<string, unknown>[]
        }),
      )
      return run()
    },
  })
}

export const createD1OidcAppCodeStore = (database: D1Database): OidcAppCodeStore =>
  createOidcAppCodeStore({
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  })
