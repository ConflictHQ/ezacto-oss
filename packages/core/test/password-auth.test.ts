import { describe, expect, it } from 'vitest'
import {
  CURRENT_PBKDF2_ITERATIONS,
  hashPassword,
  passwordNeedsRehash,
  validatePassword,
  verifyPassword,
} from '../src/password-auth.js'

describe('password hashing', () => {
  it('[security] uses the Workers-safe OWASP PBKDF2 floor with unique salts', async () => {
    const password = 'correct horse battery staple 🙂'
    const [first, second] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ])
    expect(first).toMatchObject({
      algorithm: 'pbkdf2-sha256',
      iterations: CURRENT_PBKDF2_ITERATIONS,
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
