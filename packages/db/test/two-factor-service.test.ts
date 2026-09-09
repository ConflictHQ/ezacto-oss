import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTwoFactorService } from '../src/two-factor-service.js'
import {
  RECOVERY_CODE_DECOY,
  type BeginEnrolmentInput,
  type TwoFactorStore,
} from '../src/two-factor.js'
import {
  hashRecoveryCode,
  totpCodeForStep,
  totpStep,
  type StoredArgon2idPassword,
} from '@ezacto/core'

// The decoy burn is only observable in what the verifier was handed, so the
// real one is wrapped rather than replaced -- every other test still runs the
// genuine argon2 comparison.
const verifications: StoredArgon2idPassword[] = []
vi.mock('@ezacto/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@ezacto/core')>()
  return {
    ...core,
    verifyRecoveryCode: async (code: string, stored: StoredArgon2idPassword) => {
      verifications.push(stored)
      return core.verifyRecoveryCode(code, stored)
    },
  }
})

beforeEach(() => {
  verifications.length = 0
})

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const label = { accountName: async () => 'ada@example.test', issuer: 'Acme' }
const at = new Date('2026-09-09T12:00:00.000Z')

interface Recorder {
  spentSteps: number[]
  spentCodes: number[]
  enrolled: BeginEnrolmentInput[]
}

const store = (
  overrides: Partial<TwoFactorStore> = {},
  confirmedAt: string | null = '2026-09-01T00:00:00.000Z',
): TwoFactorStore & { recorder: Recorder } => {
  const recorder: Recorder = { spentSteps: [], spentCodes: [], enrolled: [] }
  return {
    recorder,
    enrolment: async () => ({ userId: 1, secret, confirmedAt, lastUsedStep: null }),
    beginEnrolment: async (input) => {
      recorder.enrolled.push(input)
      return { userId: input.userId, secret: input.secret, confirmedAt: null, lastUsedStep: null }
    },
    confirmEnrolment: async () => true,
    spendTotpStep: async (_userId, step) => {
      recorder.spentSteps.push(step)
      return true
    },
    findRecoveryCode: async () => null,
    spendRecoveryCode: async (_userId, codeId) => {
      recorder.spentCodes.push(codeId)
      return true
    },
    unusedRecoveryCodeCount: async () => 8,
    disable: async () => true,
    ...overrides,
  }
}

describe('two-factor verification', () => {
  it('[security] accepts a live code and spends the step it came from', async () => {
    const backing = store()
    const service = createTwoFactorService({ store: backing, ...label, now: () => at })
    const code = await totpCodeForStep(secret, totpStep(at.getTime()))

    expect(await service.verifyCode(1, code)).toBe('accepted')
    // The step is spent, and it is the step the code actually came from --
    // spending a different one would leave the presented code replayable.
    expect(backing.recorder.spentSteps).toEqual([totpStep(at.getTime())])
  })

  it('[security] rejects a code the store refuses to spend', async () => {
    // Two requests carrying the same code both verify. Only one can spend it,
    // and the spend is what decides -- otherwise a replay within the window is
    // accepted twice.
    const backing = store({ spendTotpStep: async () => false })
    const service = createTwoFactorService({ store: backing, ...label, now: () => at })
    const code = await totpCodeForStep(secret, totpStep(at.getTime()))

    expect(await service.verifyCode(1, code)).toBe('rejected')
  })

  it('[security] burns a verification on an unknown recovery selector', async () => {
    // A selector that returns before doing the work tells an attacker which
    // selectors are real, and enumeration is worth more than any one guess.
    // So the unknown selector must still reach the verifier, against the decoy.
    const backing = store({ findRecoveryCode: async () => null })
    const service = createTwoFactorService({ store: backing, ...label, now: () => at })

    expect(await service.verifyCode(1, 'ABCDEFGH-IJKLMNOPQRST')).toBe('rejected')
    expect(verifications).toEqual([RECOVERY_CODE_DECOY])
    expect(backing.recorder.spentCodes).toEqual([])
  })

  it('[security] accepts a real recovery code once and spends it', async () => {
    const value = 'ABCDEFGH-IJKLMNOPQRST'
    const hash = await hashRecoveryCode(value)
    const backing = store({
      findRecoveryCode: async () => ({ id: 42, selector: 'ABCDEFGH', hash }),
    })
    const service = createTwoFactorService({ store: backing, ...label, now: () => at })

    expect(await service.verifyCode(1, value)).toBe('accepted')
    expect(backing.recorder.spentCodes).toEqual([42])
  })

  it('[security] says not_enrolled for a pending enrolment rather than accepting it', async () => {
    // A code proves the authenticator holds the seed. It does not, on its own,
    // mean the user finished turning the factor on.
    const backing = store({}, null)
    const service = createTwoFactorService({ store: backing, ...label, now: () => at })
    const code = await totpCodeForStep(secret, totpStep(at.getTime()))

    expect(await service.verifyCode(1, code)).toBe('not_enrolled')
    expect(backing.recorder.spentSteps).toEqual([])
  })

  it('[security] hands the store selectors and hashes, never the codes themselves', async () => {
    const backing = store({}, null)
    const service = createTwoFactorService({
      store: backing,
      accountName: async () => 'ada@example.test',
      issuer: 'Acme',
      now: () => at,
    })

    const offer = await service.beginEnrolment(1)
    const written = JSON.stringify(backing.recorder.enrolled)
    // The return value is the only place a plain code exists. If one reached
    // the store it would be recoverable from the database, and a recovery code
    // that can be read back is a password stored in clear.
    expect(offer.recoveryCodes.length).toBeGreaterThan(0)
    for (const code of offer.recoveryCodes) {
      expect(written).not.toContain(code)
      expect(written).not.toContain(code.replace(/-/g, ''))
    }
    // The selector is a prefix, and is meant to be stored -- it is how a
    // presented code finds its row without the row naming the code.
    expect(backing.recorder.enrolled[0]?.codes).toHaveLength(offer.recoveryCodes.length)
  })

  it('[unit] labels the authenticator entry with the issuer and the user address', async () => {
    const service = createTwoFactorService({
      store: store({}, null),
      accountName: async () => 'ada@example.test',
      issuer: 'Acme',
      now: () => at,
    })

    const offer = await service.beginEnrolment(1)
    expect(offer.otpauthUri).toContain('otpauth://totp/Acme:ada%40example.test')
    expect(offer.otpauthUri).toContain(`secret=${offer.secret}`)
  })

  it('[unit] refuses to confirm an enrolment that is already on', async () => {
    // Otherwise confirming twice is a way to run the check against a live
    // enrolment, which is the disable path wearing another name.
    const service = createTwoFactorService({ store: store(), ...label, now: () => at })
    const code = await totpCodeForStep(secret, totpStep(at.getTime()))

    expect(await service.confirmEnrolment(1, code)).toBe('not_pending')
  })

  it('[unit] reports status without claiming a pending enrolment is on', async () => {
    const pending = createTwoFactorService({ store: store({}, null), ...label, now: () => at })
    expect(await pending.status(1)).toMatchObject({
      enrolled: false,
      pendingConfirmation: true,
    })

    const live = createTwoFactorService({ store: store(), ...label, now: () => at })
    expect(await live.status(1)).toMatchObject({
      enrolled: true,
      pendingConfirmation: false,
      recoveryCodesRemaining: 8,
    })
  })
})
