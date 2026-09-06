/**
 * Contact session store. Mirrors the user session store pattern but operates
 * on the `contact_sessions` table and returns contact-typed principals.
 *
 * Contact sessions are simpler than user sessions: no profile snapshots,
 * no credential version gating, no privilege rotation.
 */

import type BetterSqlite3 from 'better-sqlite3'

export const CONTACT_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1_000
export const CONTACT_SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1_000

export interface ContactSessionMetadata {
  id: number
  contactId: number
  clientId: number
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
}

export interface IssuedContactSession {
  token: string
  session: ContactSessionMetadata
}

export interface AuthenticatedContactSession {
  contactId: number
  clientId: number
  session: ContactSessionMetadata
}

export interface ContactSessionStore {
  issue(contactId: number, clientId: number): Promise<IssuedContactSession>
  authenticate(token: string): Promise<AuthenticatedContactSession | null>
}

export interface ContactSessionStoreOptions {
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
  contactId: number
  clientId: number
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
}

interface TokenMaterial {
  selector: string
  secretHash: string
  token: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const contactTokenPattern = /^ezacto_portal_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('contact session store clock must return a canonical UTC timestamp')
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
  const token = `ezacto_portal_${selector}_${secret}`
  return { selector, secretHash: await sha256Hex(token), token }
}

const prepareToken = async (
  token: string,
): Promise<{ selector: string; secretHash: string } | null> => {
  const match = contactTokenPattern.exec(token)
  if (match === null) return null
  return { selector: match[1]!, secretHash: await sha256Hex(token) }
}

const metadata = (row: SessionRow): ContactSessionMetadata => ({
  id: row.id,
  contactId: row.contactId,
  clientId: row.clientId,
  createdAt: row.createdAt,
  lastSeenAt: row.lastSeenAt,
  idleExpiresAt: row.idleExpiresAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  revokedAt: row.revokedAt,
})

const rowColumns = (alias = '') => {
  const prefix = alias === '' ? '' : `${alias}.`
  return `${prefix}id, ${prefix}contact_id AS contactId,
    ${prefix}client_id AS clientId,
    ${prefix}created_at AS createdAt, ${prefix}last_seen_at AS lastSeenAt,
    ${prefix}idle_expires_at AS idleExpiresAt,
    ${prefix}absolute_expires_at AS absoluteExpiresAt,
    ${prefix}revoked_at AS revokedAt`
}

const isSelectorCollision = (error: unknown): boolean =>
  error instanceof Error &&
  /(UNIQUE constraint failed: contact_sessions\.selector|contact session selector collision)/i.test(
    error.message,
  )

const createContactSessionStore = (
  database: PortableDatabase,
  {
    now = () => new Date().toISOString(),
    idleTtlMs = CONTACT_SESSION_IDLE_TTL_MS,
    absoluteTtlMs = CONTACT_SESSION_ABSOLUTE_TTL_MS,
  }: ContactSessionStoreOptions = {},
): ContactSessionStore => {
  positiveTtl(idleTtlMs, 'idleTtlMs')
  positiveTtl(absoluteTtlMs, 'absoluteTtlMs')

  return {
    issue: async (contactId, clientId) => {
      if (
        !Number.isSafeInteger(contactId) || contactId < 1 ||
        !Number.isSafeInteger(clientId) || clientId < 1
      ) {
        throw new RangeError('contact and client ids must be positive safe integers')
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
              query: `INSERT INTO contact_sessions (
                  contact_id, client_id, selector, secret_hash,
                  created_at, last_seen_at, idle_expires_at,
                  absolute_expires_at, revoked_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                RETURNING ${rowColumns()}`,
              bindings: [
                contactId,
                clientId,
                material.selector,
                material.secretHash,
                timestamp,
                timestamp,
                idleExpiresAt,
                absoluteExpiresAt,
                timestamp,
              ],
            },
          ])
          const row = rows[0]?.[0] as unknown as SessionRow | undefined
          if (row === undefined) {
            throw new Error('contact session insert did not return a row')
          }
          return { token: material.token, session: metadata(row) }
        } catch (error) {
          if (attempt < 3 && isSelectorCollision(error)) continue
          throw error
        }
      }
      throw new Error('contact session token selector collision retry exhausted')
    },

    authenticate: async (token) => {
      const prepared = await prepareToken(token)
      if (prepared === null) return null
      const timestamp = now()
      assertCanonicalTimestamp(timestamp)
      const requestedIdleExpiry = futureTimestamp(timestamp, idleTtlMs)
      const rows = await database.atomic([
        {
          query: `UPDATE contact_sessions SET
              last_seen_at = CASE
                WHEN julianday(?) > julianday(last_seen_at) THEN ?
                ELSE last_seen_at
              END,
              idle_expires_at = CASE
                WHEN julianday(?) <= julianday(idle_expires_at) THEN idle_expires_at
                WHEN julianday(?) < julianday(absolute_expires_at) THEN ?
                ELSE absolute_expires_at
              END,
              updated_at = CASE
                WHEN julianday(?) > julianday(updated_at) THEN ?
                ELSE updated_at
              END
            WHERE selector = ? AND secret_hash = ? AND revoked_at IS NULL
              AND julianday(idle_expires_at) > julianday(?)
              AND julianday(absolute_expires_at) > julianday(?)
            RETURNING ${rowColumns()}`,
          bindings: [
            timestamp,
            timestamp,
            requestedIdleExpiry,
            requestedIdleExpiry,
            requestedIdleExpiry,
            timestamp,
            timestamp,
            prepared.selector,
            prepared.secretHash,
            timestamp,
            timestamp,
          ],
        },
      ])
      const row = rows[0]?.[0] as unknown as SessionRow | undefined
      if (row === undefined) return null
      return {
        contactId: row.contactId,
        clientId: row.clientId,
        session: metadata(row),
      }
    },
  }
}

export const createContainerContactSessionStore = (
  database: BetterSqlite3.Database,
  options: ContactSessionStoreOptions = {},
): ContactSessionStore => {
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
  return createContactSessionStore(portable, options)
}

export const createD1ContactSessionStore = (
  database: D1Database,
  options: ContactSessionStoreOptions = {},
): ContactSessionStore => {
  const portable: PortableDatabase = {
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  }
  return createContactSessionStore(portable, options)
}
