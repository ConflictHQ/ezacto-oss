import type BetterSqlite3 from 'better-sqlite3'
import {
  normalizeIdentityEmail,
  normalizeProviderIdentityAssertion,
  type EmailSignInResolution,
  type NormalizedProviderIdentityAssertion,
  type ProviderIdentityAssertion,
  type ProviderIdentityMatch,
  type ProviderIdentityResolution,
  type UserProfile,
} from '@ezacto/core'

export interface IdentityStore {
  resolveProvider(assertion: ProviderIdentityAssertion): Promise<ProviderIdentityResolution>
  resolveEmail(address: string): Promise<EmailSignInResolution>
}

export interface IdentityStoreOptions {
  now?: () => string
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface IdentityRow {
  userId: number
  profile: string
  managerGrants: string
  isActive: number
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('identity store clock must return a canonical UTC timestamp')
  }
}

const identityQuery = `SELECT user.id AS userId, user.profile, user.manager_grants AS managerGrants,
    user.is_active AS isActive
  FROM user_identities identity
  JOIN users user ON user.id = identity.user_id
  WHERE identity.provider = ? AND identity.provider_subject = ?
  LIMIT 1`

const emailQuery = `SELECT user.id AS userId, user.profile, user.manager_grants AS managerGrants,
    user.is_active AS isActive
  FROM user_emails email
  JOIN users user ON user.id = email.user_id
  WHERE lower(email.address) = lower(?)
    AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
  LIMIT 1`

const linkVerifiedEmail = (
  input: NormalizedProviderIdentityAssertion,
  timestamp: string,
): Operation => ({
  query: `INSERT INTO user_identities (
      user_id, provider, provider_subject, created_at, updated_at
    )
    SELECT email.user_id, ?, ?, ?, ?
    FROM user_emails email
    JOIN users user ON user.id = email.user_id
    WHERE ? = 1 AND lower(email.address) = lower(?)
      AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_identities identity
        WHERE identity.provider = ? AND identity.provider_subject = ?
      )
    LIMIT 1
    ON CONFLICT(provider, provider_subject) DO NOTHING
    RETURNING user_id AS userId`,
  bindings: [
    input.provider,
    input.subject,
    timestamp,
    timestamp,
    input.emailVerified ? 1 : 0,
    input.email,
    input.provider,
    input.subject,
  ],
})

const createUser = (
  input: NormalizedProviderIdentityAssertion,
  userId: number,
  timestamp: string,
): Operation => {
  if (input.firstName === undefined || input.lastName === undefined) {
    throw new RangeError(
      'provider profile firstName and lastName are required to create a user',
    )
  }
  return {
    query: `INSERT INTO users (
      id, first_name, last_name, timezone, is_contractor, is_active,
      has_access_to_all_future_projects, weekly_capacity, profile,
      manager_grants, is_owner, saml_exempt, created_at, updated_at
    )
    SELECT ?, ?, ?, 'UTC', 0, 1, 0, 126000, 'member', '[]', 0, 0, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM user_identities identity
      WHERE identity.provider = ? AND identity.provider_subject = ?
    )
    RETURNING id AS userId`,
  bindings: [
    userId,
    input.firstName,
    input.lastName,
    timestamp,
    timestamp,
    input.provider,
    input.subject,
  ],
  }
}

const createEmail = (
  input: NormalizedProviderIdentityAssertion,
  userId: number,
  timestamp: string,
): Operation => ({
  query: `INSERT INTO user_emails (
      user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM user_identities identity
        WHERE identity.provider = ? AND identity.provider_subject = ?
      )`,
  bindings: [
    userId,
    input.email,
    input.emailVerified ? timestamp : null,
    input.emailVerified ? 1 : 0,
    timestamp,
    timestamp,
    userId,
    input.provider,
    input.subject,
  ],
})

const linkCreatedUser = (
  input: NormalizedProviderIdentityAssertion,
  userId: number,
  timestamp: string,
): Operation => ({
  query: `INSERT INTO user_identities (
      user_id, provider, provider_subject, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM user_identities identity
        WHERE identity.provider = ? AND identity.provider_subject = ?
      )`,
  bindings: [
    userId,
    input.provider,
    input.subject,
    timestamp,
    timestamp,
    userId,
    input.provider,
    input.subject,
  ],
})

const parseIdentity = (
  row: IdentityRow | undefined,
  matchedBy: ProviderIdentityMatch,
): ProviderIdentityResolution => {
  if (row === undefined) throw new Error('provider identity resolution did not produce a user')
  if (
    !Number.isSafeInteger(row.userId) ||
    row.userId < 1 ||
    ![
      'member',
      'project_manager',
      'people_admin',
      'accounting',
      'executive_manager',
      'administrator',
    ].includes(row.profile)
  ) {
    throw new Error('provider identity resolved malformed user state')
  }
  let managerGrants: unknown
  try {
    managerGrants = JSON.parse(row.managerGrants)
  } catch {
    throw new Error('provider identity resolved malformed manager grants')
  }
  if (!Array.isArray(managerGrants) || !managerGrants.every((grant) => typeof grant === 'string')) {
    throw new Error('provider identity resolved malformed manager grants')
  }
  return {
    status: row.isActive === 1 ? 'active' : 'disabled',
    matchedBy,
    userId: row.userId,
    profile: row.profile as UserProfile,
    managerGrants,
  }
}

const parseEmail = (row: IdentityRow | undefined): EmailSignInResolution => {
  if (row === undefined || row.isActive !== 1) return { status: 'verification_required' }
  const resolved = parseIdentity(row, 'verified_email')
  return {
    status: 'active',
    userId: resolved.userId,
    profile: resolved.profile,
    managerGrants: resolved.managerGrants,
  }
}

const nextUserIdQuery = `SELECT coalesce(max(id), 0) + 1 AS userId FROM users`

const isUserIdCollision = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: users\.id/i.test(error.message)

export const createContainerIdentityStore = (
  database: BetterSqlite3.Database,
  { now = () => new Date().toISOString() }: IdentityStoreOptions = {},
): IdentityStore => {
  database.pragma('foreign_keys = ON')
  return {
    resolveProvider: async (assertion) => {
      const input = normalizeProviderIdentityAssertion(assertion)
      const timestamp = now()
      assertCanonicalTimestamp(timestamp)
      const run = database.transaction((): ProviderIdentityResolution => {
        const existing = database.prepare(identityQuery).get(input.provider, input.subject) as
          IdentityRow | undefined
        if (existing !== undefined) return parseIdentity(existing, 'subject')

        const next = database.prepare(nextUserIdQuery).get() as { userId: number }
        const link = linkVerifiedEmail(input, timestamp)
        const linked = database.prepare(link.query).get(...link.bindings) as
          { userId: number } | undefined
        if (linked !== undefined) {
          const row = database.prepare(identityQuery).get(input.provider, input.subject) as
            IdentityRow | undefined
          return parseIdentity(row, 'verified_email')
        }

        const created = createUser(input, next.userId, timestamp)
        database.prepare(created.query).get(...created.bindings)
        const email = createEmail(input, next.userId, timestamp)
        database.prepare(email.query).run(...email.bindings)
        const identity = linkCreatedUser(input, next.userId, timestamp)
        database.prepare(identity.query).run(...identity.bindings)
        const row = database.prepare(identityQuery).get(input.provider, input.subject) as
          IdentityRow | undefined
        return parseIdentity(row, 'created')
      })
      return run()
    },
    resolveEmail: async (address) => {
      const email = normalizeIdentityEmail(address)
      const row = database.prepare(emailQuery).get(email) as IdentityRow | undefined
      return parseEmail(row)
    },
  }
}

export const createD1IdentityStore = (
  database: D1Database,
  { now = () => new Date().toISOString() }: IdentityStoreOptions = {},
): IdentityStore => ({
  resolveProvider: async (assertion) => {
    const input = normalizeProviderIdentityAssertion(assertion)
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)

    const existing = await database
      .prepare(identityQuery)
      .bind(input.provider, input.subject)
      .first<IdentityRow>()
    if (existing !== null) return parseIdentity(existing, 'subject')

    const link = linkVerifiedEmail(input, timestamp)
    const linked = await database
      .prepare(link.query)
      .bind(...link.bindings)
      .first<{ userId: number }>()
    if (linked !== null) {
      const row = await database
        .prepare(identityQuery)
        .bind(input.provider, input.subject)
        .first<IdentityRow>()
      return parseIdentity(row ?? undefined, 'verified_email')
    }

    // A concurrent resolver may have linked this subject between the first
    // lookup and our conditional insert. Re-read before requiring mutable
    // profile claims that existing users do not need.
    const concurrentlyLinked = await database
      .prepare(identityQuery)
      .bind(input.provider, input.subject)
      .first<IdentityRow>()
    if (concurrentlyLinked !== null) return parseIdentity(concurrentlyLinked, 'subject')

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = await database.prepare(nextUserIdQuery).first<{ userId: number }>()
      if (next === null) throw new Error('identity store could not allocate a user id')
      const operations = [
        createUser(input, next.userId, timestamp),
        createEmail(input, next.userId, timestamp),
        linkCreatedUser(input, next.userId, timestamp),
      ]
      try {
        const results = await database.batch(
          operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
        )
        const created = results[0]?.results[0] as { userId: number } | undefined
        const row = await database
          .prepare(identityQuery)
          .bind(input.provider, input.subject)
          .first<IdentityRow>()
        const matchedBy: ProviderIdentityMatch = created !== undefined ? 'created' : 'subject'
        return parseIdentity(row ?? undefined, matchedBy)
      } catch (error) {
        if (!isUserIdCollision(error) || attempt === 3) throw error
      }
    }
    throw new Error('identity store user id allocation exhausted')
  },
  resolveEmail: async (address) => {
    const email = normalizeIdentityEmail(address)
    const row = await database.prepare(emailQuery).bind(email).first<IdentityRow>()
    return parseEmail(row ?? undefined)
  },
})
