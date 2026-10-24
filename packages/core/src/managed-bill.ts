/** Managed tenant-owned BILL connection contracts (issue 1252). The credential is
 * a tenant company login (or AP/AR sync token); the developer key is platform
 * owned and is never part of tenant custody. Provider effects are never part of
 * these contracts: stores hold sealed envelopes and lifecycle facts only. */
export const managedBillLimits = {
  companyIdLength: 64,
  credentialLength: 512,
  replyToUserIdLength: 64,
} as const

export type ManagedBillEnvironment = 'sandbox' | 'production'
export type ManagedBillConnectionStatus =
  | 'disconnected'
  | 'configured'
  | 'connected'
  | 'unavailable'

/** Plaintext tenant credential. Exists only inside one private command call. */
export interface ManagedBillCredentials {
  companyId: string
  username: string
  password: string
  replyToUserId: string | null
  environment: ManagedBillEnvironment
}

/** Safe, non-secret facts. The status never decrypts or contacts BILL. */
export interface ManagedBillConnectionState {
  /** Opaque safe integer; every connect, rotation, disconnect and erase advances it. */
  generation: number
  status: ManagedBillConnectionStatus
  companyId: string | null
  environment: ManagedBillEnvironment
  canSendFromBill: boolean
}

export interface ManagedBillSealedConnection extends ManagedBillConnectionState {
  sealed: string
}

export type ManagedBillAuthority =
  | { kind: 'native-session'; userId: number; sessionId: number }
  | { kind: 'guarded-session'; userId: number }

interface ManagedBillCommandBase {
  /** Random 64 hex digest naming this attempt; the exact-replay fence. */
  commandId: string
  expectedActorUserId: number
  expectedGeneration: number
  /** Keyed digest of the full intent, so a changed secret cannot replay as success. */
  fingerprint: string
}
export interface ManagedBillConnectCommand extends ManagedBillCommandBase {
  action: 'connect'
  companyId: string
  environment: ManagedBillEnvironment
  canSendFromBill: boolean
  /** Credential envelope sealed for generation expectedGeneration+1. */
  sealed: string
}
export interface ManagedBillDisconnectCommand extends ManagedBillCommandBase {
  action: 'disconnect'
}
export type ManagedBillCommand = ManagedBillConnectCommand | ManagedBillDisconnectCommand

export interface ManagedBillCommandResult extends ManagedBillConnectionState {
  outcome: 'applied' | 'replayed'
}

/** Count of credential-bearing rows, for closure/erasure inventory. */
export interface ManagedBillCustodyInventory {
  sealedCredentials: number
  commandReceipts: number
}

export interface ManagedBillConnectionStore {
  state(): Promise<ManagedBillConnectionState>
  /** Authorized active administrator only; rechecked inside the same SQL command. */
  prepare(authority: ManagedBillAuthority, now: string): Promise<ManagedBillConnectionState>
  apply(
    command: ManagedBillCommand,
    authority: ManagedBillAuthority,
    now: string,
  ): Promise<ManagedBillCommandResult>
  /** The sealed credential for runtime use; null when disconnected or erased. */
  readSealed(): Promise<ManagedBillSealedConnection | null>
  /** Records only a boolean outcome for the given generation; stale generations are ignored. */
  recordHealth(generation: number, healthy: boolean, now: string): Promise<void>
  /** Closure/reset: removes credential and receipts, keeps the generation monotonic. */
  erase(now: string): Promise<void>
  inventory(): Promise<ManagedBillCustodyInventory>
}

export class ManagedBillConnectionError extends Error {
  constructor(readonly kind: 'invalid' | 'forbidden' | 'conflict') {
    super('The BILL connection or administrator authority changed. Restart from settings.')
    this.name = 'ManagedBillConnectionError'
  }
}

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
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
const keyBytes = (encoded: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new ManagedBillConnectionError('invalid')
  const bytes = decode(encoded)
  if (bytes.length !== 32 || base64(bytes) !== encoded)
    throw new ManagedBillConnectionError('invalid')
  return bytes
}

export interface ManagedBillVault {
  keyId: string
  seal(credentials: ManagedBillCredentials, generation: number): Promise<string>
  open(envelope: string, generation: number): Promise<ManagedBillCredentials>
  /** Keyed digest under a separate purpose key; safe to retain in receipts. */
  fingerprint(parts: readonly unknown[]): Promise<string>
}

/** Tenant-bound AES-GCM custody. The custody and fingerprint keys are separate
 * purpose keys supplied by the host (32 bytes, base64url); `tenantBinding` is an
 * opaque host-owned identity authenticated into every envelope, so an envelope
 * cannot be opened for another tenant or another connection generation. */
export const createManagedBillVault = async (options: {
  custodyKey: string
  fingerprintKey: string
  tenantBinding: string
}): Promise<ManagedBillVault> => {
  const custody = keyBytes(options.custodyKey)
  const fingerprintBytes = keyBytes(options.fingerprintKey)
  if (options.custodyKey === options.fingerprintKey || !options.tenantBinding)
    throw new ManagedBillConnectionError('invalid')
  const aesKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(custody),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(fingerprintBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const keyId = hex(await crypto.subtle.digest('SHA-256', new Uint8Array(custody))).slice(0, 32)
  const aad = (generation: number) => {
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new ManagedBillConnectionError('invalid')
    return encoder.encode(
      JSON.stringify({
        version: 1,
        purpose: 'ezacto-managed-bill-tenant-credential',
        tenant: options.tenantBinding,
        generation,
        key_id: keyId,
      }),
    )
  }
  return {
    keyId,
    async seal(credentials, generation) {
      validateManagedBillCredentials(credentials)
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad(generation), tagLength: 128 },
        aesKey,
        encoder.encode(JSON.stringify(credentials)),
      )
      return JSON.stringify({
        version: 1,
        key_id: keyId,
        nonce: base64(nonce),
        ciphertext: base64(new Uint8Array(ciphertext)),
      })
    },
    async open(envelope, generation) {
      try {
        const record = JSON.parse(envelope) as Record<string, unknown>
        if (
          record.version !== 1 ||
          record.key_id !== keyId ||
          typeof record.nonce !== 'string' ||
          typeof record.ciphertext !== 'string'
        )
          throw new Error('envelope')
        const clear = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: new Uint8Array(decode(record.nonce)),
            additionalData: aad(generation),
            tagLength: 128,
          },
          aesKey,
          new Uint8Array(decode(record.ciphertext)),
        )
        const credentials = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear))
        validateManagedBillCredentials(credentials)
        return credentials as ManagedBillCredentials
      } catch {
        // Never surface parser/crypto detail: it can echo envelope material.
        throw new ManagedBillConnectionError('invalid')
      }
    },
    async fingerprint(parts) {
      return hex(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(JSON.stringify(parts))))
    },
  }
}

const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= max &&
  value === value.trim() &&
  !/[\p{Cc}]/u.test(value)

/** Throws a static invalid error; never includes a value in a message. */
export function validateManagedBillCredentials(
  credentials: unknown,
): asserts credentials is ManagedBillCredentials {
  const value = credentials as Partial<ManagedBillCredentials> | null
  if (
    !value ||
    typeof value !== 'object' ||
    !bounded(value.companyId, managedBillLimits.companyIdLength) ||
    !bounded(value.username, managedBillLimits.credentialLength) ||
    !bounded(value.password, managedBillLimits.credentialLength) ||
    (value.replyToUserId !== null &&
      !bounded(value.replyToUserId, managedBillLimits.replyToUserIdLength)) ||
    (value.environment !== 'sandbox' && value.environment !== 'production')
  )
    throw new ManagedBillConnectionError('invalid')
}
