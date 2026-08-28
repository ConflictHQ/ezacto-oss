import type BetterSqlite3 from 'better-sqlite3'

export interface OidcTransaction {
  id: number
  provider: string
  issuer: string
  clientId: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

export interface CreateOidcTransactionInput {
  provider: string
  issuer: string
  clientId: string
  clientKeyHash: string
  stateHash: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  expiresAt: string
  createdAt: string
  rateWindowStart: string
  cleanupBefore: string
}

export type OidcTransactionCreation = 'created' | 'collision' | 'rate_limited'

export interface OidcTransactionStore {
  create(input: CreateOidcTransactionInput): Promise<OidcTransactionCreation>
  consume(provider: string, stateHash: string, now: string): Promise<OidcTransaction | null>
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

interface TransactionRow {
  id: number
  provider: string
  issuer: string
  clientId: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/
const providerPattern = /^[a-z][a-z0-9._-]{0,99}$/
const sha256HexPattern = /^[0-9a-f]{64}$/
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/

const printableText = (value: string, field: string, maximum: number): string => {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const normalized = value.normalize('NFC').trim()
  if (
    normalized.length < 1 ||
    [...normalized].length > maximum ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 31 || codePoint === 127
    })
  ) {
    throw new RangeError(`${field} is invalid`)
  }
  return normalized
}

const issuerUrl = (value: string): string => {
  const normalized = printableText(value, 'OIDC issuer', 2048)
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new RangeError('OIDC issuer is invalid')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href !== normalized
  ) {
    throw new RangeError('OIDC issuer must be a canonical HTTPS URL')
  }
  return normalized
}

const canonicalTimestamp = (value: string, field: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError(`${field} must be a canonical UTC timestamp`)
  }
  return value
}

const providerKey = (value: string): string => {
  if (!providerPattern.test(value)) throw new RangeError('OIDC provider key is invalid')
  return value
}

const stateDigest = (value: string): string => {
  if (!sha256HexPattern.test(value)) throw new RangeError('OIDC state digest is invalid')
  return value
}

const verifier = (value: string, field: string): string => {
  if (!verifierPattern.test(value)) throw new RangeError(`${field} is invalid`)
  return value
}

const redirectUri = (value: string): string => {
  if (value.length > 2048) throw new RangeError('OIDC redirect URI is too long')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RangeError('OIDC redirect URI is invalid')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    url.href !== value
  ) {
    throw new RangeError('OIDC redirect URI must be a canonical HTTPS URL')
  }
  return value
}

const consumeNonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const rowColumns = `id, provider, issuer, client_id AS clientId,
  code_verifier AS codeVerifier, nonce,
  redirect_uri AS redirectUri, expires_at AS expiresAt,
  consumed_at AS consumedAt, created_at AS createdAt`

const transaction = (row: TransactionRow | undefined): OidcTransaction => {
  if (row === undefined || !Number.isSafeInteger(row.id) || row.id < 1) {
    throw new Error('OIDC transaction store returned malformed identity')
  }
  providerKey(row.provider)
  issuerUrl(row.issuer)
  printableText(row.clientId, 'OIDC client id', 512)
  verifier(row.codeVerifier, 'OIDC code verifier')
  verifier(row.nonce, 'OIDC nonce')
  redirectUri(row.redirectUri)
  canonicalTimestamp(row.expiresAt, 'OIDC transaction expiry')
  canonicalTimestamp(row.createdAt, 'OIDC transaction creation time')
  if (row.consumedAt !== null) {
    canonicalTimestamp(row.consumedAt, 'OIDC transaction consumption time')
  }
  return { ...row }
}

const createOidcTransactionStore = (database: PortableDatabase): OidcTransactionStore => ({
  create: async (input) => {
    const provider = providerKey(input.provider)
    const issuer = issuerUrl(input.issuer)
    const clientId = printableText(input.clientId, 'OIDC client id', 512)
    const clientKeyHash = stateDigest(input.clientKeyHash)
    const stateHash = stateDigest(input.stateHash)
    const codeVerifier = verifier(input.codeVerifier, 'OIDC code verifier')
    const nonce = verifier(input.nonce, 'OIDC nonce')
    const callback = redirectUri(input.redirectUri)
    const createdAt = canonicalTimestamp(input.createdAt, 'OIDC transaction creation time')
    const expiresAt = canonicalTimestamp(input.expiresAt, 'OIDC transaction expiry')
    const rateWindowStart = canonicalTimestamp(input.rateWindowStart, 'OIDC rate window start')
    const cleanupBefore = canonicalTimestamp(input.cleanupBefore, 'OIDC cleanup threshold')
    if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
      throw new RangeError('OIDC transaction expiry must follow creation')
    }
    if (
      Date.parse(rateWindowStart) >= Date.parse(createdAt) ||
      Date.parse(cleanupBefore) >= Date.parse(createdAt)
    ) {
      throw new RangeError('OIDC transaction maintenance windows must precede creation')
    }
    const rows = await database.atomic([
      {
        query: `DELETE FROM oidc_transactions
          WHERE julianday(expires_at) <= julianday(?)
            OR (consumed_at IS NOT NULL AND julianday(consumed_at) <= julianday(?))`,
        bindings: [createdAt, cleanupBefore],
      },
      {
        query: `INSERT INTO oidc_transactions (
            provider, issuer, client_id, client_key_hash, state_hash,
            code_verifier, nonce, redirect_uri,
            expires_at, consumed_at, consume_nonce, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?
          WHERE (
            SELECT count(*) FROM oidc_transactions
            WHERE client_key_hash = ? AND julianday(created_at) >= julianday(?)
          ) < 20
          ON CONFLICT(state_hash) DO NOTHING
          RETURNING id`,
        bindings: [
          provider,
          issuer,
          clientId,
          clientKeyHash,
          stateHash,
          codeVerifier,
          nonce,
          callback,
          expiresAt,
          createdAt,
          createdAt,
          clientKeyHash,
          rateWindowStart,
        ],
      },
      {
        query: `SELECT count(*) AS attempts FROM oidc_transactions
          WHERE client_key_hash = ? AND julianday(created_at) >= julianday(?)`,
        bindings: [clientKeyHash, rateWindowStart],
      },
    ])
    if (rows[1]?.length === 1) return 'created'
    const attempts = rows[2]?.[0]?.attempts
    return typeof attempts === 'number' && attempts >= 20 ? 'rate_limited' : 'collision'
  },
  consume: async (presentedProvider, presentedStateHash, now) => {
    const provider = providerKey(presentedProvider)
    const stateHash = stateDigest(presentedStateHash)
    const consumedAt = canonicalTimestamp(now, 'OIDC transaction consumption time')
    const nonce = consumeNonce()
    const rows = await database.atomic([
      {
        query: `UPDATE oidc_transactions
          SET consumed_at = ?, consume_nonce = ?, updated_at = ?
          WHERE provider = ? AND state_hash = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?)
          RETURNING ${rowColumns}`,
        bindings: [consumedAt, nonce, consumedAt, provider, stateHash, consumedAt],
      },
    ])
    const row = rows[0]?.[0] as unknown as TransactionRow | undefined
    return row === undefined ? null : transaction(row)
  },
})

export const createContainerOidcTransactionStore = (
  database: BetterSqlite3.Database,
): OidcTransactionStore => {
  database.pragma('foreign_keys = ON')
  return createOidcTransactionStore({
    atomic: async (operations) => {
      const run = database.transaction(() =>
        operations.map(({ query, bindings }) => {
          const statement = database.prepare(query)
          if (!statement.reader) {
            statement.run(...bindings)
            return []
          }
          return statement.all(...bindings) as Record<string, unknown>[]
        }),
      )
      return run()
    },
  })
}

export const createD1OidcTransactionStore = (
  database: D1Database,
): OidcTransactionStore =>
  createOidcTransactionStore({
    atomic: async (operations) => {
      const results = await database.batch(
        operations.map(({ query, bindings }) => database.prepare(query).bind(...bindings)),
      )
      return results.map((result) => result.results as Record<string, unknown>[])
    },
  })
