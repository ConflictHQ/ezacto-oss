import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_TIME_COST,
  ARGON2ID_VERSION,
  CURRENT_PBKDF2_ITERATIONS,
  hashPassword,
  passwordNeedsRehash,
  validatePassword,
  verifyPassword,
} from '../src/password-auth.js'

describe('password hashing', () => {
  afterEach(() => vi.restoreAllMocks())
  const encodedFixture = (...parts: string[]) => parts.join('')

  it('[security] uses OWASP-minimum Argon2id parameters with unique salts', async () => {
    const password = 'correct horse battery staple 🙂'
    const [first, second] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ])
    expect(first).toMatchObject({
      algorithm: 'argon2id',
      version: ARGON2ID_VERSION,
      memoryKiB: ARGON2ID_MEMORY_KIB,
      timeCost: ARGON2ID_TIME_COST,
      parallelism: ARGON2ID_PARALLELISM,
    })
    expect(first.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(first.passwordHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.salt).not.toBe(second.salt)
    expect(first.passwordHash).not.toBe(second.passwordHash)
    expect(JSON.stringify(first)).not.toContain(password)
    await expect(verifyPassword(password, first)).resolves.toBe(true)
    await expect(verifyPassword('wrong but long enough', first)).resolves.toBe(
      false,
    )
    expect(passwordNeedsRehash(first)).toBe(false)
  })

  it('[security] matches an independently verified Argon2id known-answer vector', async () => {
    await expect(
      verifyPassword('password', {
        algorithm: 'argon2id',
        version: ARGON2ID_VERSION,
        memoryKiB: ARGON2ID_MEMORY_KIB,
        timeCost: ARGON2ID_TIME_COST,
        parallelism: ARGON2ID_PARALLELISM,
        salt: 'AAAAAAAAAAAAAAAAAAAAAA',
        passwordHash: encodedFixture(
          '3I4-G8Hb-nW',
          'NCW9b6y5QNX',
          '813QAdykZ4Q',
          'qazSX6pzCs',
        ),
      }),
    ).resolves.toBe(true)
  })

  it('[regression] verifies the exact legacy PBKDF2 format when workerd rejects 600,000 iterations', async () => {
    const password = 'correct horse battery staple 🙂'
    const legacy = {
      algorithm: 'pbkdf2-sha256' as const,
      iterations: CURRENT_PBKDF2_ITERATIONS,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      passwordHash: encodedFixture(
        'bnGkwQATJVA',
        'WvmKcKHTFYf',
        'JltGnt71mBc',
        'ZkK97j0T-E',
      ),
    }
    const deriveBits = vi
      .spyOn(crypto.subtle, 'deriveBits')
      .mockRejectedValueOnce(
        new DOMException(
          'PBKDF2 iteration count exceeds the runtime limit',
          'OperationError',
        ),
      )

    await expect(verifyPassword(password, legacy)).resolves.toBe(true)
    expect(deriveBits).toHaveBeenCalledOnce()
    expect(passwordNeedsRehash(legacy)).toBe(true)
  })

  it('[security] rejects hostile stored work factors before expensive derivation', async () => {
    const deriveBits = vi.spyOn(crypto.subtle, 'deriveBits')
    const legacy = {
      algorithm: 'pbkdf2-sha256' as const,
      iterations: Number.MAX_SAFE_INTEGER,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      passwordHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }
    const argon = {
      algorithm: 'argon2id' as const,
      version: ARGON2ID_VERSION,
      memoryKiB: 1_048_576,
      timeCost: ARGON2ID_TIME_COST,
      parallelism: ARGON2ID_PARALLELISM,
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      passwordHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }

    await expect(
      verifyPassword('a sufficiently long password', legacy),
    ).rejects.toThrow(/supported legacy work factor/i)
    await expect(
      verifyPassword('a sufficiently long password', argon),
    ).rejects.toThrow(/parameters are unsupported/i)
    expect(deriveBits).not.toHaveBeenCalled()
  })

  it('[unit] accepts international passwords without trimming or normalizing entropy', () => {
    expect(() => validatePassword(' 密碼🙂avec espaces\u0000 ')).not.toThrow()
  })

  it('[unit] rejects passwords outside the explicit denial-of-service boundaries', () => {
    expect(() => validatePassword('too-short')).toThrow(/between 12 and 1024/)
    expect(() => validatePassword('x'.repeat(1_025))).toThrow(
      /between 12 and 1024/,
    )
  })
})
