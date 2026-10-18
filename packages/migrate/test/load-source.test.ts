import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runLoad } from '../src/load.js'
import { fileSnapshotSource, type SnapshotSource } from '../src/snapshot-source.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

/**
 * Issue 409, slice 1. Every raw read the loader makes goes through the source
 * it is given, so the same snapshot loads to the same database whether the
 * bytes come off disk or out of memory.
 */

const sourceRoot = join(import.meta.dirname, '..', 'src')

/** A source over bytes already read, which records what it was asked for. */
const memorySource = async (
  snapshotDir: string,
  resources: readonly string[],
): Promise<{ source: SnapshotSource; reads: Set<string>; sizes: Set<string> }> => {
  const bytes = new Map<string, Buffer>()
  for (const resource of resources) {
    bytes.set(resource, await readFile(join(snapshotDir, 'raw', `${resource}.jsonl`)))
  }
  const reads = new Set<string>()
  const sizes = new Set<string>()
  const held = (resource: string): Buffer => {
    const found = bytes.get(resource)
    if (found === undefined) throw new Error(`${resource} is not in memory`)
    return found
  }
  const source: SnapshotSource = {
    openRaw: async function* (resource, byteOffset) {
      reads.add(resource)
      const lines = Buffer.from(held(resource).subarray(byteOffset)).toString('utf8').split('\n')
      if (lines.at(-1) === '') lines.pop()
      yield* lines
    },
    size: async (resource) => {
      sizes.add(resource)
      return held(resource).length
    },
    describe: (resource) => `memory:${resource}`,
  }
  return { source, reads, sizes }
}

const WALL_CLOCK = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/gu
// Statement keys, event ids and closure secrets are minted per database; the snapshot
// digest, which is not, is compared through the load result instead.
const MINTED = /[0-9a-f]{32,64}/gu

const dump = (path: string): Record<string, string[]> => {
  const database = new BetterSqlite3(path, { readonly: true })
  try {
    const tables = database
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
    const out: Record<string, string[]> = {}
    for (const { name } of tables.sort((a, b) => a.name.localeCompare(b.name))) {
      const rows = database.prepare(`SELECT * FROM "${name}"`).all()
      // Wall-clock stamps (migration ledger, progress rows) differ per run.
      out[name] = rows
        .map((row) => JSON.stringify(row).replace(WALL_CLOCK, '<now>').replace(MINTED, '<hash>'))
        .sort()
    }
    return out
  } finally {
    database.close()
  }
}

describe('the loader reads rows only through its source (#409)', () => {
  it('[unit] the loader builds no raw path of its own', async () => {
    const text = await readFile(join(sourceRoot, 'load.ts'), 'utf8')
    expect(text).not.toMatch(/join\(\s*snapshotDir,\s*'raw',(?!\s*'\.load-index')/u)
  })

  describe('against the sanitized fixture', () => {
    let dir: string
    let snapshotDir: string

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'ezacto-load-source-'))
      snapshotDir = join(dir, 'snapshot')
      await buildSanitizedLoadSnapshot(snapshotDir)
    })

    afterEach(async () => rm(dir, { recursive: true, force: true }))

    it('[unit] an in-memory source and the file source load to identical databases', async () => {
      const resources = (await readdir(join(snapshotDir, 'raw')))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => name.slice(0, -'.jsonl'.length))
      const fromFile = join(dir, 'file.sqlite')
      const fromMemory = join(dir, 'memory.sqlite')
      const fileResult = await runLoad({
        snapshotDir,
        source: fileSnapshotSource(snapshotDir),
        databasePath: fromFile,
        maxRows: 5,
        maxStatements: 40,
      })
      const memory = await memorySource(snapshotDir, resources)
      const memoryResult = await runLoad({
        snapshotDir,
        source: memory.source,
        databasePath: fromMemory,
        maxRows: 5,
        maxStatements: 40,
      })
      expect(memoryResult.snapshotSha256).toBe(fileResult.snapshotSha256)
      expect(memoryResult.loadedRows).toBe(fileResult.loadedRows)
      expect(fileResult.loadedRows).toBeGreaterThan(0)
      const expected = dump(fromFile)
      const actual = dump(fromMemory)
      expect(Object.keys(actual)).toEqual(Object.keys(expected))
      for (const table of Object.keys(expected)) {
        expect(actual[table], table).toEqual(expected[table])
      }
      // Rows, lineage and sizing were all served by the source.
      expect(memory.reads).toContain('invoices')
      expect([...memory.reads].some((name) => name.endsWith('.lineage'))).toBe(true)
      expect([...memory.sizes].some((name) => name.endsWith('.lineage'))).toBe(true)
    })
  })
})
