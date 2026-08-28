import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import {
  isApiScope,
  profilesAllowedEveryApiScope,
  type ApiScope,
  type UserProfile,
} from '@ezacto/core'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export type { UserProfile } from '@ezacto/core'

export interface ApiTokenMetadata {
  id: number
  name: string
  scopes: string[]
  tokenHint: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export interface IssuedApiToken extends ApiTokenMetadata {
  /** Returned once. Only its SHA-256 digest is persisted. */
  token: string
}

export interface AuthenticatedApiToken {
  tokenId: number
  userId: number
  profile: UserProfile
  scopes: string[]
}

export interface IssueApiTokenInput {
  userId: number
  name: string
  scopes: readonly string[]
  createdAt: string
  expiresAt?: string | null
}

export interface RevokeApiTokenInput {
  userId: number
  tokenId: number
  revokedAt: string
}

export interface ApiTokenStore {
  authenticate(token: string): Promise<AuthenticatedApiToken | null>
  issue(input: Omit<IssueApiTokenInput, 'createdAt'>): Promise<IssuedApiToken>
  list(userId: number): Promise<ApiTokenMetadata[]>
  revoke(userId: number, tokenId: number): Promise<ApiTokenMetadata | null>
}

export interface CreateApiTokenStoreOptions {
  now?: () => string
}

interface TokenRow {
  id: number
  userId: number
  selector: string
  secretHash: string
  name: string
  scopes: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

const tokenPattern = /^ezacto_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const dummySecretHash = '0'.repeat(64)

const assertPositiveSafeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
}

const assertCanonicalTimestamp = (value: string, field: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  if (!match) throw new RangeError(`${field} must be a canonical UTC timestamp`)
  const epoch = Date.parse(value)
  const date = new Date(epoch)
  if (
    !Number.isFinite(epoch) ||
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3]) ||
    date.getUTCHours() !== Number(match[4]) ||
    date.getUTCMinutes() !== Number(match[5]) ||
    date.getUTCSeconds() !== Number(match[6]) ||
    date.getUTCMilliseconds() !== Number((match[7] ?? '').padEnd(3, '0') || 0)
  ) {
    throw new RangeError(`${field} must be a real canonical UTC timestamp`)
  }
}

const normalizeScopes = (scopes: readonly string[]): ApiScope[] => {
  if (scopes.length === 0 || scopes.length > 100) {
    throw new RangeError('scopes must contain between 1 and 100 entries')
  }
  const normalized = [...new Set(scopes)]
  if (normalized.length !== scopes.length) throw new RangeError('scopes must not contain duplicates')
  for (const scope of normalized) {
    if (!isApiScope(scope)) {
      throw new RangeError(`invalid API token scope: ${scope}`)
    }
  }
  return normalized.sort() as ApiScope[]
}

const randomBase64Url = (byteLength: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Fixed-work comparison for the stored and presented token digests. */
const constantTimeHashEqual = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  for (let index = 0; index < 64; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

const parseScopes = (serialized: string): ApiScope[] | null => {
  try {
    const value: unknown = JSON.parse(serialized)
    if (!Array.isArray(value) || !value.every((scope) => typeof scope === 'string')) return null
    const normalized = normalizeScopes(value)
    return JSON.stringify(normalized) === JSON.stringify(value) ? normalized : null
  } catch {
    return null
  }
}

const metadataFrom = (row: TokenRow, scopes: string[]): ApiTokenMetadata => ({
  id: row.id,
  name: row.name,
  scopes: [...scopes],
  tokenHint: `ezacto_${row.selector}_…`,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  expiresAt: row.expiresAt,
  revokedAt: row.revokedAt,
})

const tokenRowsForUser = async (database: Database, userId: number): Promise<TokenRow[]> =>
  database.all<TokenRow>(sql`
    SELECT id, user_id AS userId, selector, secret_hash AS secretHash, name, scopes,
      created_at AS createdAt, last_used_at AS lastUsedAt,
      expires_at AS expiresAt, revoked_at AS revokedAt
    FROM api_tokens
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id DESC
  `)

export const issueApiToken = async (
  database: Database,
  input: IssueApiTokenInput,
): Promise<IssuedApiToken> => {
  assertPositiveSafeInteger(input.userId, 'userId')
  assertCanonicalTimestamp(input.createdAt, 'createdAt')
  const name = input.name.trim()
  if (name.length < 1 || name.length > 100) {
    throw new RangeError('name must contain between 1 and 100 characters')
  }
  const scopes = normalizeScopes(input.scopes)
  const expiresAt = input.expiresAt ?? null
  if (expiresAt !== null) {
    assertCanonicalTimestamp(expiresAt, 'expiresAt')
    if (Date.parse(expiresAt) <= Date.parse(input.createdAt)) {
      throw new RangeError('expiresAt must be after createdAt')
    }
  }
  const permittedProfiles = profilesAllowedEveryApiScope(scopes)
  const permittedProfileSql = sql.join(
    permittedProfiles.map((profile) => sql`${profile}`),
    sql`, `,
  )

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const selector = randomBase64Url(12)
    const secret = randomBase64Url(32)
    const token = `ezacto_${selector}_${secret}`
    const secretHash = await sha256Hex(token)
    try {
      const rows = await database.all<TokenRow>(sql`
        INSERT INTO api_tokens (
          user_id, selector, secret_hash, name, scopes, last_used_at,
          expires_at, revoked_at, created_at, updated_at
        )
        SELECT user.id, ${selector}, ${secretHash}, ${name}, ${JSON.stringify(scopes)},
          NULL, ${expiresAt}, NULL, ${input.createdAt}, ${input.createdAt}
        FROM users user
        WHERE user.id = ${input.userId} AND user.is_active = 1
          AND user.profile IN (${permittedProfileSql})
        RETURNING id, user_id AS userId, selector, secret_hash AS secretHash, name, scopes,
          created_at AS createdAt, last_used_at AS lastUsedAt,
          expires_at AS expiresAt, revoked_at AS revokedAt
      `)
      const created = rows[0]
      if (!created) {
        throw new RangeError('active user profile cannot grant the requested API token scopes')
      }
      return { ...metadataFrom(created, scopes), token }
    } catch (error) {
      const collision = await database.all<{ id: number }>(sql`
        SELECT id FROM api_tokens WHERE selector = ${selector} LIMIT 1
      `)
      if (collision.length === 0 || attempt === 3) throw error
    }
  }
  throw new Error('API token selector allocation exhausted')
}

export const listApiTokens = async (
  database: Database,
  userId: number,
): Promise<ApiTokenMetadata[]> => {
  assertPositiveSafeInteger(userId, 'userId')
  const tokens: ApiTokenMetadata[] = []
  for (const row of await tokenRowsForUser(database, userId)) {
    const scopes = parseScopes(row.scopes)
    if (scopes === null) throw new Error(`API token ${row.id} has invalid stored scopes`)
    tokens.push(metadataFrom(row, scopes))
  }
  return tokens
}

export const revokeApiToken = async (
  database: Database,
  input: RevokeApiTokenInput,
): Promise<ApiTokenMetadata | null> => {
  assertPositiveSafeInteger(input.userId, 'userId')
  assertPositiveSafeInteger(input.tokenId, 'tokenId')
  assertCanonicalTimestamp(input.revokedAt, 'revokedAt')
  const rows = await database.all<TokenRow>(sql`
    UPDATE api_tokens
    SET revoked_at = CASE
        WHEN julianday(updated_at) > julianday(${input.revokedAt}) THEN updated_at
        ELSE ${input.revokedAt}
      END,
      updated_at = CASE
        WHEN julianday(updated_at) > julianday(${input.revokedAt}) THEN updated_at
        ELSE ${input.revokedAt}
      END
    WHERE id = ${input.tokenId} AND user_id = ${input.userId} AND revoked_at IS NULL
    RETURNING id, user_id AS userId, selector, secret_hash AS secretHash, name, scopes,
      created_at AS createdAt, last_used_at AS lastUsedAt,
      expires_at AS expiresAt, revoked_at AS revokedAt
  `)
  let row = rows[0]
  if (!row) {
    const existing = await database.all<TokenRow>(sql`
      SELECT id, user_id AS userId, selector, secret_hash AS secretHash, name, scopes,
        created_at AS createdAt, last_used_at AS lastUsedAt,
        expires_at AS expiresAt, revoked_at AS revokedAt
      FROM api_tokens WHERE id = ${input.tokenId} AND user_id = ${input.userId} LIMIT 1
    `)
    row = existing[0]
  }
  if (!row) return null
  const scopes = parseScopes(row.scopes)
  if (scopes === null) throw new Error(`API token ${row.id} has invalid stored scopes`)
  return metadataFrom(row, scopes)
}

export const authenticateApiToken = async (
  database: Database,
  token: string,
  usedAt: string,
): Promise<AuthenticatedApiToken | null> => {
  assertCanonicalTimestamp(usedAt, 'usedAt')
  const presentedHash = await sha256Hex(token)
  const match = tokenPattern.exec(token)
  const selector = match?.[1]
  const rows =
    selector === undefined
      ? []
      : await database.all<TokenRow>(sql`
          SELECT token.id, token.user_id AS userId, token.selector,
            token.secret_hash AS secretHash, token.name, token.scopes,
            token.created_at AS createdAt, token.last_used_at AS lastUsedAt,
            token.expires_at AS expiresAt, token.revoked_at AS revokedAt
          FROM api_tokens token
          WHERE token.selector = ${selector}
          LIMIT 1
        `)
  const row = rows[0]
  const hashMatches = constantTimeHashEqual(row?.secretHash ?? dummySecretHash, presentedHash)
  if (
    row === undefined ||
    !hashMatches ||
    row.revokedAt !== null ||
    (row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.parse(usedAt))
  ) {
    return null
  }
  const scopes = parseScopes(row.scopes)
  if (scopes === null) return null
  const permittedProfiles = profilesAllowedEveryApiScope(scopes)
  const permittedProfileSql = sql.join(
    permittedProfiles.map((profile) => sql`${profile}`),
    sql`, `,
  )

  // This conditional write is the revocation race boundary: middleware only
  // accepts the principal if the token is still active when last-use is recorded.
  const updated = await database.all<{ id: number; userId: number; profile: UserProfile | null }>(sql`
    UPDATE api_tokens
    SET last_used_at = CASE
        WHEN last_used_at IS NULL OR julianday(last_used_at) < julianday(${usedAt}) THEN ${usedAt}
        ELSE last_used_at
      END,
      updated_at = CASE
        WHEN julianday(updated_at) < julianday(${usedAt}) THEN ${usedAt}
        ELSE updated_at
      END
    WHERE id = ${row.id} AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at) > julianday(${usedAt}))
      AND EXISTS (
        SELECT 1 FROM users
        WHERE id = ${row.userId} AND is_active = 1
          AND profile IN (${permittedProfileSql})
    )
    RETURNING id, user_id AS userId,
      (SELECT profile FROM users
        WHERE users.id = api_tokens.user_id AND is_active = 1) AS profile
  `)
  const current = updated[0]
  if (
    current === undefined ||
    current.profile === null ||
    !permittedProfiles.includes(current.profile)
  ) {
    return null
  }
  return {
    tokenId: current.id,
    userId: current.userId,
    profile: current.profile,
    scopes: [...scopes],
  }
}

export const createApiTokenStore = (
  database: Database,
  { now = () => new Date().toISOString() }: CreateApiTokenStoreOptions = {},
): ApiTokenStore => ({
  authenticate: (token) => authenticateApiToken(database, token, now()),
  issue: (input) => issueApiToken(database, { ...input, createdAt: now() }),
  list: (userId) => listApiTokens(database, userId),
  revoke: (userId, tokenId) => revokeApiToken(database, { userId, tokenId, revokedAt: now() }),
})
