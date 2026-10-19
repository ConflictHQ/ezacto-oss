import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { totpCodeForStep, totpStep } from '@ezacto/core'
import {
  createContainerTwoFactorStore,
  createD1TwoFactorStore,
  type TwoFactorStore,
} from '../src/two-factor.js'
import {
  createTwoFactorService,
  deriveTwoFactorEmailCodeKey,
  TWO_FACTOR_EMAIL_CODE_MAX_ATTEMPTS,
} from '../src/two-factor-service.js'
import { migrateContainer, migrateD1, migrationIds } from '../src/migrate.js'

/**
 * Issue 770, slice B: the emailed second factor's enrolment, send limits and
 * sign-in redemption. Every test here runs against the real migration ledger on
 * both runtimes -- the container's better-sqlite3 and the worker's D1 -- because
 * the limits and the single-use spend are SQL, and a stub store would only
 * prove the stub.
 */

const t0 = new Date('2026-10-18T12:00:00.000Z')
const minute = 60 * 1_000
const seedUsers = `INSERT INTO users (
    id, first_name, last_name, profile, manager_grants, is_owner, created_at, updated_at
  ) VALUES (1, 'Avery', 'Ng', 'administrator', '[]', 0, ?, ?),
    (2, 'Robin', 'Diaz', 'member', '[]', 0, ?, ?)`

interface Harness {
  store: TwoFactorStore
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  execute(query: string, ...bindings: unknown[]): Promise<void>
  close(): Promise<void>
}

const stamp = t0.toISOString()
const totpSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.prepare(seedUsers).run(stamp, stamp, stamp, stamp)
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
  await database.prepare(seedUsers).bind(stamp, stamp, stamp, stamp).run()
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
  describe(`emailed second factor (${runtime})`, () => {
    let harness: Harness
    let clock = t0
    const addresses = new Map<number, string | null>()
    const key = new Uint8Array(32).fill(7)

    const service = () =>
      createTwoFactorService({
        store: harness.store,
        accountName: async () => 'ada@example.test',
        issuer: 'Acme',
        emailCodeKey: key,
        emailAddress: async (userId) => addresses.get(userId) ?? null,
        now: () => clock,
      })

    const at = (offsetMs: number) => new Date(t0.getTime() + offsetMs)

    // An authenticator enrolment without recovery codes: hashing them is eight
    // Argon2id derivations, which is the wrong thing to spend a loaded machine
    // on when the subject is the mailed code.
    const enrolTotp = async (userId: number) => {
      await harness.store.beginEnrolment({ userId, secret: totpSecret, codes: [] }, stamp)
      await harness.store.confirmEnrolment(userId, totpStep(t0.getTime()), stamp)
    }

    beforeAll(async () => {
      harness = await factory()
    })

    beforeEach(async () => {
      clock = t0
      addresses.clear()
      addresses.set(1, 'avery@example.test')
      addresses.set(2, 'robin@example.test')
      await harness.execute(`DELETE FROM two_factor_email_code_sends`)
      await harness.execute(`DELETE FROM user_email_second_factors`)
      await harness.execute(`DELETE FROM user_recovery_codes`)
      await harness.execute(`DELETE FROM two_factor_challenges`)
      await harness.execute(`DELETE FROM user_totp_enrolments`)
    })

    afterAll(async () => harness.close())

    it('[architecture] the migration is in the real ledger under the reserved number', () => {
      expect(migrationIds).toContain('0121_email_second_factor')
    })

    describe('enrolment', () => {
      it('[api] turns on once, and a repeat changes nothing', async () => {
        expect(await harness.store.emailFactorEnabled(1)).toBe(false)
        expect(await service().enableEmailFactor(1)).toBe('enabled')
        expect(await harness.store.emailFactorEnabled(1)).toBe(true)
        expect(await service().enableEmailFactor(1)).toBe('already_enabled')
        expect(await harness.rows(`SELECT user_id FROM user_email_second_factors`)).toHaveLength(1)
        expect((await service().status(1)).emailEnabled).toBe(true)
        expect((await service().status(2)).emailEnabled).toBe(false)
      })

      it('[security] refuses without a verified address, and without a key', async () => {
        addresses.set(1, null)
        expect(await service().enableEmailFactor(1)).toBe('no_verified_email')
        expect(await harness.store.emailFactorEnabled(1)).toBe(false)
        addresses.set(1, 'avery@example.test')
        const keyless = createTwoFactorService({
          store: harness.store,
          accountName: async () => 'x',
          issuer: 'Acme',
          emailAddress: async () => 'avery@example.test',
          now: () => clock,
        })
        expect(await keyless.enableEmailFactor(1)).toBe('no_verified_email')
        expect(await harness.store.emailFactorEnabled(1)).toBe(false)
      })

      it('[security] a user that does not exist cannot be given the factor', async () => {
        await expect(harness.store.enableEmailFactor(999, stamp)).rejects.toThrow()
      })

      it('[api] turning it off removes the row and reports whether there was one', async () => {
        await service().enableEmailFactor(1)
        expect(await service().disableEmailFactor(1)).toBe(true)
        expect(await service().disableEmailFactor(1)).toBe(false)
        expect(await harness.store.emailFactorEnabled(1)).toBe(false)
      })

      it('[security] turning it off stops a code already in flight, and spares the rest', async () => {
        await service().enableEmailFactor(1)
        const issued = await service().issueEmailCodeChallenge(1)
        if (issued.status !== 'issued') throw new Error('expected a challenge')
        // A TOTP-style challenge for the same user, carrying no code.
        const plain = await service().issueChallenge(1)
        await service().disableEmailFactor(1)
        expect(
          await service().redeemChallenge(issued.offer.token, issued.offer.emailCode),
        ).toEqual({ status: 'unknown_challenge' })
        expect(await harness.store.challengeHolder(await sha256(plain.token), stamp)).toEqual({
          userId: 1,
        })
      })
    })

    describe('sending is limited', () => {
      const claim = (userId: number, offsetMs: number) =>
        harness.store.claimEmailCodeSend(userId, at(offsetMs).toISOString(), minute, 5)

      it('[security] allows one a minute, and says how long to wait', async () => {
        expect(await claim(1, 0)).toEqual({ status: 'claimed' })
        expect(await claim(1, 30_000)).toEqual({ status: 'limited', retryAfterMs: 30_000 })
        // The boundary instant is allowed: the earlier send is a full minute old.
        expect(await claim(1, minute)).toEqual({ status: 'claimed' })
      })

      it('[security] allows five an hour, and the sixth waits for the oldest to age out', async () => {
        for (let sent = 0; sent < 5; sent += 1) {
          expect(await claim(1, sent * minute)).toEqual({ status: 'claimed' })
        }
        // Past the one-minute rule, but five are already inside the hour.
        expect(await claim(1, 5 * minute)).toEqual({
          status: 'limited',
          retryAfterMs: 55 * minute,
        })
        expect(await claim(1, 60 * minute - 1)).toMatchObject({ status: 'limited' })
        expect(await claim(1, 60 * minute)).toEqual({ status: 'claimed' })
        // And that one counts: the next is held by the minute rule again.
        expect(await claim(1, 60 * minute + 1_000)).toMatchObject({ status: 'limited' })
      })

      it("[security] one user's mail does not spend another's allowance", async () => {
        await claim(1, 0)
        expect(await claim(2, 0)).toEqual({ status: 'claimed' })
      })

      it('[security] a refused send is not recorded', async () => {
        await claim(1, 0)
        await claim(1, 1_000)
        await claim(1, 2_000)
        expect(await harness.rows(`SELECT id FROM two_factor_email_code_sends`)).toHaveLength(1)
      })

      it('[security] only a user with the factor on can be mailed a code', async () => {
        expect(await service().issueEmailCodeChallenge(1)).toEqual({ status: 'unavailable' })
        await service().enableEmailFactor(1)
        expect((await service().issueEmailCodeChallenge(1)).status).toBe('issued')
      })

      it('[security] the service enforces the limit on every issue, the sign-in included', async () => {
        await service().enableEmailFactor(1)
        expect((await service().issueEmailCodeChallenge(1)).status).toBe('issued')
        clock = at(10_000)
        expect(await service().issueEmailCodeChallenge(1)).toEqual({
          status: 'rate_limited',
          retryAfterSeconds: 50,
        })
        clock = at(minute)
        expect((await service().issueEmailCodeChallenge(1)).status).toBe('issued')
      })

      it('[security] an address that went away stops the mail rather than guessing one', async () => {
        await service().enableEmailFactor(1)
        addresses.set(1, null)
        expect(await service().issueEmailCodeChallenge(1)).toEqual({ status: 'unavailable' })
        expect(await harness.rows(`SELECT id FROM two_factor_email_code_sends`)).toHaveLength(0)
      })
    })

    describe('redeeming at sign-in', () => {
      const issueFor = async (userId: number) => {
        const issued = await service().issueEmailCodeChallenge(userId)
        if (issued.status !== 'issued') throw new Error(`expected a challenge: ${issued.status}`)
        return issued.offer
      }

      it('[e2e:first-run] a user with only the email factor signs in with the code, once', async () => {
        await service().enableEmailFactor(2)
        const offer = await issueFor(2)
        expect(offer.emailTo).toBe('robin@example.test')
        expect(offer.emailCode).toMatch(/^[0-9]{6}$/)
        // No TOTP enrolment exists for this user at all.
        expect(await harness.store.enrolment(2)).toBeNull()

        expect(await service().redeemChallenge(offer.token, offer.emailCode)).toEqual({
          status: 'accepted',
          userId: 2,
        })
        // Replay of the consumed challenge and code.
        expect(await service().redeemChallenge(offer.token, offer.emailCode)).toEqual({
          status: 'unknown_challenge',
        })
      })

      it('[security] the plain code is not stored, only a keyed hash of it', async () => {
        await service().enableEmailFactor(2)
        const offer = await issueFor(2)
        const [row] = await harness.rows<{ code_hash: string }>(
          `SELECT code_hash FROM two_factor_challenges`,
        )
        expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/)
        expect(row?.code_hash).not.toContain(offer.emailCode)
        const dump = JSON.stringify(await harness.rows(`SELECT * FROM two_factor_challenges`))
        expect(dump).not.toContain(offer.emailCode)
      })

      it('[security] the derived key is stable per deployment and differs from its parent', async () => {
        const parent = new Uint8Array(32).fill(3)
        const derived = await deriveTwoFactorEmailCodeKey(parent)
        expect(derived).toHaveLength(32)
        expect(derived).toEqual(await deriveTwoFactorEmailCodeKey(parent))
        expect(derived).not.toEqual(parent)
        expect(derived).not.toEqual(await deriveTwoFactorEmailCodeKey(new Uint8Array(32).fill(4)))
      })

      it('[security] the sixth wrong code exhausts the challenge and the right one is then refused', async () => {
        await service().enableEmailFactor(2)
        const offer = await issueFor(2)
        const wrong = offer.emailCode === '000000' ? '000001' : '000000'
        for (let guess = 1; guess < TWO_FACTOR_EMAIL_CODE_MAX_ATTEMPTS; guess += 1) {
          expect(await service().redeemChallenge(offer.token, wrong)).toEqual({
            status: 'rejected',
          })
        }
        expect(await service().redeemChallenge(offer.token, wrong)).toEqual({ status: 'locked' })
        expect(await service().redeemChallenge(offer.token, offer.emailCode)).toEqual({
          status: 'locked',
        })
      })

      it('[security] an expired challenge refuses the right code', async () => {
        await service().enableEmailFactor(2)
        const offer = await issueFor(2)
        clock = at(5 * minute + 1)
        expect(await service().redeemChallenge(offer.token, offer.emailCode)).toEqual({
          status: 'unknown_challenge',
        })
      })

      it('[security] a user with no TOTP row and a wrong six-digit code is simply rejected', async () => {
        await service().enableEmailFactor(2)
        const offer = await issueFor(2)
        const wrong = offer.emailCode === '123456' ? '123457' : '123456'
        expect(await service().redeemChallenge(offer.token, wrong)).toEqual({
          status: 'rejected',
        })
        // A recovery-code shaped guess burns nothing it does not have either.
        expect(
          await service().redeemChallenge(offer.token, 'ABCDEFGH-IJKLMNOPQRST'),
        ).toEqual({ status: 'rejected' })
      })

      it('[e2e:first-run] a user with both factors may answer with either', async () => {
        const svc = service()
        await svc.enableEmailFactor(1)
        await enrolTotp(1)
        const secret = totpSecret

        const mailed = await issueFor(1)
        expect(await svc.redeemChallenge(mailed.token, mailed.emailCode)).toEqual({
          status: 'accepted',
          userId: 1,
        })

        clock = at(5 * minute + 1_000)
        const second = await issueFor(1)
        const authenticator = await totpCodeForStep(secret, totpStep(clock.getTime()))
        expect(await svc.redeemChallenge(second.token, authenticator)).toEqual({
          status: 'accepted',
          userId: 1,
        })
      })

      it('[security] a wrong six-digit code against a challenge with a mailed code spends both budgets and neither signs in', async () => {
        const svc = service()
        await svc.enableEmailFactor(1)
        await enrolTotp(1)
        clock = at(5 * minute + 1_000)
        const offer = await issueFor(1)
        const wrong = offer.emailCode === '000000' ? '000001' : '000000'
        expect(await svc.redeemChallenge(offer.token, wrong)).toEqual({ status: 'rejected' })
        const [challenge] = await harness.rows<{ code_attempts: number }>(
          `SELECT code_attempts FROM two_factor_challenges`,
        )
        expect(challenge?.code_attempts).toBe(1)
        expect((await harness.store.enrolment(1))?.failedAttempts).toBe(1)
      })

      it('[security] four wrong mailed codes leave the authenticator answering', async () => {
        const svc = service()
        await svc.enableEmailFactor(1)
        await enrolTotp(1)
        clock = at(5 * minute + 1_000)
        const offer = await issueFor(1)
        const wrong = offer.emailCode === '000000' ? '000001' : '000000'
        // Four wrong guesses on the challenge, within the authenticator's own
        // ceiling of five.
        for (let guess = 1; guess < TWO_FACTOR_EMAIL_CODE_MAX_ATTEMPTS; guess += 1) {
          await svc.redeemChallenge(offer.token, wrong)
        }
        const authenticator = await totpCodeForStep(totpSecret, totpStep(clock.getTime()))
        expect(await svc.redeemChallenge(offer.token, authenticator)).toEqual({
          status: 'accepted',
          userId: 1,
        })
      })

      it('[security] a challenge with no mailed code never redeems by email', async () => {
        await service().enableEmailFactor(2)
        const plain = await service().issueChallenge(2, { emailCodeAllowed: true })
        // Whatever six digits are tried, there is nothing to match and nothing signs in.
        expect(await service().redeemChallenge(plain.token, '123456')).toEqual({
          status: 'rejected',
        })
        const [row] = await harness.rows<{ code_attempts: number }>(
          `SELECT code_attempts FROM two_factor_challenges`,
        )
        expect(row?.code_attempts).toBe(0)
      })
    })

    describe('resend', () => {
      it('[security] supersedes the earlier challenge and its code', async () => {
        await service().enableEmailFactor(2)
        const first = await service().issueEmailCodeChallenge(2)
        if (first.status !== 'issued') throw new Error('expected a challenge')
        clock = at(minute)
        const sent = await service().resendEmailCode(first.offer.token)
        if (sent.status !== 'sent') throw new Error(`expected a resend: ${sent.status}`)
        expect(sent.token).not.toBe(first.offer.token)
        expect(sent.emailTo).toBe('robin@example.test')
        expect(await service().redeemChallenge(first.offer.token, first.offer.emailCode)).toEqual({
          status: 'unknown_challenge',
        })
        expect(await service().redeemChallenge(sent.token, sent.emailCode)).toEqual({
          status: 'accepted',
          userId: 2,
        })
      })

      it('[security] a resend is a send: once a minute, five an hour', async () => {
        await service().enableEmailFactor(2)
        const first = await service().issueEmailCodeChallenge(2)
        if (first.status !== 'issued') throw new Error('expected a challenge')
        let token = first.offer.token
        clock = at(30_000)
        expect(await service().resendEmailCode(token)).toEqual({
          status: 'rate_limited',
          retryAfterSeconds: 30,
        })
        for (let sent = 1; sent < 5; sent += 1) {
          clock = at(sent * minute)
          const resent = await service().resendEmailCode(token)
          if (resent.status !== 'sent') throw new Error(`send ${sent}: ${resent.status}`)
          token = resent.token
        }
        clock = at(5 * minute)
        expect(await service().resendEmailCode(token)).toEqual({
          status: 'rate_limited',
          retryAfterSeconds: 55 * 60,
        })
      })

      it('[security] a challenge the password sign-in did not mark cannot be mailed a code', async () => {
        await service().enableEmailFactor(2)
        // As a magic-link or any other sign-in would issue it.
        const other = await service().issueChallenge(2)
        expect(await service().resendEmailCode(other.token)).toEqual({ status: 'refused' })
        expect(await harness.rows(`SELECT id FROM two_factor_email_code_sends`)).toHaveLength(0)
      })

      it('[security] a user without the factor cannot be mailed, even on a marked challenge', async () => {
        const marked = await service().issueChallenge(2, { emailCodeAllowed: true })
        expect(await service().resendEmailCode(marked.token)).toEqual({ status: 'refused' })
      })

      it('[security] an administrator turning the factor off refuses the resend', async () => {
        await service().enableEmailFactor(2)
        const marked = await service().issueChallenge(2, { emailCodeAllowed: true })
        await service().disableEmailFactor(2)
        expect(await service().resendEmailCode(marked.token)).toEqual({ status: 'refused' })
      })

      it('[security] unknown, malformed, spent and expired tokens are all just unknown', async () => {
        await service().enableEmailFactor(2)
        const issued = await service().issueEmailCodeChallenge(2)
        if (issued.status !== 'issued') throw new Error('expected a challenge')
        expect(await service().resendEmailCode('not-a-token')).toEqual({
          status: 'unknown_challenge',
        })
        expect(await service().resendEmailCode('A'.repeat(43))).toEqual({
          status: 'unknown_challenge',
        })
        await service().redeemChallenge(issued.offer.token, issued.offer.emailCode)
        clock = at(minute)
        expect(await service().resendEmailCode(issued.offer.token)).toEqual({
          status: 'unknown_challenge',
        })
      })

      it("[security] one user's resend leaves another user's challenge standing", async () => {
        await service().enableEmailFactor(1)
        await service().enableEmailFactor(2)
        const mine = await service().issueEmailCodeChallenge(1)
        const theirs = await service().issueEmailCodeChallenge(2)
        if (mine.status !== 'issued' || theirs.status !== 'issued') throw new Error('expected')
        clock = at(minute)
        await service().resendEmailCode(mine.offer.token)
        expect(
          await service().redeemChallenge(theirs.offer.token, theirs.offer.emailCode),
        ).toEqual({ status: 'accepted', userId: 2 })
      })
    })

    describe('storage', () => {
      it('[architecture] a challenge cannot be rewritten to allow a code', async () => {
        await harness.store.createChallenge({
          userId: 1,
          tokenHash: 'a'.repeat(64),
          expiresAt: at(5 * minute).toISOString(),
          createdAt: stamp,
          cleanupBefore: stamp,
        })
        await expect(
          harness.execute(`UPDATE two_factor_challenges SET email_code_allowed = 1`),
        ).rejects.toThrow(/single use and immutable/)
      })

      it('[api] reports what a challenge may be mailed', async () => {
        const base = {
          userId: 1,
          expiresAt: at(5 * minute).toISOString(),
          createdAt: stamp,
          cleanupBefore: stamp,
        }
        await harness.store.createChallenge({ ...base, tokenHash: 'a'.repeat(64) })
        expect(await harness.store.challengeState('a'.repeat(64), stamp)).toEqual({
          userId: 1,
          hasCode: false,
          emailCodeAllowed: false,
        })
        await harness.store.createChallenge({
          ...base,
          tokenHash: 'b'.repeat(64),
          emailCodeAllowed: true,
        })
        expect(await harness.store.challengeState('b'.repeat(64), stamp)).toEqual({
          userId: 1,
          hasCode: false,
          emailCodeAllowed: true,
        })
        await harness.store.createChallenge({
          ...base,
          tokenHash: 'c'.repeat(64),
          codeHash: '1'.repeat(64),
        })
        // A mailed challenge is by construction one that may be mailed.
        expect(await harness.store.challengeState('c'.repeat(64), stamp)).toEqual({
          userId: 1,
          hasCode: true,
          emailCodeAllowed: true,
        })
        expect(await harness.store.challengeState('d'.repeat(64), stamp)).toBeNull()
      })
    })
  })
}

const sha256 = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
