import type BetterSqlite3 from 'better-sqlite3'
import {
  apiScopes,
  PasswordDerivationOverloadedError,
  hashPassword,
  validatePassword,
  verifyPassword,
  type StoredPassword,
} from '@ezacto/core'
import { prepareApiTokenForStorage } from './api-tokens.js'

export interface InstanceBootstrapInput {
  organizationName: string
  ownerFirstName: string
  ownerLastName: string
  ownerEmail: string
  token: string
}

export interface InstanceBootstrapResult {
  userId: 1
  profile: 'administrator'
}

export interface InstanceOwnerPasswordInput {
  token: string
  password: string
}

export interface InstanceOwnerPasswordResult extends InstanceBootstrapResult {
  ownerEmail: string
}

export interface InstanceBootstrapOptions {
  now?: () => string
}

export class InstanceBootstrapConflictError extends Error {
  constructor() {
    super('instance bootstrap conflicts with existing identity state')
    this.name = 'InstanceBootstrapConflictError'
  }
}

export class InstanceOwnerPasswordConflictError extends Error {
  constructor() {
    super('instance owner password conflicts with bootstrap state')
    this.name = 'InstanceOwnerPasswordConflictError'
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

interface OwnerPasswordRow {
  ownerEmail: string
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

interface NormalizedBootstrap {
  organizationName: string
  ownerFirstName: string
  ownerLastName: string
  ownerEmail: string
  tokenSelector: string
  tokenSecretHash: string
  tokenName: string
  tokenScopes: string
  createdAt: string
}

const tokenName = 'Instance owner bootstrap'
const tokenScopes = JSON.stringify([...apiScopes].sort())
const legacyModules = JSON.stringify({ expenses: true, invoices: true })
const approvalModules = JSON.stringify({
  approval: true,
  expenses: true,
  invoices: true,
  team: true,
})
const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const normalizedText = (value: string, field: string, maximum: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  const length = [...normalized].length
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint <= 31 || codePoint === 127
  })
  if (length < 1 || length > maximum || hasControlCharacter) {
    throw new RangeError(`${field} must contain between 1 and ${maximum} printable characters`)
  }
  return normalized
}

const normalizedEmail = (value: string): string => {
  const email = normalizedText(value, 'ownerEmail', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new RangeError('ownerEmail must be a valid email address')
  }
  return email
}

const assertCanonicalTimestamp = (value: string): void => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('bootstrap clock must return a canonical UTC timestamp')
  }
}

const normalize = async (
  input: InstanceBootstrapInput,
  now: () => string,
): Promise<NormalizedBootstrap> => {
  const createdAt = now()
  assertCanonicalTimestamp(createdAt)
  const prepared = await prepareApiTokenForStorage(input.token)
  return {
    organizationName: normalizedText(input.organizationName, 'organizationName', 200),
    ownerFirstName: normalizedText(input.ownerFirstName, 'ownerFirstName', 100),
    ownerLastName: normalizedText(input.ownerLastName, 'ownerLastName', 100),
    ownerEmail: normalizedEmail(input.ownerEmail),
    tokenSelector: prepared.selector,
    tokenSecretHash: prepared.secretHash,
    tokenName,
    tokenScopes,
    createdAt,
  }
}

const claim = (input: NormalizedBootstrap): Operation => ({
  query: `INSERT INTO instance_bootstrap (
      id, organization_name, owner_first_name, owner_last_name, owner_email,
      token_selector, token_secret_hash, token_name, token_scopes, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      organization_name = excluded.organization_name,
      owner_first_name = excluded.owner_first_name,
      owner_last_name = excluded.owner_last_name,
      owner_email = excluded.owner_email,
      token_selector = excluded.token_selector,
      token_secret_hash = excluded.token_secret_hash,
      token_name = excluded.token_name,
      token_scopes = excluded.token_scopes`,
  bindings: [
    input.organizationName,
    input.ownerFirstName,
    input.ownerLastName,
    input.ownerEmail,
    input.tokenSelector,
    input.tokenSecretHash,
    input.tokenName,
    input.tokenScopes,
    input.createdAt,
  ],
})

const operations = (input: NormalizedBootstrap, modules: string): Operation[] => [
  claim(input),
  {
    query: `INSERT INTO organizations (id, name, modules, created_at, updated_at)
      SELECT 1, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM organizations)`,
    bindings: [input.organizationName, modules, input.createdAt, input.createdAt],
  },
  {
    query: `INSERT INTO users (
        id, first_name, last_name, timezone, is_contractor, is_active,
        has_access_to_all_future_projects, weekly_capacity, profile,
        manager_grants, is_owner, saml_exempt, created_at, updated_at
      ) SELECT 1, ?, ?, 'UTC', 0, 1, 1, 126000, 'administrator', '[]', 0, 0, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM users)`,
    bindings: [input.ownerFirstName, input.ownerLastName, input.createdAt, input.createdAt],
  },
  {
    query: `INSERT INTO user_emails (
        id, user_id, address, verified_at, is_primary, invalidated_at, created_at, updated_at
      ) SELECT 1, 1, ?, ?, 1, NULL, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM user_emails)`,
    bindings: [input.ownerEmail, input.createdAt, input.createdAt, input.createdAt],
  },
  {
    query: `INSERT INTO api_tokens (
        id, user_id, selector, secret_hash, name, scopes, last_used_at,
        expires_at, revoked_at, created_at, updated_at
      ) SELECT 1, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM api_tokens)`,
    bindings: [
      input.tokenSelector,
      input.tokenSecretHash,
      input.tokenName,
      input.tokenScopes,
      input.createdAt,
      input.createdAt,
    ],
  },
  claim(input),
]

const isConflict = (error: unknown): boolean =>
  error instanceof Error &&
  /instance bootstrap (?:requires empty identity state|state mismatch)/i.test(error.message)

const translateConflict = (error: unknown): never => {
  if (isConflict(error)) throw new InstanceBootstrapConflictError()
  throw error
}

const ownerPasswordLookup = `SELECT
    bootstrap.owner_email AS ownerEmail,
    password.credential_version AS credentialVersion,
    password.algorithm,
    password.version,
    password.iterations,
    password.memory_kib AS memoryKiB,
    password.time_cost AS timeCost,
    password.parallelism,
    password.salt,
    password.password_hash AS passwordHash
  FROM instance_bootstrap bootstrap
  JOIN users user ON user.id = 1
  JOIN organization_owner owner ON owner.id = 1 AND owner.user_id = user.id
  JOIN user_emails email ON email.user_id = user.id
    AND email.address = bootstrap.owner_email
    AND email.is_primary = 1
  JOIN api_tokens token ON token.id = 1 AND token.user_id = user.id
  LEFT JOIN user_passwords password ON password.user_id = user.id
  WHERE bootstrap.id = 1
    AND user.is_owner = 1
    AND user.profile = 'administrator'
    AND user.is_active = 1
    AND email.verified_at IS NOT NULL
    AND email.invalidated_at IS NULL
    AND token.selector = bootstrap.token_selector
    AND token.secret_hash = bootstrap.token_secret_hash
    AND token.name = bootstrap.token_name
    AND token.scopes = bootstrap.token_scopes
    AND token.selector = ?
    AND token.secret_hash = ?
    AND token.revoked_at IS NULL
    AND (token.expires_at IS NULL OR julianday(token.expires_at) > julianday(?))`

const ownerPasswordInsert = `INSERT INTO user_passwords (
    user_id, credential_version, algorithm, version, iterations, memory_kib, time_cost,
    parallelism, salt, password_hash, created_at, updated_at
  ) SELECT
    1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  FROM instance_bootstrap bootstrap
  JOIN users user ON user.id = 1
  JOIN organization_owner owner ON owner.id = 1 AND owner.user_id = user.id
  JOIN user_emails email ON email.user_id = user.id
    AND email.address = bootstrap.owner_email
    AND email.is_primary = 1
  JOIN api_tokens token ON token.id = 1 AND token.user_id = user.id
  WHERE bootstrap.id = 1
    AND user.is_owner = 1
    AND user.profile = 'administrator'
    AND user.is_active = 1
    AND email.verified_at IS NOT NULL
    AND email.invalidated_at IS NULL
    AND token.selector = bootstrap.token_selector
    AND token.secret_hash = bootstrap.token_secret_hash
    AND token.name = bootstrap.token_name
    AND token.scopes = bootstrap.token_scopes
    AND token.selector = ?
    AND token.secret_hash = ?
    AND token.revoked_at IS NULL
    AND (token.expires_at IS NULL OR julianday(token.expires_at) > julianday(?))
    AND NOT EXISTS (SELECT 1 FROM user_passwords WHERE user_id = user.id)
  RETURNING user_id AS userId`

const storedPassword = (row: OwnerPasswordRow): StoredPassword | null => {
  const values = [
    row.algorithm,
    row.credentialVersion,
    row.version,
    row.iterations,
    row.memoryKiB,
    row.timeCost,
    row.parallelism,
    row.salt,
    row.passwordHash,
  ]
  if (values.every((value) => value === null)) return null
  if (row.algorithm === 'pbkdf2-sha256') {
    if (
      !Number.isSafeInteger(row.credentialVersion) ||
      row.credentialVersion! < 1 ||
      row.version !== null ||
      row.iterations === null ||
      row.memoryKiB !== null ||
      row.timeCost !== null ||
      row.parallelism !== null ||
      row.salt === null ||
      row.passwordHash === null
    ) {
      throw new InstanceOwnerPasswordConflictError()
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
    row.parallelism === null ||
    row.salt === null ||
    row.passwordHash === null
  ) {
    throw new InstanceOwnerPasswordConflictError()
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

const exactOwnerPasswordRetry = async (
  database: PortableDatabase,
  bindings: readonly unknown[],
  password: string,
): Promise<OwnerPasswordRow> => {
  const row = await database.first<OwnerPasswordRow>(ownerPasswordLookup, bindings)
  if (row === null) throw new InstanceOwnerPasswordConflictError()
  const existing = storedPassword(row)
  if (existing === null) throw new InstanceOwnerPasswordConflictError()
  try {
    if (await verifyPassword(password, existing)) return row
  } catch (error) {
    if (error instanceof PasswordDerivationOverloadedError) throw error
    throw new InstanceOwnerPasswordConflictError()
  }
  throw new InstanceOwnerPasswordConflictError()
}

const enrollInstanceOwnerPassword = async (
  database: PortableDatabase,
  input: InstanceOwnerPasswordInput,
  { now = () => new Date().toISOString() }: InstanceBootstrapOptions = {},
): Promise<InstanceOwnerPasswordResult> => {
  validatePassword(input.password)
  const timestamp = now()
  assertCanonicalTimestamp(timestamp)
  const token = await prepareApiTokenForStorage(input.token)
  const bindings = [token.selector, token.secretHash, timestamp] as const
  const row = await database.first<OwnerPasswordRow>(ownerPasswordLookup, bindings)
  if (row === null) throw new InstanceOwnerPasswordConflictError()

  const existing = storedPassword(row)
  if (existing !== null) {
    const retry = await exactOwnerPasswordRetry(database, bindings, input.password)
    return { userId: 1, profile: 'administrator', ownerEmail: retry.ownerEmail }
  }

  const password = await hashPassword(input.password)
  try {
    const rows = await database.atomic([
      {
        query: ownerPasswordInsert,
        bindings: [
          password.algorithm,
          password.version,
          // iterations: a PBKDF2 column, and nothing hashes to PBKDF2 any more.
          null,
          password.memoryKiB,
          password.timeCost,
          password.parallelism,
          password.salt,
          password.passwordHash,
          timestamp,
          timestamp,
          ...bindings,
        ],
      },
    ])
    if ((rows[0]?.[0] as { userId?: number } | undefined)?.userId !== 1) {
      throw new InstanceOwnerPasswordConflictError()
    }
  } catch (error) {
    if (error instanceof InstanceOwnerPasswordConflictError) {
      const retry = await exactOwnerPasswordRetry(database, bindings, input.password)
      return { userId: 1, profile: 'administrator', ownerEmail: retry.ownerEmail }
    }
    if (
      error instanceof Error &&
      /unique constraint failed: user_passwords\.user_id/i.test(error.message)
    ) {
      const retry = await exactOwnerPasswordRetry(database, bindings, input.password)
      return { userId: 1, profile: 'administrator', ownerEmail: retry.ownerEmail }
    }
    throw error
  }
  return { userId: 1, profile: 'administrator', ownerEmail: row.ownerEmail }
}

export const bootstrapInstanceD1 = async (
  database: D1Database,
  input: InstanceBootstrapInput,
  { now = () => new Date().toISOString() }: InstanceBootstrapOptions = {},
): Promise<InstanceBootstrapResult> => {
  const normalized = await normalize(input, now)
  const approvalsAvailable = await database
    .prepare(`SELECT 1 AS available FROM sqlite_master
      WHERE type = 'table' AND name = 'timesheet_submissions'`)
    .first()
  try {
    await database.batch(
      operations(
        normalized,
        approvalsAvailable === null ? legacyModules : approvalModules,
      ).map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
    )
  } catch (error) {
    translateConflict(error)
  }
  return { userId: 1, profile: 'administrator' }
}

export const bootstrapInstanceContainer = async (
  database: BetterSqlite3.Database,
  input: InstanceBootstrapInput,
  { now = () => new Date().toISOString() }: InstanceBootstrapOptions = {},
): Promise<InstanceBootstrapResult> => {
  const normalized = await normalize(input, now)
  const approvalsAvailable = database
    .prepare(`SELECT 1 AS available FROM sqlite_master
      WHERE type = 'table' AND name = 'timesheet_submissions'`)
    .get()
  const run = database.transaction(() => {
    for (const { query, bindings } of operations(
      normalized,
      approvalsAvailable === undefined ? legacyModules : approvalModules,
    )) {
      database.prepare(query).run(...bindings)
    }
  })
  try {
    run()
  } catch (error) {
    translateConflict(error)
  }
  return { userId: 1, profile: 'administrator' }
}

export const enrollInstanceOwnerPasswordD1 = async (
  database: D1Database,
  input: InstanceOwnerPasswordInput,
  options: InstanceBootstrapOptions = {},
): Promise<InstanceOwnerPasswordResult> =>
  enrollInstanceOwnerPassword(
    {
      first: async (query, bindings = []) =>
        database
          .prepare(query)
          .bind(...bindings)
          .first(),
      atomic: async (requestedOperations) => {
        const results = await database.batch(
          requestedOperations.map(({ query, bindings }) =>
            database.prepare(query).bind(...bindings),
          ),
        )
        return results.map((result) => result.results as Record<string, unknown>[])
      },
    },
    input,
    options,
  )

export const enrollInstanceOwnerPasswordContainer = async (
  database: BetterSqlite3.Database,
  input: InstanceOwnerPasswordInput,
  options: InstanceBootstrapOptions = {},
): Promise<InstanceOwnerPasswordResult> =>
  enrollInstanceOwnerPassword(
    {
      first: async <T>(query: string, bindings: readonly unknown[] = []) =>
        (database.prepare(query).get(...bindings) as T | undefined) ?? null,
      atomic: async (requestedOperations) => {
        const run = database.transaction(() =>
          requestedOperations.map(
            ({ query, bindings }) =>
              database.prepare(query).all(...bindings) as Record<string, unknown>[],
          ),
        )
        return run()
      },
    },
    input,
    options,
  )
