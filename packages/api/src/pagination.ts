import { validationError } from './errors.js'
import { serializeMany, type Serializer } from './serializer.js'

const defaultPageSize = 50
const maximumPageSize = 200
const cursorVersion = 1
const cursorPattern = /^[A-Za-z0-9_-]+$/

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
}

export const cursorPage = async <Row extends { id: number }, Output, Viewer>({
  requestUrl,
  source,
  viewer,
  serializer,
}: CursorPageOptions<Row, Output, Viewer>): Promise<CursorPageEnvelope<Output>> => {
  const perPageValues = requestUrl.searchParams.getAll('per_page')
  const cursorValues = requestUrl.searchParams.getAll('cursor')
  if (perPageValues.length > 1) throw invalidField('per_page', 'duplicate', 'per_page may appear once')
  if (cursorValues.length > 1) throw invalidField('cursor', 'duplicate', 'cursor may appear once')

  const requestedPageSize = parsePageSize(perPageValues[0])
  const cursor = cursorValues[0] === undefined ? null : decodeCursor(cursorValues[0])
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
    ? encodeCursor({
        v: cursorVersion,
        a: visible.at(-1)!.id,
        t: throughId,
        s: pageSize,
      })
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

const encodeCursor = (payload: CursorPayload): string =>
  btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

const decodeCursor = (raw: string): CursorPayload => {
  try {
    if (raw.length === 0 || raw.length > 256 || !cursorPattern.test(raw)) throw new Error()
    const padded = raw
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(raw.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded)) as Partial<CursorPayload>
    if (
      parsed.v !== cursorVersion ||
      !Number.isSafeInteger(parsed.a) ||
      !Number.isSafeInteger(parsed.t) ||
      !Number.isSafeInteger(parsed.s) ||
      parsed.s! < 1 ||
      parsed.s! > maximumPageSize ||
      parsed.a! >= parsed.t!
    ) {
      throw new Error()
    }
    const payload: CursorPayload = { v: cursorVersion, a: parsed.a!, t: parsed.t!, s: parsed.s! }
    if (encodeCursor(payload) !== raw) throw new Error()
    return payload
  } catch {
    throw invalidField('cursor', 'invalid', 'cursor is malformed or unsupported')
  }
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
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`)
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
