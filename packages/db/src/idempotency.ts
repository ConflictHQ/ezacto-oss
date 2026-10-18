import { AsyncLocalStorage } from 'node:async_hooks'
import type BetterSqlite3 from 'better-sqlite3'

/**
 * Idempotency keys in the database (issue 952): the claim a keyed write makes,
 * and the stores the HTTP layer (`@ezacto/api` `withIdempotency`) reads and
 * completes.
 *
 * The hosted router runs a whole request inside one transaction, so a write and
 * the record of its response commit together. D1 has no transaction that spans
 * a request -- a batch is the unit -- so the guarantee is built differently
 * here, and it has to be built where every write passes:
 *
 * - A keyed request runs inside a claim scope (`runWithClaim`).
 * - Every write made in that scope carries one more statement in its own batch
 *   or transaction: the claim. It inserts the key's row when there is none, does
 *   nothing when the row is this attempt's own, and collides with the primary
 *   key when another attempt holds the key -- which rolls the whole write back.
 * - So a write can never commit without its claim, and once one attempt has
 *   claimed a key no other attempt's write can commit at all. A retry that
 *   finds the row knows the first attempt wrote; one that finds nothing knows
 *   it did not, and runs.
 *
 * The response is recorded straight after the request, as its own statement
 * (`complete`). An instance that stops in between leaves the row claimed: the
 * work is done but its answer was never kept, which the HTTP layer reports once
 * a short lease has passed.
 *
 * Reads pass straight through, and nothing changes outside a claim scope: the
 * crons, the queue consumer and the migrations never see a rider.
 */

/** The row a keyed request claims, as the HTTP layer derived it. */
export interface IdempotencyClaim {
  /** Domain-separated hash of the client's key; stable across secret rotation. */
  readonly id: string
  /** HMAC of method, target, content type and body. */
  readonly fingerprint: string
  readonly secretVersion: string
  /** HMAC of the credentials the request carried; a replay needs the same. */
  readonly holder: string
  /** This execution of the request. Another retry is another attempt. */
  readonly attempt: string
  readonly createdAt: string
  readonly expiresAt: string
}

/** A stored row, as the HTTP layer reads it. */
export interface IdempotencyRecord {
  readonly id: string
  readonly fingerprint: string
  readonly secretVersion: string
  readonly holder: string
  readonly attempt: string
  readonly state: 'claimed' | 'done'
  /** Null while claimed, and on a completed row whose response was not kept. */
  readonly nonce: string | null
  readonly sealed: string | null
  readonly createdAt: string
  readonly expiresAt: string
}

/** A response as it is stored: sealed, or not kept at all. */
export interface SealedIdempotentResponse {
  readonly nonce: string
  readonly sealed: string
}

/** What the claim went through while the request ran. */
export type IdempotentExecution<T> = {
  /** A write carrying the claim committed: the key belongs to this attempt. */
  readonly wrote: boolean
  /** A write was refused because another attempt holds the key. */
  readonly lost: boolean
} & ({ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown })

export interface IdempotencyStore {
  /** Current durable revision of resource authorization inputs. */
  authorizationRevision(): Promise<string>
  read(id: string): Promise<IdempotencyRecord | null>
  /** Drops this key's row if it has expired, so the key can be claimed afresh. */
  forget(id: string, now: string): Promise<void>
  /** Runs a request under its claim. Never throws; a failure is in the result. */
  execute<T>(claim: IdempotencyClaim, work: () => Promise<T>): Promise<IdempotentExecution<T>>
  /** Completes a row this attempt claimed. False when the row is not its own. */
  complete(
    claim: IdempotencyClaim,
    response: SealedIdempotentResponse | null,
    now: string,
  ): Promise<boolean>
}

interface ClaimState {
  readonly claim: IdempotencyClaim
  wrote: boolean
  lost: boolean
  readonly pending: Set<Promise<unknown>>
  /**
   * Set once the request has settled. Inherited work cannot then write: the
   * response already records this attempt's outcome. Independent queue work
   * must explicitly detach with outsideClaim before it begins.
   */
  closed: boolean
}

const scope = new AsyncLocalStorage<ClaimState | undefined>()

const activeClaim = (): ClaimState | undefined => scope.getStore()

const requireOpenClaim = (state: ClaimState): void => {
  if (state.closed) throw new Error('idempotency claim has closed; detached request writes are forbidden')
}

/**
 * Runs `work` with every write it makes carrying `claim`. The database handles
 * it writes through must have been wrapped by `createIdempotentD1` or
 * `createIdempotentSqlite`; any other handle writes without a claim.
 */
export const runWithClaim = async <T>(
  claim: IdempotencyClaim,
  work: () => Promise<T>,
): Promise<IdempotentExecution<T>> => {
  const state: ClaimState = { claim, wrote: false, lost: false, closed: false, pending: new Set() }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await scope.run(state, work) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  // Stop new writes, but settle D1 batches already sent before freezing the
  // outcome. Otherwise a detached in-flight write can land after wrote=false
  // has been returned and the response has gone out without being recorded.
  state.closed = true
  const settled = await Promise.allSettled(state.pending)
  const failed = settled.find((result) => result.status === 'rejected')
  if (outcome.ok && failed?.status === 'rejected') outcome = { ok: false, error: failed.reason }
  return { ...outcome, wrote: state.wrote, lost: state.lost }
}

/**
 * Runs `work` with no claim: what it writes commits as it would outside any
 * keyed request. For the writes authentication makes on every request -- a
 * session's last-seen time, a token's last use -- which are not the request's
 * own work. Were they to claim the key, a request refused before it changed
 * anything (a 403, a 500 before its write) would read as done to its retry.
 */
export const outsideClaim = <T>(work: () => Promise<T>): Promise<T> => scope.run(undefined, work)

/**
 * The rider. Inserts the claim when the key has no row, does nothing when the
 * row is this attempt's, and fails on the primary key when another attempt's
 * row is there -- the failure is the point: it takes the write down with it.
 * Positional parameters, repeated: `?1` reuse is not portable to better-sqlite3.
 */
const claimSql = `INSERT INTO idempotency_keys (id, fingerprint, secret_version, holder, attempt, state, created_at, expires_at)
  SELECT ?, ?, ?, ?, ?, 'claimed', ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM idempotency_keys WHERE id = ? AND attempt = ?)`

const claimParameters = (claim: IdempotencyClaim): unknown[] => [
  claim.id,
  claim.fingerprint,
  claim.secretVersion,
  claim.holder,
  claim.attempt,
  claim.createdAt,
  claim.expiresAt,
  claim.id,
  claim.attempt,
]

const ownerSql = 'SELECT attempt FROM idempotency_keys WHERE id = ?'

/**
 * After a write failed: did it fail because another attempt holds the key, or
 * did an earlier write of this attempt (or this one, its answer lost) commit
 * the claim? The row says which.
 */
const settle = (state: ClaimState, owner: string | undefined): void => {
  if (owner === undefined) return
  if (owner === state.claim.attempt) state.wrote = true
  else state.lost = true
}

const leadingTrivia = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/u

/**
 * Whether a statement can only read. Conservative by construction: anything
 * not plainly a SELECT, EXPLAIN or VALUES -- or a WITH that names no writing
 * verb -- is treated as a write. A read mistaken for a write costs a harmless
 * claim; a write mistaken for a read would be a write without one.
 */
export const isReadOnlySql = (sql: string): boolean => {
  const body = sql.replace(leadingTrivia, '')
  if (/^(?:select|explain|values)\b/iu.test(body)) return true
  if (/^with\b/iu.test(body)) return !/\b(?:insert|update|delete|replace)\b/iu.test(body)
  return false
}

const refusedOutsideTransaction = (what: string): Error =>
  new Error(`${what} cannot carry an idempotency claim; keyed requests write through prepare and batch only`)

// ---------------------------------------------------------------------------
// D1

const ridingD1 = new WeakMap<D1Database, D1Database>()

const rawRows = (result: D1Result, columnNames: boolean): unknown[] => {
  const rows = (result.results ?? []) as Record<string, unknown>[]
  const values = rows.map((row) => Object.values(row))
  return columnNames ? [rows[0] === undefined ? [] : Object.keys(rows[0]), ...values] : values
}

class RidingD1Statement {
  constructor(
    readonly database: RidingD1Database,
    readonly inner: D1PreparedStatement,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]): RidingD1Statement {
    return new RidingD1Statement(this.database, this.inner.bind(...values), this.sql)
  }

  run(): Promise<D1Result> {
    return this.database.single(this, (statement) => statement.run(), (result) => result)
  }

  all(): Promise<D1Result> {
    return this.database.single(this, (statement) => statement.all(), (result) => result)
  }

  first(column?: string): Promise<unknown> {
    return this.database.single(
      this,
      (statement) => (column === undefined ? statement.first() : statement.first(column)),
      (result) => {
        const row = (result.results ?? [])[0] as Record<string, unknown> | undefined
        if (row === undefined) return null
        if (column === undefined) return row
        if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`)
        return row[column]
      },
    )
  }

  raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
    const columnNames = options?.columnNames === true
    return this.database.single(
      this,
      (statement) =>
        (columnNames ? statement.raw({ columnNames: true }) : statement.raw()) as Promise<unknown[]>,
      (result) => rawRows(result, columnNames),
    )
  }
}

class RidingD1Database {
  constructor(readonly inner: D1Database) {}

  prepare(sql: string): RidingD1Statement {
    return new RidingD1Statement(this, this.inner.prepare(sql), sql)
  }

  batch(statements: readonly unknown[]): Promise<D1Result[]> {
    const state = activeClaim()
    const inner = statements.map((statement) =>
      statement instanceof RidingD1Statement ? statement.inner : (statement as D1PreparedStatement),
    )
    // A statement that did not come from this wrapper cannot be classified, so
    // it counts as a write.
    const writes = statements.some(
      (statement) => !(statement instanceof RidingD1Statement) || !isReadOnlySql(statement.sql),
    )
    if (state === undefined || !writes) return this.inner.batch(inner)
    return this.ride(state, inner)
  }

  exec(query: string): Promise<D1ExecResult> {
    if (activeClaim() !== undefined) return Promise.reject(refusedOutsideTransaction('exec'))
    return this.inner.exec(query)
  }

  withSession(constraintOrBookmark?: string): D1DatabaseSession {
    if (activeClaim() !== undefined) throw refusedOutsideTransaction('withSession')
    return this.inner.withSession(constraintOrBookmark as D1SessionBookmark)
  }

  dump(): Promise<ArrayBuffer> {
    return this.inner.dump()
  }

  /** One statement: sent as it is, or -- a write in a claim scope -- as a batch with the claim. */
  async single<T>(
    statement: RidingD1Statement,
    direct: (statement: D1PreparedStatement) => Promise<T>,
    fromBatch: (result: D1Result) => T,
  ): Promise<T> {
    const state = activeClaim()
    if (state === undefined || isReadOnlySql(statement.sql)) return direct(statement.inner)
    const [result] = await this.ride(state, [statement.inner])
    return fromBatch(result!)
  }

  ride(state: ClaimState, statements: readonly D1PreparedStatement[]): Promise<D1Result[]> {
    requireOpenClaim(state)
    const pending = this.commit(state, statements)
    state.pending.add(pending)
    void pending.then(() => state.pending.delete(pending), () => state.pending.delete(pending))
    return pending
  }

  private async commit(state: ClaimState, statements: readonly D1PreparedStatement[]): Promise<D1Result[]> {
    const rider = this.inner.prepare(claimSql).bind(...claimParameters(state.claim))
    try {
      const results = await this.inner.batch([...statements, rider])
      state.wrote = true
      return results.slice(0, -1)
    } catch (error) {
      try {
        const row = await this.inner
          .prepare(ownerSql)
          .bind(state.claim.id)
          .first<{ attempt: string }>()
        settle(state, row?.attempt)
      } catch {
        // The write's own failure is the one worth reporting.
      }
      throw error
    }
  }
}

/**
 * The D1 binding every service of a request is built on. Stable per binding,
 * so caches keyed on the database (the migration readiness check) still hit.
 */
export const createIdempotentD1 = (database: D1Database): D1Database => {
  if (database instanceof RidingD1Database) return database
  const existing = ridingD1.get(database)
  if (existing !== undefined) return existing
  const riding = new RidingD1Database(database) as unknown as D1Database
  ridingD1.set(database, riding)
  return riding
}

// ---------------------------------------------------------------------------
// better-sqlite3 (the container)

const chainable = new Set(['bind', 'raw', 'pluck', 'expand', 'safeIntegers'])
const executing = new Set(['run', 'get', 'all', 'iterate'])
const ridingSqlite = new WeakSet<object>()

/**
 * The container's handle, wrapped. A write made in a claim scope commits with
 * the claim: inside the outermost transaction this wrapper opened, the claim is
 * the transaction's last statement; a lone write is put in a transaction of its
 * own with it. A statement's own `readonly` flag tells a write from a read.
 */
export const createIdempotentSqlite = (database: BetterSqlite3.Database): BetterSqlite3.Database => {
  if (ridingSqlite.has(database)) return database
  /** Transactions this wrapper has open, outermost first. */
  let depth = 0
  /** Writes made inside the outermost open transaction. */
  let transactionWrites = 0
  /** Whether the claim ran in the transaction call now finishing. */
  let claimed = false

  const claimNow = (state: ClaimState): void => {
    database.prepare(claimSql).run(...claimParameters(state.claim))
  }

  const settleSqlite = (state: ClaimState): void => {
    try {
      const row = database.prepare(ownerSql).get(state.claim.id) as { attempt: string } | undefined
      settle(state, row?.attempt)
    } catch {
      // The write's own failure is the one worth reporting.
    }
  }

  const write = <T>(execute: () => T): T => {
    const state = activeClaim()
    if (state === undefined) return execute()
    requireOpenClaim(state)
    if (database.inTransaction) {
      if (depth === 0) throw refusedOutsideTransaction('A transaction this wrapper did not open')
      transactionWrites += 1
      return execute()
    }
    try {
      const result = database
        .transaction(() => {
          const value = execute()
          claimNow(state)
          return value
        })
        .immediate()
      state.wrote = true
      return result
    } catch (error) {
      settleSqlite(state)
      throw error
    }
  }

  const wrapStatement = (statement: BetterSqlite3.Statement): BetterSqlite3.Statement => {
    const proxy: BetterSqlite3.Statement = new Proxy(statement, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        const method = value as (...args: unknown[]) => unknown
        if (typeof property === 'string' && chainable.has(property)) {
          return (...args: unknown[]) => {
            method.apply(target, args)
            return proxy
          }
        }
        if (typeof property === 'string' && executing.has(property)) {
          return (...args: unknown[]) => {
            if (target.readonly) return method.apply(target, args)
            // A write's rows are all read inside the claim's transaction; an
            // iterator would outlive it.
            if (property === 'iterate') {
              return write(() => target.all(...args) as unknown[])[Symbol.iterator]()
            }
            return write(() => method.apply(target, args))
          }
        }
        return method.bind(target)
      },
    })
    return proxy
  }

  type Transaction = ((...args: unknown[]) => unknown) & {
    deferred: (...args: unknown[]) => unknown
    immediate: (...args: unknown[]) => unknown
    exclusive: (...args: unknown[]) => unknown
  }

  const wrapTransaction = (fn: (...args: unknown[]) => unknown): Transaction => {
    const native = database.transaction(function (this: unknown, ...args: unknown[]) {
      depth += 1
      const outermost = depth === 1
      if (outermost) transactionWrites = 0
      try {
        const result = fn.apply(this, args)
        const state = activeClaim()
        if (outermost && state !== undefined && transactionWrites > 0) {
          claimNow(state)
          claimed = true
        }
        return result
      } finally {
        depth -= 1
      }
    }) as unknown as Transaction
    const variant =
      (run: (...args: unknown[]) => unknown) =>
      (...args: unknown[]): unknown => {
        const state = activeClaim()
        const outermost = depth === 0
        if (outermost) claimed = false
        try {
          const result = run(...args)
          if (outermost && claimed && state !== undefined) state.wrote = true
          return result
        } catch (error) {
          if (outermost && state !== undefined) settleSqlite(state)
          throw error
        }
      }
    const wrapped = variant(native) as Transaction
    wrapped.deferred = variant(native.deferred)
    wrapped.immediate = variant(native.immediate)
    wrapped.exclusive = variant(native.exclusive)
    Object.defineProperty(wrapped, 'database', { value: proxy })
    return wrapped
  }

  const proxy: BetterSqlite3.Database = new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => wrapStatement(target.prepare(sql))
      }
      if (property === 'transaction') {
        return (fn: (...args: unknown[]) => unknown) => wrapTransaction(fn)
      }
      if (property === 'exec') {
        return (sql: string) => {
          if (activeClaim() !== undefined) throw refusedOutsideTransaction('exec')
          target.exec(sql)
          return proxy
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
  ridingSqlite.add(proxy)
  return proxy
}

// ---------------------------------------------------------------------------
// Stores

const authorizationSql = 'SELECT CAST(revision AS TEXT) AS revision FROM idempotency_authorization WHERE id = 1'

const authorizationRevision = (row: { revision: string } | null | undefined): string => {
  if (row === null || row === undefined || !/^[0-9]+$/u.test(row.revision)) {
    throw new Error('idempotency authorization revision is unavailable')
  }
  return row.revision
}

const readSql = `SELECT id, fingerprint, secret_version, holder, attempt, state, nonce, sealed, created_at, expires_at
  FROM idempotency_keys WHERE id = ?`
const forgetSql = 'DELETE FROM idempotency_keys WHERE id = ? AND expires_at <= ?'
const completeSql = `UPDATE idempotency_keys SET state = 'done', nonce = ?, sealed = ?
  WHERE id = ? AND attempt = ? AND state = 'claimed'`
/** Bounded, so one write never pays for a long quiet spell's backlog at once. */
const purgeSql = `DELETE FROM idempotency_keys WHERE id IN (
  SELECT id FROM idempotency_keys WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`

interface StoredRow {
  id: string
  fingerprint: string
  secret_version: string
  holder: string
  attempt: string
  state: 'claimed' | 'done'
  nonce: string | null
  sealed: string | null
  created_at: string
  expires_at: string
}

const fromRow = (row: StoredRow): IdempotencyRecord => ({
  id: row.id,
  fingerprint: row.fingerprint,
  secretVersion: row.secret_version,
  holder: row.holder,
  attempt: row.attempt,
  state: row.state,
  nonce: row.nonce,
  sealed: row.sealed,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
})

/**
 * The D1 store. Give it the binding itself, not the riding wrapper: its own
 * statements must never carry a claim (they run outside the scope anyway).
 */
export const createD1IdempotencyStore = (database: D1Database): IdempotencyStore => ({
  async authorizationRevision() {
    return authorizationRevision(await database.prepare(authorizationSql).first<{ revision: string }>())
  },
  async read(id) {
    const row = await database.prepare(readSql).bind(id).first<StoredRow>()
    return row === null ? null : fromRow(row)
  },
  async forget(id, now) {
    await database.prepare(forgetSql).bind(id, now).run()
  },
  execute: runWithClaim,
  async complete(claim, response, now) {
    const [completed] = await database.batch([
      database
        .prepare(completeSql)
        .bind(response?.nonce ?? null, response?.sealed ?? null, claim.id, claim.attempt),
      database.prepare(purgeSql).bind(now),
    ])
    return (completed?.meta.changes ?? 0) === 1
  },
})

/** The container's store, on the handle itself rather than the riding wrapper. */
export const createContainerIdempotencyStore = (
  database: BetterSqlite3.Database,
): IdempotencyStore => ({
  async authorizationRevision() {
    return authorizationRevision(database.prepare(authorizationSql).get() as { revision: string } | undefined)
  },
  async read(id) {
    const row = database.prepare(readSql).get(id) as StoredRow | undefined
    return row === undefined ? null : fromRow(row)
  },
  async forget(id, now) {
    database.prepare(forgetSql).run(id, now)
  },
  execute: runWithClaim,
  async complete(claim, response, now) {
    return database.transaction(() => {
      const { changes } = database
        .prepare(completeSql)
        .run(response?.nonce ?? null, response?.sealed ?? null, claim.id, claim.attempt)
      database.prepare(purgeSql).run(now)
      return changes === 1
    })()
  },
})
