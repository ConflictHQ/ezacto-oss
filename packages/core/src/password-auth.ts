export const CURRENT_PBKDF2_ITERATIONS = 600_000
export const PASSWORD_MIN_CODE_POINTS = 12
export const PASSWORD_MAX_CODE_POINTS = 1_024
export const PASSWORD_MAX_UTF8_BYTES = 4_096

export interface StoredPassword {
  algorithm: 'pbkdf2-sha256'
  iterations: number
  salt: string
  passwordHash: string
}

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

const derive = async (
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

const assertIterations = (iterations: number): void => {
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < CURRENT_PBKDF2_ITERATIONS
  ) {
    throw new RangeError(
      `PBKDF2 iterations must be at least ${CURRENT_PBKDF2_ITERATIONS}`,
    )
  }
}

export const hashPassword = async (
  password: string,
): Promise<StoredPassword> => {
  validatePassword(password)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return {
    algorithm: 'pbkdf2-sha256',
    iterations: CURRENT_PBKDF2_ITERATIONS,
    salt: encodeBase64Url(salt),
    passwordHash: encodeBase64Url(
      await derive(password, salt, CURRENT_PBKDF2_ITERATIONS),
    ),
  }
}

export const verifyPassword = async (
  password: string,
  stored: StoredPassword,
): Promise<boolean> => {
  if (stored.algorithm !== 'pbkdf2-sha256') return false
  assertIterations(stored.iterations)
  const salt = decodeBase64Url(stored.salt, 'salt', 16)
  const expected = decodeBase64Url(stored.passwordHash, 'passwordHash', 32)
  const actual = await derive(password, salt, stored.iterations)
  let difference = actual.byteLength ^ expected.byteLength
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= actual[index]! ^ (expected[index] ?? 0)
  }
  return difference === 0
}

export const passwordNeedsRehash = (stored: StoredPassword): boolean =>
  stored.algorithm !== 'pbkdf2-sha256' ||
  stored.iterations < CURRENT_PBKDF2_ITERATIONS
