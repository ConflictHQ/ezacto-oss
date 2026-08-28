import type BetterSqlite3 from 'better-sqlite3'
import { apiScopes } from '@ezacto/core'
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

export interface InstanceBootstrapOptions {
  now?: () => string
}

export class InstanceBootstrapConflictError extends Error {
  constructor() {
    super('instance bootstrap conflicts with existing identity state')
    this.name = 'InstanceBootstrapConflictError'
  }
}

interface Operation {
  query: string
  bindings: readonly unknown[]
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
const modules = JSON.stringify({ expenses: true, invoices: true })
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

const operations = (input: NormalizedBootstrap): Operation[] => [
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

export const bootstrapInstanceD1 = async (
  database: D1Database,
  input: InstanceBootstrapInput,
  { now = () => new Date().toISOString() }: InstanceBootstrapOptions = {},
): Promise<InstanceBootstrapResult> => {
  const normalized = await normalize(input, now)
  try {
    await database.batch(
      operations(normalized).map(({ query, bindings }) =>
        database.prepare(query).bind(...bindings),
      ),
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
  const run = database.transaction(() => {
    for (const { query, bindings } of operations(normalized)) {
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
