import {
  hashPassword,
  verifyPassword,
  type StoredPassword,
} from './password-auth.js'

/**
 * TOTP (RFC 6238) and the recovery codes that stand in for it.
 *
 * Only WebCrypto is used. The container entry runs this same file, so a
 * Node-only hash or a native binding would have to be excluded from the worker
 * bundle and would then be a second implementation nobody tests.
 *
 * Nothing here writes to a log. A seed or a recovery code that reaches a log
 * line is a credential in plain text on someone's stdout, so these functions
 * return values and never narrate them.
 */

export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6
export const TOTP_SECRET_BYTES = 20

/**
 * How many periods either side of the server's clock a code may come from.
 * One step is the usual compromise: a phone that is half a minute behind still
 * works, while the window an attacker may replay into stays at 90 seconds.
 */
export const TOTP_DRIFT_STEPS = 1

export const RECOVERY_CODE_COUNT = 10
export const RECOVERY_CODE_LENGTH = 20
export const RECOVERY_CODE_GROUP_SIZE = 5

/**
 * The leading characters of a recovery code, stored beside its hash so a
 * presented code is found with one indexed lookup and verified with exactly
 * one Argon2id derivation. Iterating every code a user holds would cost ten
 * derivations per attempt, which no request budget survives.
 *
 * The selector narrows the search; it does not authenticate. The remaining
 * characters carry 60 bits that only the Argon2id hash protects, so a database
 * someone walks off with still yields no usable code.
 */
export const RECOVERY_CODE_SELECTOR_LENGTH = 8

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

const decodeBase32 = (value: string): Uint8Array => {
  let bits = 0
  let accumulator = 0
  const bytes: number[] = []
  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new RangeError('secret must be base32')
    accumulator = (accumulator << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((accumulator >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(bytes)
}

/** Uniform because 256 is a multiple of 32: masking to five bits adds no bias. */
const randomBase32 = (length: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let value = ''
  for (const byte of bytes) value += BASE32_ALPHABET[byte & 31]
  return value
}

const constantTimeEquals = (left: string, right: string): boolean => {
  let difference = left.length ^ right.length
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ (right.charCodeAt(index) || 0)
  }
  return difference === 0
}

export const generateTotpSecret = (): string =>
  // Eight bits per random byte, five bits per character: 20 bytes is the
  // RFC 4226 recommended seed length and encodes to exactly 32 characters.
  randomBase32(Math.ceil((TOTP_SECRET_BYTES * 8) / 5))

export interface TotpUriInput {
  secret: string
  /** What the authenticator app shows under the issuer, usually an email. */
  accountName: string
  issuer: string
}

export const totpAuthUri = ({
  secret,
  accountName,
  issuer,
}: TotpUriInput): string => {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`
  const parameters = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${parameters.toString()}`
}

export const totpStep = (timestampMs: number): number =>
  Math.floor(timestampMs / 1_000 / TOTP_PERIOD_SECONDS)

const hotp = async (secret: string, counter: number): Promise<string> => {
  const seed = decodeBase32(secret)
  const message = new Uint8Array(8)
  let remaining = BigInt(counter)
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  const key = await crypto.subtle.importKey(
    'raw',
    seed.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, message.buffer as ArrayBuffer),
  )
  const offset = mac[mac.length - 1]! & 0x0f
  const truncated =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  return String(truncated % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** The code a correctly synchronised authenticator shows for `step`. */
export const totpCodeForStep = (
  secret: string,
  step: number,
): Promise<string> => hotp(secret, step)

export interface TotpVerificationInput {
  timestampMs: number
  /**
   * The step a previously accepted code came from, or null when the enrolment
   * has never been used. A code is good for thirty seconds and the drift
   * window widens that to ninety, which is long enough for someone reading it
   * over a shoulder to type it in after the owner did.
   */
  lastUsedStep?: number | null
  driftSteps?: number
}

export type TotpVerificationResult =
  | { status: 'accepted'; step: number }
  | { status: 'rejected'; reason: 'malformed' | 'mismatch' | 'replayed' }

export const verifyTotpCode = async (
  secret: string,
  code: string,
  input: TotpVerificationInput,
): Promise<TotpVerificationResult> => {
  if (typeof code !== 'string' || !new RegExp(`^[0-9]{${TOTP_DIGITS}}$`).test(code)) {
    return { status: 'rejected', reason: 'malformed' }
  }
  const drift = input.driftSteps ?? TOTP_DRIFT_STEPS
  const centre = totpStep(input.timestampMs)
  let matched: number | null = null
  for (let offset = -drift; offset <= drift; offset += 1) {
    const step = centre + offset
    if (step < 0) continue
    // Every candidate is evaluated even after a match so that the work done
    // does not reveal which step the presented code came from.
    if (constantTimeEquals(await totpCodeForStep(secret, step), code)) {
      matched = step
    }
  }
  if (matched === null) return { status: 'rejected', reason: 'mismatch' }
  const lastUsed = input.lastUsedStep ?? null
  if (lastUsed !== null && matched <= lastUsed) {
    return { status: 'rejected', reason: 'replayed' }
  }
  return { status: 'accepted', step: matched }
}

const groupRecoveryCode = (value: string): string => {
  const groups: string[] = []
  for (let index = 0; index < value.length; index += RECOVERY_CODE_GROUP_SIZE) {
    groups.push(value.slice(index, index + RECOVERY_CODE_GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * Codes are handed out once, in the display grouping, and never reconstructed:
 * only their Argon2id hashes are stored. Selectors are forced distinct because
 * a duplicate would make one of the two codes unreachable.
 */
export const generateRecoveryCodes = (
  count: number = RECOVERY_CODE_COUNT,
): string[] => {
  const selectors = new Set<string>()
  const codes: string[] = []
  while (codes.length < count) {
    const value = randomBase32(RECOVERY_CODE_LENGTH)
    const selector = value.slice(0, RECOVERY_CODE_SELECTOR_LENGTH)
    if (selectors.has(selector)) continue
    selectors.add(selector)
    codes.push(groupRecoveryCode(value))
  }
  return codes
}

/**
 * Accepts what a person actually types: any casing, with or without the
 * grouping hyphens and surrounding whitespace. A code that cannot be a code
 * returns null rather than throwing, because at verification time a malformed
 * code is simply a wrong one and the caller must not answer it differently.
 */
export const normalizeRecoveryCode = (value: string): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[\s-]/g, '').toUpperCase()
  return new RegExp(`^[A-Z2-7]{${RECOVERY_CODE_LENGTH}}$`).test(normalized)
    ? normalized
    : null
}

export const recoveryCodeSelector = (value: string): string | null =>
  normalizeRecoveryCode(value)?.slice(0, RECOVERY_CODE_SELECTOR_LENGTH) ?? null

/** Hashed with the same Argon2id parameters as a password, for the same reason. */
export const hashRecoveryCode = (value: string): Promise<StoredPassword> => {
  const normalized = normalizeRecoveryCode(value)
  if (normalized === null) throw new RangeError('recovery code is malformed')
  return hashPassword(normalized)
}

export const verifyRecoveryCode = async (
  value: string,
  stored: StoredPassword,
): Promise<boolean> => {
  const normalized = normalizeRecoveryCode(value)
  if (normalized === null) return false
  return verifyPassword(normalized, stored)
}
