import { WebhookError } from './webhooks.js'
const encoder = new TextEncoder()
const base64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const decode = (value: string): Uint8Array =>
  Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
    char.charCodeAt(0),
  )
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
const secretPattern = /^ezwh_[A-Za-z0-9_-]{43}$/
export const createWebhookSigningSecret = (): string =>
  'ezwh_' + base64(crypto.getRandomValues(new Uint8Array(32)))
export interface WebhookSecretIdentity {
  subscriptionId: string
  generation: number
}
export interface WebhookSecretVault {
  readonly keyId: string
  seal(secret: string, identity: WebhookSecretIdentity): Promise<string>
  open(envelope: string, identity: WebhookSecretIdentity): Promise<string>
}
/** A dedicated deployment key, never the backup encryption key or an API signing key. */
export const createWebhookSecretVault = async (encodedKey: string): Promise<WebhookSecretVault> => {
  const unavailable = (): never => {
    throw new WebhookError('webhook_secret_unavailable', 'configuration')
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) return unavailable()
  const bytes = decode(encodedKey)
  if (bytes.length !== 32 || base64(bytes) !== encodedKey) return unavailable()
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(bytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
  const keyId = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
  const aad = (identity: WebhookSecretIdentity) => {
    if (
      !uuid.test(identity.subscriptionId) ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1
    )
      throw new WebhookError('invalid_webhook_secret_identity')
    return encoder.encode(
      JSON.stringify({
        version: 1,
        purpose: 'ezacto-outbound-webhook-signing',
        subscription_id: identity.subscriptionId,
        generation: identity.generation,
        key_id: keyId,
      }),
    )
  }
  return {
    keyId,
    async seal(secret, identity) {
      if (!secretPattern.test(secret) || base64(decode(secret.slice(5))) !== secret.slice(5))
        throw new WebhookError('invalid_webhook_signing_secret', 'secret')
      const nonce = crypto.getRandomValues(new Uint8Array(12)),
        associated = aad(identity)
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: associated, tagLength: 128 },
        key,
        encoder.encode(secret),
      )
      return JSON.stringify({
        version: 1,
        key_id: keyId,
        nonce: base64(nonce),
        ciphertext: base64(new Uint8Array(ciphertext)),
      })
    },
    async open(envelope, identity) {
      const associated = aad(identity)
      try {
        if (typeof envelope !== 'string' || envelope.length > 1024) return unavailable()
        const record = JSON.parse(envelope) as Record<string, unknown>
        if (
          !record ||
          typeof record !== 'object' ||
          Array.isArray(record) ||
          Object.keys(record).some(
            (name) => !['version', 'key_id', 'nonce', 'ciphertext'].includes(name),
          ) ||
          record.version !== 1 ||
          record.key_id !== keyId ||
          typeof record.nonce !== 'string' ||
          !/^[A-Za-z0-9_-]{16}$/.test(record.nonce) ||
          typeof record.ciphertext !== 'string' ||
          !/^[A-Za-z0-9_-]{86}$/.test(record.ciphertext)
        )
          return unavailable()
        const nonce = decode(record.nonce),
          ciphertext = decode(record.ciphertext)
        if (base64(nonce) !== record.nonce || base64(ciphertext) !== record.ciphertext)
          return unavailable()
        const clear = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: new Uint8Array(nonce),
            additionalData: associated,
            tagLength: 128,
          },
          key,
          new Uint8Array(ciphertext),
        )
        const secret = new TextDecoder('utf-8', { fatal: true }).decode(clear)
        if (!secretPattern.test(secret)) return unavailable()
        return secret
      } catch {
        return unavailable()
      }
    },
  }
}
