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
  /** Wrong codes since the last accepted one, across every surface that asks. */
  failedAttempts: number
  /** Set once the count hits the ceiling; until it passes, no code is read. */
  lockedUntil: string | null
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

/**
 * What a sign-in holds instead of a session while it waits for the second
 * factor. It names the user and nothing else: presenting it proves only that
 * the primary credential was accepted a few minutes ago.
 */
export interface TwoFactorChallenge {
  userId: number
}

export interface CreateTwoFactorChallengeInput {
  userId: number
  tokenHash: string
  expiresAt: string
  createdAt: string
  /** Expired or already-consumed rows at or before this instant are swept first. */
  cleanupBefore: string
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
  /**
   * Records a wrong code, against a pending enrolment as much as a confirmed
   * one. Returns the resulting lock instant once the count reaches
   * `maxAttempts`, and null while there are guesses left. The count and the
   * comparison live in the UPDATE so concurrent guesses cannot each read the
   * same old value and each decide they were under the ceiling.
   */
  recordFailedVerification(
    userId: number,
    now: string,
    maxAttempts: number,
    lockMs: number,
  ): Promise<string | null>
  /** Clears the count and any lock; run after a code is accepted. */
  clearFailedVerifications(userId: number, now: string): Promise<void>
  createChallenge(input: CreateTwoFactorChallengeInput): Promise<'created' | 'collision'>
  /**
   * Verify-and-consume in one UPDATE, so one challenge cannot become two
   * sessions. Null when the token is unknown, already spent, or expired.
   */
  consumeChallenge(tokenHash: string, now: string): Promise<TwoFactorChallenge | null>
  /** The challenge's user without spending it, for the code check that precedes the spend. */
  challengeHolder(tokenHash: string, now: string): Promise<TwoFactorChallenge | null>
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
  failedAttempts: number
  lockedUntil: string | null
}

interface ChallengeRow {
  userId: number
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

const assertCeiling = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('a two-factor attempt ceiling must be a positive safe integer')
  }
  return value
}

const assertDuration = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('a two-factor lock duration must be a positive safe integer')
  }
  return value
}

const challenge = (row: ChallengeRow | undefined): TwoFactorChallenge | null => {
  if (row === undefined) return null
  if (!Number.isSafeInteger(row.userId) || row.userId < 1) {
    throw new Error('two-factor challenge store returned a malformed user id')
  }
  return { userId: row.userId }
}

const assertStep = (step: number): number => {
  if (!Number.isSafeInteger(step) || step < 0) {
    throw new RangeError('a TOTP step must be a non-negative safe integer')
  }
  return step
}

const enrolmentQuery = `SELECT user_id AS userId, secret,
    confirmed_at AS confirmedAt, last_used_step AS lastUsedStep,
    failed_attempts AS failedAttempts, locked_until AS lockedUntil
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
    (user_id, secret, confirmed_at, last_used_step, created_at, updated_at,
     failed_attempts, locked_until)
  SELECT ?, ?, NULL, NULL, ?, ?, 0, NULL
  WHERE NOT EXISTS (SELECT 1 FROM user_totp_enrolments WHERE user_id = ?)
  RETURNING user_id AS userId, secret, confirmed_at AS confirmedAt,
    last_used_step AS lastUsedStep, failed_attempts AS failedAttempts,
    locked_until AS lockedUntil`

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
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil,
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
    const inserted = enrolment((rows[2]?.[0] as unknown as EnrolmentRow | undefined) ?? null)
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
      // The enrolment is gone, so nothing is left to challenge for; a live
      // challenge would otherwise sit there naming a user with no factor.
      {
        query: `DELETE FROM two_factor_challenges WHERE user_id = ? RETURNING id`,
        bindings: [userId],
      },
    ])
    return rows[0]?.length === 1
  },

  recordFailedVerification: async (userId, now, maxAttempts, lockMs) => {
    const timestamp = assertCanonicalTimestamp(now)
    const ceiling = assertCeiling(maxAttempts)
    const duration = assertDuration(lockMs)
    const unlockAt = new Date(Date.parse(timestamp) + duration).toISOString()
    const rows = await database.atomic([
      {
        // The count and the lock move together. Reaching the ceiling sets the
        // lock and returns the count to zero, so the next window starts clean
        // rather than locking again on the first wrong code after it lifts.
        query: `UPDATE user_totp_enrolments
            SET failed_attempts = CASE
                  WHEN failed_attempts + 1 >= ? THEN 0
                  ELSE failed_attempts + 1
                END,
              locked_until = CASE
                  WHEN failed_attempts + 1 >= ? THEN ?
                  ELSE locked_until
                END,
              updated_at = ?
          WHERE user_id = ?
          RETURNING locked_until AS lockedUntil`,
        bindings: [ceiling, ceiling, unlockAt, timestamp, userId],
      },
    ])
    const row = rows[0]?.[0] as { lockedUntil?: string | null } | undefined
    const lockedUntil = row?.lockedUntil ?? null
    return lockedUntil !== null && Date.parse(lockedUntil) > Date.parse(timestamp)
      ? lockedUntil
      : null
  },

  clearFailedVerifications: async (userId, now) => {
    await database.atomic([
      {
        query: `UPDATE user_totp_enrolments
            SET failed_attempts = 0, locked_until = NULL, updated_at = ?
          WHERE user_id = ? AND (failed_attempts > 0 OR locked_until IS NOT NULL)
          RETURNING user_id AS userId`,
        bindings: [assertCanonicalTimestamp(now), userId],
      },
    ])
  },

  createChallenge: async ({ userId, tokenHash, expiresAt, createdAt, cleanupBefore }) => {
    const created = assertCanonicalTimestamp(createdAt)
    const expires = assertCanonicalTimestamp(expiresAt)
    const sweep = assertCanonicalTimestamp(cleanupBefore)
    if (Date.parse(expires) <= Date.parse(created)) {
      throw new RangeError('a two-factor challenge must expire after it is created')
    }
    const rows = await database.atomic([
      {
        query: `DELETE FROM two_factor_challenges
          WHERE julianday(expires_at) <= julianday(?)
            OR (consumed_at IS NOT NULL AND julianday(consumed_at) <= julianday(?))
          RETURNING id`,
        bindings: [created, sweep],
      },
      {
        query: `INSERT INTO two_factor_challenges
            (user_id, token_hash, expires_at, consumed_at, created_at, updated_at)
          VALUES (?, ?, ?, NULL, ?, ?)
          ON CONFLICT(token_hash) DO NOTHING
          RETURNING id`,
        bindings: [userId, tokenHash, expires, created, created],
      },
    ])
    return rows[1]?.length === 1 ? 'created' : 'collision'
  },

  consumeChallenge: async (tokenHash, now) => {
    const timestamp = assertCanonicalTimestamp(now)
    const rows = await database.atomic([
      {
        query: `UPDATE two_factor_challenges SET consumed_at = ?, updated_at = ?
          WHERE token_hash = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?)
          RETURNING user_id AS userId`,
        bindings: [timestamp, timestamp, tokenHash, timestamp],
      },
    ])
    return challenge(rows[0]?.[0] as unknown as ChallengeRow | undefined)
  },

  challengeHolder: async (tokenHash, now) =>
    challenge(
      (await database.first<ChallengeRow>(
        `SELECT user_id AS userId FROM two_factor_challenges
          WHERE token_hash = ? AND consumed_at IS NULL
            AND julianday(expires_at) > julianday(?)`,
        [tokenHash, assertCanonicalTimestamp(now)],
      )) ?? undefined,
    ),
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
