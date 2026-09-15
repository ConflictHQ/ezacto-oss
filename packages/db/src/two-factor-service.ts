// The adapter that makes two-factor auth reachable.
//
// The routes, the store and the crypto were all written and correct, and
// nothing constructed the service between them -- so `installTwoFactorRoutes`
// hung off an option no runtime supplied and the feature could not be used.
//
// Almost everything careful here already lives in the store or in core. What
// this adds is the ordering, and the ordering is the security:
//
//   a code is verified, then spent, and the spend decides
//
// The store's `spendTotpStep` compares against the last used step inside the
// UPDATE, so two requests carrying the same code cannot both read the old value
// and both conclude they were first. Verifying tells you the code is real;
// only the spend tells you it was still yours to use.

import {
  RECOVERY_CODE_DECOY,
  type TwoFactorStore,
} from './two-factor.js'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  recoveryCodeSelector,
  totpAuthUri,
  verifyRecoveryCode,
  verifyTotpCode,
} from '@ezacto/core'

export interface TwoFactorStatus {
  enrolled: boolean
  pendingConfirmation: boolean
  recoveryCodesRemaining: number
}

export interface TwoFactorEnrolmentOffer {
  secret: string
  otpauthUri: string
  /** Shown once, at enrolment. Only their hashes reach the store. */
  recoveryCodes: readonly string[]
}

/**
 * Long enough to fetch a phone, short enough that a challenge left open on a
 * shared machine is not a standing invitation.
 */
export const TWO_FACTOR_CHALLENGE_TTL_MS = 5 * 60 * 1_000
/** Wrong codes, across every surface, before the factor stops answering. */
export const TWO_FACTOR_MAX_ATTEMPTS = 5
export const TWO_FACTOR_LOCK_MS = 15 * 60 * 1_000

export interface TwoFactorChallengeOffer {
  /** Bearer material. The caller stores it, and it is never written down here. */
  token: string
  expiresAt: string
}

export interface TwoFactorServiceOptions {
  store: TwoFactorStore
  /**
   * What the authenticator app shows under the issuer -- the user's own
   * address, so someone with several accounts can tell the entries apart.
   * Resolved per call rather than held, because it can change.
   */
  accountName: (userId: number) => Promise<string>
  /** Deployment brand, the heading the authenticator groups entries under. */
  issuer: string
  now?: () => Date
  maxAttempts?: number
  lockMs?: number
  challengeTtlMs?: number
}

export type TwoFactorVerdict =
  | 'accepted'
  | 'rejected'
  | 'not_enrolled'
  /** The attempt ceiling was reached; no code is read until the lock lifts. */
  | 'locked'

export type TwoFactorChallengeVerdict =
  | { status: 'accepted'; userId: number }
  | { status: 'rejected' }
  | { status: 'locked' }
  /** Unknown, already spent, or expired -- the sign-in has to start again. */
  | { status: 'unknown_challenge' }

const CHALLENGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  )
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const createTwoFactorService = ({
  store,
  accountName,
  issuer,
  now = () => new Date(),
  maxAttempts = TWO_FACTOR_MAX_ATTEMPTS,
  lockMs = TWO_FACTOR_LOCK_MS,
  challengeTtlMs = TWO_FACTOR_CHALLENGE_TTL_MS,
}: TwoFactorServiceOptions) => {
  /**
   * A TOTP code or a recovery code, whichever the user presented.
   *
   * Both paths run a verification even when they already know the answer. An
   * unknown recovery selector burns one against `RECOVERY_CODE_DECOY`, because
   * a selector that returns faster than a wrong code tells an attacker which
   * selectors are real -- and the enumeration is worth more than any single
   * guess.
   */
  const check = async (userId: number, code: string): Promise<TwoFactorVerdict> => {
    const enrolment = await store.enrolment(userId)
    if (enrolment === null || enrolment.confirmedAt === null) return 'not_enrolled'
    // The ceiling is read before the code is. A six-digit code with a
    // plus-or-minus-one step window leaves three of a million valid at any
    // moment, which is only out of reach while the guesses are counted.
    if (
      enrolment.lockedUntil !== null &&
      Date.parse(enrolment.lockedUntil) > now().getTime()
    ) {
      return 'locked'
    }

    const selector = recoveryCodeSelector(code)
    if (selector !== null) {
      const stored = await store.findRecoveryCode(userId, selector)
      const matched = await verifyRecoveryCode(code, stored?.hash ?? RECOVERY_CODE_DECOY)
      if (!matched || stored === null) return 'rejected'
      // The spend is the authority: two requests carrying the same recovery
      // code both verify, and only one can spend it.
      return (await store.spendRecoveryCode(userId, stored.id, now().toISOString()))
        ? 'accepted'
        : 'rejected'
    }

    const verified = await verifyTotpCode(enrolment.secret, code, {
      timestampMs: now().getTime(),
    })
    if (verified.status !== 'accepted') return 'rejected'
    return (await store.spendTotpStep(userId, verified.step, now().toISOString()))
      ? 'accepted'
      : 'rejected'
  }

  /**
   * `check` with the counter around it. Every surface that reads a code goes
   * through here, so confirm, disable and the sign-in challenge all spend from
   * one budget -- switching between them buys an attacker nothing.
   */
  const verifyCode = async (userId: number, code: string): Promise<TwoFactorVerdict> => {
    const verdict = await check(userId, code)
    if (verdict === 'accepted') {
      await store.clearFailedVerifications(userId, now().toISOString())
      return 'accepted'
    }
    if (verdict !== 'rejected') return verdict
    const lockedUntil = await store.recordFailedVerification(
      userId,
      now().toISOString(),
      maxAttempts,
      lockMs,
    )
    return lockedUntil === null ? 'rejected' : 'locked'
  }

  return {
    verifyCode,

    /**
     * Whether a sign-in has to stop for this user. Anything short of a
     * confirmed enrolment is false: a seed nobody has proved would lock the
     * owner out of an account they can still reach by password today.
     */
    async isEnrolled(userId: number): Promise<boolean> {
      const enrolment = await store.enrolment(userId)
      return enrolment !== null && enrolment.confirmedAt !== null
    },

    /**
     * What a sign-in gets instead of a session. The plain token is returned
     * once and only its digest is stored, so a database leak yields challenges
     * nobody can present -- the same bargain the session store makes.
     */
    async issueChallenge(userId: number): Promise<TwoFactorChallengeOffer> {
      const issuedAt = now().toISOString()
      const expiresAt = new Date(Date.parse(issuedAt) + challengeTtlMs).toISOString()
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const token = base64Url(crypto.getRandomValues(new Uint8Array(32)))
        const created = await store.createChallenge({
          userId,
          tokenHash: await sha256Hex(token),
          expiresAt,
          createdAt: issuedAt,
          cleanupBefore: new Date(Date.parse(issuedAt) - challengeTtlMs).toISOString(),
        })
        if (created === 'created') return { token, expiresAt }
      }
      throw new Error('could not issue a two-factor challenge')
    },

    /**
     * The second half of a sign-in. A wrong code leaves the challenge standing
     * -- a typo should cost a retry, not the password -- and spends from the
     * enrolment's budget, which is what stops the retries being unlimited.
     */
    async redeemChallenge(
      token: string,
      code: string,
    ): Promise<TwoFactorChallengeVerdict> {
      if (!CHALLENGE_TOKEN_PATTERN.test(token)) return { status: 'unknown_challenge' }
      const tokenHash = await sha256Hex(token)
      const holder = await store.challengeHolder(tokenHash, now().toISOString())
      if (holder === null) return { status: 'unknown_challenge' }
      const verdict = await verifyCode(holder.userId, code)
      if (verdict === 'locked') return { status: 'locked' }
      // A challenge for someone who disabled the factor in between is spent
      // rather than honoured: it was only ever a promise to ask for a code.
      if (verdict !== 'accepted') return { status: 'rejected' }
      // Consuming is what makes the challenge a session, and the UPDATE is
      // conditional, so two requests holding the same token cannot both pass.
      const consumed = await store.consumeChallenge(tokenHash, now().toISOString())
      if (consumed === null) return { status: 'unknown_challenge' }
      return { status: 'accepted', userId: consumed.userId }
    },

    /**
     * A fresh seed and a fresh set of recovery codes, pending until a code
     * proves the authenticator holds the same seed.
     *
     * The plain codes are returned and never written down: the store takes
     * selectors and hashes, so this return value is the only time they exist.
     * A confirmed enrolment cannot be restarted -- the store raises
     * `TwoFactorEnrolmentLockedError` rather than swapping the seed under a
     * live session, and that error is the caller's to surface.
     */
    async beginEnrolment(userId: number): Promise<TwoFactorEnrolmentOffer> {
      const secret = generateTotpSecret()
      const recoveryCodes = generateRecoveryCodes()
      const codes = await Promise.all(
        // Non-null by construction: these codes come from
        // `generateRecoveryCodes`, and `hashRecoveryCode` throws on any code
        // whose shape would have made the selector null.
        recoveryCodes.map(async (value) => ({
          selector: recoveryCodeSelector(value) as string,
          hash: await hashRecoveryCode(value),
        })),
      )
      await store.beginEnrolment({ userId, secret, codes }, now().toISOString())
      return {
        secret,
        otpauthUri: totpAuthUri({
          secret,
          accountName: await accountName(userId),
          issuer,
        }),
        recoveryCodes,
      }
    },

    async status(userId: number): Promise<TwoFactorStatus> {
      const enrolment = await store.enrolment(userId)
      return {
        enrolled: enrolment?.confirmedAt !== null && enrolment !== null,
        pendingConfirmation: enrolment !== null && enrolment.confirmedAt === null,
        recoveryCodesRemaining:
          enrolment === null ? 0 : await store.unusedRecoveryCodeCount(userId),
      }
    },

    async confirmEnrolment(
      userId: number,
      code: string,
    ): Promise<'enabled' | 'rejected' | 'not_pending' | 'locked'> {
      const enrolment = await store.enrolment(userId)
      if (enrolment === null) return 'not_pending'
      // Already on. Confirming again is not an error the caller can act on, and
      // it must not be a way to re-run the check against a live enrolment.
      if (enrolment.confirmedAt !== null) return 'not_pending'
      // A pending enrolment is counted too. It is the one place a code is
      // checked against a seed the presenter chose, and leaving it uncounted
      // would make it the cheapest place to learn how the check behaves.
      if (
        enrolment.lockedUntil !== null &&
        Date.parse(enrolment.lockedUntil) > now().getTime()
      ) {
        return 'locked'
      }
      const verified = await verifyTotpCode(enrolment.secret, code, {
        timestampMs: now().getTime(),
      })
      if (verified.status !== 'accepted') {
        const lockedUntil = await store.recordFailedVerification(
          userId,
          now().toISOString(),
          maxAttempts,
          lockMs,
        )
        return lockedUntil === null ? 'rejected' : 'locked'
      }
      if (!(await store.confirmEnrolment(userId, verified.step, now().toISOString()))) {
        return 'rejected'
      }
      await store.clearFailedVerifications(userId, now().toISOString())
      return 'enabled'
    },

    async disable(
      userId: number,
      code: string,
    ): Promise<'disabled' | 'rejected' | 'not_enrolled' | 'locked'> {
      const verdict = await verifyCode(userId, code)
      if (verdict !== 'accepted') return verdict
      return (await store.disable(userId)) ? 'disabled' : 'not_enrolled'
    },
  }
}
