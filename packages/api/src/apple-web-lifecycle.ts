import { jwtVerify } from 'jose'
import type { AppleWebConnection, AppleWebCustodyStore, AppleWebCleanupPort } from '@ezacto/core'
import type { AppleWebLifecyclePort, AppleWebProviderConfig } from './apple-web.js'
import { APPLE_LIFECYCLE_ISSUER, AppleProofUnavailable, createAppleLifecycleKeySet } from './apple-lifecycle-proof.js'
import { readLimitedBody } from './errors.js'

export const APPLE_WEB_CONNECTION_COOKIE = '__Host-ezacto_apple_connection'
export interface AppleWebCustodyConfig extends AppleWebProviderConfig {
  site: 'team' | 'demo'
  encryptionKeys: Readonly<Record<string, string>>
  activeKeyId: string
  routingSecret: string
}
class LifecycleOperationError extends Error {
  constructor(readonly retryable: boolean) { super('Apple lifecycle operation unavailable') }
}
const encoder = new TextEncoder()
const token = (): string => encode(crypto.getRandomValues(new Uint8Array(32)))
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const decode = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))
const hash = async (value: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))).map(byte => byte.toString(16).padStart(2, '0')).join('')
const cookie = (value: string, maxAge = 90 * 86400): string => `${APPLE_WEB_CONNECTION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
const browserHandle = (request: Request): string | null => {
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(APPLE_WEB_CONNECTION_COOKIE + '='))
  if (values.length !== 1) return null
  const value = values[0]!.slice(APPLE_WEB_CONNECTION_COOKIE.length + 1)
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function assertAppleWebCustodyConfig(config: AppleWebCustodyConfig): void {
  const expected = config.site === 'team' ? ['com.ezacto.web', 'https://app.example.com'] : ['com.ezacto.web.demo', 'https://ezacto.io']
  if (!['team', 'demo'].includes(config.site) || config.servicesId !== expected[0] || config.redirectOrigin !== expected[1]) throw new TypeError('Apple web deployment is not approved')
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.routingSecret) || decode(config.routingSecret).length !== 32 || encode(decode(config.routingSecret)) !== config.routingSecret ||
    Object.keys(config.encryptionKeys).length < 1 || Object.keys(config.encryptionKeys).length > 8 ||
    config.encryptionKeys[config.activeKeyId] === undefined) throw new TypeError('Apple web custody keys are invalid')
  for (const [id, value] of Object.entries(config.encryptionKeys)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(value) || decode(value).length !== 32 || encode(decode(value)) !== value) throw new TypeError('Apple web custody key is invalid')
  }
}

export function createAppleWebLifecycle(options: {
  config: AppleWebCustodyConfig
  store: AppleWebCustodyStore
  fetch?: typeof fetch
  now?: () => Date
  signInAllowed?: boolean
}): AppleWebLifecyclePort & AppleWebCleanupPort {
  const { config, store } = options
  assertAppleWebCustodyConfig(config)
  const retrieve = options.fetch ?? fetch
  const now = options.now ?? (() => new Date())
  const keys = createAppleLifecycleKeySet({ fetch: retrieve })
  const context = (connection: Pick<AppleWebConnection, 'subjectDigest' | 'grantId' | 'generation'>): Uint8Array<ArrayBuffer> => encoder.encode(JSON.stringify([
    APPLE_LIFECYCLE_ISSUER, config.redirectOrigin, config.servicesId, connection.subjectDigest, connection.grantId, connection.generation,
  ]))
  const seal = async (value: unknown, associated: Uint8Array<ArrayBuffer>): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await crypto.subtle.importKey('raw', decode(config.encryptionKeys[config.activeKeyId]!), 'AES-GCM', false, ['encrypt'])
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associated }, key, encoder.encode(JSON.stringify(value)))
    return JSON.stringify({ version: 1, kid: config.activeKeyId, iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) })
  }
  const unseal = async (connection: AppleWebConnection): Promise<{ capability: string; subject: string }> => {
    if (connection.serviceIssuer !== APPLE_LIFECYCLE_ISSUER || connection.instanceOrigin !== config.redirectOrigin || connection.clientId !== config.servicesId || connection.sealedCapability === null) throw new Error('Apple web custody unavailable')
    const envelope: unknown = JSON.parse(connection.sealedCapability)
    if (!record(envelope) || envelope.version !== 1 || typeof envelope.kid !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string') throw new Error('Apple web custody unavailable')
    const material = config.encryptionKeys[envelope.kid]
    if (material === undefined) throw new Error('Apple web custody key unavailable')
    const key = await crypto.subtle.importKey('raw', decode(material), 'AES-GCM', false, ['decrypt'])
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv), additionalData: context(connection) }, key, decode(envelope.ciphertext))
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!record(value) || typeof value.capability !== 'string' || typeof value.subject !== 'string') throw new Error('Apple web custody unavailable')
    return { capability: value.capability, subject: value.subject }
  }
  const post = async (path: string, body: unknown, capability?: string): Promise<Record<string, unknown>> => {
    const response = await retrieve(APPLE_LIFECYCLE_ISSUER + path, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(capability === undefined ? {} : { authorization: 'Bearer ' + capability }) }, body: JSON.stringify(body),
    }).catch(() => { throw new LifecycleOperationError(true) })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new LifecycleOperationError(response.status >= 500 || response.status === 429)
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readLimitedBody(response.body, 32768)))
    if (!record(value)) throw new LifecycleOperationError(false)
    return value
  }
  const verify = async (receipt: unknown, type: 'apple_grant' | 'apple_revocation') => {
    if (typeof receipt !== 'string' || receipt.length > 16384) throw new Error('Invalid Apple web proof')
    const { payload, protectedHeader } = await jwtVerify(receipt, keys, {
      issuer: APPLE_LIFECYCLE_ISSUER, audience: config.redirectOrigin, algorithms: ['ES256'],
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'], currentDate: now(),
    })
    if (protectedHeader.typ !== 'JWT' || typeof protectedHeader.kid !== 'string' || payload.aud !== config.redirectOrigin ||
      payload.type !== type || payload.channel !== 'web' || payload.client_id !== config.servicesId ||
      typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || !identifier(payload.grant_id) || !identifier(payload.jti) ||
      !positive(payload.generation) || !positive(payload.iat) || !positive(payload.exp) || payload.iat > now().valueOf() / 1000 ||
      payload.exp <= payload.iat || payload.exp - payload.iat > (type === 'apple_grant' ? 300 : 7 * 86400)) throw new Error('Invalid Apple web proof')
    return { payload, receipt, subject: payload.sub, grantId: payload.grant_id, generation: payload.generation }
  }
  const browser = async (request: Request) => {
    const handle = browserHandle(request)
    return handle === null ? null : store.browser(await hash(handle))
  }
  const revoke = async (connection: AppleWebConnection, requestId: string): Promise<void> => {
    if (!await store.pending(connection.id, requestId, now().toISOString())) throw new Error('Apple cleanup request mismatch')
    const custody = await unseal(connection)
    const result = await post('/v1/apple/revocations', { deletionRequestId: requestId }, custody.capability)
    const proof = await verify(result.receipt, 'apple_revocation')
    if (result.status !== 'revoked' || proof.payload.status !== 'revoked' || proof.subject !== custody.subject ||
      proof.grantId !== connection.grantId || proof.generation !== connection.generation || proof.payload.request_id !== requestId ||
      !positive(proof.payload.revoked_at) || proof.payload.revoked_at > proof.payload.iat!) throw new Error('Apple revocation proof mismatch')
    const accepted = await store.complete({ id: connection.id, requestId, grantId: proof.grantId, generation: proof.generation,
      sealedReceipt: await seal({ receipt: proof.receipt }, context(connection)), now: now().toISOString() })
    if (!accepted) throw new Error('Apple revocation custody changed')
    // Local proof is durable before ACK. A lost ACK leaves only the service's
    // documented bounded delivery context; it cannot revoke a later grant.
    await post('/v1/apple/revocations/ack', { deletionRequestId: requestId, disposition: await store.requestExists(requestId) ? 'delivered' : 'user_discarded' }, custody.capability).catch(() => undefined)
  }
  return {
    async challenge(input) {
      if (input.purpose === 'sign-in' && options.signInAllowed === false) throw new Error('Apple web sign-in is disabled')
      if (input.servicesId !== config.servicesId || input.instanceOrigin !== config.redirectOrigin || input.redirectUri !== config.redirectOrigin + '/auth/apple/callback' || input.demo !== (config.site === 'demo')) throw new Error('Apple web configuration mismatch')
      const value = await post('/v1/apple/web/challenges', { site: config.site, purpose: input.purpose === 'disconnect' ? 'cleanup' : 'sign-in',
        ...(input.purpose === 'disconnect' ? { deletionRequestId: input.requestId ?? token() } : {}) })
      if (!identifier(value.challengeId) || typeof value.nonce !== 'string' || typeof value.expiresAt !== 'string' || value.clientId !== config.servicesId || value.redirectUri !== input.redirectUri) throw new Error('Invalid Apple web challenge')
      return { challengeId: value.challengeId, nonce: value.nonce, expiresAt: value.expiresAt }
    },
    async exchange(input) {
      if (input.purpose === 'sign-in' && options.signInAllowed === false) throw new Error('Apple web sign-in is disabled')
      if (input.servicesId !== config.servicesId || input.instanceOrigin !== config.redirectOrigin || input.redirectUri !== config.redirectOrigin + '/auth/apple/callback' || input.demo !== (config.site === 'demo')) throw new Error('Apple web configuration mismatch')
      const value = await post('/v1/apple/web/grants', { challengeId: input.challengeId, authorizationCode: input.authorizationCode, identityToken: input.identityToken })
      const proof = await verify(value.bindingReceipt, 'apple_grant')
      if (proof.payload.nonce !== input.nonce || proof.payload.challenge_id !== input.challengeId ||
        proof.payload.purpose !== (input.purpose === 'disconnect' ? 'cleanup' : 'sign-in') ||
        (input.purpose === 'disconnect' ? !identifier(proof.payload.request_id) : proof.payload.request_id !== undefined) ||
        value.grantId !== proof.grantId || value.generation !== proof.generation || value.instanceOrigin !== config.redirectOrigin ||
        typeof value.capability !== 'string' || !/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/.test(value.capability) ||
        value.capability.split('.')[1] !== proof.grantId) throw new Error('Apple web binding proof mismatch')
      const capability = value.capability
      const bind = async (userId: number | null) => {
        const routingKey = await crypto.subtle.importKey('raw', decode(config.routingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
        const subjectDigest = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', routingKey, encoder.encode(proof.subject)))).map(byte => byte.toString(16).padStart(2, '0')).join('')
        const handle = token()
        const metadata = { subjectDigest, grantId: proof.grantId, generation: proof.generation }
        const timestamp = now().toISOString()
        const saved = await store.save({ ...metadata, id: token(), browserHash: await hash(handle), userId,
          serviceIssuer: APPLE_LIFECYCLE_ISSUER, instanceOrigin: config.redirectOrigin, clientId: config.servicesId,
          sealedCapability: await seal({ capability, subject: proof.subject }, context(metadata)),
          sealedReceipt: null, cleanupRequestId: typeof proof.payload.request_id === 'string' ? proof.payload.request_id : null,
          status: 'active', createdAt: timestamp, updatedAt: timestamp })
        if (saved === null) throw new Error('Apple web custody needs request-bound recovery')
        return { setCookie: cookie(handle) }
      }
      return { subject: proof.subject,
        bindUser: async userId => {
          if (config.site !== 'team' || input.purpose !== 'sign-in' || !Number.isSafeInteger(userId) || userId < 1) throw new Error('Invalid Apple team custody')
          return bind(userId)
        },
        bindBrowser: () => bind(null),
      }
    },
    async connected(request) { return await browser(request) !== null },
    async disconnect(request) {
      const connection = await browser(request)
      if (connection === null) throw new Error('Apple browser recovery required')
      await revoke(connection, connection.cleanupRequestId ?? token())
      return { setCookie: cookie('', 0) }
    },
    async begin(userId, requestId) {
      await store.begin(userId, requestId, now().toISOString())
    },
    async perform(requestId) {
      for (const connection of await store.obligations(requestId)) {
        try { await revoke(connection, requestId) } catch (error) {
          if (!(error instanceof AppleProofUnavailable) && !(error instanceof LifecycleOperationError && error.retryable)) await store.manual(connection.id, now().toISOString())
        }
      }
    },
    status: requestId => store.status(requestId),
  }
}
