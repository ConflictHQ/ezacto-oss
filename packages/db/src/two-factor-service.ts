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
}

export type TwoFactorVerdict = 'accepted' | 'rejected' | 'not_enrolled'

export const createTwoFactorService = ({
  store,
  accountName,
  issuer,
  now = () => new Date(),
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
  const verifyCode = async (userId: number, code: string): Promise<TwoFactorVerdict> => {
    const enrolment = await store.enrolment(userId)
    if (enrolment === null || enrolment.confirmedAt === null) return 'not_enrolled'

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

  return {
    verifyCode,

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
    ): Promise<'enabled' | 'rejected' | 'not_pending'> {
      const enrolment = await store.enrolment(userId)
      if (enrolment === null) return 'not_pending'
      // Already on. Confirming again is not an error the caller can act on, and
      // it must not be a way to re-run the check against a live enrolment.
      if (enrolment.confirmedAt !== null) return 'not_pending'
      const verified = await verifyTotpCode(enrolment.secret, code, {
        timestampMs: now().getTime(),
      })
      if (verified.status !== 'accepted') return 'rejected'
      return (await store.confirmEnrolment(userId, verified.step, now().toISOString()))
        ? 'enabled'
        : 'rejected'
    },

    async disable(
      userId: number,
      code: string,
    ): Promise<'disabled' | 'rejected' | 'not_enrolled'> {
      const verdict = await verifyCode(userId, code)
      if (verdict !== 'accepted') return verdict === 'not_enrolled' ? 'not_enrolled' : 'rejected'
      return (await store.disable(userId)) ? 'disabled' : 'not_enrolled'
    },
  }
}
