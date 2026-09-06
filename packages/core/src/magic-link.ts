/**
 * Magic-link token generation and verification.
 *
 * Tokens are HMAC-SHA256 signed payloads that carry contact identity and
 * expiry. The signature prevents forgery; the DB layer enforces single-use.
 *
 * Token format: `ezacto_magic_<base64url_payload>.<base64url_signature>`
 */

export interface MagicLinkPayload {
  /** Contact email address (lowercase). */
  sub: string
  /** Contact row id. */
  cid: number
  /** Client row id the contact belongs to. */
  cli: number
  /** Expiry as Unix milliseconds. */
  exp: number
  /** Unique token identifier for single-use tracking. */
  jti: string
}

export interface MagicLinkTokenInput {
  contactEmail: string
  contactId: number
  clientId: number
  ttlMs: number
}

/** Default magic-link lifetime: 15 minutes. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1_000

const textEncoder = new TextEncoder()

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const base64UrlDecode = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const randomBase64Url = (byteLength: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  return base64UrlEncode(bytes)
}

const importHmacKey = async (secret: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    secret.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )

const sign = async (data: Uint8Array, key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.sign('HMAC', key, data as Uint8Array<ArrayBuffer>))

const verify = async (
  data: Uint8Array,
  signature: Uint8Array,
  key: CryptoKey,
): Promise<boolean> =>
  crypto.subtle.verify('HMAC', key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>)

/**
 * Create a signed magic-link token.
 *
 * @param input - Contact identity and TTL.
 * @param signingKey - HMAC-SHA256 key material (at least 32 bytes recommended).
 * @param now - Current time override for testing.
 * @returns The signed token string and its unique identifier.
 */
export const createMagicLinkToken = async (
  input: MagicLinkTokenInput,
  signingKey: Uint8Array,
  now?: string,
): Promise<{ token: string; jti: string; expiresAt: string }> => {
  if (signingKey.byteLength < 32) {
    throw new RangeError('magic link signing key must be at least 32 bytes')
  }
  if (
    !Number.isSafeInteger(input.contactId) || input.contactId < 1 ||
    !Number.isSafeInteger(input.clientId) || input.clientId < 1
  ) {
    throw new RangeError('contact and client ids must be positive safe integers')
  }
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
    throw new RangeError('ttl must be a positive safe integer')
  }
  const email = input.contactEmail.trim().toLowerCase()
  if (email.length < 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new RangeError('contact email must be a valid email address')
  }

  const timestamp = now ?? new Date().toISOString()
  const expiresAt = new Date(Date.parse(timestamp) + input.ttlMs).toISOString()
  const jti = randomBase64Url(24)

  const payload: MagicLinkPayload = {
    sub: email,
    cid: input.contactId,
    cli: input.clientId,
    exp: Date.parse(expiresAt),
    jti,
  }

  const payloadBytes = textEncoder.encode(JSON.stringify(payload))
  const payloadEncoded = base64UrlEncode(payloadBytes)
  const key = await importHmacKey(signingKey)
  const signature = await sign(textEncoder.encode(payloadEncoded), key)

  return {
    token: `ezacto_magic_${payloadEncoded}.${base64UrlEncode(signature)}`,
    jti,
    expiresAt,
  }
}

/**
 * Verify a magic-link token's HMAC signature and expiry.
 *
 * This does NOT check single-use status; that is the DB layer's responsibility.
 *
 * @returns The decoded payload if signature and expiry are valid, or null.
 */
export const verifyMagicLinkToken = async (
  token: string,
  signingKey: Uint8Array,
  now?: string,
): Promise<MagicLinkPayload | null> => {
  if (signingKey.byteLength < 32) {
    throw new RangeError('magic link signing key must be at least 32 bytes')
  }
  if (!token.startsWith('ezacto_magic_')) return null
  const body = token.slice('ezacto_magic_'.length)
  const dotIndex = body.indexOf('.')
  if (dotIndex < 1 || dotIndex === body.length - 1) return null

  const payloadEncoded = body.slice(0, dotIndex)
  const signatureEncoded = body.slice(dotIndex + 1)

  let signatureBytes: Uint8Array
  try {
    signatureBytes = base64UrlDecode(signatureEncoded)
  } catch {
    return null
  }

  const key = await importHmacKey(signingKey)
  const valid = await verify(
    textEncoder.encode(payloadEncoded),
    signatureBytes,
    key,
  )
  if (!valid) return null

  let payloadBytes: Uint8Array
  try {
    payloadBytes = base64UrlDecode(payloadEncoded)
  } catch {
    return null
  }

  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return null
  }

  if (
    typeof payload !== 'object' || payload === null ||
    !('sub' in payload) || typeof (payload as MagicLinkPayload).sub !== 'string' ||
    !('cid' in payload) || typeof (payload as MagicLinkPayload).cid !== 'number' ||
    !('cli' in payload) || typeof (payload as MagicLinkPayload).cli !== 'number' ||
    !('exp' in payload) || typeof (payload as MagicLinkPayload).exp !== 'number' ||
    !('jti' in payload) || typeof (payload as MagicLinkPayload).jti !== 'string'
  ) {
    return null
  }

  const typed = payload as MagicLinkPayload
  const currentTime = Date.parse(now ?? new Date().toISOString())
  if (typed.exp <= currentTime) return null

  return typed
}
