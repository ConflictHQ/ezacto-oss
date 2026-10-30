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
import { closedAccountProviderKey, accountClosureDigest } from './account-closure-sign-in.js'
import { verifiedProvisioningDomainQuery } from './sso-provisioning-domains.js'

export interface IdentityStore {
  resolveProvider(assertion: ProviderIdentityAssertion): Promise<ProviderIdentityResolution>
  resolveEmail(address: string): Promise<EmailSignInResolution>
}

/**
 * Open sign-up for one provider. An unknown identity from it, with a verified
 * address, becomes a member assigned to `projectId` even when its domain is not
 * a verified provisioning domain. Only the App Review instance sets this: the
 * reviewer signs in with an Apple ID nobody can know in advance, at a domain
 * (icloud.com, the private relay) no instance can prove it owns.
 */
export interface SelfSignupPolicy {
  provider: string
  projectId: number
}

export interface IdentityStoreOptions {
  now?: () => string
  selfSignup?: SelfSignupPolicy
}

/** `APPLE_SELF_SIGNUP_PROJECT_ID`: unset or blank is off; anything else must be a project id. */
export const selfSignupProjectIdFromVariable = (value: string | undefined): number | null => {
  if (value === undefined || value.trim() === '') return null
  const trimmed = value.trim()
  const projectId = /^[1-9][0-9]{0,15}$/u.test(trimmed) ? Number(trimmed) : Number.NaN
  if (!Number.isSafeInteger(projectId)) {
    throw new TypeError('APPLE_SELF_SIGNUP_PROJECT_ID must be a positive project id')
  }
  return projectId
}

/** Profile material for a self-signed-up user Apple sent no name for. */
const SELF_SIGNUP_FIRST_NAME = 'New'
const SELF_SIGNUP_LAST_NAME = 'Member'

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
  blockedKeys: readonly string[],
): Operation => ({
  query: `INSERT INTO user_identities (
      user_id, provider, provider_subject, created_at, updated_at
    )
    SELECT email.user_id, ?, ?, ?, ?
    FROM user_emails email
    JOIN users user ON user.id = email.user_id
    WHERE ? = 1 AND lower(email.address) = lower(?)
      AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM closed_account_sign_in_guards WHERE digest IN (?,?))
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
    ...blockedKeys,
    input.provider,
    input.subject,
  ],
})

/**
 * Provisioning is the one step scoped to a domain. The guard is part of the
 * INSERT rather than a read before it because the row it consults can be
 * deleted or un-verified between the two, and a stranger who wins that race
 * would otherwise get an account that no configuration permits. Self sign-up
 * is the one alternative, and it is guarded the same way: the project it
 * assigns to must still be active when the row is written.
 */
const createUser = (
  input: NormalizedProviderIdentityAssertion,
  userId: number,
  timestamp: string,
  blockedKeys: readonly string[],
  signupProjectId: number | null,
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
      AND (
        EXISTS (
          SELECT 1 FROM sso_provisioning_domains domain
          WHERE domain.domain = ? AND domain.verified_at IS NOT NULL
        )
        OR EXISTS (SELECT 1 FROM projects WHERE id = ? AND is_active = 1)
      )
      -- #736. The linking branch above already refuses an unverified claim;
      -- provisioning did not, so a provider that lets someone set an
      -- unverified address at a verified provisioning domain would hand a
      -- stranger a member account holding that address. The real owner could
      -- then never add it, because an address is unique while it lives. A
      -- verified provisioning domain says the domain is ours, not that this
      -- claimant is who they say.
      AND ? = 1
      AND NOT EXISTS (SELECT 1 FROM closed_account_sign_in_guards WHERE digest IN (?,?))
    RETURNING id AS userId`,
  bindings: [
    userId,
    input.firstName,
    input.lastName,
    timestamp,
    timestamp,
    input.provider,
    input.subject,
    input.provisioningDomain,
    signupProjectId,
    input.emailVerified ? 1 : 0,
    ...blockedKeys,
  ],
  }
}

/**
 * The self-signed-up user's one project. Written only for the user this
 * assertion's subject was just linked to, so a batch whose user INSERT was
 * refused cannot hand the assignment to whoever holds the id instead.
 */
const assignSignupProject = (
  input: NormalizedProviderIdentityAssertion,
  userId: number,
  projectId: number,
  timestamp: string,
): Operation => ({
  query: `INSERT INTO user_assignments (
      project_id, user_id, is_active, is_project_manager, use_default_rates,
      created_at, updated_at
    )
    SELECT ?, ?, 1, 0, 1, ?, ?
    WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND is_active = 1)
      AND EXISTS (
        SELECT 1 FROM user_identities identity
        WHERE identity.user_id = ? AND identity.provider = ? AND identity.provider_subject = ?
      )
    ON CONFLICT(project_id, user_id) DO NOTHING`,
  bindings: [
    projectId,
    userId,
    timestamp,
    timestamp,
    projectId,
    userId,
    input.provider,
    input.subject,
  ],
})

const activeProjectQuery = `SELECT 1 AS permitted FROM projects WHERE id = ? AND is_active = 1`

const signupProjectFor = (
  input: NormalizedProviderIdentityAssertion,
  policy: SelfSignupPolicy | undefined,
): number | null =>
  policy !== undefined && input.provider === policy.provider ? policy.projectId : null

const withSignupProfile = (
  input: NormalizedProviderIdentityAssertion,
  signupProjectId: number | null,
): NormalizedProviderIdentityAssertion =>
  signupProjectId === null
    ? input
    : {
        ...input,
        firstName: input.firstName ?? SELF_SIGNUP_FIRST_NAME,
        lastName: input.lastName ?? SELF_SIGNUP_LAST_NAME,
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
): Extract<ProviderIdentityResolution, { matchedBy: ProviderIdentityMatch }> => {
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

/**
 * The answer for an assertion that matched no subject and no verified address
 * and came from a domain this instance has not proved it owns. Returning it —
 * rather than creating a user — is #268: without the scope, anyone with a
 * Google account who reaches the sign-in provisions themselves an account
 * beside the real people.
 */
const provisioningNotPermitted: ProviderIdentityResolution = {
  status: 'provisioning_not_permitted',
}

const nextUserIdQuery = `SELECT coalesce(max(id), 0) + 1 AS userId FROM users`

const isUserIdCollision = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed: users\.id/i.test(error.message)

export const createContainerIdentityStore = (
  database: BetterSqlite3.Database,
  { now = () => new Date().toISOString(), selfSignup }: IdentityStoreOptions = {},
): IdentityStore => {
  database.pragma('foreign_keys = ON')
  return {
    resolveProvider: async (assertion) => {
      const asserted = normalizeProviderIdentityAssertion(assertion)
      const signupProjectId = signupProjectFor(asserted, selfSignup)
      const input = withSignupProfile(asserted, signupProjectId)
      const timestamp = now()
      assertCanonicalTimestamp(timestamp)
      const secret = (database.prepare('SELECT secret FROM account_closure_security WHERE id=1').get() as {secret:string}).secret
      const blockedKeys = [accountClosureDigest(secret,'provider',closedAccountProviderKey(input.provider,input.subject)),accountClosureDigest(secret,'email',input.email.toLowerCase())]
      const run = database.transaction((): ProviderIdentityResolution => {
        if (database.prepare('SELECT 1 FROM closed_account_sign_in_guards WHERE digest IN (?,?) LIMIT 1').get(...blockedKeys)) return provisioningNotPermitted
        const existing = database.prepare(identityQuery).get(input.provider, input.subject) as
          IdentityRow | undefined
        if (existing !== undefined) return parseIdentity(existing, 'subject')

        const next = database.prepare(nextUserIdQuery).get() as { userId: number }
        const link = linkVerifiedEmail(input, timestamp, blockedKeys)
        const linked = database.prepare(link.query).get(...link.bindings) as
          { userId: number } | undefined
        if (linked !== undefined) {
          const row = database.prepare(identityQuery).get(input.provider, input.subject) as
            IdentityRow | undefined
          return parseIdentity(row, 'verified_email')
        }

        const permitted =
          (database
            .prepare(verifiedProvisioningDomainQuery)
            .get(input.provisioningDomain) as { permitted: number } | undefined) ??
          (signupProjectId === null
            ? undefined
            : (database.prepare(activeProjectQuery).get(signupProjectId) as
                | { permitted: number }
                | undefined))
        if (permitted === undefined) return provisioningNotPermitted

        const created = createUser(input, next.userId, timestamp, blockedKeys, signupProjectId)
        const inserted = database.prepare(created.query).get(...created.bindings) as
          { userId: number } | undefined
        // The row read above can be gone by the time the INSERT runs its own
        // guard. Nothing was created, so say so rather than resolving a user
        // that does not exist.
        if (inserted === undefined) return provisioningNotPermitted
        const email = createEmail(input, next.userId, timestamp)
        database.prepare(email.query).run(...email.bindings)
        const identity = linkCreatedUser(input, next.userId, timestamp)
        database.prepare(identity.query).run(...identity.bindings)
        if (signupProjectId !== null) {
          const assignment = assignSignupProject(input, next.userId, signupProjectId, timestamp)
          database.prepare(assignment.query).run(...assignment.bindings)
        }
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
  { now = () => new Date().toISOString(), selfSignup }: IdentityStoreOptions = {},
): IdentityStore => ({
  resolveProvider: async (assertion) => {
    const asserted = normalizeProviderIdentityAssertion(assertion)
    const signupProjectId = signupProjectFor(asserted, selfSignup)
    const input = withSignupProfile(asserted, signupProjectId)
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    const security = await database.prepare('SELECT secret FROM account_closure_security WHERE id=1').first<{secret:string}>()
    if (!security) throw new Error('Missing account closure security configuration')
    const blockedKeys = [accountClosureDigest(security.secret,'provider',closedAccountProviderKey(input.provider,input.subject)),accountClosureDigest(security.secret,'email',input.email.toLowerCase())]
    if (await database.prepare('SELECT 1 FROM closed_account_sign_in_guards WHERE digest IN (?,?) LIMIT 1').bind(...blockedKeys).first()) return provisioningNotPermitted

    const existing = await database
      .prepare(identityQuery)
      .bind(input.provider, input.subject)
      .first<IdentityRow>()
    if (existing !== null) return parseIdentity(existing, 'subject')

    const link = linkVerifiedEmail(input, timestamp, blockedKeys)
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

    const permitted =
      (await database
        .prepare(verifiedProvisioningDomainQuery)
        .bind(input.provisioningDomain)
        .first<{ permitted: number }>()) ??
      (signupProjectId === null
        ? null
        : await database
            .prepare(activeProjectQuery)
            .bind(signupProjectId)
            .first<{ permitted: number }>())
    if (permitted === null) return provisioningNotPermitted

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = await database.prepare(nextUserIdQuery).first<{ userId: number }>()
      if (next === null) throw new Error('identity store could not allocate a user id')
      const operations = [
        createUser(input, next.userId, timestamp, blockedKeys, signupProjectId),
        createEmail(input, next.userId, timestamp),
        linkCreatedUser(input, next.userId, timestamp),
        ...(signupProjectId === null
          ? []
          : [assignSignupProject(input, next.userId, signupProjectId, timestamp)]),
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
        // No identity and no insert means the INSERT's own domain guard
        // refused: the row read before the batch stopped being verified.
        if (row === null) return provisioningNotPermitted
        const matchedBy: ProviderIdentityMatch = created !== undefined ? 'created' : 'subject'
        return parseIdentity(row, matchedBy)
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
