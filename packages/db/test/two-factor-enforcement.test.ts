import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { totpCodeForStep, totpStep } from '@ezacto/core'
import { migrateContainer } from '../src/migrate.js'
import { createContainerPasswordAuthService } from '../src/password-auth.js'
import { createContainerTwoFactorStore } from '../src/two-factor.js'
import { createTwoFactorService } from '../src/two-factor-service.js'

/**
 * Issue 731 and issue 735, against a real migrated database rather than a fake
 * store. The half of two-factor that was missing is ordering -- a challenge
 * before a session, a ceiling before the guesses run out -- and ordering is
 * exactly what a fake gets right by construction and SQL gets wrong.
 */

const at = '2026-09-09T12:00:00.000Z'

let sqlite: BetterSqlite3.Database | null = null

afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const seed = `INSERT INTO users (
    id, first_name, last_name, profile, manager_grants, is_active,
    created_at, updated_at
  ) VALUES (1, 'Ada', 'Okonkwo', 'administrator', '[]', 1, ?, ?)`

/** The clock is fixed so a code computed here is the code the service reads. */
const enrolled = async (clock: { now: Date }) => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  database.prepare(seed).run(at, at)
  sqlite = database
  const service = createTwoFactorService({
    store: createContainerTwoFactorStore(database),
    accountName: async () => 'ada@example.test',
    issuer: 'Acme',
    now: () => clock.now,
  })
  const offer = await service.beginEnrolment(1)
  const code = await totpCodeForStep(offer.secret, totpStep(clock.now.getTime()))
  expect(await service.confirmEnrolment(1, code)).toBe('enabled')
  return { service, secret: offer.secret, recoveryCodes: offer.recoveryCodes }
}

const codeAt = async (secret: string, when: Date) =>
  totpCodeForStep(secret, totpStep(when.getTime()))

describe('two-factor enforcement', () => {
  it('[security] a confirmed enrolment is what makes a sign-in stop', async () => {
    const clock = { now: new Date(at) }
    const { service } = await enrolled(clock)
    expect(await service.isEnrolled(1)).toBe(true)
  })

  it('[security] a pending enrolment changes no sign-in', async () => {
    // A seed nobody has proved would lock the owner out of an account they can
    // still reach by password, which is the failure mode worth avoiding.
    const database = new BetterSqlite3(':memory:')
    migrateContainer(database)
    database.prepare(seed).run(at, at)
    sqlite = database
    const service = createTwoFactorService({
      store: createContainerTwoFactorStore(database),
      accountName: async () => 'ada@example.test',
      issuer: 'Acme',
      now: () => new Date(at),
    })
    await service.beginEnrolment(1)
    expect(await service.isEnrolled(1)).toBe(false)
  })

  it('[security] a challenge becomes a session once, and only with a code', async () => {
    const clock = { now: new Date(at) }
    const { service, secret } = await enrolled(clock)

    const challenge = await service.issueChallenge(1)
    expect(challenge.expiresAt).toBe('2026-09-09T12:05:00.000Z')

    // The step that confirmed the enrolment is spent, so the next window is
    // where a usable code lives. That is the replay guard, not a quirk.
    clock.now = new Date('2026-09-09T12:00:35.000Z')
    const code = await codeAt(secret, clock.now)
    expect(await service.redeemChallenge(challenge.token, code)).toEqual({
      status: 'accepted',
      userId: 1,
    })
    // The same challenge cannot mint a second session, and the same code
    // cannot be replayed into a fresh one.
    expect(await service.redeemChallenge(challenge.token, code)).toEqual({
      status: 'unknown_challenge',
    })
  })

  it('[security] a wrong code leaves the challenge standing', async () => {
    // A typo should cost a retry. Burning the challenge would send the person
    // back to the password form for a mistyped digit.
    const clock = { now: new Date(at) }
    const { service, secret } = await enrolled(clock)
    const challenge = await service.issueChallenge(1)

    expect(await service.redeemChallenge(challenge.token, '000000')).toEqual({
      status: 'rejected',
    })
    clock.now = new Date('2026-09-09T12:00:35.000Z')
    expect(
      await service.redeemChallenge(challenge.token, await codeAt(secret, clock.now)),
    ).toEqual({ status: 'accepted', userId: 1 })
  })

  it('[security] an unknown or malformed challenge is refused without a lookup', async () => {
    const clock = { now: new Date(at) }
    const { service } = await enrolled(clock)
    expect(await service.redeemChallenge('not-a-token', '000000')).toEqual({
      status: 'unknown_challenge',
    })
    expect(await service.redeemChallenge('Z'.repeat(43), '000000')).toEqual({
      status: 'unknown_challenge',
    })
  })

  it('[security] an expired challenge is not answerable', async () => {
    const clock = { now: new Date(at) }
    const { service, secret } = await enrolled(clock)
    const challenge = await service.issueChallenge(1)

    clock.now = new Date('2026-09-09T12:05:00.001Z')
    expect(
      await service.redeemChallenge(challenge.token, await codeAt(secret, clock.now)),
    ).toEqual({ status: 'unknown_challenge' })
  })

  it('[security] a recovery code answers a challenge, once', async () => {
    const clock = { now: new Date(at) }
    const { service, recoveryCodes } = await enrolled(clock)
    const first = await service.issueChallenge(1)
    expect(await service.redeemChallenge(first.token, recoveryCodes[0]!)).toEqual({
      status: 'accepted',
      userId: 1,
    })

    const second = await service.issueChallenge(1)
    expect(await service.redeemChallenge(second.token, recoveryCodes[0]!)).toEqual({
      status: 'rejected',
    })
  })

  it('[security] the ceiling is shared, and it stops the guessing', async () => {
    // Issue 735. Five wrong codes and the factor stops answering, whether they
    // arrive at the challenge or at the disable route: one budget, so switching
    // between the surfaces buys nothing.
    const clock = { now: new Date(at) }
    const { service, secret } = await enrolled(clock)
    const challenge = await service.issueChallenge(1)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.redeemChallenge(challenge.token, '000000')).toEqual({
        status: 'rejected',
      })
    }
    expect(await service.disable(1, '000000')).toBe('locked')
    expect(await service.redeemChallenge(challenge.token, '000001')).toEqual({
      status: 'locked',
    })

    // The right code is refused too while the lock holds -- otherwise the lock
    // only slows an attacker down and never stops one.
    clock.now = new Date('2026-09-09T12:00:35.000Z')
    expect(
      await service.redeemChallenge(challenge.token, await codeAt(secret, clock.now)),
    ).toEqual({ status: 'locked' })

    // Fifteen minutes on, the factor answers again.
    clock.now = new Date('2026-09-09T12:15:01.000Z')
    expect(
      await service.redeemChallenge(challenge.token, await codeAt(secret, clock.now)),
    ).toEqual({ status: 'unknown_challenge' })
  })

  it('[security] an accepted code returns the budget to full', async () => {
    const clock = { now: new Date(at) }
    const { service, secret } = await enrolled(clock)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.disable(1, '000000')).toBe('rejected')
    }
    clock.now = new Date('2026-09-09T12:00:35.000Z')
    const challenge = await service.issueChallenge(1)
    expect(
      await service.redeemChallenge(challenge.token, await codeAt(secret, clock.now)),
    ).toMatchObject({ status: 'accepted' })

    // Four more wrong codes would have locked the account a moment ago.
    clock.now = new Date('2026-09-09T12:01:05.000Z')
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.disable(1, '000000')).toBe('rejected')
    }
  })

  it('[security] counts wrong codes while an enrolment is still pending', async () => {
    const database = new BetterSqlite3(':memory:')
    migrateContainer(database)
    database.prepare(seed).run(at, at)
    sqlite = database
    const service = createTwoFactorService({
      store: createContainerTwoFactorStore(database),
      accountName: async () => 'ada@example.test',
      issuer: 'Acme',
      now: () => new Date(at),
    })
    const offer = await service.beginEnrolment(1)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await service.confirmEnrolment(1, '000000')).toBe('rejected')
    }
    expect(await service.confirmEnrolment(1, '000000')).toBe('locked')
    // The lock holds even against the code that would have worked.
    expect(
      await service.confirmEnrolment(1, await codeAt(offer.secret, new Date(at))),
    ).toBe('locked')
  })

  it('[security] a password reset takes the open challenges with it', async () => {
    // The reset already revokes every session. A challenge is a session this
    // sign-in has not collected yet, so leaving one standing would keep the old
    // password's last sign-in redeemable for minutes after the password stopped
    // existing.
    const database = new BetterSqlite3(':memory:')
    migrateContainer(database)
    let clock = '2026-09-09T12:00:00.000Z'
    const passwords = createContainerPasswordAuthService(database, {
      now: () => clock,
    })
    const signup = await passwords.signup({
      organizationName: 'Kestrel Environmental',
      firstName: 'Ada',
      lastName: 'Okonkwo',
      email: 'ada@example.test',
      password: 'correct horse battery staple',
      clientKey: '198.51.100.10',
    })
    await passwords.verifyEmail(signup.token, '198.51.100.10')
    sqlite = database

    const service = createTwoFactorService({
      store: createContainerTwoFactorStore(database),
      accountName: async () => 'ada@example.test',
      issuer: 'Acme',
      now: () => new Date(clock),
    })
    const offer = await service.beginEnrolment(1)
    expect(
      await service.confirmEnrolment(
        1,
        await totpCodeForStep(offer.secret, totpStep(Date.parse(clock))),
      ),
    ).toBe('enabled')
    const challenge = await service.issueChallenge(1)

    clock = '2026-09-09T12:01:00.000Z'
    const reset = await passwords.requestPasswordReset('ada@example.test', '198.51.100.10')
    await passwords.resetPassword(reset!.token, 'a different long passphrase', '198.51.100.10')

    clock = '2026-09-09T12:01:35.000Z'
    expect(
      await service.redeemChallenge(
        challenge.token,
        await totpCodeForStep(offer.secret, totpStep(Date.parse(clock))),
      ),
    ).toEqual({ status: 'unknown_challenge' })
  })
})
