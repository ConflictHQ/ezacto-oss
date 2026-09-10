import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerBrandAssetStore } from '../src/brand-assets.js'
import { migrateContainer } from '../src/migrate.js'

const now = '2026-09-09T12:00:00.000Z'
const later = '2026-09-10T09:30:00.000Z'
const hash = (character: string): string => character.repeat(64)

const databases: BetterSqlite3.Database[] = []

const database = (): BetterSqlite3.Database => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  databases.push(sqlite)
  return sqlite
}

const write = (slot: string, contentHash: string, overrides: Record<string, unknown> = {}) => ({
  slot: slot as 'wordmark_light' | 'wordmark_dark' | 'favicon',
  contentHash,
  fileKey: `brand/sha256/${contentHash.slice(0, 2)}/${contentHash}`,
  contentType: 'image/png',
  byteSize: 4_096,
  uploadedByUserId: null,
  now,
  ...overrides,
})

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close()
})

describe('brand asset store (#489)', () => {
  it('[unit] a slot holds one mark, and uploading again replaces it', async () => {
    const store = createContainerBrandAssetStore(database())
    await store.put(write('wordmark_dark', hash('a')))
    const replaced = await store.put(
      write('wordmark_dark', hash('b'), { now: later, byteSize: 9_000 }),
    )

    expect(replaced.contentHash).toBe(hash('b'))
    expect(replaced.byteSize).toBe(9_000)
    // The slot is the key, so the first mark is gone rather than shadowed:
    // nothing can be ambiguous about which mark is the live one.
    expect(await store.list()).toHaveLength(1)
    // `created_at` records when this instance first put a mark in the slot;
    // `updated_at` records the file that is there now.
    expect(replaced.createdAt).toBe(now)
    expect(replaced.updatedAt).toBe(later)
  })

  it('[unit] the three slots are independent', async () => {
    const store = createContainerBrandAssetStore(database())
    await store.put(write('wordmark_dark', hash('a')))
    await store.put(write('wordmark_light', hash('b')))
    await store.put(write('favicon', hash('c')))
    expect((await store.list()).map((asset) => asset.slot)).toEqual([
      'favicon',
      'wordmark_dark',
      'wordmark_light',
    ])

    expect(await store.remove('wordmark_dark')).toBe(true)
    expect((await store.list()).map((asset) => asset.slot)).toEqual([
      'favicon',
      'wordmark_light',
    ])
    expect(await store.remove('wordmark_dark')).toBe(false)
  })

  it('[security] the schema refuses a script-capable content type', async () => {
    const store = createContainerBrandAssetStore(database())
    // The route sniffs the bytes and would never write this; the CHECK is the
    // second line, so no other writer can put an SVG behind the public route.
    await expect(
      store.put(write('favicon', hash('a'), { contentType: 'image/svg+xml' })),
    ).rejects.toThrow(/CHECK constraint failed/iu)
    expect(await store.list()).toEqual([])
  })

  it('[security] the schema refuses a mark over the size cap', async () => {
    const store = createContainerBrandAssetStore(database())
    await expect(
      store.put(write('favicon', hash('a'), { byteSize: 512 * 1024 + 1 })),
    ).rejects.toThrow(/CHECK constraint failed/iu)
    await expect(
      store.put(write('favicon', hash('a'), { byteSize: 0 })),
    ).rejects.toThrow(/CHECK constraint failed/iu)
    expect((await store.put(write('favicon', hash('a'), { byteSize: 512 * 1024 }))).byteSize)
      .toBe(512 * 1024)
  })

  it('[unit] refuses a slot nobody defined and a hash that is not one', async () => {
    const store = createContainerBrandAssetStore(database())
    await expect(store.put(write('wordmark_huge', hash('a')))).rejects.toThrow(
      /CHECK constraint failed/iu,
    )
    await expect(
      store.put(write('favicon', 'Z'.repeat(64))),
    ).rejects.toThrow(/CHECK constraint failed/iu)
  })

  it('[unit] refuses a clock that is not a canonical UTC instant', async () => {
    const store = createContainerBrandAssetStore(database())
    await expect(
      store.put(write('favicon', hash('a'), { now: '2026-09-09 12:00:00' })),
    ).rejects.toThrow(RangeError)
  })
})
