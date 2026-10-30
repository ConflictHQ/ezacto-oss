import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, migrateContainer } from '@ezacto/db'
import {
  fileChildIndexStore,
  memoryChildIndexStore,
  type ChildIndexStore,
} from '../src/child-index-store.js'
import { loadNextChunk, type LoadChunkResult } from '../src/load.js'
import { readManifest } from '../src/manifest.js'
import { RESOURCES } from '../src/resources.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'
import { inflateUsers } from './load-inflate.js'

/**
 * Issue 409, slice 2. The child index is built and read through a store, so a
 * load with no disk of its own builds exactly the index a disk-backed one does.
 */

/** The first child resource to be indexed, so the first partial build is its. */
const FIRST_CHILD = 'billable_rates'

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('the child index store port (#409)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-index-store-'))
  })

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  const stores: [string, () => ChildIndexStore][] = [
    ['file', () => fileChildIndexStore(join(dir, 'snapshot'))],
    ['memory', () => memoryChildIndexStore()],
  ]

  describe.each(stores)('%s store', (kind, make) => {
    it('[unit] writes and reads at positions, and grows, truncates and reports its size', async () => {
      const store = make()
      const file = await store.open('a.idx', 'create')
      await file.write('0123456789', 0)
      await file.write('AB', 4)
      expect(await file.size()).toBe(10)
      expect(text(await file.read(2, 5))).toBe('23AB6')
      // A read past the end is short, never padded: the loader counts on it to
      // detect a truncated index.
      expect(text(await file.read(8, 10))).toBe('89')
      await file.truncate(3)
      expect(await file.size()).toBe(3)
      await file.sync()
      await file.close()
      await file.close()
      const again = await store.open('a.idx', 'read')
      expect(text(await again.read(0, 10))).toBe('012')
      await again.close()
    })

    it('[unit] reports an absent file with ENOENT rather than creating it', async () => {
      const store = make()
      await expect(store.open('missing', 'read')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(store.open('missing', 'update')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(store.readText('missing')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('[unit] create empties a file that is already there; update keeps it', async () => {
      const store = make()
      const first = await store.open('a.idx', 'create')
      await first.write('kept', 0)
      await first.close()
      const kept = await store.open('a.idx', 'update')
      expect(await kept.size()).toBe(4)
      await kept.close()
      const emptied = await store.open('a.idx', 'create')
      expect(await emptied.size()).toBe(0)
      await emptied.close()
    })

    it('[unit] replaces text whole, renames over a target, and removes what is absent quietly', async () => {
      const store = make()
      await store.writeText('state.json', 'one')
      await store.writeText('state.json', 'two')
      expect(await store.readText('state.json')).toBe('two')
      const partial = await store.open('a.partial', 'create')
      await partial.write('built', 0)
      await partial.close()
      await store.writeText('a.idx', 'stale')
      await store.rename('a.partial', 'a.idx')
      expect(await store.readText('a.idx')).toBe('built')
      await expect(store.open('a.partial', 'read')).rejects.toMatchObject({ code: 'ENOENT' })
      await store.remove('a.idx')
      await store.remove('a.idx')
      await expect(store.readText('a.idx')).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('[unit] runs exclusive turns one at a time, in order, and survives a failing turn', async () => {
      const store = make()
      const events: string[] = []
      const turn = (name: string, fail = false) =>
        store.exclusive(async () => {
          events.push(`${name}:in`)
          await new Promise((resolve) => setTimeout(resolve, 15))
          events.push(`${name}:out`)
          if (fail) throw new Error(`${name} failed`)
        })
      const results = await Promise.allSettled([turn('a', true), turn('b'), turn('c')])
      expect(events).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out'])
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    })
  })
})

describe('a load through the child index store (#409)', () => {
  let dir: string
  let snapshotDir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-index-load-'))
    snapshotDir = join(dir, 'snapshot')
    await buildSanitizedLoadSnapshot(snapshotDir)
    await inflateUsers(snapshotDir, 180)
  })

  afterEach(async () => rm(dir, { recursive: true, force: true }))

  const withDatabase = async <T>(
    name: string,
    body: (database: ReturnType<typeof createContainerDatabase>, sqlite: BetterSqlite3.Database) => Promise<T>,
  ): Promise<T> => {
    const sqlite = new BetterSqlite3(join(dir, name))
    try {
      migrateContainer(sqlite)
      return await body(createContainerDatabase(sqlite), sqlite)
    } finally {
      sqlite.close()
    }
  }

  const step = (
    database: ReturnType<typeof createContainerDatabase>,
    indexStore: ChildIndexStore,
  ): Promise<LoadChunkResult> =>
    loadNextChunk({ database, snapshotDir, indexStore, maxRows: 100, maxStatements: 700 })

  const finish = async (
    database: ReturnType<typeof createContainerDatabase>,
    indexStore: ChildIndexStore,
  ): Promise<number> => {
    for (let invocation = 1; invocation < 400; invocation += 1) {
      if ((await step(database, indexStore)).complete) return invocation
    }
    throw new Error('load did not complete')
  }

  const rowCounts = (sqlite: BetterSqlite3.Database): Record<string, number> => {
    const counts: Record<string, number> = {}
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
         AND substr(name, 1, 1) <> '_' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
    for (const { name } of tables) {
      counts[name] = (
        sqlite.prepare(`SELECT count(*) AS count FROM "${name}"`).get() as { count: number }
      ).count
    }
    return counts
  }

  const indexBytes = async (store: ChildIndexStore, name: string): Promise<string> => {
    const file = await store.open(name, 'read')
    try {
      return text(await file.read(0, await file.size()))
    } finally {
      await file.close()
    }
  }

  it('[integration] completes a full load with a memory store and no .load-index on disk', async () => {
    const memory = memoryChildIndexStore()
    await withDatabase('memory.sqlite', async (database, sqlite) => {
      await finish(database, memory)
      expect(existsSync(join(snapshotDir, 'raw', '.load-index'))).toBe(false)
      const memoryCounts = rowCounts(sqlite)
      expect(memoryCounts.teammate_assignments).toBeGreaterThan(0)
      await withDatabase('file.sqlite', async (fileDatabase, fileSqlite) => {
        await finish(fileDatabase, fileChildIndexStore(snapshotDir))
        expect(existsSync(join(snapshotDir, 'raw', '.load-index'))).toBe(true)
        expect(rowCounts(fileSqlite)).toEqual(memoryCounts)
      })
    })
  }, 90_000)

  it('[unit] holds no more than one record per parent for each child resource, and no leftovers', async () => {
    const memory = memoryChildIndexStore()
    await withDatabase('bounded.sqlite', async (database) => {
      for (let invocation = 0; invocation < 400; invocation += 1) {
        // Indexing is done once the load moves on to rows.
        if ((await step(database, memory)).resource !== null) break
      }
    })
    const manifest = await readManifest(snapshotDir)
    let expected = 0
    for (const step of RESOURCES) {
      if (step.kind !== 'child' || (manifest.resources[step.name]?.count ?? 0) === 0) continue
      expected += (manifest.resources[step.parent]?.count ?? 0) * 111
    }
    expect(expected).toBeGreaterThan(0)
    expect(memory.heldBytes()).toBe(expected)
    expect(memory.names().every((name) => name.endsWith('.idx'))).toBe(true)
  }, 90_000)

  it('[unit] refuses a snapshot whose index exceeds the store budget before building anything', async () => {
    const memory = memoryChildIndexStore({ budgetBytes: 1_000 })
    await withDatabase('budget.sqlite', async (database) => {
      await expect(step(database, memory)).rejects.toThrow(/needs \d+ bytes of child index/)
    })
    expect(memory.names()).toEqual([])
  })

  describe.each([
    ['file', (): ChildIndexStore => fileChildIndexStore(snapshotDir)],
    ['memory', (): ChildIndexStore => memoryChildIndexStore()],
  ] as const)('%s store', (kind, make) => {
    const finalIndex = async (
      store: ChildIndexStore,
      database: ReturnType<typeof createContainerDatabase>,
      sabotage: ((store: ChildIndexStore, digest: string) => Promise<void>) | null,
    ): Promise<string> => {
      let digest = ''
      let sabotaged = sabotage === null
      for (let invocation = 0; invocation < 400; invocation += 1) {
        const result = await step(database, store)
        digest = result.snapshotSha256
        // The first call builds only part of the index: stop it there.
        if (!sabotaged && result.resource === null && !result.complete) {
          await sabotage!(store, digest)
          sabotaged = true
        }
        // Indexing is done once the load moves on to rows.
        if (result.complete || result.resource !== null) break
      }
      return indexBytes(store, `${FIRST_CHILD}.${digest}.idx`)
    }

    it('[unit] a crash mid-build converges on the index an uninterrupted build makes', async () => {
      const clean = await withDatabase(`clean-${kind}.sqlite`, (database) =>
        finalIndex(make(), database, null),
      )
      if (kind === 'file') await rm(join(snapshotDir, 'raw', '.load-index'), { recursive: true })

      // A torn tail beyond the last durable record, as a crash between the
      // index write and the checkpoint leaves.
      const torn = await withDatabase(`torn-${kind}.sqlite`, (database) =>
        finalIndex(make(), database, async (store, digest) => {
          const partial = await store.open(`${FIRST_CHILD}.${digest}.idx.partial`, 'update')
          await partial.write('torn-record-that-no-checkpoint-covers', await partial.size())
          await partial.close()
        }),
      )
      expect(torn).toBe(clean)
      if (kind === 'file') await rm(join(snapshotDir, 'raw', '.load-index'), { recursive: true })

      // A checkpoint with no index file behind it: rebuilt from the start.
      const lost = await withDatabase(`lost-${kind}.sqlite`, (database) =>
        finalIndex(make(), database, async (store, digest) => {
          await store.remove(`${FIRST_CHILD}.${digest}.idx.partial`)
        }),
      )
      expect(lost).toBe(clean)
    }, 120_000)
  })
})
