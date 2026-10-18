/**
 * Idempotency keys over HTTP (issue 952): the same contract the hosted router
 * keeps (ConflictHQ/ezacto-hosted, `docs/consistency.md`), for the Worker and
 * the container, which run this code directly.
 *
 * A write (POST, PUT, PATCH, DELETE) may carry `Idempotency-Key`. Its first
 * execution is stored with its response, and a retry with the same key gets
 * that response back -- marked `idempotent-replayed: true` -- without anything
 * running again. Keys live 24 hours. Every answer advertises the lifetime in
 * `Idempotency-Key-Lifetime`, which is how a client knows it may retry a write
 * here at all: an instance that does not send it is never sent a blind retry.
 *
 * What a key binds is the request it first carried: method, target, content
 * type and body (a 422 otherwise). Its stored answer is handed back only under
 * the same credentials the first attempt carried; a retry under others -- a
 * client that signed in again -- is told the work was done (409) and reloads.
 * Replay also requires fresh authorization in the same principal scope.
 * A key read out of a log is not enough to read what a write answered. Keys
 * must still be unguessable -- a fresh random UUID per logical write.
 *
 * The database half (`@ezacto/db` `idempotency.ts`) makes every write a keyed
 * request commits carry the key's claim, so a write never commits twice. This
 * half decides what a request with a key is answered:
 *
 * - no row: run it under the claim; if it wrote, record its response. An
 *   attempt that changed nothing is not recorded: its retry simply runs again.
 *   Authentication's own writes (a session's last-seen time, a token's last
 *   use) never claim the key, so "wrote" means the request's own work;
 * - a row with another fingerprint: 422 `idempotency_key_reused`;
 * - a completed row: the stored response, or 409 `idempotent_result_unavailable`
 *   when it was not kept (over 1 MB, or a server error after the write landed:
 *   the work is done, so the honest answer is "reload", not the error again);
 * - a claimed row: the first attempt wrote and has not finished. The duplicate
 *   waits a few seconds for it and is handed its answer; failing that, 503
 *   `idempotent_request_in_progress` with `Retry-After`. Once the claim is
 *   older than its lease the attempt is taken to have stopped mid-way, and the
 *   answer is 409.
 *
 * Where it differs from hosted, because D1 has no transaction that spans a
 * request: the response is recorded straight after the request rather than in
 * the same commit as its writes, and a duplicate that runs alongside the first
 * attempt cannot commit anything -- its writes collide with the claim -- so it
 * waits for the first one's answer instead of rerunning.
 *
 * Nothing stored is readable without the client's key: rows are found by an
 * hash of the key, and responses are sealed (AES-256-GCM) under a key derived
 * from it, so a stored sign-in cookie cannot be read out of the database.
 * WebCrypto throughout: the same code runs on workerd, on Node and under the
 * hosted router.
 */

import { CLOUDFLARE_ACCESS_JWT_HEADER } from './cloudflare-access.js'
import { MAX_ATTACHMENT_BYTES } from './attachments.js'
import { ApiError, readLimitedBody } from './errors.js'
import { PORTAL_SESSION_COOKIE_NAME } from './magic-link-auth.js'
import { SESSION_COOKIE_NAME } from './sessions.js'
import { TWO_FACTOR_CHALLENGE_COOKIE } from './two-factor-challenge.js'

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed'
export const IDEMPOTENCY_KEY_LIFETIME_HEADER = 'idempotency-key-lifetime'
export const IDEMPOTENCY_KEY_LIFETIME_SECONDS = 24 * 60 * 60
/**
 * How long a claimed row is taken to be a request still running. Beyond any
 * request this runtime finishes; after it, the attempt is taken to have stopped
 * between its write and its record.
 */
export const IDEMPOTENCY_LEASE_MS = 60_000
/**
 * How long a duplicate waits for the attempt holding its key -- usually the
 * client's own first attempt, given up on while the server still worked -- to
 * finish, so that it can be handed that answer. Only then is it told to come
 * back. Hosted reaches the same place by rerunning the loser.
 */
export const IDEMPOTENCY_WAIT_MS = 5_000
/** Responses larger than this are recorded as done but not kept. */
export const MAX_STORED_RESPONSE_BYTES = 1024 * 1024
/** The largest supported upload, with the attachment route's multipart allowance. */
export const MAX_IDEMPOTENCY_REQUEST_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/u
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/** The claim a keyed request makes; `@ezacto/db` stores it. */
export interface IdempotencyClaim {
  readonly id: string
  readonly fingerprint: string
  readonly secretVersion: string
  readonly holder: string
  readonly attempt: string
  readonly createdAt: string
  readonly expiresAt: string
}

export interface IdempotencyRecord {
  readonly id: string
  readonly fingerprint: string
  readonly secretVersion: string
  readonly holder: string
  readonly attempt: string
  readonly state: 'claimed' | 'done'
  readonly nonce: string | null
  readonly sealed: string | null
  readonly createdAt: string
  readonly expiresAt: string
}

export interface SealedIdempotentResponse {
  readonly nonce: string
  readonly sealed: string
}

export type IdempotentExecution<T> = {
  readonly wrote: boolean
  readonly lost: boolean
} & ({ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown })

/** Implemented by `createD1IdempotencyStore` and `createContainerIdempotencyStore`. */
export interface IdempotencyStore {
  /** Current durable revision of resource authorization inputs. */
  authorizationRevision(): Promise<string>
  read(id: string): Promise<IdempotencyRecord | null>
  forget(id: string, now: string): Promise<void>
  execute<T>(claim: IdempotencyClaim, work: () => Promise<T>): Promise<IdempotentExecution<T>>
  complete(
    claim: IdempotencyClaim,
    response: SealedIdempotentResponse | null,
    now: string,
  ): Promise<boolean>
}

export interface IdempotencyOptions {
  readonly store: IdempotencyStore
  /**
   * Fresh authorization, without running the command. Return a stable scope
   * for an authorized principal, a refusal Response, or null for a surface
   * whose responses must not be replayed. Called before execution and again
   * before disclosure, including after waiting for a concurrent attempt.
   */
  readonly authorize: (request: Request) => Promise<string | Response | null>
  /** `deriveIdempotencySecret` of the deployment's cursor signing key. */
  readonly secret: Uint8Array
  readonly now?: () => Date
  /**
   * The Worker's `waitUntil`. A client that disconnects mid-write must not cut
   * the record of its write off, or its retry could only be told "done".
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void
  /** Where a failure to record a response is reported. The response still goes out. */
  readonly report?: (error: unknown) => void
  /**
   * How long a duplicate waits for the attempt that holds its key to finish,
   * before it is told to come back. Defaults to `IDEMPOTENCY_WAIT_MS`.
   */
  readonly waitForClaimMs?: number
}

const encoder = new TextEncoder()
const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text)

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0))

const copy = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

/**
 * The deployment's idempotency secret, derived from the cursor signing key
 * every deployment already has (HKDF, its own label), so there is no new secret
 * to provision. Claim lookup is independent of this key: after rotation a
 * retry finds its original claim but receives 409 instead of executing again.
 */
export const deriveIdempotencySecret = async (cursorSigningKey: Uint8Array): Promise<Uint8Array> => {
  const base = await crypto.subtle.importKey('raw', copy(cursorSigningKey), 'HKDF', false, [
    'deriveBits',
  ])
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('ezacto idempotency keys') },
      base,
      256,
    ),
  )
}

const hmacHex = async (secret: Uint8Array, data: Uint8Array): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    copy(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', key, copy(data)))
}

const sealKey = async (secret: Uint8Array, key: string): Promise<CryptoKey> => {
  const base = await crypto.subtle.importKey('raw', copy(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(key), info: utf8('idempotent-response') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

const boundaryOf = (contentType: string): string | null => {
  if (!/^multipart\/form-data\s*;/iu.test(contentType)) return null
  const match = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType)
  return match?.[1] ?? match?.[2] ?? null
}

/** Where `needle` next occurs in `haystack` from `from`, or -1. */
const indexOfBytes = (haystack: Uint8Array, needle: Uint8Array, from: number): number => {
  const last = haystack.byteLength - needle.byteLength
  for (let at = haystack.indexOf(needle[0]!, from); at !== -1 && at <= last; at = haystack.indexOf(needle[0]!, at + 1)) {
    let matched = true
    for (let offset = 1; offset < needle.byteLength; offset += 1) {
      if (haystack[at + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return at
  }
  return -1
}

/** MIME delimiters occur at line starts, with an opening or closing suffix. */
const indexOfDelimiter = (body: Uint8Array, delimiter: Uint8Array, from: number): number => {
  for (let at = indexOfBytes(body, delimiter, from); at !== -1; at = indexOfBytes(body, delimiter, at + 1)) {
    const lineStart = at === 0 || (body[at - 2] === 13 && body[at - 1] === 10)
    const after = at + delimiter.byteLength
    const suffix = (body[after] === 13 && body[after + 1] === 10)
      || (body[after] === 45 && body[after + 1] === 45)
    if (lineStart && suffix) return at
  }
  return -1
}

/**
 * What a body is, as far as its key is concerned: its bytes -- except for a
 * form upload. A multipart body is serialized afresh on every send, under a new
 * random boundary, so the same file sent again never arrives as the same bytes.
 * Everything between the boundaries (each part's headers and content) is the
 * same, so that is what is hashed: segment by segment, as views of the body
 * already read, because an attachment can be 25 MB inside a Worker's 128 MB and
 * parsing or copying it here would double what the upload route already holds.
 */
const bodyIdentity = async (
  contentType: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<{ contentType: string; digest: string }> => {
  const boundary = boundaryOf(contentType)
  if (boundary === null) return { contentType, digest: hex((await digest(body)).buffer) }
  const delimiter = utf8(`--${boundary}`)
  const segments: Uint8Array<ArrayBuffer>[] = []
  for (let start = 0; ; ) {
    const at = indexOfDelimiter(body, delimiter, start)
    segments.push(await digest(body.subarray(start, at === -1 ? body.byteLength : at)))
    if (at === -1) break
    start = at + delimiter.byteLength
  }
  const joined = new Uint8Array(segments.length * 32)
  segments.forEach((segment, index) => joined.set(segment, index * 32))
  return { contentType: 'multipart/form-data', digest: hex((await digest(joined)).buffer) }
}

/** The request as it binds its key: method, path and query, content type, body. */
const fingerprintOf = async (
  secret: Uint8Array,
  request: Request,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> => {
  const url = new URL(request.url)
  const identity = await bodyIdentity(request.headers.get('content-type') ?? '', body)
  return hmacHex(
    secret,
    utf8(
      [
        'request',
        request.method,
        `${url.pathname}${url.search}`,
        identity.contentType,
        identity.digest,
      ].join('\u0000'),
    ),
  )
}

/** The cookies that authenticate a request here. */
const CREDENTIAL_COOKIES = [SESSION_COOKIE_NAME, PORTAL_SESSION_COOKIE_NAME, TWO_FACTOR_CHALLENGE_COOKIE]

const cookieValues = (header: string | null): Map<string, string> => {
  const values = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const name = part.slice(0, separator).trim()
    if (!values.has(name)) values.set(name, part.slice(separator + 1).trim())
  }
  return values
}

/**
 * Who a request speaks for, as far as a replay is concerned: an HMAC of the
 * credentials it carries -- the bearer token, the session cookies, a Cloudflare
 * Access assertion. A stored answer goes back only to a retry carrying the
 * same ones and the same freshly authorized principal scope. A key alone
 * is not enough to read what a write answered.
 */
const holderOf = async (secret: Uint8Array, request: Request, authorization: string | null): Promise<string> => {
  const cookies = cookieValues(request.headers.get('cookie'))
  return hmacHex(
    secret,
    utf8(
      [
        'holder',
        authorization ?? '',
        request.headers.get('authorization') ?? '',
        ...CREDENTIAL_COOKIES.map((name) => `${name}=${cookies.get(name) ?? ''}`),
        request.headers.get(CLOUDFLARE_ACCESS_JWT_HEADER) ?? '',
      ].join('\u0000'),
    ),
  )
}

/**
 * The request the app is handed, rebuilt around the body already read: the
 * original's body has been consumed, and a clone would hold a second copy of an
 * upload while this one is hashed.
 */
const rebuilt = (request: Request, body: Uint8Array<ArrayBuffer>): Request =>
  new Request(request.url, {
    method: request.method,
    headers: request.headers,
    redirect: request.redirect,
    signal: request.signal,
    ...(body.byteLength === 0 ? {} : { body }),
  })

interface BufferedResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: readonly (readonly [string, string])[]
  readonly body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>
}

/** Return the prefix already read, then pull the remaining bytes on demand. */
const remainingBody = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array[],
): ReadableStream<Uint8Array> => new ReadableStream({
  async pull(controller) {
    const chunk = prefix.shift()
    if (chunk !== undefined) {
      controller.enqueue(chunk)
      return
    }
    try {
      const { done, value } = await reader.read()
      if (done) {
        reader.releaseLock()
        controller.close()
      } else controller.enqueue(value)
    } catch (error) {
      reader.releaseLock()
      controller.error(error)
    }
  },
  async cancel(reason) {
    try { await reader.cancel(reason) } finally { reader.releaseLock() }
  },
})

const responseBody = async (response: Response): Promise<BufferedResponse['body']> => {
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let streaming = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
      if (size > MAX_STORED_RESPONSE_BYTES) {
        streaming = true
        return remainingBody(reader, chunks)
      }
    }
  } finally {
    if (!streaming) reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const buffer = async (response: Response): Promise<BufferedResponse> => {
  const headers: [string, string][] = []
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers.push([name, value])
  })
  for (const cookie of response.headers.getSetCookie()) headers.push(['set-cookie', cookie])
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: await responseBody(response),
  }
}

const toResponse = (
  buffered: BufferedResponse,
  extra: readonly (readonly [string, string])[] = [],
): Response => {
  const headers = new Headers()
  for (const [name, value] of buffered.headers) headers.append(name, value)
  for (const [name, value] of extra) headers.set(name, value)
  return new Response(NULL_BODY_STATUSES.has(buffered.status) ? null : buffered.body, {
    status: buffered.status,
    statusText: buffered.statusText,
    headers,
  })
}

interface SerializedResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
}

const seal = async (
  key: CryptoKey,
  id: string,
  response: BufferedResponse,
): Promise<SealedIdempotentResponse | null> => {
  if (!(response.body instanceof Uint8Array)) return null
  const payload: SerializedResponse = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers.map(([name, value]) => [name, value]),
    body: toBase64(response.body),
  }
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: utf8(id) },
    key,
    utf8(JSON.stringify(payload)),
  )
  return { nonce: toBase64(nonce), sealed: toBase64(new Uint8Array(sealed)) }
}

const open = async (key: CryptoKey, id: string, stored: SealedIdempotentResponse): Promise<BufferedResponse> => {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(stored.nonce), additionalData: utf8(id) },
    key,
    fromBase64(stored.sealed),
  )
  const payload = JSON.parse(new TextDecoder().decode(plain)) as SerializedResponse
  return {
    status: payload.status,
    statusText: payload.statusText,
    headers: payload.headers,
    body: fromBase64(payload.body),
  }
}

const lifetime = (): readonly [string, string] => [
  IDEMPOTENCY_KEY_LIFETIME_HEADER,
  String(IDEMPOTENCY_KEY_LIFETIME_SECONDS),
]

/** Says on any answer that this deployment honours keys. */
const advertised = (response: Response): Response => {
  // A WebSocket upgrade cannot be copied without losing its socket.
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set(...lifetime())
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

interface Refusal {
  readonly status: 400 | 409 | 413 | 422 | 503
  readonly code: string
  readonly message: string
  readonly field?: { readonly code: string; readonly message: string }
  readonly retryAfter?: number
}

const refuse = (refusal: Refusal): Response => {
  const requestId = crypto.randomUUID()
  const headers = new Headers({
    'cache-control': 'no-store',
    'x-request-id': requestId,
  })
  headers.set(...lifetime())
  if (refusal.retryAfter !== undefined) headers.set('retry-after', String(refusal.retryAfter))
  return Response.json(
    {
      error: {
        code: refusal.code,
        message: refusal.message,
        fields:
          refusal.field === undefined
            ? []
            : [{ field: 'Idempotency-Key', code: refusal.field.code, message: refusal.field.message }],
      },
      request_id: requestId,
    },
    { status: refusal.status, headers },
  )
}

const refusals = {
  invalid: (): Refusal => ({
    status: 400,
    code: 'invalid_idempotency_key',
    message: 'The Idempotency-Key header must be 1 to 255 visible ASCII characters.',
    field: { code: 'invalid', message: 'Idempotency-Key must be 1 to 255 visible ASCII characters.' },
  }),
  reused: (): Refusal => ({
    status: 422,
    code: 'idempotency_key_reused',
    message:
      'This Idempotency-Key was already used for a different request (method, path or body differ).',
    field: { code: 'reused', message: 'Idempotency-Key was already used for a different request.' },
  }),
  unavailable: (): Refusal => ({
    status: 409,
    code: 'idempotent_result_unavailable',
    message:
      'The request with this Idempotency-Key was already carried out; its response was not kept. Reload to see the result.',
  }),
  inProgress: (): Refusal => ({
    status: 503,
    code: 'idempotent_request_in_progress',
    message:
      'The request with this Idempotency-Key is still being carried out. Retry after Retry-After with the same key.',
    retryAfter: 1,
  }),
}

interface KeyContext {
  readonly id: string
  readonly fingerprint: string
  readonly secretVersion: string
  readonly holder: string
  readonly sealKey: CryptoKey
  readonly authorization: string | null
  readonly request: Request
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Answers a key that already has a row. A row still claimed is waited on --
 * briefly, re-read with a growing pause -- so that a duplicate of a request
 * still running gets that request's answer rather than a "come back". A claim
 * older than the lease is an attempt that stopped between its write and its
 * record: the work is done, and it is never run again.
 */
const answerStored = async (
  first: IdempotencyRecord | null,
  key: KeyContext,
  options: IdempotencyOptions,
  report: (error: unknown) => void,
): Promise<Response> => {
  const deadline = Date.now() + (options.waitForClaimMs ?? IDEMPOTENCY_WAIT_MS)
  let pause = 25
  let stored = first
  for (;;) {
    // Gone between the two reads (expired and purged): nothing to hand over.
    if (stored === null) return refuse(refusals.inProgress())
    if (stored.secretVersion !== key.secretVersion) return refuse(refusals.unavailable())
    if (stored.fingerprint !== key.fingerprint) return refuse(refusals.reused())
    if (stored.state === 'done') break
    const now = options.now?.() ?? new Date()
    if (now.getTime() - Date.parse(stored.createdAt) >= IDEMPOTENCY_LEASE_MS) {
      return refuse(refusals.unavailable())
    }
    if (Date.now() + pause > deadline) return refuse(refusals.inProgress())
    await sleep(pause)
    pause = Math.min(pause * 2, 250)
    stored = await options.store.read(key.id)
  }
  // The same request under other credentials: the work is done, and its
  // answer is not theirs to read.
  if (stored.holder !== key.holder) return refuse(refusals.unavailable())
  if (stored.nonce === null || stored.sealed === null) return refuse(refusals.unavailable())
  const authorization = await options.authorize(key.request)
  if (authorization instanceof Response) return advertised(authorization)
  if (authorization === null || authorization !== key.authorization) return refuse(refusals.unavailable())
  try {
    const response = await open(key.sealKey, key.id, { nonce: stored.nonce, sealed: stored.sealed })
    return toResponse(response, [[IDEMPOTENT_REPLAYED_HEADER, 'true'], lifetime()])
  } catch (error) {
    // A row this key found but cannot open has been tampered with or corrupted.
    // The work it records was done; running it again is the one wrong answer.
    report(error)
    return refuse(refusals.unavailable())
  }
}

/**
 * The key's row id, the request's fingerprint and the seal, from one read of
 * the body. The body is not kept: only the rebuilt request holds it.
 */
const prepare = async (
  request: Request,
  key: string,
  secret: Uint8Array,
  authorization: string | null,
): Promise<{ context: KeyContext; forApp: Request }> => {
  const body = await readLimitedBody(request.body, MAX_IDEMPOTENCY_REQUEST_BYTES)
  const [id, fingerprint, holder, sealing, secretVersion] = await Promise.all([
    digest(utf8(`ezacto-idempotency-id\u0000${key}`)).then((bytes) => hex(bytes.buffer)),
    fingerprintOf(secret, request, body),
    holderOf(secret, request, authorization),
    sealKey(secret, key),
    hmacHex(secret, utf8('ezacto-idempotency-secret-version')),
  ])
  return { context: { id, fingerprint, holder, secretVersion, sealKey: sealing, authorization, request }, forApp: rebuilt(request, body) }
}

/**
 * Serves one request with idempotency-key semantics. Requests without a key,
 * and every read, run as they are; the answer is advertised either way.
 */
export const withIdempotency = async (
  request: Request,
  run: (request: Request) => Promise<Response>,
  options: IdempotencyOptions,
): Promise<Response> => {
  const key = WRITE_METHODS.has(request.method) ? request.headers.get(IDEMPOTENCY_KEY_HEADER) : null
  if (key === null) return advertised(await run(request))
  if (!KEY_PATTERN.test(key)) return refuse(refusals.invalid())

  const authorization = await options.authorize(request)
  if (authorization instanceof Response) return advertised(authorization)

  const report = options.report ?? ((): void => undefined)
  let prepared: Awaited<ReturnType<typeof prepare>>
  try {
    prepared = await prepare(request, key, options.secret, authorization)
  } catch (error) {
    if (error instanceof ApiError && error.status === 413) {
      return refuse({ status: 413, code: error.code, message: error.message })
    }
    throw error
  }
  const { context, forApp } = prepared
  const { id, fingerprint, holder, secretVersion } = context
  const now = options.now?.() ?? new Date()
  const nowIso = now.toISOString()

  let stored = await options.store.read(id)
  if (stored !== null && stored.expiresAt <= nowIso) {
    await options.store.forget(id, nowIso)
    stored = null
  }
  if (stored !== null) return answerStored(stored, context, options, report)

  const claim: IdempotencyClaim = {
    id,
    fingerprint,
    secretVersion,
    holder,
    attempt: crypto.randomUUID(),
    createdAt: nowIso,
    expiresAt: new Date(now.getTime() + IDEMPOTENCY_KEY_LIFETIME_SECONDS * 1000).toISOString(),
  }

  const afterLoss = async (): Promise<Response> =>
    answerStored(await options.store.read(id), context, options, report)

  const served = (async (): Promise<Response> => {
    const execution = await options.store.execute(claim, async () => buffer(await run(forApp)))
    // Another attempt holds the key: whatever this one answered, it wrote nothing.
    if (execution.lost) return afterLoss()
    if (!execution.ok) throw execution.error
    const response = execution.value
    const finishedAt = (options.now?.() ?? new Date()).toISOString()
    if (!execution.wrote) {
      // Nothing changed, so nothing is kept: a retry runs again, and is
      // answered for the state and the credentials it arrives with -- a client
      // refused with a 401 or 403 that signs in again is not handed the old
      // refusal.
      // Unless another attempt claimed the key meanwhile: then its answer is
      // this one's as well.
      const other = await options.store.read(id)
      return other === null ? toResponse(response, [lifetime()]) : answerStored(other, context, options, report)
    }
    try {
      // A server error after the write landed is not replayed: the work is
      // done, and "reload" is the true answer to a retry, not the error.
      const kept = response.status >= 500 || authorization === null ? null : await seal(context.sealKey, id, response)
      await options.store.complete(claim, kept, finishedAt)
    } catch (error) {
      // The work is done and this is its answer. Failing to keep it costs a
      // later retry its replay -- the row stays claimed, so that retry is told
      // the work was done -- but never this caller its response.
      report(error)
    }
    return toResponse(response, [lifetime()])
  })()
  options.waitUntil?.(served.catch(() => undefined))
  return served
}
