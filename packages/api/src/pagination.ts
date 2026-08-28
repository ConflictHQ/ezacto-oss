import { validationError } from './errors.js'
import { serializeMany, type Serializer } from './serializer.js'

const defaultPageSize = 50
const maximumPageSize = 200
const cursorVersion = 1
const cursorPartPattern = /^[A-Za-z0-9_-]+$/
const minimumSigningKeyBytes = 32

interface CursorPayload {
  v: typeof cursorVersion
  a: number
  t: number
  s: number
}

export interface CursorWindow {
  /** Last id returned by the previous page; null on the first page. */
  afterId: number | null
  /** High-water id captured before the first page, excluding later inserts. */
  throughId: number
  /** Fetch exactly this many rows so the chassis can detect a next page. */
  take: number
}

export interface CursorSource<Row extends { id: number }> {
  /** Maximum visible id at the start of a traversal, or null for an empty collection. */
  highWatermark(): Promise<number | null>
  /** Return rows in strictly increasing id order inside the supplied window. */
  list(window: CursorWindow): Promise<readonly Row[]>
}

export interface CursorPageEnvelope<Output> {
  data: Output[]
  links: {
    self: string
    next: string | null
  }
  page: {
    per_page: number
    next_cursor: string | null
  }
}

interface CursorPageOptions<Row extends { id: number }, Output, Viewer> {
  requestUrl: URL
  source: CursorSource<Row>
  viewer: Readonly<Viewer>
  serializer: Serializer<Row, Output, Viewer>
  /** Server-owned HMAC key. At least 32 bytes and stable across a traversal. */
  cursorSigningKey: Uint8Array
}

export const cursorPage = async <Row extends { id: number }, Output, Viewer>({
  requestUrl,
  source,
  viewer,
  serializer,
  cursorSigningKey,
}: CursorPageOptions<Row, Output, Viewer>): Promise<CursorPageEnvelope<Output>> => {
  assertSigningKey(cursorSigningKey)
  const perPageValues = requestUrl.searchParams.getAll('per_page')
  const cursorValues = requestUrl.searchParams.getAll('cursor')
  if (perPageValues.length > 1) throw invalidField('per_page', 'duplicate', 'per_page may appear once')
  if (cursorValues.length > 1) throw invalidField('cursor', 'duplicate', 'cursor may appear once')

  const requestedPageSize = parsePageSize(perPageValues[0])
  const scope = cursorScope(requestUrl)
  const cursor =
    cursorValues[0] === undefined
      ? null
      : await decodeCursor(cursorValues[0], cursorSigningKey, scope)
  if (cursor !== null && requestedPageSize !== null && requestedPageSize !== cursor.s) {
    throw invalidField(
      'per_page',
      'cursor_mismatch',
      'per_page must match the page size encoded by cursor',
    )
  }
  const pageSize = cursor?.s ?? requestedPageSize ?? defaultPageSize
  const afterId = cursor?.a ?? null
  const throughId = cursor?.t ?? (await source.highWatermark())
  const self = relativeLink(requestUrl)

  if (throughId === null) {
    return emptyPage(self, pageSize)
  }
  assertSafeInteger(throughId, 'source high-water id')
  if (afterId !== null && afterId >= throughId) {
    throw invalidField('cursor', 'invalid', 'cursor does not name a remaining id window')
  }

  const rows = await source.list({ afterId, throughId, take: pageSize + 1 })
  validateRows(rows, afterId, throughId, pageSize + 1)
  const visible = rows.slice(0, pageSize)
  const hasNext = rows.length > pageSize
  const nextCursor = hasNext
    ? await encodeCursor({
        v: cursorVersion,
        a: visible.at(-1)!.id,
        t: throughId,
        s: pageSize,
      }, cursorSigningKey, scope)
    : null

  return {
    data: serializeMany(visible, viewer, serializer),
    links: {
      self,
      next: nextCursor === null ? null : nextLink(requestUrl, nextCursor, pageSize),
    },
    page: { per_page: pageSize, next_cursor: nextCursor },
  }
}

const parsePageSize = (raw: string | undefined): number | null => {
  if (raw === undefined) return null
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw invalidField('per_page', 'invalid_integer', 'per_page must be a positive integer')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value > maximumPageSize) {
    throw invalidField(
      'per_page',
      'out_of_range',
      `per_page must be between 1 and ${maximumPageSize}`,
    )
  }
  return value
}

const invalidField = (field: string, code: string, message: string) =>
  validationError([{ field, code, message }])

const encodeCursor = async (
  payload: CursorPayload,
  signingKey: Uint8Array,
  scope: string,
): Promise<string> => {
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await sign(encodedPayload, signingKey, scope)
  return `${encodedPayload}.${encodeBase64Url(signature)}`
}

const decodeCursor = async (
  raw: string,
  signingKey: Uint8Array,
  scope: string,
): Promise<CursorPayload> => {
  try {
    if (raw.length === 0 || raw.length > 512) throw new Error()
    const parts = raw.split('.')
    if (parts.length !== 2) throw new Error()
    const encodedPayload = parts[0]!
    const encodedSignature = parts[1]!
    if (!cursorPartPattern.test(encodedPayload) || !cursorPartPattern.test(encodedSignature)) {
      throw new Error()
    }
    const signature = decodeBase64Url(encodedSignature)
    if (!(await verify(encodedPayload, signature, signingKey, scope))) throw new Error()
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(encodedPayload)),
    ) as Partial<CursorPayload>
    if (
      parsed.v !== cursorVersion ||
      !Number.isSafeInteger(parsed.a) ||
      !Number.isSafeInteger(parsed.t) ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.a! < 1 ||
      parsed.t! < 1 ||
      parsed.s! < 1 ||
      parsed.s! > maximumPageSize ||
      parsed.a! >= parsed.t!
    ) {
      throw new Error()
    }
    const payload: CursorPayload = { v: cursorVersion, a: parsed.a!, t: parsed.t!, s: parsed.s! }
    const canonicalPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
    if (canonicalPayload !== encodedPayload) throw new Error()
    return payload
  } catch {
    throw invalidField('cursor', 'invalid', 'cursor is malformed or unsupported')
  }
}

const assertSigningKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.byteLength < minimumSigningKeyBytes) {
    throw new TypeError(`cursor signing key must contain at least ${minimumSigningKeyBytes} bytes`)
  }
}

const cursorScope = (requestUrl: URL): string => {
  const scoped = new URL(requestUrl)
  scoped.searchParams.delete('cursor')
  scoped.searchParams.delete('per_page')
  scoped.searchParams.sort()
  return `${scoped.pathname}${scoped.search}`
}

const importSigningKey = (key: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', copyBuffer(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])

const signedMessage = (encodedPayload: string, scope: string): ArrayBuffer =>
  copyBuffer(new TextEncoder().encode(`${scope}\n${encodedPayload}`))

const sign = async (
  encodedPayload: string,
  keyBytes: Uint8Array,
  scope: string,
): Promise<Uint8Array> => {
  const key = await importSigningKey(keyBytes)
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, signedMessage(encodedPayload, scope)))
}

const verify = async (
  encodedPayload: string,
  signature: Uint8Array,
  keyBytes: Uint8Array,
  scope: string,
): Promise<boolean> => {
  const key = await importSigningKey(keyBytes)
  return crypto.subtle.verify(
    'HMAC',
    key,
    copyBuffer(signature),
    signedMessage(encodedPayload, scope),
  )
}

const copyBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

const decodeBase64Url = (encoded: string): Uint8Array => {
  if (encoded.length === 0 || !cursorPartPattern.test(encoded)) throw new Error()
  const padded = encoded
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== encoded) throw new Error()
  return bytes
}

const validateRows = <Row extends { id: number }>(
  rows: readonly Row[],
  afterId: number | null,
  throughId: number,
  maximumRows: number,
): void => {
  if (rows.length > maximumRows) throw new Error('cursor source returned more rows than requested')
  let previous = afterId
  for (const row of rows) {
    assertSafeInteger(row.id, 'source row id')
    if ((previous !== null && row.id <= previous) || row.id > throughId) {
      throw new Error('cursor source returned rows outside the requested stable window')
    }
    previous = row.id
  }
}

const assertSafeInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

const relativeLink = (url: URL): string => `${url.pathname}${url.search}`

const nextLink = (requestUrl: URL, cursor: string, pageSize: number): string => {
  const next = new URL(requestUrl)
  next.searchParams.set('per_page', String(pageSize))
  next.searchParams.set('cursor', cursor)
  return relativeLink(next)
}

const emptyPage = <Output>(self: string, pageSize: number): CursorPageEnvelope<Output> => ({
  data: [],
  links: { self, next: null },
  page: { per_page: pageSize, next_cursor: null },
})
