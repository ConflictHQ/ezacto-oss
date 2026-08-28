import type BetterSqlite3 from 'better-sqlite3'
import type { ResolvedUserIdentity, UserProfile } from '@ezacto/core'

export const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1_000
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000

export type SessionRevocationReason =
  'user_revoked' | 'privilege_change' | 'password_reset' | 'user_disabled'

export interface SessionMetadata {
  id: number
  userId: number
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
  revocationReason: SessionRevocationReason | null
}

export interface IssuedSession {
  token: string
  session: SessionMetadata
}

export interface AuthenticatedSession {
  principal: ResolvedUserIdentity
  session: SessionMetadata
  rotatedToken?: string
}

export interface SessionStore {
  issue(userId: number): Promise<IssuedSession>
  authenticate(token: string): Promise<AuthenticatedSession | null>
  list(userId: number): Promise<SessionMetadata[]>
  revoke(userId: number, sessionId: number): Promise<SessionMetadata | null>
  revokeAll(
    userId: number,
    reason?: Exclude<SessionRevocationReason, 'privilege_change'>,
  ): Promise<number>
}

export interface SessionStoreOptions {
  now?: () => string
  idleTtlMs?: number
  absoluteTtlMs?: number
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

interface SessionRow {
  id: number
  userId: number
  profileSnapshot: string
  managerGrantsSnapshot: string
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
  revocationReason: SessionRevocationReason | null
}

interface CandidateRow extends SessionRow {
  currentProfile: string
  currentManagerGrants: string
  isActive: number
}

interface TokenMaterial {
  selector: string
  secretHash: string
  token: string
}

const profiles: readonly UserProfile[] = [
  'member',
  'project_manager',
  'people_admin',
  'accounting',
  'executive_manager',
  'administrator',
]

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const sessionTokenPattern = /^ezacto_session_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('session store clock must return a canonical UTC timestamp')
  }
}

const positiveTtl = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

const futureTimestamp = (now: string, milliseconds: number): string =>
  new Date(Date.parse(now) + milliseconds).toISOString()

const randomBase64Url = (byteLength: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const issueToken = async (): Promise<TokenMaterial> => {
  const selector = randomBase64Url(12)
  const secret = randomBase64Url(32)
  const token = `ezacto_session_${selector}_${secret}`
  return { selector, secretHash: await sha256Hex(token), token }
}

const prepareToken = async (
  token: string,
): Promise<{ selector: string; secretHash: string } | null> => {
  const match = sessionTokenPattern.exec(token)
  if (match === null) return null
  return { selector: match[1]!, secretHash: await sha256Hex(token) }
}

const metadata = (row: SessionRow): SessionMetadata => {
  if (
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    !Number.isSafeInteger(row.userId) ||
    row.userId < 1
  ) {
    throw new Error('session store returned malformed identifiers')
  }
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
  }
}

const principal = (
  userId: number,
  profile: string,
  serializedManagerGrants: string,
): ResolvedUserIdentity => {
  if (!Number.isSafeInteger(userId) || userId < 1 || !profiles.includes(profile as UserProfile)) {
    throw new Error('session store returned malformed principal state')
  }
  let grants: unknown
  try {
    grants = JSON.parse(serializedManagerGrants)
  } catch {
    throw new Error('session store returned malformed manager grants')
  }
  if (!Array.isArray(grants) || !grants.every((grant) => typeof grant === 'string')) {
    throw new Error('session store returned malformed manager grants')
  }
  return { userId, profile: profile as UserProfile, managerGrants: grants }
}

const rowColumns = (alias = '') => {
  const prefix = alias === '' ? '' : `${alias}.`
  return `${prefix}id, ${prefix}user_id AS userId,
    ${prefix}profile_snapshot AS profileSnapshot,
    ${prefix}manager_grants_snapshot AS managerGrantsSnapshot,
    ${prefix}created_at AS createdAt, ${prefix}last_seen_at AS lastSeenAt,
    ${prefix}idle_expires_at AS idleExpiresAt,
    ${prefix}absolute_expires_at AS absoluteExpiresAt,
    ${prefix}revoked_at AS revokedAt, ${prefix}revocation_reason AS revocationReason`
}

const isSelectorCollision = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: sessions\.selector/i.test(error.message)

const createSessionStore = (
  database: PortableDatabase,
  {
    now = () => new Date().toISOString(),
    idleTtlMs = SESSION_IDLE_TTL_MS,
    absoluteTtlMs = SESSION_ABSOLUTE_TTL_MS,
  }: SessionStoreOptions = {},
): SessionStore => {
  positiveTtl(idleTtlMs, 'idleTtlMs')
  positiveTtl(absoluteTtlMs, 'absoluteTtlMs')

  const issue = async (userId: number): Promise<IssuedSession> => {
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new RangeError('session user id must be a positive safe integer')
    }
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    const absoluteExpiresAt = futureTimestamp(timestamp, absoluteTtlMs)
    const requestedIdleExpiry = futureTimestamp(timestamp, idleTtlMs)
    const idleExpiresAt =
      Date.parse(requestedIdleExpiry) < Date.parse(absoluteExpiresAt)
        ? requestedIdleExpiry
        : absoluteExpiresAt

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const material = await issueToken()
      try {
        const rows = await database.atomic([
          {
            query: `INSERT INTO sessions (
                user_id, selector, secret_hash, profile_snapshot,
                manager_grants_snapshot, created_at, last_seen_at,
                idle_expires_at, absolute_expires_at, revoked_at,
                revocation_reason, rotation_nonce, updated_at
              )
              SELECT id, ?, ?, profile, manager_grants, ?, ?, ?, ?, NULL, NULL, NULL, ?
              FROM users WHERE id = ? AND is_active = 1
              RETURNING ${rowColumns()}`,
            bindings: [
              material.selector,
              material.secretHash,
              timestamp,
              timestamp,
              idleExpiresAt,
              absoluteExpiresAt,
              timestamp,
              userId,
            ],
          },
        ])
        const row = rows[0]?.[0] as unknown as SessionRow | undefined
        if (row === undefined) throw new Error('session user is unavailable or disabled')
        return { token: material.token, session: metadata(row) }
      } catch (error) {
        if (attempt < 3 && isSelectorCollision(error)) continue
        throw error
      }
    }
    throw new Error('session token selector collision retry exhausted')
  }

  const authenticate = async (token: string): Promise<AuthenticatedSession | null> => {
    const prepared = await prepareToken(token)
    if (prepared === null) return null
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    const requestedIdleExpiry = futureTimestamp(timestamp, idleTtlMs)
    const rows = await database.atomic([
      {
        query: `UPDATE sessions SET
            last_seen_at = ?,
            idle_expires_at = CASE
              WHEN julianday(?) < julianday(absolute_expires_at) THEN ?
              ELSE absolute_expires_at
            END,
            updated_at = ?
          WHERE selector = ? AND secret_hash = ? AND revoked_at IS NULL
            AND julianday(idle_expires_at) > julianday(?)
            AND julianday(absolute_expires_at) > julianday(?)
            AND julianday(?) >= julianday(last_seen_at)
            AND EXISTS (
              SELECT 1 FROM users user WHERE user.id = sessions.user_id
                AND user.is_active = 1
                AND user.profile = sessions.profile_snapshot
                AND user.manager_grants = sessions.manager_grants_snapshot
            )
          RETURNING ${rowColumns()}`,
        bindings: [
          timestamp,
          requestedIdleExpiry,
          requestedIdleExpiry,
          timestamp,
          prepared.selector,
          prepared.secretHash,
          timestamp,
          timestamp,
          timestamp,
        ],
      },
      {
        query: `SELECT ${rowColumns('session')},
            user.profile AS currentProfile,
            user.manager_grants AS currentManagerGrants,
            user.is_active AS isActive
          FROM sessions session JOIN users user ON user.id = session.user_id
          WHERE session.selector = ? AND session.secret_hash = ?
            AND session.revoked_at IS NULL
            AND julianday(session.idle_expires_at) > julianday(?)
            AND julianday(session.absolute_expires_at) > julianday(?)
          LIMIT 1`,
        bindings: [prepared.selector, prepared.secretHash, timestamp, timestamp],
      },
    ])
    const touched = rows[0]?.[0] as unknown as SessionRow | undefined
    if (touched !== undefined) {
      return {
        principal: principal(
          touched.userId,
          touched.profileSnapshot,
          touched.managerGrantsSnapshot,
        ),
        session: metadata(touched),
      }
    }

    const candidate = rows[1]?.[0] as unknown as CandidateRow | undefined
    if (candidate === undefined) return null
    if (candidate.isActive !== 1) {
      await database.atomic([
        {
          query: `UPDATE sessions SET revoked_at = ?, revocation_reason = 'user_disabled',
              updated_at = ?
            WHERE id = ? AND revoked_at IS NULL RETURNING id`,
          bindings: [timestamp, timestamp, candidate.id],
        },
      ])
      return null
    }

    const material = await issueToken()
    const nonce = randomBase64Url(12)
    const rotatedRows = await database.atomic([
      {
        query: `UPDATE sessions SET revoked_at = ?, revocation_reason = 'privilege_change',
            rotation_nonce = ?, updated_at = ?
          WHERE id = ? AND selector = ? AND secret_hash = ? AND revoked_at IS NULL
            AND julianday(idle_expires_at) > julianday(?)
            AND julianday(absolute_expires_at) > julianday(?)
            AND EXISTS (
              SELECT 1 FROM users user WHERE user.id = sessions.user_id
                AND user.is_active = 1
                AND (
                  user.profile <> sessions.profile_snapshot
                  OR user.manager_grants <> sessions.manager_grants_snapshot
                )
            )
          RETURNING id`,
        bindings: [
          timestamp,
          nonce,
          timestamp,
          candidate.id,
          prepared.selector,
          prepared.secretHash,
          timestamp,
          timestamp,
        ],
      },
      {
        query: `INSERT INTO sessions (
            user_id, selector, secret_hash, profile_snapshot,
            manager_grants_snapshot, created_at, last_seen_at,
            idle_expires_at, absolute_expires_at, revoked_at,
            revocation_reason, rotation_nonce, updated_at
          )
          SELECT old.user_id, ?, ?, user.profile, user.manager_grants, ?, ?,
            CASE
              WHEN julianday(?) < julianday(old.absolute_expires_at) THEN ?
              ELSE old.absolute_expires_at
            END,
            old.absolute_expires_at, NULL, NULL, NULL, ?
          FROM sessions old JOIN users user ON user.id = old.user_id
          WHERE old.id = ? AND old.rotation_nonce = ?
            AND old.revocation_reason = 'privilege_change' AND user.is_active = 1
          RETURNING ${rowColumns()}`,
        bindings: [
          material.selector,
          material.secretHash,
          timestamp,
          timestamp,
          requestedIdleExpiry,
          requestedIdleExpiry,
          timestamp,
          candidate.id,
          nonce,
        ],
      },
    ])
    if (rotatedRows[0]?.length !== 1 || rotatedRows[1]?.length !== 1) return null
    const rotated = rotatedRows[1]![0] as unknown as SessionRow
    return {
      principal: principal(rotated.userId, rotated.profileSnapshot, rotated.managerGrantsSnapshot),
      session: metadata(rotated),
      rotatedToken: material.token,
    }
  }

  return {
    issue,
    authenticate,
    list: async (userId) => {
      if (!Number.isSafeInteger(userId) || userId < 1) return []
      const rows = await database.atomic([
        {
          query: `SELECT ${rowColumns()} FROM sessions
            WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
          bindings: [userId],
        },
      ])
      return (rows[0] as unknown as SessionRow[]).map(metadata)
    },
    revoke: async (userId, sessionId) => {
      if (
        !Number.isSafeInteger(userId) ||
        userId < 1 ||
        !Number.isSafeInteger(sessionId) ||
        sessionId < 1
      ) {
        return null
      }
      const timestamp = now()
      assertCanonicalTimestamp(timestamp)
      const rows = await database.atomic([
        {
          query: `UPDATE sessions SET revoked_at = ?, revocation_reason = 'user_revoked',
              updated_at = ?
            WHERE id = ? AND user_id = ? AND revoked_at IS NULL
            RETURNING ${rowColumns()}`,
          bindings: [timestamp, timestamp, sessionId, userId],
        },
        {
          query: `SELECT ${rowColumns()} FROM sessions WHERE id = ? AND user_id = ? LIMIT 1`,
          bindings: [sessionId, userId],
        },
      ])
      const row = (rows[0]?.[0] ?? rows[1]?.[0]) as unknown as SessionRow | undefined
      return row === undefined ? null : metadata(row)
    },
    revokeAll: async (userId, reason = 'user_revoked') => {
      if (!Number.isSafeInteger(userId) || userId < 1) return 0
      const timestamp = now()
      assertCanonicalTimestamp(timestamp)
      const rows = await database.atomic([
        {
          query: `UPDATE sessions SET revoked_at = ?, revocation_reason = ?, updated_at = ?
            WHERE user_id = ? AND revoked_at IS NULL RETURNING id`,
          bindings: [timestamp, reason, timestamp, userId],
        },
      ])
      return rows[0]?.length ?? 0
    },
  }
}

export const createContainerSessionStore = (
  database: BetterSqlite3.Database,
  options: SessionStoreOptions = {},
): SessionStore => {
  database.pragma('foreign_keys = ON')
  const portable: PortableDatabase = {
    atomic: async (operations) => {
      const run = database.transaction(() =>
        operations.map(
          ({ query, bindings }) =>
            database.prepare(query).all(...bindings) as Record<string, unknown>[],
        ),
      )
      return run()
    },
  }
  return createSessionStore(portable, options)
}

export const createD1SessionStore = (
  database: D1Database,
  options: SessionStoreOptions = {},
): SessionStore => {
  const portable: PortableDatabase = {
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  }
  return createSessionStore(portable, options)
}
