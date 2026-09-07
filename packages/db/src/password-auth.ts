import type BetterSqlite3 from 'better-sqlite3'
import {
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_TIME_COST,
  ARGON2ID_VERSION,
  hashPassword,
  normalizeIdentityEmail,
  passwordNeedsRehash,
  verifyPassword,
  type ResolvedUserIdentity,
  type StoredPassword,
  type UserProfile,
} from '@ezacto/core'

export type AuthTokenKind = 'verify_email' | 'password_reset'
export type AuthRateLimitAction =
  'signup' | 'sign_in' | 'verify_email' | 'request_reset' | 'reset_password'

export interface AuthDelivery {
  kind: AuthTokenKind
  to: string
  token: string
  expiresAt: string
}

export interface FirstRunSignupInput {
  organizationName: string
  firstName: string
  lastName: string
  email: string
  password: string
  clientKey: string
}

export interface PasswordSignInInput {
  email: string
  password: string
  clientKey: string
}

export type PasswordSignInResult =
  | {
      status: 'authenticated'
      principal: ResolvedUserIdentity
      credentialVersion: number
    }
  | { status: 'invalid_credentials' }
  | { status: 'verification_required' }

export interface AddUserEmailInput {
  userId: number
  email: string
  clientKey: string
}

export interface PasswordAuthService {
  signup(input: FirstRunSignupInput): Promise<AuthDelivery>
  /**
   * Add a second address to an existing user and issue the verification token
   * for it. The address lands pending and non-primary; nothing the user already
   * has is touched.
   */
  addEmail(input: AddUserEmailInput): Promise<AuthDelivery>
  verifyEmail(token: string, clientKey: string): Promise<ResolvedUserIdentity>
  signIn(input: PasswordSignInInput): Promise<PasswordSignInResult>
  requestPasswordReset(email: string, clientKey: string): Promise<AuthDelivery | null>
  resetPassword(token: string, password: string, clientKey: string): Promise<ResolvedUserIdentity>
}

export interface PasswordAuthServiceOptions {
  now?: () => string
}

export class AuthRateLimitError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super('authentication attempt rate limit exceeded')
    this.name = 'AuthRateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class FirstRunSignupUnavailableError extends Error {
  constructor() {
    super('first-run signup is unavailable after identity state exists')
    this.name = 'FirstRunSignupUnavailableError'
  }
}

export class UnknownUserError extends Error {
  constructor() {
    super('the user does not exist or is not active')
    this.name = 'UnknownUserError'
  }
}

export class EmailAddressUnavailableError extends Error {
  constructor() {
    super('the email address is already on an account')
    this.name = 'EmailAddressUnavailableError'
  }
}

export class InvalidAuthTokenError extends Error {
  constructor() {
    super('authentication token is invalid, expired, or already used')
    this.name = 'InvalidAuthTokenError'
  }
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  first<T>(query: string, bindings?: readonly unknown[]): Promise<T | null>
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

interface PasswordRow {
  userId: number
  profile: string
  managerGrants: string
  isActive: number
  verifiedAt: string | null
  invalidatedAt: string | null
  address: string
  credentialVersion: number | null
  algorithm: 'pbkdf2-sha256' | 'argon2id' | null
  version: number | null
  iterations: number | null
  memoryKiB: number | null
  timeCost: number | null
  parallelism: number | null
  salt: string | null
  passwordHash: string | null
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

const rateLimits: Record<AuthRateLimitAction, { attempts: number; windowMs: number }> = {
  signup: { attempts: 5, windowMs: 60 * 60 * 1_000 },
  sign_in: { attempts: 10, windowMs: 15 * 60 * 1_000 },
  verify_email: { attempts: 10, windowMs: 15 * 60 * 1_000 },
  request_reset: { attempts: 5, windowMs: 60 * 60 * 1_000 },
  reset_password: { attempts: 10, windowMs: 60 * 60 * 1_000 },
}

const verifyTokenTtlMs = 24 * 60 * 60 * 1_000
const resetTokenTtlMs = 60 * 60 * 1_000
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const tokenPattern = /^ezacto_(verify|reset)_([A-Za-z0-9_-]{16})_([A-Za-z0-9_-]{43})$/
const dummyPassword: StoredPassword = {
  algorithm: 'argon2id',
  version: ARGON2ID_VERSION,
  memoryKiB: ARGON2ID_MEMORY_KIB,
  timeCost: ARGON2ID_TIME_COST,
  parallelism: ARGON2ID_PARALLELISM,
  salt: 'AAAAAAAAAAAAAAAAAAAAAA',
  passwordHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}

const printableText = (value: string, field: string, maximum: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
  if (normalized.length === 0 || [...normalized].length > maximum || hasControlCharacter) {
    throw new RangeError(`${field} must contain between 1 and ${maximum} printable characters`)
  }
  return normalized
}

const clientKey = (value: string): string => printableText(value, 'clientKey', 512)

const emailRateLimitSubject = (value: string): string =>
  typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : 'invalid-email'

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('password auth clock must return a canonical UTC timestamp')
  }
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

const issueToken = async (kind: AuthTokenKind): Promise<TokenMaterial> => {
  const selector = randomBase64Url(12)
  const secret = randomBase64Url(32)
  const token = `ezacto_${kind === 'verify_email' ? 'verify' : 'reset'}_${selector}_${secret}`
  return { selector, secretHash: await sha256Hex(token), token }
}

const prepareToken = async (
  token: string,
  expectedKind: AuthTokenKind,
): Promise<{ selector: string; secretHash: string }> => {
  const match = tokenPattern.exec(token)
  const actualKind = match?.[1] === 'verify' ? 'verify_email' : 'password_reset'
  if (match === null || actualKind !== expectedKind) throw new InvalidAuthTokenError()
  return { selector: match[2]!, secretHash: await sha256Hex(token) }
}

const principal = (row: PasswordRow | undefined): ResolvedUserIdentity => {
  if (
    row === undefined ||
    row.isActive !== 1 ||
    !Number.isSafeInteger(row.userId) ||
    row.userId < 1 ||
    !profiles.includes(row.profile as UserProfile)
  ) {
    throw new Error('password authentication resolved malformed user state')
  }
  let grants: unknown
  try {
    grants = JSON.parse(row.managerGrants)
  } catch {
    throw new Error('password authentication resolved malformed manager grants')
  }
  if (!Array.isArray(grants) || !grants.every((grant) => typeof grant === 'string')) {
    throw new Error('password authentication resolved malformed manager grants')
  }
  return {
    userId: row.userId,
    profile: row.profile as UserProfile,
    managerGrants: grants,
  }
}

const passwordRecord = (row: PasswordRow | null): StoredPassword | null => {
  if (row?.algorithm === null || row?.salt === null || row?.passwordHash === null || row === null) {
    return null
  }
  if (row.algorithm === 'pbkdf2-sha256') {
    if (
      !Number.isSafeInteger(row.credentialVersion) ||
      row.credentialVersion! < 1 ||
      row.iterations === null ||
      row.version !== null ||
      row.memoryKiB !== null ||
      row.timeCost !== null ||
      row.parallelism !== null
    ) {
      throw new Error('password authentication resolved malformed PBKDF2 state')
    }
    return {
      algorithm: row.algorithm,
      iterations: row.iterations,
      salt: row.salt,
      passwordHash: row.passwordHash,
    }
  }
  if (
    row.algorithm !== 'argon2id' ||
    !Number.isSafeInteger(row.credentialVersion) ||
    row.credentialVersion! < 1 ||
    row.version === null ||
    row.iterations !== null ||
    row.memoryKiB === null ||
    row.timeCost === null ||
    row.parallelism === null
  ) {
    throw new Error('password authentication resolved malformed Argon2id state')
  }
  return {
    algorithm: row.algorithm,
    version: row.version,
    memoryKiB: row.memoryKiB,
    timeCost: row.timeCost,
    parallelism: row.parallelism,
    salt: row.salt,
    passwordHash: row.passwordHash,
  }
}

const passwordLookup = `SELECT user.id AS userId, user.profile,
    user.manager_grants AS managerGrants, user.is_active AS isActive,
    email.address, email.verified_at AS verifiedAt, email.invalidated_at AS invalidatedAt,
    password.credential_version AS credentialVersion,
    password.algorithm, password.version, password.iterations,
    password.memory_kib AS memoryKiB, password.time_cost AS timeCost,
    password.parallelism, password.salt,
    password.password_hash AS passwordHash
  FROM user_emails email
  JOIN users user ON user.id = email.user_id
  LEFT JOIN user_passwords password ON password.user_id = user.id
  WHERE lower(email.address) = lower(?) AND email.invalidated_at IS NULL
  ORDER BY email.verified_at IS NOT NULL DESC, email.id
  LIMIT 1`

const principalByUserQuery = `SELECT user.id AS userId, user.profile,
    user.manager_grants AS managerGrants, user.is_active AS isActive,
    email.address, email.verified_at AS verifiedAt, email.invalidated_at AS invalidatedAt,
    password.credential_version AS credentialVersion,
    password.algorithm, password.version, password.iterations,
    password.memory_kib AS memoryKiB, password.time_cost AS timeCost,
    password.parallelism, password.salt,
    password.password_hash AS passwordHash
  FROM users user
  JOIN user_emails email ON email.user_id = user.id
  LEFT JOIN user_passwords password ON password.user_id = user.id
  WHERE user.id = ?
  ORDER BY email.is_primary DESC, email.id
  LIMIT 1`

const rateLimit = async (
  database: PortableDatabase,
  action: AuthRateLimitAction,
  client: string,
  subject: string,
  now: string,
): Promise<void> => {
  const policy = rateLimits[action]
  const normalizedClient = clientKey(client)
  const keyHashes = await Promise.all([
    sha256Hex(`${action}\u0000client\u0000${normalizedClient}`),
    sha256Hex(`${action}\u0000subject\u0000${subject}`),
  ])
  const rows = await database.atomic(
    keyHashes.map((keyHash) => ({
      query: `INSERT INTO auth_rate_limits (
          action, key_hash, window_started_at, attempts, updated_at
        ) VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(action, key_hash) DO UPDATE SET
          attempts = CASE
            WHEN (unixepoch(excluded.window_started_at) - unixepoch(auth_rate_limits.window_started_at)) * 1000 >= ?
              THEN 1
            ELSE auth_rate_limits.attempts + 1
          END,
          window_started_at = CASE
            WHEN (unixepoch(excluded.window_started_at) - unixepoch(auth_rate_limits.window_started_at)) * 1000 >= ?
              THEN excluded.window_started_at
            ELSE auth_rate_limits.window_started_at
          END,
          updated_at = excluded.updated_at
        RETURNING attempts, window_started_at AS windowStartedAt`,
      bindings: [action, keyHash, now, now, policy.windowMs, policy.windowMs],
    })),
  )
  let retryAfterSeconds = 0
  for (const rowsForKey of rows) {
    const row = rowsForKey[0] as { attempts?: number; windowStartedAt?: string } | undefined
    if (row?.attempts === undefined || row.windowStartedAt === undefined) {
      throw new Error('authentication rate limit did not return state')
    }
    if (row.attempts > policy.attempts) {
      const retryAt = Date.parse(row.windowStartedAt) + policy.windowMs
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        Math.max(1, Math.ceil((retryAt - Date.parse(now)) / 1_000)),
      )
    }
  }
  if (retryAfterSeconds > 0) throw new AuthRateLimitError(retryAfterSeconds)
}

const tokenInsert = (
  material: TokenMaterial,
  kind: AuthTokenKind,
  userEmailId: number,
  expiresAt: string,
  now: string,
): Operation => ({
  query: `INSERT INTO auth_tokens (
      selector, secret_hash, kind, user_email_id, expires_at,
      used_at, used_nonce, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    RETURNING id`,
  bindings: [material.selector, material.secretHash, kind, userEmailId, expiresAt, now, now],
})

const translateFirstRun = (error: unknown): never => {
  if (
    error instanceof Error &&
    /(?:first-run signup requires empty identity state|unique constraint failed: auth_first_run\.(?:id|claim_nonce))/i.test(
      error.message,
    )
  ) {
    throw new FirstRunSignupUnavailableError()
  }
  throw error
}

const createPasswordAuthService = (
  database: PortableDatabase,
  { now = () => new Date().toISOString() }: PasswordAuthServiceOptions = {},
): PasswordAuthService => ({
  signup: async (input) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    await rateLimit(
      database,
      'signup',
      input.clientKey,
      emailRateLimitSubject(input.email),
      timestamp,
    )
    const email = normalizeIdentityEmail(input.email)
    const organizationName = printableText(input.organizationName, 'organizationName', 200)
    const firstName = printableText(input.firstName, 'firstName', 100)
    const lastName = printableText(input.lastName, 'lastName', 100)
    const password = await hashPassword(input.password)
    const material = await issueToken('verify_email')
    const claimNonce = randomBase64Url(12)
    const expiresAt = futureTimestamp(timestamp, verifyTokenTtlMs)
    try {
      const rows = await database.atomic([
        {
          query: `INSERT INTO auth_first_run (
              id, claim_nonce, completed_at, created_at, updated_at
            ) VALUES (1, ?, NULL, ?, ?) RETURNING id`,
          bindings: [claimNonce, timestamp, timestamp],
        },
        {
          query: `INSERT INTO organizations (
              id, name, modules, created_at, updated_at
            ) SELECT 1, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM auth_first_run WHERE id = 1 AND claim_nonce = ?)
            RETURNING id`,
          bindings: [
            organizationName,
            JSON.stringify({ approval: true, expenses: true, invoices: true, team: true }),
            timestamp,
            timestamp,
            claimNonce,
          ],
        },
        {
          query: `INSERT INTO users (
              id, first_name, last_name, timezone, is_contractor, is_active,
              has_access_to_all_future_projects, weekly_capacity, profile,
              manager_grants, is_owner, saml_exempt, created_at, updated_at
            ) SELECT 1, ?, ?, 'UTC', 0, 1, 1, 126000, 'administrator', '[]', 0, 0, ?, ?
            WHERE EXISTS (SELECT 1 FROM auth_first_run WHERE id = 1 AND claim_nonce = ?)
            RETURNING id`,
          bindings: [firstName, lastName, timestamp, timestamp, claimNonce],
        },
        {
          query: `INSERT INTO user_emails (
              id, user_id, address, verified_at, is_primary, invalidated_at,
              created_at, updated_at
            ) SELECT 1, 1, ?, NULL, 0, NULL, ?, ?
            WHERE EXISTS (SELECT 1 FROM auth_first_run WHERE id = 1 AND claim_nonce = ?)
            RETURNING id`,
          bindings: [email, timestamp, timestamp, claimNonce],
        },
        {
          query: `INSERT INTO user_passwords (
              user_id, credential_version, algorithm, version, iterations, memory_kib, time_cost,
              parallelism, salt, password_hash, created_at, updated_at
            ) SELECT 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM auth_first_run WHERE id = 1 AND claim_nonce = ?)
            RETURNING user_id AS userId`,
          bindings: [
            password.algorithm,
            password.algorithm === 'argon2id' ? password.version : null,
            password.algorithm === 'pbkdf2-sha256' ? password.iterations : null,
            password.algorithm === 'argon2id' ? password.memoryKiB : null,
            password.algorithm === 'argon2id' ? password.timeCost : null,
            password.algorithm === 'argon2id' ? password.parallelism : null,
            password.salt,
            password.passwordHash,
            timestamp,
            timestamp,
            claimNonce,
          ],
        },
        tokenInsert(material, 'verify_email', 1, expiresAt, timestamp),
      ])
      if (rows.some((rowsForOperation) => rowsForOperation.length !== 1)) {
        throw new Error('first-run signup did not create complete identity state')
      }
    } catch (error) {
      translateFirstRun(error)
    }
    return { kind: 'verify_email', to: email, token: material.token, expiresAt }
  },

  addEmail: async (input) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    await rateLimit(
      database,
      'verify_email',
      input.clientKey,
      emailRateLimitSubject(input.email),
      timestamp,
    )
    const email = normalizeIdentityEmail(input.email)
    if (!Number.isSafeInteger(input.userId) || input.userId < 1) throw new UnknownUserError()
    const material = await issueToken('verify_email')
    const expiresAt = futureTimestamp(timestamp, verifyTokenTtlMs)
    let rows: Record<string, unknown>[][]
    try {
      rows = await database.atomic([
        {
          // Pending and non-primary. #269: adding the work address must leave
          // the personal one exactly as it was, because that is the address
          // payroll reconciliation matches on. The NOT EXISTS is the friendly
          // half of the verified-address unique index — it also refuses an
          // address a second person is still in the middle of verifying.
          query: `INSERT INTO user_emails (
              user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at
            )
            SELECT user.id, ?, NULL, 0, NULL, ?, ?
            FROM users user
            WHERE user.id = ? AND user.is_active = 1
              AND NOT EXISTS (
                SELECT 1 FROM user_emails existing
                WHERE lower(existing.address) = lower(?) AND existing.invalidated_at IS NULL
              )
            RETURNING id`,
          bindings: [email, timestamp, timestamp, input.userId, email],
        },
        {
          // The batch is one transaction in both runtimes, so this subquery
          // sees the row above; naming it by address rather than by id is the
          // only way to carry the identifier across a D1 batch.
          query: `INSERT INTO auth_tokens (
              selector, secret_hash, kind, user_email_id, expires_at,
              used_at, used_nonce, created_at, updated_at
            )
            SELECT ?, ?, 'verify_email', email.id, ?, NULL, NULL, ?, ?
            FROM user_emails email
            WHERE email.user_id = ? AND lower(email.address) = lower(?)
              AND email.verified_at IS NULL AND email.invalidated_at IS NULL
            RETURNING id`,
          bindings: [
            material.selector,
            material.secretHash,
            expiresAt,
            timestamp,
            timestamp,
            input.userId,
            email,
          ],
        },
      ])
    } catch (error) {
      if (error instanceof Error && /unique constraint failed/i.test(error.message)) {
        throw new EmailAddressUnavailableError()
      }
      throw error
    }
    // A token was issued, so either the address was just added or the caller
    // asked again for one this same user had already added and not yet
    // verified. Both are the same answer to whoever is waiting for the mail.
    if (rows[1]?.length === 1) {
      return { kind: 'verify_email', to: email, token: material.token, expiresAt }
    }
    if (rows[0]?.length === 1) throw new Error('email verification token was not persisted')
    const user = await database.first<{ id: number }>(
      `SELECT id FROM users WHERE id = ? AND is_active = 1`,
      [input.userId],
    )
    if (user === null) throw new UnknownUserError()
    throw new EmailAddressUnavailableError()
  },

  verifyEmail: async (token, presentedClientKey) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    await rateLimit(database, 'verify_email', presentedClientKey, token, timestamp)
    const prepared = await prepareToken(token, 'verify_email')
    const nonce = randomBase64Url(12)
    const rows = await database.atomic([
      {
        query: `UPDATE auth_tokens SET used_at = ?, used_nonce = ?, updated_at = ?
          WHERE selector = ? AND secret_hash = ? AND kind = 'verify_email'
            AND used_at IS NULL AND julianday(expires_at) > julianday(?)
          RETURNING user_email_id AS userEmailId`,
        bindings: [timestamp, nonce, timestamp, prepared.selector, prepared.secretHash, timestamp],
      },
      {
        // The address only becomes primary when the user has none. A second
        // address must not displace the first: the personal address is what
        // payroll reconciliation matches entries by, and promoting a newly
        // verified work address would break that match. It would also collide
        // with the one-primary-per-user index and fail the whole verification.
        query: `UPDATE user_emails SET verified_at = ?, updated_at = ?,
            is_primary = CASE WHEN EXISTS (
              SELECT 1 FROM user_emails existing
              WHERE existing.user_id = user_emails.user_id
                AND existing.is_primary = 1 AND existing.invalidated_at IS NULL
                AND existing.id <> user_emails.id
            ) THEN 0 ELSE 1 END
          WHERE id = (
            SELECT user_email_id FROM auth_tokens
            WHERE selector = ? AND secret_hash = ? AND used_nonce = ?
          ) AND verified_at IS NULL AND invalidated_at IS NULL
          RETURNING user_id AS userId`,
        bindings: [timestamp, timestamp, prepared.selector, prepared.secretHash, nonce],
      },
      {
        query: `UPDATE auth_first_run SET completed_at = ?, updated_at = ?
          WHERE id = 1 AND completed_at IS NULL AND EXISTS (
            SELECT 1 FROM auth_tokens token
            JOIN user_emails email ON email.id = token.user_email_id
            WHERE token.selector = ? AND token.secret_hash = ? AND token.used_nonce = ?
              AND email.user_id = 1 AND email.verified_at IS NOT NULL
          ) RETURNING id`,
        bindings: [timestamp, timestamp, prepared.selector, prepared.secretHash, nonce],
      },
    ])
    const consumed = rows[0]?.[0] as { userEmailId?: number } | undefined
    const verified = rows[1]?.[0] as { userId?: number } | undefined
    if (consumed?.userEmailId === undefined || verified?.userId === undefined) {
      throw new InvalidAuthTokenError()
    }
    const row = await database.first<PasswordRow>(principalByUserQuery, [verified.userId])
    return principal(row ?? undefined)
  },

  signIn: async (input) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    await rateLimit(
      database,
      'sign_in',
      input.clientKey,
      emailRateLimitSubject(input.email),
      timestamp,
    )
    const email = normalizeIdentityEmail(input.email)
    const row = await database.first<PasswordRow>(passwordLookup, [email])
    const record = passwordRecord(row)
    const matches = await verifyPassword(input.password, record ?? dummyPassword)
    if (!matches || record === null || row === null || row.isActive !== 1) {
      return { status: 'invalid_credentials' }
    }
    if (row.verifiedAt === null || row.invalidatedAt !== null) {
      return { status: 'verification_required' }
    }
    let credentialVersion = row.credentialVersion!
    if (passwordNeedsRehash(record)) {
      const replacement = await hashPassword(input.password)
      const upgraded = await database.atomic([
        {
          query: `UPDATE user_passwords SET
              credential_version = credential_version + 1,
              algorithm = ?, version = ?, iterations = ?, memory_kib = ?,
              time_cost = ?, parallelism = ?, salt = ?, password_hash = ?, updated_at = ?
            WHERE user_id = ? AND credential_version = ?
              AND algorithm = ? AND salt = ? AND password_hash = ?
              AND credential_version < 9007199254740991
            RETURNING credential_version AS credentialVersion`,
          bindings: [
            replacement.algorithm,
            replacement.algorithm === 'argon2id' ? replacement.version : null,
            replacement.algorithm === 'pbkdf2-sha256' ? replacement.iterations : null,
            replacement.algorithm === 'argon2id' ? replacement.memoryKiB : null,
            replacement.algorithm === 'argon2id' ? replacement.timeCost : null,
            replacement.algorithm === 'argon2id' ? replacement.parallelism : null,
            replacement.salt,
            replacement.passwordHash,
            timestamp,
            row.userId,
            credentialVersion,
            record.algorithm,
            record.salt,
            record.passwordHash,
          ],
        },
      ])
      const version = upgraded[0]?.[0] as { credentialVersion?: number } | undefined
      if (version?.credentialVersion === undefined) {
        return { status: 'invalid_credentials' }
      }
      credentialVersion = version.credentialVersion
    }
    return {
      status: 'authenticated',
      principal: principal(row),
      credentialVersion,
    }
  },

  requestPasswordReset: async (presentedEmail, presentedClientKey) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    await rateLimit(
      database,
      'request_reset',
      presentedClientKey,
      emailRateLimitSubject(presentedEmail),
      timestamp,
    )
    const email = normalizeIdentityEmail(presentedEmail)
    const row = await database.first<PasswordRow>(passwordLookup, [email])
    if (
      row === null ||
      row.isActive !== 1 ||
      row.verifiedAt === null ||
      row.invalidatedAt !== null ||
      passwordRecord(row) === null
    ) {
      return null
    }
    const material = await issueToken('password_reset')
    const expiresAt = futureTimestamp(timestamp, resetTokenTtlMs)
    const emailId = await database.first<{ id: number }>(
      `SELECT id FROM user_emails
       WHERE user_id = ? AND lower(address) = lower(?)
         AND verified_at IS NOT NULL AND invalidated_at IS NULL
       LIMIT 1`,
      [row.userId, email],
    )
    if (emailId === null) return null
    const rows = await database.atomic([
      tokenInsert(material, 'password_reset', emailId.id, expiresAt, timestamp),
    ])
    if (rows[0]?.length !== 1) {
      throw new Error('password reset token was not persisted')
    }
    return { kind: 'password_reset', to: email, token: material.token, expiresAt }
  },

  resetPassword: async (token, newPassword, presentedClientKey) => {
    const timestamp = now()
    assertCanonicalTimestamp(timestamp)
    await rateLimit(database, 'reset_password', presentedClientKey, token, timestamp)
    const prepared = await prepareToken(token, 'password_reset')
    const password = await hashPassword(newPassword)
    const nonce = randomBase64Url(12)
    const rows = await database.atomic([
      {
        query: `UPDATE auth_tokens SET used_at = ?, used_nonce = ?, updated_at = ?
          WHERE selector = ? AND secret_hash = ? AND kind = 'password_reset'
            AND used_at IS NULL AND julianday(expires_at) > julianday(?)
            AND EXISTS (
              SELECT 1 FROM user_emails email JOIN users user ON user.id = email.user_id
              WHERE email.id = auth_tokens.user_email_id
                AND email.verified_at IS NOT NULL AND email.invalidated_at IS NULL
                AND user.is_active = 1
            )
          RETURNING user_email_id AS userEmailId`,
        bindings: [timestamp, nonce, timestamp, prepared.selector, prepared.secretHash, timestamp],
      },
      {
        query: `UPDATE user_passwords SET
            credential_version = credential_version + 1,
            algorithm = ?, version = ?, iterations = ?, memory_kib = ?,
            time_cost = ?, parallelism = ?, salt = ?, password_hash = ?, updated_at = ?
          WHERE user_id = (
            SELECT email.user_id FROM auth_tokens token
            JOIN user_emails email ON email.id = token.user_email_id
            WHERE token.selector = ? AND token.secret_hash = ? AND token.used_nonce = ?
          ) AND credential_version < 9007199254740991
          RETURNING user_id AS userId`,
        bindings: [
          password.algorithm,
          password.algorithm === 'argon2id' ? password.version : null,
          password.algorithm === 'pbkdf2-sha256' ? password.iterations : null,
          password.algorithm === 'argon2id' ? password.memoryKiB : null,
          password.algorithm === 'argon2id' ? password.timeCost : null,
          password.algorithm === 'argon2id' ? password.parallelism : null,
          password.salt,
          password.passwordHash,
          timestamp,
          prepared.selector,
          prepared.secretHash,
          nonce,
        ],
      },
      {
        query: `UPDATE sessions SET revoked_at = ?, revocation_reason = 'password_reset',
            updated_at = ?
          WHERE user_id = (
            SELECT email.user_id FROM auth_tokens token
            JOIN user_emails email ON email.id = token.user_email_id
            WHERE token.selector = ? AND token.secret_hash = ? AND token.used_nonce = ?
          ) AND revoked_at IS NULL
          RETURNING id`,
        bindings: [timestamp, timestamp, prepared.selector, prepared.secretHash, nonce],
      },
    ])
    const consumed = rows[0]?.[0] as { userEmailId?: number } | undefined
    const updated = rows[1]?.[0] as { userId?: number } | undefined
    if (consumed?.userEmailId === undefined || updated?.userId === undefined) {
      throw new InvalidAuthTokenError()
    }
    const row = await database.first<PasswordRow>(principalByUserQuery, [updated.userId])
    return principal(row ?? undefined)
  },
})

export const createContainerPasswordAuthService = (
  database: BetterSqlite3.Database,
  options: PasswordAuthServiceOptions = {},
): PasswordAuthService => {
  database.pragma('foreign_keys = ON')
  const portable: PortableDatabase = {
    first: async <T>(query: string, bindings: readonly unknown[] = []) =>
      (database.prepare(query).get(...bindings) as T | undefined) ?? null,
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
  return createPasswordAuthService(portable, options)
}

export const createD1PasswordAuthService = (
  database: D1Database,
  options: PasswordAuthServiceOptions = {},
): PasswordAuthService => {
  const portable: PortableDatabase = {
    first: async (query, bindings = []) =>
      database
        .prepare(query)
        .bind(...bindings)
        .first(),
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  }
  return createPasswordAuthService(portable, options)
}
