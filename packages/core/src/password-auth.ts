import { argon2idAsync } from '@noble/hashes/argon2.js'
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { PasswordDerivationLimiter } from './password-kdf-limiter.js'

export { PasswordDerivationOverloadedError } from './password-kdf-limiter.js'

export const CURRENT_PBKDF2_ITERATIONS = 600_000
export const ARGON2ID_VERSION = 0x13
export const ARGON2ID_MEMORY_KIB = 19 * 1_024
export const ARGON2ID_TIME_COST = 2
export const ARGON2ID_PARALLELISM = 1
export const PASSWORD_DERIVATION_CONCURRENCY = 1
export const PASSWORD_DERIVATION_MAX_QUEUE = 9
export const PASSWORD_DERIVATION_QUEUE_TIMEOUT_MS = 5_000
export const PASSWORD_MIN_CODE_POINTS = 12
export const PASSWORD_MAX_CODE_POINTS = 1_024
export const PASSWORD_MAX_UTF8_BYTES = 4_096

export interface StoredPbkdf2Password {
  algorithm: 'pbkdf2-sha256'
  iterations: number
  salt: string
  passwordHash: string
}

export interface StoredArgon2idPassword {
  algorithm: 'argon2id'
  version: number
  memoryKiB: number
  timeCost: number
  parallelism: number
  salt: string
  passwordHash: string
}

export type StoredPassword = StoredPbkdf2Password | StoredArgon2idPassword

const passwordDerivations = new PasswordDerivationLimiter({
  concurrency: PASSWORD_DERIVATION_CONCURRENCY,
  maxQueue: PASSWORD_DERIVATION_MAX_QUEUE,
  queueTimeoutMs: PASSWORD_DERIVATION_QUEUE_TIMEOUT_MS,
})

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const decodeBase64Url = (
  value: string,
  field: string,
  byteLength: number,
): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new RangeError(`${field} must be canonical base64url`)
  }
  let binary: string
  try {
    const padding = '='.repeat((4 - (value.length % 4)) % 4)
    binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding)
  } catch {
    throw new RangeError(`${field} must be canonical base64url`)
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.byteLength !== byteLength || encodeBase64Url(bytes) !== value) {
    throw new RangeError(`${field} must encode exactly ${byteLength} bytes`)
  }
  return bytes
}

export const validatePassword = (password: string): void => {
  if (typeof password !== 'string')
    throw new TypeError('password must be a string')
  const codePoints = [...password].length
  const bytes = new TextEncoder().encode(password).byteLength
  if (
    codePoints < PASSWORD_MIN_CODE_POINTS ||
    codePoints > PASSWORD_MAX_CODE_POINTS ||
    bytes > PASSWORD_MAX_UTF8_BYTES
  ) {
    throw new RangeError(
      `password must contain between ${PASSWORD_MIN_CODE_POINTS} and ${PASSWORD_MAX_CODE_POINTS} characters and at most ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`,
    )
  }
}

const deriveNativePbkdf2 = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  const saltBytes = new Uint8Array(salt.byteLength)
  saltBytes.set(salt)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
      key,
      256,
    ),
  )
}

const assertLegacyIterations = (iterations: number): void => {
  if (
    !Number.isSafeInteger(iterations) ||
    iterations !== CURRENT_PBKDF2_ITERATIONS
  ) {
    throw new RangeError(
      `PBKDF2 iterations must equal the supported legacy work factor ${CURRENT_PBKDF2_ITERATIONS}`,
    )
  }
}

const deriveLegacyPbkdf2 = async (
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> => {
  assertLegacyIterations(iterations)
  try {
    return await deriveNativePbkdf2(password, salt, iterations)
  } catch (error) {
    // Cloudflare's production workerd rejects standards-compliant PBKDF2
    // requests above 100,000 iterations. Preserve verification of the hashes
    // this application already wrote without weakening their work factor.
    if (!(error instanceof Error) || error.name !== 'OperationError')
      throw error
    return passwordDerivations.run(() =>
      pbkdf2Async(sha256, password, salt, {
        c: iterations,
        dkLen: 32,
        asyncTick: 10,
      }),
    )
  }
}

const assertCurrentArgon2idParameters = (
  stored: StoredArgon2idPassword,
): void => {
  if (
    stored.version !== ARGON2ID_VERSION ||
    stored.memoryKiB !== ARGON2ID_MEMORY_KIB ||
    stored.timeCost !== ARGON2ID_TIME_COST ||
    stored.parallelism !== ARGON2ID_PARALLELISM
  ) {
    throw new RangeError('Argon2id parameters are unsupported')
  }
}

const deriveArgon2id = async (
  password: string,
  salt: Uint8Array,
  stored: StoredArgon2idPassword,
): Promise<Uint8Array> => {
  assertCurrentArgon2idParameters(stored)
  return passwordDerivations.run(() =>
    argon2idAsync(password, salt, {
      version: stored.version,
      m: stored.memoryKiB,
      t: stored.timeCost,
      p: stored.parallelism,
      dkLen: 32,
      maxmem: ARGON2ID_MEMORY_KIB * 1_024,
      asyncTick: 10,
    }),
  )
}

export const hashPassword = async (
  password: string,
): Promise<StoredPassword> => {
  validatePassword(password)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const stored: StoredArgon2idPassword = {
    algorithm: 'argon2id',
    version: ARGON2ID_VERSION,
    memoryKiB: ARGON2ID_MEMORY_KIB,
    timeCost: ARGON2ID_TIME_COST,
    parallelism: ARGON2ID_PARALLELISM,
    salt: encodeBase64Url(salt),
    passwordHash: '',
  }
  stored.passwordHash = encodeBase64Url(
    await deriveArgon2id(password, salt, stored),
  )
  return stored
}

export const verifyPassword = async (
  password: string,
  stored: StoredPassword,
): Promise<boolean> => {
  const salt = decodeBase64Url(stored.salt, 'salt', 16)
  const expected = decodeBase64Url(stored.passwordHash, 'passwordHash', 32)
  const actual =
    stored.algorithm === 'argon2id'
      ? await deriveArgon2id(password, salt, stored)
      : await deriveLegacyPbkdf2(password, salt, stored.iterations)
  let difference = actual.byteLength ^ expected.byteLength
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= actual[index]! ^ (expected[index] ?? 0)
  }
  return difference === 0
}

export const passwordNeedsRehash = (stored: StoredPassword): boolean =>
  stored.algorithm !== 'argon2id' ||
  stored.version !== ARGON2ID_VERSION ||
  stored.memoryKiB !== ARGON2ID_MEMORY_KIB ||
  stored.timeCost !== ARGON2ID_TIME_COST ||
  stored.parallelism !== ARGON2ID_PARALLELISM
