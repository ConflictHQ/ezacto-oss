import type BetterSqlite3 from 'better-sqlite3'
import { normalizeProvisioningDomain } from '@ezacto/core'

/**
 * The domains SSO may create a user for, and the DNS challenge that proves the
 * instance owns each one. Verification lives outside this module — it needs the
 * network — so the store only records what a lookup found; deciding what a TXT
 * answer means is the caller's job.
 */
export interface SsoProvisioningDomainRecord {
  id: number
  domain: string
  challengeToken: string
  verifiedAt: string | null
  lastCheckedAt: string | null
  createdAt: string
  updatedAt: string
}

export type SsoProvisioningDomainErrorCode = 'invalid_domain' | 'conflict' | 'not_found'

export class SsoProvisioningDomainError extends Error {
  constructor(
    readonly code: SsoProvisioningDomainErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SsoProvisioningDomainError'
  }
}

export interface SsoProvisioningDomainStore {
  list(): Promise<readonly SsoProvisioningDomainRecord[]>
  get(id: number): Promise<SsoProvisioningDomainRecord>
  add(domain: string, now: string): Promise<SsoProvisioningDomainRecord>
  remove(id: number): Promise<void>
  /**
   * Record the outcome of a DNS lookup. `verified` false clears `verified_at`
   * rather than leaving it: a domain whose record has been taken down must lose
   * its provisioning rights, or a lapsed claim provisions forever.
   */
  recordCheck(id: number, verified: boolean, checkedAt: string): Promise<SsoProvisioningDomainRecord>
}

export interface SsoProvisioningDomainStoreOptions {
  /** Overridable only so tests can pin the challenge token. */
  challengeToken?: () => string
}

interface Row {
  id: number
  domain: string
  challenge_token: string
  verified_at: string | null
  last_checked_at: string | null
  created_at: string
  updated_at: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('provisioning domain clock must return a canonical UTC timestamp')
  }
  return value
}

/**
 * 32 random bytes, base64url. Not derived from the domain, so a name gives no
 * head start in guessing the value that has to be published under it.
 */
const randomChallengeToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const record = (row: Row): SsoProvisioningDomainRecord => ({
  id: row.id,
  domain: row.domain,
  challengeToken: row.challenge_token,
  verifiedAt: row.verified_at,
  lastCheckedAt: row.last_checked_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const assertDomain = (value: string): string => {
  try {
    return normalizeProvisioningDomain(value)
  } catch {
    throw new SsoProvisioningDomainError(
      'invalid_domain',
      'The provisioning domain must be a DNS name such as example.com.',
    )
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /unique constraint failed/i.test(error.message)

const listQuery = `SELECT id, domain, challenge_token, verified_at, last_checked_at,
    created_at, updated_at
  FROM sso_provisioning_domains ORDER BY domain`

const getQuery = `SELECT id, domain, challenge_token, verified_at, last_checked_at,
    created_at, updated_at
  FROM sso_provisioning_domains WHERE id = ?`

const insertQuery = `INSERT INTO sso_provisioning_domains (
    domain, challenge_token, verified_at, last_checked_at, created_at, updated_at
  ) VALUES (?, ?, NULL, NULL, ?, ?)
  RETURNING id, domain, challenge_token, verified_at, last_checked_at,
    created_at, updated_at`

const deleteQuery = `DELETE FROM sso_provisioning_domains WHERE id = ? RETURNING id`

const recordCheckQuery = `UPDATE sso_provisioning_domains
  SET verified_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
    last_checked_at = ?, updated_at = ?
  WHERE id = ?
  RETURNING id, domain, challenge_token, verified_at, last_checked_at,
    created_at, updated_at`

/**
 * The one question sign-in asks of this table. `verified_at IS NOT NULL` is the
 * whole permission: a row that was added but never proved, or proved and later
 * failed a re-check, answers no.
 */
export const verifiedProvisioningDomainQuery = `SELECT 1 AS permitted
  FROM sso_provisioning_domains
  WHERE domain = ? AND verified_at IS NOT NULL LIMIT 1`

export const createContainerSsoProvisioningDomainStore = (
  database: BetterSqlite3.Database,
  { challengeToken = randomChallengeToken }: SsoProvisioningDomainStoreOptions = {},
): SsoProvisioningDomainStore => {
  database.pragma('foreign_keys = ON')
  const one = (row: Row | undefined, code: SsoProvisioningDomainErrorCode): Row => {
    if (row === undefined) {
      throw new SsoProvisioningDomainError(code, 'The provisioning domain does not exist.')
    }
    return row
  }
  return {
    list: async () => (database.prepare(listQuery).all() as Row[]).map(record),
    get: async (id) => record(one(database.prepare(getQuery).get(id) as Row | undefined, 'not_found')),
    add: async (domain, now) => {
      const timestamp = assertCanonicalTimestamp(now)
      try {
        return record(
          one(
            database
              .prepare(insertQuery)
              .get(assertDomain(domain), challengeToken(), timestamp, timestamp) as Row | undefined,
            'not_found',
          ),
        )
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SsoProvisioningDomainError(
            'conflict',
            'The provisioning domain is already configured.',
          )
        }
        throw error
      }
    },
    remove: async (id) => {
      const removed = database.prepare(deleteQuery).get(id) as { id: number } | undefined
      if (removed === undefined) {
        throw new SsoProvisioningDomainError('not_found', 'The provisioning domain does not exist.')
      }
    },
    recordCheck: async (id, verified, checkedAt) => {
      const timestamp = assertCanonicalTimestamp(checkedAt)
      return record(
        one(
          database
            .prepare(recordCheckQuery)
            .get(verified ? 1 : 0, timestamp, timestamp, timestamp, id) as Row | undefined,
          'not_found',
        ),
      )
    },
  }
}

export const createD1SsoProvisioningDomainStore = (
  database: D1Database,
  { challengeToken = randomChallengeToken }: SsoProvisioningDomainStoreOptions = {},
): SsoProvisioningDomainStore => {
  const one = (row: Row | null): Row => {
    if (row === null) {
      throw new SsoProvisioningDomainError('not_found', 'The provisioning domain does not exist.')
    }
    return row
  }
  return {
    list: async () => (await database.prepare(listQuery).all<Row>()).results.map(record),
    get: async (id) => record(one(await database.prepare(getQuery).bind(id).first<Row>())),
    add: async (domain, now) => {
      const timestamp = assertCanonicalTimestamp(now)
      try {
        return record(
          one(
            await database
              .prepare(insertQuery)
              .bind(assertDomain(domain), challengeToken(), timestamp, timestamp)
              .first<Row>(),
          ),
        )
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new SsoProvisioningDomainError(
            'conflict',
            'The provisioning domain is already configured.',
          )
        }
        throw error
      }
    },
    remove: async (id) => {
      const removed = await database.prepare(deleteQuery).bind(id).first<{ id: number }>()
      if (removed === null) {
        throw new SsoProvisioningDomainError('not_found', 'The provisioning domain does not exist.')
      }
    },
    recordCheck: async (id, verified, checkedAt) => {
      const timestamp = assertCanonicalTimestamp(checkedAt)
      return record(
        one(
          await database
            .prepare(recordCheckQuery)
            .bind(verified ? 1 : 0, timestamp, timestamp, timestamp, id)
            .first<Row>(),
        ),
      )
    },
  }
}
