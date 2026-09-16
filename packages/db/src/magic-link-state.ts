/**
 * Magic-link token DB operations: create, consume (single-use), and clean up.
 *
 * The HMAC verification happens in the core layer; this module manages the
 * durable single-use guarantee and the contact identity lookup for session
 * issuance.
 */

import type BetterSqlite3 from 'better-sqlite3'

export interface MagicLinkRecord {
  id: number
  jti: string
  contactEmail: string
  contactId: number
  clientId: number
  expiresAt: string
  usedAt: string | null
  createdAt: string
}

export interface MagicLinkCreateInput {
  jti: string
  contactEmail: string
  contactId: number
  clientId: number
  tokenHash: string
  expiresAt: string
}

export interface MagicLinkConsumeResult {
  contactId: number
  clientId: number
  contactEmail: string
}

export interface MagicLinkStore {
  create(input: MagicLinkCreateInput): Promise<MagicLinkRecord>
  consume(jti: string): Promise<MagicLinkConsumeResult | null>
  /**
   * Whether this address already has an unused, unexpired link issued since
   * `since`. The portal throttle (#734): without it, an unauthenticated caller
   * could have us mail any known contact as fast as it could post, and every
   * request left a row behind for good.
   */
  hasActiveLink(contactEmail: string, now: string, since: string): Promise<boolean>
}

export interface MagicLinkStoreOptions {
  now?: () => string
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('magic link store clock must return a canonical UTC timestamp')
  }
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const createMagicLinkStore = (
  database: PortableDatabase,
  { now = () => new Date().toISOString() }: MagicLinkStoreOptions = {},
): MagicLinkStore => ({
  create: async (input) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    const rows = await database.atomic([
      {
        // Sweep before inserting, the way the staff store does. Nothing else
        // ever deleted from this table, so it grew one row per request for
        // ever, including every request that was never clicked.
        query: `DELETE FROM magic_link_tokens
          WHERE julianday(expires_at) <= julianday(?)
             OR used_at IS NOT NULL`,
        bindings: [timestamp],
      },
      {
        query: `INSERT INTO magic_link_tokens (
            jti, contact_email, contact_id, client_id, token_hash,
            expires_at, used_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
          RETURNING id, jti, contact_email AS contactEmail,
            contact_id AS contactId, client_id AS clientId,
            expires_at AS expiresAt, used_at AS usedAt, created_at AS createdAt`,
        bindings: [
          input.jti,
          input.contactEmail,
          input.contactId,
          input.clientId,
          input.tokenHash,
          input.expiresAt,
          timestamp,
        ],
      },
    ])
    const row = rows[1]?.[0] as unknown as MagicLinkRecord | undefined
    if (row === undefined) {
      throw new Error('magic link token insert did not return a row')
    }
    return row
  },

  hasActiveLink: async (contactEmail, now, since) => {
    assertCanonicalTimestamp(now)
    assertCanonicalTimestamp(since)
    const rows = await database.atomic([
      {
        query: `SELECT 1 AS present FROM magic_link_tokens
          WHERE lower(contact_email) = lower(?) AND used_at IS NULL
            AND julianday(expires_at) > julianday(?)
            AND julianday(created_at) >= julianday(?)
          LIMIT 1`,
        bindings: [contactEmail, now, since],
      },
    ])
    return (rows[0]?.length ?? 0) > 0
  },

  consume: async (jti) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    const rows = await database.atomic([
      {
        query: `UPDATE magic_link_tokens
          SET used_at = ?
          WHERE jti = ?
            AND used_at IS NULL
            AND julianday(expires_at) > julianday(?)
          RETURNING contact_id AS contactId, client_id AS clientId,
            contact_email AS contactEmail`,
        bindings: [timestamp, jti, timestamp],
      },
    ])
    const row = rows[0]?.[0] as unknown as MagicLinkConsumeResult | undefined
    return row ?? null
  },
})

export const createContainerMagicLinkStore = (
  database: BetterSqlite3.Database,
  options: MagicLinkStoreOptions = {},
): MagicLinkStore => {
  database.pragma('foreign_keys = ON')
  const portable: PortableDatabase = {
    atomic: async (operations) => {
      const run = database.transaction(() =>
        operations.map(({ query, bindings }) => {
          const statement = database.prepare(query)
          // better-sqlite3 refuses .all() on a statement that returns nothing,
          // which the sweep added in #734 is. Same shape as the staff store.
          if (!statement.reader) {
            statement.run(...bindings)
            return []
          }
          return statement.all(...bindings) as Record<string, unknown>[]
        }),
      )
      return run()
    },
  }
  return createMagicLinkStore(portable, options)
}

export const createD1MagicLinkStore = (
  database: D1Database,
  options: MagicLinkStoreOptions = {},
): MagicLinkStore => {
  const portable: PortableDatabase = {
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  }
  return createMagicLinkStore(portable, options)
}

/** Exported for token hash generation in the API layer. */
export { sha256Hex as magicLinkTokenHash }
