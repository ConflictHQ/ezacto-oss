import { describe, expect, it } from 'vitest'
import { ApiError, cursorPage, type CursorSource, type CursorWindow } from '../src/index.js'

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
