import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

/**
 * Which ways in are switched on. Issue 761.
 *
 * Only the decisions somebody made are stored: an absent key is enabled, so an
 * instance that has never touched the setting behaves exactly as it did before
 * the column existed. Whether a method is *available* is deployment state --
 * a client id, a signing key -- and is resolved at the edge, not here.
 */

type SignInMethodDatabase =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

export type SignInMethod = 'password' | 'magic_link' | 'google' | 'github'

export const SIGN_IN_METHODS: readonly SignInMethod[] = [
  'password',
  'magic_link',
  'google',
  'github',
]

export const isSignInMethod = (value: string): value is SignInMethod =>
  (SIGN_IN_METHODS as readonly string[]).includes(value)

export interface SignInMethodState {
  method: SignInMethod
  enabled: boolean
}

interface RawRow {
  password: number | null
  magic_link: number | null
  google: number | null
  github: number | null
}

/**
 * Either an ORM handle or the binding itself. The shell is rendered by a Worker
 * path that has no services and must not import the container driver, so it
 * hands the D1 binding straight in.
 */
const nativeClient = (database: SignInMethodDatabase | NativeClient): NativeClient =>
  '$client' in database
    ? (database as SignInMethodDatabase & { $client: NativeClient }).$client
    : (database as NativeClient)

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const first = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row | null> => {
  if (isD1Client(client)) return client.prepare(sql).bind(...params).first<Row>()
  return (client.prepare(sql).get(...params) as Row | undefined) ?? null
}

// COALESCE to 1, not to 0: the absent key is the untouched default, and the
// untouched default has to be "on" or an upgrade would lock an instance out.
const select = `SELECT
  COALESCE(json_extract(sign_in_methods, '$.password'), 1) AS password,
  COALESCE(json_extract(sign_in_methods, '$.magic_link'), 1) AS magic_link,
  COALESCE(json_extract(sign_in_methods, '$.google'), 1) AS google,
  COALESCE(json_extract(sign_in_methods, '$.github'), 1) AS github
FROM organizations WHERE id = 1`

const toStates = (row: RawRow): readonly SignInMethodState[] =>
  SIGN_IN_METHODS.map((method) => ({ method, enabled: row[method] === 1 }))

// No organization row yet means a first run that has not bootstrapped. Nothing
// has been switched off, so nothing is.
const allEnabled = (): readonly SignInMethodState[] =>
  SIGN_IN_METHODS.map((method) => ({ method, enabled: true }))

/**
 * What this person could actually sign in with, which is the question a lockout
 * guard has to answer. It is deliberately evidence, not eligibility: a provider
 * counts once there is an identity row for it, meaning they have signed in that
 * way at least once. A guard built on "they probably could" is a guard that
 * hands someone a locked instance and an explanation.
 *
 * `magic_link` needs only a verified address, because the link is sent to one.
 */
const usableSelect = `SELECT
  EXISTS (SELECT 1 FROM user_passwords WHERE user_id = ?) AS password,
  EXISTS (
    SELECT 1 FROM user_emails
    WHERE user_id = ? AND verified_at IS NOT NULL AND invalidated_at IS NULL
  ) AS magic_link,
  EXISTS (
    SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'google'
  ) AS google,
  EXISTS (
    SELECT 1 FROM user_identities WHERE user_id = ? AND provider = 'github'
  ) AS github`

export class SignInMethodRepository {
  readonly #client: NativeClient

  constructor(database: SignInMethodDatabase | NativeClient) {
    this.#client = nativeClient(database)
  }

  async list(): Promise<readonly SignInMethodState[]> {
    const row = await first<RawRow>(this.#client, select)
    return row === null ? allEnabled() : toStates(row)
  }

  /** The methods this user has demonstrated they can use. */
  async usableBy(userId: number): Promise<readonly SignInMethod[]> {
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new RangeError('sign-in method user id must be a positive safe integer')
    }
    const row = await first<RawRow>(this.#client, usableSelect, [
      userId,
      userId,
      userId,
      userId,
    ])
    if (row === null) return []
    return SIGN_IN_METHODS.filter((method) => row[method] === 1)
  }

  async setEnabled(
    method: SignInMethod,
    enabled: boolean,
    updatedAt: string,
  ): Promise<readonly SignInMethodState[]> {
    const value = enabled ? "json('true')" : "json('false')"
    const update = `UPDATE organizations
      SET sign_in_methods = json_set(sign_in_methods, '$.${method}', ${value}),
        updated_at = ?
      WHERE id = 1`
    const client = this.#client

    if (isD1Client(client)) {
      const [, read] = await client.batch([
        client.prepare(update).bind(updatedAt),
        client.prepare(select),
      ])
      const rows = (read?.results ?? []) as unknown as RawRow[]
      return rows[0] ? toStates(rows[0]) : allEnabled()
    }

    const execute = client.transaction(() => {
      client.prepare(update).run(updatedAt)
      return client.prepare(select).get() as RawRow | undefined
    })
    const row = execute.immediate()
    return row ? toStates(row) : allEnabled()
  }
}

export const createSignInMethodRepository = (
  database: SignInMethodDatabase | NativeClient,
): SignInMethodRepository => new SignInMethodRepository(database)
