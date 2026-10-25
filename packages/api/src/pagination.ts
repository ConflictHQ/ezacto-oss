import { validationError } from './errors.js'
import { serializeMany, type Serializer } from './serializer.js'

const defaultPageSize = 50
const maximumPageSize = 200
const cursorVersion = 1
const keysetCursorVersion = 2
const maximumCursorLength = 512
// A keyset cursor carries the last row's sort key, which for the invoice list
// includes its number: 255 characters as the API writes one, more where an
// import carried more, in any script. Sized for a 1,024-character number made
// entirely of characters JSON escapes to six bytes, then base64'd.
const maximumKeysetCursorLength = 12_288
const cursorPartPattern = /^[A-Za-z0-9_-]+$/
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const minimumSigningKeyBytes = 32

interface CursorPayload {
  v: typeof cursorVersion
  a: number
  t: number
  s: number
}

interface KeysetCursorPayload {
  v: typeof keysetCursorVersion
  /** The last row's position, as the order encodes it. */
  p: unknown
  /** The snapshot instant the traversal is bounded by. */
  t: string
  s: number
}

interface ProjectionCursorPayload {
  v: 3;
  a: number;
  s: number;
}

/** A live, revisioned projection pages by id without claiming a frozen row snapshot. */
export const projectionPage = async <
  Projection extends { nextCursor: number | null },
>({
  requestUrl,
  cursorSigningKey,
  maximumSize,
  read,
}: {
  requestUrl: URL;
  cursorSigningKey: Uint8Array;
  maximumSize: number;
  read(afterId: number | undefined, size: number): Promise<Projection>;
}) => {
  assertSigningKey(cursorSigningKey);
  const sizes = requestUrl.searchParams.getAll("per_page");
  const cursors = requestUrl.searchParams.getAll("cursor");
  if (sizes.length > 1 || cursors.length > 1)
    throw invalidField(
      "cursor",
      "duplicate",
      "pagination parameters may appear once",
    );
  const requested = parsePageSize(sizes[0]);
  const scope = cursorScope(requestUrl);
  let cursor: ProjectionCursorPayload | null = null;
  if (cursors[0] !== undefined) {
    try {
      const signed = await readSignedPayload(
        cursors[0],
        cursorSigningKey,
        scope,
        maximumCursorLength,
      );
      const parsed = signed.parsed as Partial<ProjectionCursorPayload> | null;
      if (
        !parsed ||
        parsed.v !== 3 ||
        !Number.isSafeInteger(parsed.a) ||
        parsed.a! < 1 ||
        !Number.isSafeInteger(parsed.s) ||
        parsed.s! < 1 ||
        parsed.s! > maximumSize
      )
        throw new Error();
      cursor = { v: 3, a: parsed.a!, s: parsed.s! };
      if (
        encodeBase64Url(new TextEncoder().encode(JSON.stringify(cursor))) !==
        signed.encodedPayload
      )
        throw new Error();
    } catch {
      throw invalidField(
        "cursor",
        "invalid",
        "cursor is malformed or unsupported",
      );
    }
  }
  if (cursor && requested !== null && requested !== cursor.s)
    throw invalidField(
      "per_page",
      "cursor_mismatch",
      "per_page must match the cursor",
    );
  const size = cursor?.s ?? requested ?? defaultPageSize;
  if (size > maximumSize)
    throw invalidField(
      "per_page",
      "invalid_integer",
      `per_page must be at most ${maximumSize}`,
    );
  const { nextCursor: nextId, ...data } = await read(cursor?.a, size);
  if (
    nextId !== null &&
    (!Number.isSafeInteger(nextId) || nextId <= (cursor?.a ?? 0))
  )
    throw new Error("projection returned an invalid next position");
  const nextCursor =
    nextId === null
      ? null
      : await encodeCursor(
          { v: 3, a: nextId, s: size },
          cursorSigningKey,
          scope,
        );
  return {
    data,
    links: {
      self: relativeLink(requestUrl),
      next: nextCursor === null ? null : nextLink(requestUrl, nextCursor, size),
    },
    page: { per_page: size, next_cursor: nextCursor },
  };
};

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

/**
 * The keyset chassis: the same signed, scope-bound, take+1 cursor as
 * `cursorPage`, for a collection read in an order other than its ids.
 *
 * An id cursor can say "after id 40, up to id 90" because ids are both the
 * order and the insertion sequence. Where the order is something else -- the
 * invoice list, newest first -- the cursor carries the last row's position in
 * that order instead, and the traversal is bounded by creation time rather
 * than by a high-water id: rows created after the first page are left out, so
 * nothing added while somebody pages extends or shifts what they read.
 */
export interface KeysetWindow<Position> {
  /** Position of the last row of the previous page; null on the first page. */
  after: Position | null
  /** Latest creation instant at the start of the traversal; later rows are excluded. */
  createdThrough: string
  /** Fetch exactly this many rows so the chassis can detect a next page. */
  take: number
}

export interface KeysetSource<Row extends { id: number | string; created_at: string }, Position> {
  /**
   * Latest creation instant at the start of a traversal, as a UTC timestamp
   * with milliseconds, or null for an empty collection.
   */
  snapshot(): Promise<string | null>
  /** Rows strictly after `after` in the order, created no later than `createdThrough`. */
  list(window: KeysetWindow<Position>): Promise<readonly Row[]>
}

export interface KeysetOrder<Row, Position> {
  /** Where a row sits. The next page resumes strictly after the last one. */
  positionOf(row: Readonly<Row>): Position
  /** Negative when `left` is listed first. Zero only for the same row. */
  compare(left: Position, right: Position): number
  /** The position as a cursor carries it: plain JSON. */
  encode(position: Position): unknown
  /** A position read back from a cursor, or null where it is not one. */
  decode(value: unknown): Position | null
}

interface KeysetCursorPageOptions<
  Row extends { id: number | string; created_at: string },
  Position,
  Output,
  Viewer,
> {
  requestUrl: URL
  source: KeysetSource<Row, Position>
  order: KeysetOrder<Row, Position>
  viewer: Readonly<Viewer>
  serializer: Serializer<Row, Output, Viewer>
  /** Server-owned HMAC key. At least 32 bytes and stable across a traversal. */
  cursorSigningKey: Uint8Array
}

export const keysetCursorPage = async <
  Row extends { id: number | string; created_at: string },
  Position,
  Output,
  Viewer,
>({
  requestUrl,
  source,
  order,
  viewer,
  serializer,
  cursorSigningKey,
}: KeysetCursorPageOptions<Row, Position, Output, Viewer>): Promise<
  CursorPageEnvelope<Output>
> => {
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
      : await decodeKeysetCursor(cursorValues[0], cursorSigningKey, scope, order)
  if (cursor !== null && requestedPageSize !== null && requestedPageSize !== cursor.size) {
    throw invalidField(
      'per_page',
      'cursor_mismatch',
      'per_page must match the page size encoded by cursor',
    )
  }
  const pageSize = cursor?.size ?? requestedPageSize ?? defaultPageSize
  const after = cursor?.after ?? null
  const createdThrough = cursor?.createdThrough ?? (await source.snapshot())
  const self = relativeLink(requestUrl)

  if (createdThrough === null) {
    return emptyPage(self, pageSize)
  }
  if (!isCanonicalInstant(createdThrough)) {
    throw new Error('keyset source snapshot must be a UTC timestamp with milliseconds')
  }

  const rows = await source.list({ after, createdThrough, take: pageSize + 1 })
  validateKeysetRows(rows, after, createdThrough, pageSize + 1, order)
  const visible = rows.slice(0, pageSize)
  const hasNext = rows.length > pageSize
  const nextCursor = hasNext
    ? await encodeCursor(
        {
          v: keysetCursorVersion,
          p: order.encode(order.positionOf(visible.at(-1)!)),
          t: createdThrough,
          s: pageSize,
        },
        cursorSigningKey,
        scope,
      )
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
  payload: CursorPayload | KeysetCursorPayload | ProjectionCursorPayload,
  signingKey: Uint8Array,
  scope: string,
): Promise<string> => {
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await sign(encodedPayload, signingKey, scope)
  return `${encodedPayload}.${encodeBase64Url(signature)}`
}

/**
 * The payload of a cursor this server signed for this scope, parsed but not
 * yet validated. Throws on anything else; the callers turn that into the one
 * 422 a malformed, forged or replayed cursor gets.
 */
const readSignedPayload = async (
  raw: string,
  signingKey: Uint8Array,
  scope: string,
  maximumLength: number,
): Promise<{ encodedPayload: string; parsed: unknown }> => {
  if (raw.length === 0 || raw.length > maximumLength) throw new Error()
  const parts = raw.split('.')
  if (parts.length !== 2) throw new Error()
  const encodedPayload = parts[0]!
  const encodedSignature = parts[1]!
  if (!cursorPartPattern.test(encodedPayload) || !cursorPartPattern.test(encodedSignature)) {
    throw new Error()
  }
  const signature = decodeBase64Url(encodedSignature)
  if (!(await verify(encodedPayload, signature, signingKey, scope))) throw new Error()
  const parsed: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(encodedPayload)),
  )
  return { encodedPayload, parsed }
}

const decodeCursor = async (
  raw: string,
  signingKey: Uint8Array,
  scope: string,
): Promise<CursorPayload> => {
  try {
    const signed = await readSignedPayload(raw, signingKey, scope, maximumCursorLength)
    const encodedPayload = signed.encodedPayload
    const parsed = signed.parsed as Partial<CursorPayload>
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

const decodeKeysetCursor = async <Row, Position>(
  raw: string,
  signingKey: Uint8Array,
  scope: string,
  order: KeysetOrder<Row, Position>,
): Promise<{ after: Position; createdThrough: string; size: number }> => {
  try {
    const signed = await readSignedPayload(raw, signingKey, scope, maximumKeysetCursorLength)
    const parsed = signed.parsed as Partial<KeysetCursorPayload> | null
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      parsed.v !== keysetCursorVersion ||
      typeof parsed.t !== 'string' ||
      !isCanonicalInstant(parsed.t) ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.s! < 1 ||
      parsed.s! > maximumPageSize
    ) {
      throw new Error()
    }
    const after = order.decode(parsed.p)
    if (after === null) throw new Error()
    // Re-encoded from what was read, so a payload that verifies but is not
    // the one this server writes -- extra fields, another spelling of the
    // same position -- is refused rather than half-understood.
    const payload: KeysetCursorPayload = {
      v: keysetCursorVersion,
      p: order.encode(after),
      t: parsed.t,
      s: parsed.s!,
    }
    const canonicalPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
    if (canonicalPayload !== signed.encodedPayload) throw new Error()
    return { after, createdThrough: parsed.t, size: parsed.s! }
  } catch {
    throw invalidField('cursor', 'invalid', 'cursor is malformed or unsupported')
  }
}

const isCanonicalInstant = (value: string): boolean =>
  canonicalInstantPattern.test(value) && new Date(Date.parse(value)).toISOString() === value

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

const validateKeysetRows = <Row extends { id: number | string; created_at: string }, Position>(
  rows: readonly Row[],
  after: Position | null,
  createdThrough: string,
  maximumRows: number,
  order: KeysetOrder<Row, Position>,
): void => {
  if (rows.length > maximumRows) throw new Error('cursor source returned more rows than requested')
  const bound = Date.parse(createdThrough)
  let previous = after
  for (const row of rows) {
    if (typeof row.id === 'number') assertSafeInteger(row.id, 'source row id')
    else if (!/^[a-zA-Z0-9_-]{1,128}$/.test(row.id)) throw new Error('invalid source row id')
    const position = order.positionOf(row)
    const created = Date.parse(row.created_at)
    if (
      (previous !== null && order.compare(previous, position) >= 0) ||
      !Number.isFinite(created) ||
      created > bound
    ) {
      throw new Error('cursor source returned rows outside the requested stable window')
    }
    previous = position
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
