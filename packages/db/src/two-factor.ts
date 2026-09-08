import type BetterSqlite3 from 'better-sqlite3'
import {
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_TIME_COST,
  ARGON2ID_VERSION,
  type StoredArgon2idPassword,
} from '@ezacto/core'

/**
 * Persistence for the second factor. The crypto is not here: verifying a TOTP
 * code and hashing a recovery code are pure functions in `@ezacto/core`, and
 * keeping them there is what lets the same verification run in the worker and
 * the container without this module being loaded at all.
 *
 * So the store never sees a recovery code in plain text. Callers hand it a
 * selector and an already-derived Argon2id hash, and read the hash back to
 * compare against; there is no column, argument, or return value on this
 * interface through which a code could be written down.
 */
export interface TotpEnrolment {
  userId: number
  /** Base32 seed. Recoverable by construction — an HMAC cannot be checked against a hash. */
  secret: string
  /** Null until a code proved the user's authenticator holds the same seed. */
  confirmedAt: string | null
  lastUsedStep: number | null
}

export interface NewRecoveryCode {
  selector: string
  hash: StoredArgon2idPassword
}

export interface StoredRecoveryCode {
  id: number
  selector: string
  hash: StoredArgon2idPassword
}

export interface BeginEnrolmentInput {
  userId: number
  secret: string
  codes: readonly NewRecoveryCode[]
}

/**
 * A confirmed enrolment cannot be replaced by starting a new one. Re-enrolling
 * has to go through `disable`, which is the path that asks for a factor first;
 * without that, anyone holding a live session could quietly swap the seed and
 * lock the owner out of their own account.
 */
export class TwoFactorEnrolmentLockedError extends Error {
  constructor() {
    super('two-factor authentication is already enabled for this user')
    this.name = 'TwoFactorEnrolmentLockedError'
  }
}

export interface TwoFactorStore {
  enrolment(userId: number): Promise<TotpEnrolment | null>
  beginEnrolment(input: BeginEnrolmentInput, now: string): Promise<TotpEnrolment>
  /** Turns the pending enrolment on and spends the step that proved it. */
  confirmEnrolment(userId: number, step: number, now: string): Promise<boolean>
  /**
   * Records a step as spent, refusing one that is not newer than the last.
   * The comparison happens in the UPDATE so that two requests carrying the
   * same code cannot both read the old value and both decide they are first.
   */
  spendTotpStep(userId: number, step: number, now: string): Promise<boolean>
  /**
   * Null when no unused code carries that selector. A caller must still run a
   * verification in that case — `RECOVERY_CODE_DECOY` exists for it — or an
   * unknown selector answers faster than a wrong code and the difference
   * enumerates which selectors are real.
   */
  findRecoveryCode(userId: number, selector: string): Promise<StoredRecoveryCode | null>
  spendRecoveryCode(userId: number, codeId: number, now: string): Promise<boolean>
  unusedRecoveryCodeCount(userId: number): Promise<number>
  /** Removes the enrolment and every code with it. False when there was nothing to remove. */
  disable(userId: number): Promise<boolean>
}

/**
 * A hash no code derives to, for the caller to burn a verification against
 * when a selector matches nothing.
 */
export const RECOVERY_CODE_DECOY: StoredArgon2idPassword = {
  algorithm: 'argon2id',
  version: ARGON2ID_VERSION,
  memoryKiB: ARGON2ID_MEMORY_KIB,
  timeCost: ARGON2ID_TIME_COST,
  parallelism: ARGON2ID_PARALLELISM,
  salt: 'AAAAAAAAAAAAAAAAAAAAAA',
  passwordHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}

interface Operation {
  query: string
  bindings: readonly unknown[]
}

interface PortableDatabase {
  first<T>(query: string, bindings?: readonly unknown[]): Promise<T | null>
  atomic(operations: readonly Operation[]): Promise<Record<string, unknown>[][]>
}

interface EnrolmentRow {
  userId: number
  secret: string
  confirmedAt: string | null
  lastUsedStep: number | null
}

interface RecoveryCodeRow {
  id: number
  selector: string
  version: number
  memoryKiB: number
  timeCost: number
  parallelism: number
  salt: string
  codeHash: string
}

const canonicalTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

const assertCanonicalTimestamp = (value: string): string => {
  const match = canonicalTimestampPattern.exec(value)
  const epoch = Date.parse(value)
  if (match === null || !Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError('two-factor clock must return a canonical UTC timestamp')
  }
  return value
}

const assertStep = (step: number): number => {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new RangeError('a TOTP step must be a non-negative safe integer')
  }
  return step
}

const enrolmentQuery = `SELECT user_id AS userId, secret,
    confirmed_at AS confirmedAt, last_used_step AS lastUsedStep
  FROM user_totp_enrolments WHERE user_id = ?`

const recoveryCodeQuery = `SELECT id, selector, version,
    memory_kib AS memoryKiB, time_cost AS timeCost, parallelism, salt,
    code_hash AS codeHash
  FROM user_recovery_codes
  WHERE user_id = ? AND selector = ? AND used_at IS NULL`

const unusedCountQuery = `SELECT count(*) AS remaining FROM user_recovery_codes
  WHERE user_id = ? AND used_at IS NULL`

// Each write is conditioned on the enrolment being unproved, so a user who is
// already enrolled loses neither seed nor codes to a second attempt: the whole
// batch becomes a no-op and the empty RETURNING is what reports it.
const discardPendingEnrolment = `DELETE FROM user_totp_enrolments
  WHERE user_id = ? AND confirmed_at IS NULL
  RETURNING user_id AS userId`

const discardPendingCodes = `DELETE FROM user_recovery_codes
  WHERE user_id = ? AND NOT EXISTS (
    SELECT 1 FROM user_totp_enrolments WHERE user_id = ?
  )
  RETURNING id`

const insertEnrolment = `INSERT INTO user_totp_enrolments
    (user_id, secret, confirmed_at, last_used_step, created_at, updated_at)
  SELECT ?, ?, NULL, NULL, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM user_totp_enrolments WHERE user_id = ?)
  RETURNING user_id AS userId, secret, confirmed_at AS confirmedAt,
    last_used_step AS lastUsedStep`

const insertRecoveryCode = `INSERT INTO user_recovery_codes
    (user_id, selector, algorithm, version, memory_kib, time_cost, parallelism,
     salt, code_hash, used_at, created_at, updated_at)
  SELECT ?, ?, 'argon2id', ?, ?, ?, ?, ?, ?, NULL, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM user_totp_enrolments WHERE user_id = ? AND confirmed_at IS NULL
  )
  RETURNING id`

const enrolment = (row: EnrolmentRow | null): TotpEnrolment | null =>
  row === null
    ? null
    : {
        userId: row.userId,
        secret: row.secret,
        confirmedAt: row.confirmedAt,
        lastUsedStep: row.lastUsedStep,
      }

const recoveryCode = (row: RecoveryCodeRow | null): StoredRecoveryCode | null =>
  row === null
    ? null
    : {
        id: row.id,
        selector: row.selector,
        hash: {
          algorithm: 'argon2id',
          version: row.version,
          memoryKiB: row.memoryKiB,
          timeCost: row.timeCost,
          parallelism: row.parallelism,
          salt: row.salt,
          passwordHash: row.codeHash,
        },
      }

const createTwoFactorStore = (database: PortableDatabase): TwoFactorStore => ({
  enrolment: async (userId) =>
    enrolment(await database.first<EnrolmentRow>(enrolmentQuery, [userId])),

  beginEnrolment: async ({ userId, secret, codes }, now) => {
    const timestamp = assertCanonicalTimestamp(now)
    const rows = await database.atomic([
      { query: discardPendingEnrolment, bindings: [userId] },
      { query: discardPendingCodes, bindings: [userId, userId] },
      {
        query: insertEnrolment,
        bindings: [userId, secret, timestamp, timestamp, userId],
      },
      ...codes.map(({ selector, hash }) => ({
        query: insertRecoveryCode,
        bindings: [
          userId,
          selector,
          hash.version,
          hash.memoryKiB,
          hash.timeCost,
          hash.parallelism,
          hash.salt,
          hash.passwordHash,
          timestamp,
          timestamp,
          userId,
        ],
      })),
    ])
    const inserted = enrolment((rows[2]?.[0] as EnrolmentRow | undefined) ?? null)
    if (inserted === null) throw new TwoFactorEnrolmentLockedError()
    return inserted
  },

  confirmEnrolment: async (userId, step, now) => {
    const timestamp = assertCanonicalTimestamp(now)
    const rows = await database.atomic([
      {
        query: `UPDATE user_totp_enrolments
            SET confirmed_at = ?, last_used_step = ?, updated_at = ?
          WHERE user_id = ? AND confirmed_at IS NULL
          RETURNING user_id AS userId`,
        bindings: [timestamp, assertStep(step), timestamp, userId],
      },
    ])
    return rows[0]?.length === 1
  },

  spendTotpStep: async (userId, step, now) => {
    const rows = await database.atomic([
      {
        query: `UPDATE user_totp_enrolments SET last_used_step = ?, updated_at = ?
          WHERE user_id = ? AND confirmed_at IS NOT NULL AND last_used_step < ?
          RETURNING user_id AS userId`,
        bindings: [assertStep(step), assertCanonicalTimestamp(now), userId, step],
      },
    ])
    return rows[0]?.length === 1
  },

  findRecoveryCode: async (userId, selector) =>
    recoveryCode(await database.first<RecoveryCodeRow>(recoveryCodeQuery, [userId, selector])),

  spendRecoveryCode: async (userId, codeId, now) => {
    const timestamp = assertCanonicalTimestamp(now)
    const rows = await database.atomic([
      {
        query: `UPDATE user_recovery_codes SET used_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND used_at IS NULL
          RETURNING id`,
        bindings: [timestamp, timestamp, codeId, userId],
      },
    ])
    return rows[0]?.length === 1
  },

  unusedRecoveryCodeCount: async (userId) =>
    (await database.first<{ remaining: number }>(unusedCountQuery, [userId]))?.remaining ?? 0,

  disable: async (userId) => {
    const rows = await database.atomic([
      {
        query: `DELETE FROM user_totp_enrolments WHERE user_id = ? RETURNING user_id AS userId`,
        bindings: [userId],
      },
      {
        query: `DELETE FROM user_recovery_codes WHERE user_id = ? RETURNING id`,
        bindings: [userId],
      },
    ])
    return rows[0]?.length === 1
  },
})

export const createContainerTwoFactorStore = (
  database: BetterSqlite3.Database,
): TwoFactorStore => {
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
  return createTwoFactorStore(portable)
}

export const createD1TwoFactorStore = (database: D1Database): TwoFactorStore => {
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
  return createTwoFactorStore(portable)
}
