import { describe, expect, it } from 'vitest'
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_CODE_SELECTOR_LENGTH,
  TOTP_PERIOD_SECONDS,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  recoveryCodeSelector,
  totpAuthUri,
  totpCodeForStep,
  totpStep,
  verifyRecoveryCode,
  verifyTotpCode,
} from '../src/totp.js'

// RFC 6238 Appendix B, SHA-1 column, truncated to the six digits an
// authenticator app actually shows. The seed is the RFC's ASCII
// "12345678901234567890" in base32.
const referenceSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const referenceVectors = [
  [59, '287082'],
  [1_111_111_109, '081804'],
  [1_111_111_111, '050471'],
  [1_234_567_890, '005924'],
  [2_000_000_000, '279037'],
  [20_000_000_000, '353130'],
] as const

const secondsToStep = (seconds: number) =>
  Math.floor(seconds / TOTP_PERIOD_SECONDS)

describe('TOTP', () => {
  it('[unit] reproduces the RFC 6238 reference codes', async () => {
    for (const [seconds, expected] of referenceVectors) {
      expect(
        await totpCodeForStep(referenceSecret, secondsToStep(seconds)),
        `T=${seconds}`,
      ).toBe(expected)
    }
  })

  it('[unit] accepts one period of clock drift and no more', async () => {
    const now = 1_111_111_111_000
    const centre = totpStep(now)
    for (const offset of [-1, 0, 1]) {
      const code = await totpCodeForStep(referenceSecret, centre + offset)
      expect(
        await verifyTotpCode(referenceSecret, code, { timestampMs: now }),
      ).toEqual({ status: 'accepted', step: centre + offset })
    }
    for (const offset of [-2, 2]) {
      const code = await totpCodeForStep(referenceSecret, centre + offset)
      expect(
        await verifyTotpCode(referenceSecret, code, { timestampMs: now }),
      ).toEqual({ status: 'rejected', reason: 'mismatch' })
    }
  })

  it('[unit] refuses a code from a step that has already been spent', async () => {
    const now = 1_111_111_111_000
    const centre = totpStep(now)
    const code = await totpCodeForStep(referenceSecret, centre)
    expect(
      await verifyTotpCode(referenceSecret, code, {
        timestampMs: now,
        lastUsedStep: centre,
      }),
    ).toEqual({ status: 'rejected', reason: 'replayed' })
    // The step before the spent one is stale too, not merely equal to it.
    const earlier = await totpCodeForStep(referenceSecret, centre - 1)
    expect(
      await verifyTotpCode(referenceSecret, earlier, {
        timestampMs: now,
        lastUsedStep: centre,
      }),
    ).toEqual({ status: 'rejected', reason: 'replayed' })
    // A fresh step after the spent one still works.
    const next = await totpCodeForStep(referenceSecret, centre + 1)
    expect(
      await verifyTotpCode(referenceSecret, next, {
        timestampMs: now,
        lastUsedStep: centre,
      }),
    ).toEqual({ status: 'accepted', step: centre + 1 })
  })

  it('[unit] rejects anything that is not six digits', async () => {
    for (const code of ['', '05047', '0504710', 'abcdef', '05047 1']) {
      expect(
        await verifyTotpCode(referenceSecret, code, {
          timestampMs: 1_111_111_111_000,
        }),
      ).toEqual({ status: 'rejected', reason: 'malformed' })
    }
  })

  it('[unit] issues a 32-character base32 seed that differs every time', () => {
    const seeds = new Set(
      Array.from({ length: 16 }, () => generateTotpSecret()),
    )
    expect(seeds.size).toBe(16)
    for (const seed of seeds) expect(seed).toMatch(/^[A-Z2-7]{32}$/)
  })

  it('[unit] builds an otpauth URI an authenticator can import', () => {
    const uri = totpAuthUri({
      secret: referenceSecret,
      accountName: 'owner@example.test',
      issuer: 'ezacto',
    })
    expect(uri).toBe(
      'otpauth://totp/ezacto:owner%40example.test' +
        `?secret=${referenceSecret}&issuer=ezacto&algorithm=SHA1&digits=6&period=30`,
    )
  })
})

describe('recovery codes', () => {
  it('[unit] issues distinct, grouped codes with distinct selectors', () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT)
    expect(
      new Set(codes.map((code) => recoveryCodeSelector(code))).size,
    ).toBe(RECOVERY_CODE_COUNT)
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/)
      expect(recoveryCodeSelector(code)).toHaveLength(
        RECOVERY_CODE_SELECTOR_LENGTH,
      )
    }
  })

  it('[unit] reads a code back however a person types it', () => {
    const [code] = generateRecoveryCodes(1)
    const normalized = normalizeRecoveryCode(code!)
    expect(normalized).toMatch(/^[A-Z2-7]{20}$/)
    expect(normalizeRecoveryCode(code!.toLowerCase())).toBe(normalized)
    expect(normalizeRecoveryCode(`  ${code!.replaceAll('-', ' ')} `)).toBe(
      normalized,
    )
    expect(normalizeRecoveryCode(normalized!)).toBe(normalized)
    for (const rejected of ['', code!.slice(0, 10), `${code!}A`, '0'.repeat(20)])
      expect(normalizeRecoveryCode(rejected)).toBeNull()
  })

  it('[unit] stores only an Argon2id hash and verifies against it', async () => {
    const [code, other] = generateRecoveryCodes(2)
    const stored = await hashRecoveryCode(code!)
    expect(stored.algorithm).toBe('argon2id')
    // The hash must not be the code, in any casing or grouping it was shown in.
    const serialized = JSON.stringify(stored)
    expect(serialized).not.toContain(normalizeRecoveryCode(code!)!)
    expect(serialized).not.toContain(code!)

    expect(await verifyRecoveryCode(code!, stored)).toBe(true)
    expect(await verifyRecoveryCode(code!.toLowerCase(), stored)).toBe(true)
    expect(await verifyRecoveryCode(other!, stored)).toBe(false)
    expect(await verifyRecoveryCode('not a code', stored)).toBe(false)
  })

  it('[unit] refuses to hash something that is not a code', async () => {
    expect(() => hashRecoveryCode('short')).toThrow(RangeError)
  })
})
