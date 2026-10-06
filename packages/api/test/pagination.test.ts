import { describe, expect, it } from 'vitest'
import {
  ApiError,
  cursorPage,
  keysetCursorPage,
  type CursorSource,
  type CursorWindow,
  type KeysetOrder,
  type KeysetSource,
  type KeysetWindow,
} from '../src/index.js'

interface StoredRow {
  id: number
  label: string
  secret: string
}

const cursorSigningKey = new Uint8Array(32).fill(0x5a)

const sourceFor = (
  rows: StoredRow[],
  highWatermarkCalls: { count: number },
): CursorSource<StoredRow> => ({
  highWatermark: async () => {
    highWatermarkCalls.count += 1
    return rows.length === 0 ? null : Math.max(...rows.map(({ id }) => id))
  },
  list: async ({ afterId, throughId, take }: CursorWindow) =>
    rows
      .filter(({ id }) => (afterId === null || id > afterId) && id <= throughId)
      .sort((left, right) => left.id - right.id)
      .slice(0, take),
})

const serialize = (row: Readonly<StoredRow>, viewer: Readonly<{ includeSecret: boolean }>) => ({
  id: row.id,
  label: row.label,
  ...(viewer.includeSecret ? { secret: row.secret } : {}),
})

describe('cursor pagination', () => {
  it('[api] holds a high-water window stable across concurrent inserts', async () => {
    const rows: StoredRow[] = [1, 2, 3, 4].map((id) => ({
      id,
      label: `row-${id}`,
      secret: `secret-${id}`,
    }))
    const highWatermarkCalls = { count: 0 }
    const source = sourceFor(rows, highWatermarkCalls)
    const first = await cursorPage({
      requestUrl: new URL('https://api.test/api/v1/things?per_page=2&active=true'),
      source,
      viewer: { includeSecret: false },
      serializer: serialize,
      cursorSigningKey,
    })
    expect(first.data).toEqual([
      { id: 1, label: 'row-1' },
      { id: 2, label: 'row-2' },
    ])
    expect(first.links.self).toBe('/api/v1/things?per_page=2&active=true')
    expect(first.links.next).toContain('/api/v1/things?per_page=2&active=true&cursor=')
    expect(first.page.next_cursor).not.toBeNull()

    rows.push(
      { id: 5, label: 'concurrent-5', secret: 'new-5' },
      { id: 6, label: 'concurrent-6', secret: 'new-6' },
    )
    const second = await cursorPage({
      requestUrl: new URL(first.links.next!, 'https://api.test'),
      source,
      viewer: { includeSecret: false },
      serializer: serialize,
      cursorSigningKey,
    })
    expect(second.data).toEqual([
      { id: 3, label: 'row-3' },
      { id: 4, label: 'row-4' },
    ])
    expect(second.links.next).toBeNull()
    expect(second.page.next_cursor).toBeNull()
    expect(highWatermarkCalls.count).toBe(1)
  })

  it('[api] uses an empty links envelope without querying an empty collection', async () => {
    let listCalls = 0
    const page = await cursorPage({
      requestUrl: new URL('https://api.test/api/v1/things'),
      source: {
        highWatermark: async () => null,
        list: async () => {
          listCalls += 1
          return []
        },
      },
      viewer: {},
      serializer: (row: { id: number }) => row,
      cursorSigningKey,
    })
    expect(page).toEqual({
      data: [],
      links: { self: '/api/v1/things', next: null },
      page: { per_page: 50, next_cursor: null },
    })
    expect(listCalls).toBe(0)
  })

  it('[api] rejects malformed cursors, duplicate inputs, and invalid page sizes as 422s', async () => {
    const source = sourceFor([{ id: 1, label: 'one', secret: 'hidden' }], { count: 0 })
    const invalidUrls = [
      'https://api.test/api/v1/things?cursor=not-json',
      'https://api.test/api/v1/things?per_page=0',
      'https://api.test/api/v1/things?per_page=201',
      'https://api.test/api/v1/things?per_page=2&per_page=3',
      'https://api.test/api/v1/things?cursor=abc&cursor=def',
    ]
    for (const requestUrl of invalidUrls) {
      const error = await cursorPage({
        requestUrl: new URL(requestUrl),
        source,
        viewer: {},
        serializer: (row) => row,
        cursorSigningKey,
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(422)
      expect((error as ApiError).fields).toHaveLength(1)
    }
  })

  it('[unit] rejects source rows outside the requested ordered window', async () => {
    await expect(
      cursorPage({
        requestUrl: new URL('https://api.test/api/v1/things?per_page=2'),
        source: {
          highWatermark: async () => 3,
          list: async () => [
            { id: 2, label: 'two', secret: 'hidden' },
            { id: 1, label: 'one', secret: 'hidden' },
          ],
        },
        viewer: {},
        serializer: (row) => row,
        cursorSigningKey,
      }),
    ).rejects.toThrow(/stable window/)
  })

  it('[security] rejects cursor tampering and replay across collection scopes', async () => {
    const rows: StoredRow[] = [1, 2, 3, 4].map((id) => ({
      id,
      label: `row-${id}`,
      secret: `secret-${id}`,
    }))
    const source = sourceFor(rows, { count: 0 })
    const first = await cursorPage({
      requestUrl: new URL('https://api.test/api/v1/things?active=true&per_page=2'),
      source,
      viewer: { includeSecret: false },
      serializer: serialize,
      cursorSigningKey,
    })
    const cursor = first.page.next_cursor!
    const [encodedPayload, signature] = cursor.split('.') as [string, string]
    const payload = JSON.parse(
      atob(encodedPayload.replaceAll('-', '+').replaceAll('_', '/')),
    ) as { v: number; a: number; t: number; s: number }
    payload.t = 6
    const forgedPayload = btoa(JSON.stringify(payload))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    rows.push(
      { id: 5, label: 'concurrent-5', secret: 'new-5' },
      { id: 6, label: 'concurrent-6', secret: 'new-6' },
    )

    for (const requestUrl of [
      `https://api.test/api/v1/things?active=true&per_page=2&cursor=${forgedPayload}.${signature}`,
      `https://api.test/api/v1/other?active=true&per_page=2&cursor=${cursor}`,
      `https://api.test/api/v1/things?active=false&per_page=2&cursor=${cursor}`,
    ]) {
      await expect(
        cursorPage({
          requestUrl: new URL(requestUrl),
          source,
          viewer: { includeSecret: false },
          serializer: serialize,
          cursorSigningKey,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    }
  })

  it('[unit] refuses undersized cursor signing keys', async () => {
    await expect(
      cursorPage({
        requestUrl: new URL('https://api.test/api/v1/things'),
        source: sourceFor([], { count: 0 }),
        viewer: {},
        serializer: (row) => row,
        cursorSigningKey: new Uint8Array(31),
      }),
    ).rejects.toThrow(/at least 32 bytes/)
  })
})

interface DatedRow {
  id: number
  label: string
  created_at: string
}

/** Newest label first, then highest id: an order that is not the ids'. */
const labelOrder: KeysetOrder<DatedRow, { label: string; id: number }> = {
  positionOf: (row) => ({ label: row.label, id: row.id }),
  compare: (left, right) =>
    left.label === right.label ? right.id - left.id : left.label < right.label ? 1 : -1,
  encode: (position) => [position.label, position.id],
  decode: (value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    Number.isSafeInteger(value[1]) &&
    (value[1] as number) > 0
      ? { label: value[0], id: value[1] as number }
      : null,
}

const datedSource = (
  rows: DatedRow[],
  snapshotCalls: { count: number },
): KeysetSource<DatedRow, { label: string; id: number }> => ({
  snapshot: async () => {
    snapshotCalls.count += 1
    return rows.length === 0
      ? null
      : rows.map((row) => row.created_at).sort().at(-1)!
  },
  list: async ({ after, createdThrough, take }: KeysetWindow<{ label: string; id: number }>) =>
    rows
      .filter((row) => row.created_at <= createdThrough)
      .filter((row) => after === null || labelOrder.compare(after, labelOrder.positionOf(row)) < 0)
      .sort((left, right) => labelOrder.compare(labelOrder.positionOf(left), labelOrder.positionOf(right)))
      .slice(0, take),
})

const at = (minute: number): string => `2026-10-05T09:${String(minute).padStart(2, '0')}:00.000Z`

describe('keyset cursor pagination', () => {
  const book = (): DatedRow[] => [
    { id: 1, label: 'delta', created_at: at(1) },
    { id: 9, label: 'bravo', created_at: at(2) },
    { id: 4, label: 'echo', created_at: at(3) },
    { id: 7, label: 'charlie', created_at: at(4) },
  ]

  it('[api] pages in the source order and holds the snapshot across concurrent inserts', async () => {
    const rows = book()
    const snapshotCalls = { count: 0 }
    const source = datedSource(rows, snapshotCalls)
    const first = await keysetCursorPage({
      requestUrl: new URL('https://api.test/api/v1/things?per_page=2&active=true'),
      source,
      order: labelOrder,
      viewer: {},
      serializer: (row: Readonly<DatedRow>) => ({ id: row.id, label: row.label }),
      cursorSigningKey,
    })
    expect(first.data).toEqual([
      { id: 4, label: 'echo' },
      { id: 1, label: 'delta' },
    ])
    expect(first.links.next).toContain('/api/v1/things?per_page=2&active=true&cursor=')

    // Created after the first page, and sorting into the rest of the list.
    rows.push({ id: 2, label: 'alpha', created_at: at(30) })
    rows.push({ id: 3, label: 'charlie', created_at: at(31) })
    const second = await keysetCursorPage({
      requestUrl: new URL(first.links.next!, 'https://api.test'),
      source,
      order: labelOrder,
      viewer: {},
      serializer: (row: Readonly<DatedRow>) => ({ id: row.id, label: row.label }),
      cursorSigningKey,
    })
    expect(second.data).toEqual([
      { id: 7, label: 'charlie' },
      { id: 9, label: 'bravo' },
    ])
    expect(second.page.next_cursor).toBeNull()
    expect(snapshotCalls.count).toBe(1)
  })

  it('[api] carries a position in any script through the cursor', async () => {
    const rows: DatedRow[] = [
      { id: 1, label: 'Rechnung-\u00fc-\u{1F600}', created_at: at(1) },
      { id: 2, label: 'Rechnung-\u00fc-\u{1F600}', created_at: at(1) },
    ]
    const source = datedSource(rows, { count: 0 })
    const first = await keysetCursorPage({
      requestUrl: new URL('https://api.test/api/v1/things?per_page=1'),
      source,
      order: labelOrder,
      viewer: {},
      serializer: (row: Readonly<DatedRow>) => row.id,
      cursorSigningKey,
    })
    expect(first.data).toEqual([2])
    const second = await keysetCursorPage({
      requestUrl: new URL(first.links.next!, 'https://api.test'),
      source,
      order: labelOrder,
      viewer: {},
      serializer: (row: Readonly<DatedRow>) => row.id,
      cursorSigningKey,
    })
    expect(second.data).toEqual([1])
  })

  it('[api] answers an empty page without listing an empty collection', async () => {
    let listCalls = 0
    const page = await keysetCursorPage({
      requestUrl: new URL('https://api.test/api/v1/things'),
      source: {
        snapshot: async () => null,
        list: async () => {
          listCalls += 1
          return []
        },
      },
      order: labelOrder,
      viewer: {},
      serializer: (row: DatedRow) => row,
      cursorSigningKey,
    })
    expect(page).toEqual({
      data: [],
      links: { self: '/api/v1/things', next: null },
      page: { per_page: 50, next_cursor: null },
    })
    expect(listCalls).toBe(0)
  })

  it('[api] rejects malformed cursors, duplicate inputs and invalid page sizes as 422s', async () => {
    const source = datedSource(book(), { count: 0 })
    for (const requestUrl of [
      'https://api.test/api/v1/things?cursor=not-json',
      'https://api.test/api/v1/things?per_page=0',
      'https://api.test/api/v1/things?per_page=201',
      'https://api.test/api/v1/things?per_page=2&per_page=3',
      'https://api.test/api/v1/things?cursor=abc&cursor=def',
    ]) {
      const error = await keysetCursorPage({
        requestUrl: new URL(requestUrl),
        source,
        order: labelOrder,
        viewer: {},
        serializer: (row) => row,
        cursorSigningKey,
      }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(422)
      expect((error as ApiError).fields).toHaveLength(1)
    }
  })

  it('[unit] rejects source rows out of order, at or before the cursor, or after the snapshot', async () => {
    const page = (rows: DatedRow[], snapshot = at(5)) =>
      keysetCursorPage({
        requestUrl: new URL('https://api.test/api/v1/things?per_page=2'),
        source: { snapshot: async () => snapshot, list: async () => rows },
        order: labelOrder,
        viewer: {},
        serializer: (row) => row,
        cursorSigningKey,
      })
    await expect(
      page([
        { id: 9, label: 'bravo', created_at: at(2) },
        { id: 4, label: 'echo', created_at: at(3) },
      ]),
    ).rejects.toThrow(/stable window/)
    await expect(
      page([
        { id: 4, label: 'echo', created_at: at(3) },
        { id: 4, label: 'echo', created_at: at(3) },
      ]),
    ).rejects.toThrow(/stable window/)
    await expect(page([{ id: 4, label: 'echo', created_at: at(6) }])).rejects.toThrow(
      /stable window/,
    )
    await expect(page([], '2026-10-05T09:05:00Z')).rejects.toThrow(/milliseconds/)
  })

  it('[security] rejects tampering, replay across scopes, and an id cursor', async () => {
    const source = datedSource(book(), { count: 0 })
    const options = {
      source,
      order: labelOrder,
      viewer: {},
      serializer: (row: Readonly<DatedRow>) => row.id,
      cursorSigningKey,
    }
    const first = await keysetCursorPage({
      ...options,
      requestUrl: new URL('https://api.test/api/v1/things?active=true&per_page=2'),
    })
    const cursor = first.page.next_cursor!
    const [encodedPayload, signature] = cursor.split('.') as [string, string]
    const payload = JSON.parse(
      atob(encodedPayload.replaceAll('-', '+').replaceAll('_', '/')),
    ) as { v: number; p: unknown; t: string; s: number }
    // A later snapshot would let rows created since into the traversal.
    payload.t = at(59)
    const forgedPayload = btoa(JSON.stringify(payload))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    // An id-chassis cursor for the same scope, which is a different shape.
    const idCursor = (
      await cursorPage({
        requestUrl: new URL('https://api.test/api/v1/things?active=true&per_page=2'),
        source: sourceFor(
          [1, 2, 3].map((id) => ({ id, label: `row-${id}`, secret: 'hidden' })),
          { count: 0 },
        ),
        viewer: {},
        serializer: (row) => row.id,
        cursorSigningKey,
      })
    ).page.next_cursor!

    for (const requestUrl of [
      `https://api.test/api/v1/things?active=true&per_page=2&cursor=${forgedPayload}.${signature}`,
      `https://api.test/api/v1/other?active=true&per_page=2&cursor=${cursor}`,
      `https://api.test/api/v1/things?active=false&per_page=2&cursor=${cursor}`,
      `https://api.test/api/v1/things?active=true&per_page=2&cursor=${idCursor}`,
    ]) {
      await expect(
        keysetCursorPage({ ...options, requestUrl: new URL(requestUrl) }),
      ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
    }
    // And the other way round: the id chassis refuses a keyset cursor.
    await expect(
      cursorPage({
        requestUrl: new URL(`https://api.test/api/v1/things?active=true&per_page=2&cursor=${cursor}`),
        source: sourceFor([], { count: 0 }),
        viewer: {},
        serializer: (row) => row,
        cursorSigningKey,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' })
  })
})
