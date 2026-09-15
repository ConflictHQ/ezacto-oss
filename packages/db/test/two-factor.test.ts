import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_TIME_COST,
  ARGON2ID_VERSION,
  type StoredArgon2idPassword,
} from '@ezacto/core'
import {
  RECOVERY_CODE_DECOY,
  TwoFactorEnrolmentLockedError,
  createContainerTwoFactorStore,
  createD1TwoFactorStore,
  type NewRecoveryCode,
  type TwoFactorStore,
} from '../src/two-factor.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

const created = '2026-09-08T10:00:00.000Z'
const later = '2026-09-08T10:05:00.000Z'
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const replacementSecret = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U'

// Hashes, not codes. The plain text of a recovery code never reaches this
// module in production and it does not reach this file either, so a failing
// assertion cannot print one.
const hash = (salt: string, passwordHash: string): StoredArgon2idPassword => ({
  algorithm: 'argon2id',
  version: ARGON2ID_VERSION,
  memoryKiB: ARGON2ID_MEMORY_KIB,
  timeCost: ARGON2ID_TIME_COST,
  parallelism: ARGON2ID_PARALLELISM,
  salt,
  passwordHash,
})

const codes: NewRecoveryCode[] = [
  { selector: 'AAAAAAAA', hash: hash('B'.repeat(22), 'C'.repeat(43)) },
  { selector: 'DDDDDDDD', hash: hash('E'.repeat(22), 'F'.repeat(43)) },
]

interface Harness {
  store: TwoFactorStore
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  execute(query: string, ...bindings: unknown[]): Promise<void>
  close(): Promise<void>
}

const seedUsers = `INSERT INTO users (
    id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
  ) VALUES (1, 'Avery', 'Ng', 'administrator', '[]', 0, ?, ?),
    (2, 'Robin', 'Diaz', 'member', '[]', 0, ?, ?)`

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  // 0040 is in the ledger, so migrateContainer creates these tables. Applying
  // the statements again by hand is a duplicate CREATE.
  migrateContainer(database)
  database.prepare(seedUsers).run(created, created, created, created)
  return {
    store: createContainerTwoFactorStore(database),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      database.prepare(query).all(...bindings) as T[],
    execute: async (query: string, ...bindings: unknown[]) => {
      database.prepare(query).run(...bindings)
    },
    close: async () => {
      database.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  await database.prepare(seedUsers).bind(created, created, created, created).run()
  return {
    store: createD1TwoFactorStore(database),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results,
    execute: async (query: string, ...bindings: unknown[]) => {
      await database
        .prepare(query)
        .bind(...bindings)
        .run()
    },
    close: async () => miniflare.dispose(),
  }
}

const factories = [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const

for (const [runtime, factory] of factories) {
  describe(`two-factor store (${runtime})`, () => {
    let harness: Harness

    beforeAll(async () => {
      harness = await factory()
    })

    beforeEach(async () => {
      await harness.execute(`DELETE FROM user_recovery_codes`)
      await harness.execute(`DELETE FROM two_factor_challenges`)
      await harness.execute(`DELETE FROM user_totp_enrolments`)
    })

    afterAll(async () => harness.close())

    it('[api] enrols pending, and stays pending until a code proves it', async () => {
      expect(await harness.store.enrolment(1)).toBeNull()
      const pending = await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      expect(pending).toEqual({
        userId: 1,
        secret,
        confirmedAt: null,
        lastUsedStep: null,
        failedAttempts: 0,
        lockedUntil: null,
      })
      expect(await harness.store.unusedRecoveryCodeCount(1)).toBe(2)

      expect(await harness.store.confirmEnrolment(1, 100, later)).toBe(true)
      expect(await harness.store.enrolment(1)).toEqual({
        userId: 1,
        secret,
        confirmedAt: later,
        lastUsedStep: 100,
        failedAttempts: 0,
        lockedUntil: null,
      })
      // Confirmation is once. A second one would reset the replay guard.
      expect(await harness.store.confirmEnrolment(1, 500, later)).toBe(false)
    })

    it('[api] restarts a pending enrolment but refuses to replace a live one', async () => {
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      const restarted = await harness.store.beginEnrolment(
        { userId: 1, secret: replacementSecret, codes: [codes[0]!] },
        later,
      )
      expect(restarted.secret).toBe(replacementSecret)
      expect(await harness.store.unusedRecoveryCodeCount(1)).toBe(1)

      await harness.store.confirmEnrolment(1, 100, later)
      await expect(
        harness.store.beginEnrolment({ userId: 1, secret: replacementSecret, codes }, later),
      ).rejects.toBeInstanceOf(TwoFactorEnrolmentLockedError)
      // The refusal takes nothing with it: the live seed and its codes survive.
      expect(await harness.store.enrolment(1)).toMatchObject({
        secret: replacementSecret,
        confirmedAt: later,
      })
      expect(await harness.store.unusedRecoveryCodeCount(1)).toBe(1)
    })

    it('[api] spends a TOTP step only when it is newer than the last', async () => {
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      await harness.store.confirmEnrolment(1, 100, created)

      expect(await harness.store.spendTotpStep(1, 100, later)).toBe(false)
      expect(await harness.store.spendTotpStep(1, 99, later)).toBe(false)
      expect(await harness.store.spendTotpStep(1, 101, later)).toBe(true)
      expect(await harness.store.enrolment(1)).toMatchObject({ lastUsedStep: 101 })
      expect(await harness.store.spendTotpStep(1, 101, later)).toBe(false)
    })

    it('[api] refuses to spend a step against an unproved enrolment', async () => {
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      expect(await harness.store.spendTotpStep(1, 100, later)).toBe(false)
    })

    it('[security] locks the factor once the wrong codes reach the ceiling', async () => {
      // Issue 735. Three codes are valid per thirty seconds out of a million,
      // and the check is a cheap HMAC, so the guesses have to be counted or the
      // second factor is a formality.
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      await harness.store.confirmEnrolment(1, 100, created)

      for (let attempt = 1; attempt < 5; attempt += 1) {
        expect(await harness.store.recordFailedVerification(1, created, 5, 900_000)).toBeNull()
        expect(await harness.store.enrolment(1)).toMatchObject({
          failedAttempts: attempt,
          lockedUntil: null,
        })
      }
      const lockedUntil = await harness.store.recordFailedVerification(1, created, 5, 900_000)
      expect(lockedUntil).toBe('2026-09-08T10:15:00.000Z')
      // The count restarts with the lock, so the window that follows gets its
      // own budget rather than locking again on the first wrong code.
      expect(await harness.store.enrolment(1)).toMatchObject({
        failedAttempts: 0,
        lockedUntil,
      })

      await harness.store.clearFailedVerifications(1, later)
      expect(await harness.store.enrolment(1)).toMatchObject({
        failedAttempts: 0,
        lockedUntil: null,
      })
    })

    it('[security] counts wrong codes against a pending enrolment too', async () => {
      // The confirm route checks a code against a seed the presenter chose. It
      // is the cheapest place to measure how the check behaves, so it counts.
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      expect(await harness.store.recordFailedVerification(1, created, 2, 900_000)).toBeNull()
      expect(await harness.store.recordFailedVerification(1, created, 2, 900_000)).toBe(
        '2026-09-08T10:15:00.000Z',
      )
    })

    it('[security] turns one challenge into exactly one session', async () => {
      // Issue 731. The consume is the authority: two requests holding the same
      // challenge both verify the same code, and only one may become a session.
      const tokenHash = 'a'.repeat(64)
      expect(
        await harness.store.createChallenge({
          userId: 1,
          tokenHash,
          expiresAt: later,
          createdAt: created,
          cleanupBefore: '2026-09-08T09:00:00.000Z',
        }),
      ).toBe('created')

      // Reading the holder leaves the challenge standing, so a mistyped code
      // costs a retry rather than the password.
      expect(await harness.store.challengeHolder(tokenHash, created)).toEqual({ userId: 1 })
      expect(await harness.store.challengeHolder(tokenHash, created)).toEqual({ userId: 1 })

      expect(await harness.store.consumeChallenge(tokenHash, created)).toEqual({ userId: 1 })
      expect(await harness.store.consumeChallenge(tokenHash, created)).toBeNull()
      expect(await harness.store.challengeHolder(tokenHash, created)).toBeNull()
    })

    it('[security] refuses an expired challenge and an unknown one alike', async () => {
      const tokenHash = 'b'.repeat(64)
      await harness.store.createChallenge({
        userId: 1,
        tokenHash,
        expiresAt: later,
        createdAt: created,
        cleanupBefore: '2026-09-08T09:00:00.000Z',
      })
      const afterExpiry = '2026-09-08T10:05:00.001Z'
      expect(await harness.store.challengeHolder(tokenHash, afterExpiry)).toBeNull()
      expect(await harness.store.consumeChallenge(tokenHash, afterExpiry)).toBeNull()
      expect(await harness.store.challengeHolder('c'.repeat(64), created)).toBeNull()
    })

    it('[security] drops the challenges of a user who removed the factor', async () => {
      // A challenge outliving the enrolment would name a user with no second
      // factor, and redeeming it would be a sign-in nothing checked.
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      await harness.store.confirmEnrolment(1, 100, created)
      await harness.store.createChallenge({
        userId: 1,
        tokenHash: 'd'.repeat(64),
        expiresAt: later,
        createdAt: created,
        cleanupBefore: '2026-09-08T09:00:00.000Z',
      })
      expect(await harness.store.disable(1)).toBe(true)
      expect(await harness.store.challengeHolder('d'.repeat(64), created)).toBeNull()
    })

    it('[e2e:first-run] a recovery code gets one person in exactly once', async () => {
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      await harness.store.confirmEnrolment(1, 100, created)

      const found = await harness.store.findRecoveryCode(1, 'AAAAAAAA')
      expect(found?.hash).toEqual(codes[0]!.hash)
      expect(await harness.store.spendRecoveryCode(1, found!.id, later)).toBe(true)
      expect(await harness.store.spendRecoveryCode(1, found!.id, later)).toBe(false)
      expect(await harness.store.findRecoveryCode(1, 'AAAAAAAA')).toBeNull()
      expect(await harness.store.unusedRecoveryCodeCount(1)).toBe(1)
      // Spending one code leaves the enrolment standing on the others.
      expect(await harness.store.enrolment(1)).toMatchObject({ confirmedAt: created })
    })

    it("[api] never reaches another user's codes or enrolment", async () => {
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      expect(await harness.store.findRecoveryCode(2, 'AAAAAAAA')).toBeNull()
      expect(await harness.store.unusedRecoveryCodeCount(2)).toBe(0)
      const found = await harness.store.findRecoveryCode(1, 'AAAAAAAA')
      expect(await harness.store.spendRecoveryCode(2, found!.id, later)).toBe(false)
      expect(await harness.store.unusedRecoveryCodeCount(1)).toBe(2)
    })

    it('[api] disabling takes the seed and every code with it', async () => {
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      await harness.store.confirmEnrolment(1, 100, created)
      expect(await harness.store.disable(1)).toBe(true)
      expect(await harness.store.enrolment(1)).toBeNull()
      expect(await harness.store.unusedRecoveryCodeCount(1)).toBe(0)
      expect(await harness.store.disable(1)).toBe(false)
      // With nothing left, enrolling again is allowed.
      await harness.store.beginEnrolment({ userId: 1, secret: replacementSecret, codes }, later)
      expect(await harness.store.enrolment(1)).toMatchObject({ secret: replacementSecret })
    })

    it('[unit] the decoy hash is a real Argon2id record no code can match', async () => {
      expect(RECOVERY_CODE_DECOY).toMatchObject({
        algorithm: 'argon2id',
        version: ARGON2ID_VERSION,
        memoryKiB: ARGON2ID_MEMORY_KIB,
      })
      await harness.store.beginEnrolment({ userId: 1, secret, codes }, created)
      expect(
        (await harness.store.findRecoveryCode(1, 'AAAAAAAA'))?.hash.passwordHash,
      ).not.toBe(RECOVERY_CODE_DECOY.passwordHash)
    })

    it('[unit] refuses a clock the schema would reject', async () => {
      await expect(
        harness.store.beginEnrolment({ userId: 1, secret, codes }, '2026-09-08 10:00:00'),
      ).rejects.toBeInstanceOf(RangeError)
      expect(await harness.store.enrolment(1)).toBeNull()
    })
  })
}

describe('two-factor schema', () => {
  it('[architecture] refuses to un-spend or rewrite a recovery code', async () => {
    const database = new BetterSqlite3(':memory:')
    migrateContainer(database)
    database.prepare(seedUsers).run(created, created, created, created)
    const store = createContainerTwoFactorStore(database)
    await store.beginEnrolment({ userId: 1, secret, codes }, created)
    const found = await store.findRecoveryCode(1, 'AAAAAAAA')
    await store.spendRecoveryCode(1, found!.id, later)

    expect(() =>
      database
        .prepare(`UPDATE user_recovery_codes SET used_at = NULL WHERE id = ?`)
        .run(found!.id),
    ).toThrow(/single use and immutable/)
    expect(() =>
      database
        .prepare(`UPDATE user_recovery_codes SET code_hash = ? WHERE user_id = 1 AND used_at IS NULL`)
        .run('Z'.repeat(43)),
    ).toThrow(/single use and immutable/)
    database.close()
  })

  it('[architecture] refuses to rotate or unconfirm a proved enrolment', async () => {
    const database = new BetterSqlite3(':memory:')
    migrateContainer(database)
    database.prepare(seedUsers).run(created, created, created, created)
    const store = createContainerTwoFactorStore(database)
    await store.beginEnrolment({ userId: 1, secret, codes }, created)
    await store.confirmEnrolment(1, 100, later)

    expect(() =>
      database
        .prepare(`UPDATE user_totp_enrolments SET secret = ? WHERE user_id = 1`)
        .run(replacementSecret),
    ).toThrow(/confirmed TOTP enrolment is immutable/)
    expect(() =>
      database.prepare(`UPDATE user_totp_enrolments SET confirmed_at = NULL WHERE user_id = 1`).run(),
    ).toThrow(/confirmed TOTP enrolment is immutable/)
    database.close()
  })
})
