import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database, migrateContainer, migrateD1 } from '@ezacto/db'
import {
  LoadLeaseHeldError,
  LoadLeaseLostError,
  LoadSnapshotChangedError,
  claimLoadLease,
  loadNextChunk,
  releaseLoadLease,
  runLoad,
  type LoadLease,
} from '../src/load.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { fileSnapshotSource, type SnapshotSource } from '../src/snapshot-source.js'
import { buildSanitizedLoadSnapshot } from './load-fixture.js'

/**
 * Issue 409, slice 3. One load at a time per target database, owned by a lease
 * row in the target; a holder that loses it stops before its next write; and
 * a source that changes under a running load is refused.
 */

const T0 = 1_800_000_000_000
const TTL = 60_000

describe('the load lease (#409)', () => {
  let dir: string
  let snapshotDir: string
  let sqlite: BetterSqlite3.Database
  let database: ReturnType<typeof createContainerDatabase>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-load-lease-'))
    snapshotDir = join(dir, 'snapshot')
    await buildSanitizedLoadSnapshot(snapshotDir)
    sqlite = new BetterSqlite3(join(dir, 'target.sqlite'))
    migrateContainer(sqlite)
    database = createContainerDatabase(sqlite)
  })

  afterEach(async () => {
    sqlite.close()
    await rm(dir, { recursive: true, force: true })
  })

  const count = (table: string): number =>
    (sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count

  const claim = (now: number, source?: SnapshotSource): Promise<LoadLease> =>
    claimLoadLease({ database, snapshotDir, source, ttlMs: TTL, now: () => now })

  const log = (): { fence: number; event: string; previous_holder: string | null }[] =>
    sqlite
      .prepare(`SELECT fence, event, previous_holder FROM _ezacto_load_lease_log ORDER BY seq`)
      .all() as { fence: number; event: string; previous_holder: string | null }[]

  describe('claiming', () => {
    it('[container] refuses a second claimant while the lease is live', async () => {
      const first = await claim(T0)
      expect(first.fence).toBe(1)
      const refused = await claim(T0 + TTL - 1).catch((error: unknown) => error)
      expect(refused).toBeInstanceOf(LoadLeaseHeldError)
      expect((refused as LoadLeaseHeldError).expiresAt).toBe(T0 + TTL)
      // The refusal changed nothing: the holder is still the holder.
      expect(sqlite.prepare(`SELECT holder, fence FROM _ezacto_load_lease`).get()).toEqual({
        holder: first.holder,
        fence: 1,
      })
    })

    it('[container] takes over an expired lease, bumps the fence and records it', async () => {
      const stale = await claim(T0)
      const taker = await claim(T0 + TTL)
      expect(taker.holder).not.toBe(stale.holder)
      expect(taker.fence).toBe(2)
      expect(log()).toEqual([
        { fence: 1, event: 'claimed', previous_holder: null },
        { fence: 2, event: 'taken_over', previous_holder: stale.holder },
      ])
    })

    it('[container] lets the next claimant in at once after a release, and says so', async () => {
      const first = await claim(T0)
      await releaseLoadLease(database, first)
      const second = await claim(T0 + 1)
      expect(second.fence).toBe(2)
      expect(log()).toEqual([
        { fence: 1, event: 'claimed', previous_holder: null },
        { fence: 1, event: 'released', previous_holder: null },
        { fence: 2, event: 'claimed', previous_holder: null },
      ])
    })

    it('[container] renews on each invocation, so a working load keeps its lease', async () => {
      let now = T0
      const lease = await claimLoadLease({ database, snapshotDir, ttlMs: TTL, now: () => now })
      for (let step = 0; step < 3; step += 1) {
        now += TTL - 1_000
        await loadNextChunk({ database, snapshotDir, lease, maxRows: 1 })
        expect(lease.expiresAt).toBe(now + TTL)
      }
      // Never expired, so nobody else could have had it.
      await expect(claimLoadLease({ database, snapshotDir, now: () => now + 1 })).rejects.toThrow(
        LoadLeaseHeldError,
      )
    })
  })

  describe('fencing', () => {
    it('[container] stops a holder that lost its lease mid-chunk before its next write', async () => {
      const stale = await claim(T0)
      const files = fileSnapshotSource(snapshotDir)
      let tookOver: LoadLease | null = null
      // The first raw read happens inside the chunk, after this holder's lease
      // check passed. A second loader takes the lease over at exactly that point.
      const source: SnapshotSource = {
        ...files,
        openRaw: (resource, byteOffset) => {
          return (async function* () {
            if (tookOver === null) tookOver = await claim(T0 + TTL, files)
            yield* files.openRaw(resource, byteOffset)
          })()
        },
      }

      await expect(
        loadNextChunk({ database, snapshotDir, source, lease: stale, maxRows: 5 }),
      ).rejects.toThrow(LoadLeaseLostError)
      expect(tookOver).not.toBeNull()
      // Nothing of the stale holder's chunk landed: no admission, no progress.
      expect(count('_ezacto_load_admission')).toBe(0)
      expect(count('_ezacto_load_progress')).toBe(0)
      expect(count('users')).toBe(0)

      // The holder that took over is not refused, and carries on.
      await loadNextChunk({ database, snapshotDir, lease: tookOver!, maxRows: 5 })
      expect(tookOver!.fence).toBe(2)
    }, 60_000)

    it('[container] lands none of a row chunk when the lease is taken over while it is being read', async () => {
      const stale = await claim(T0)
      let loaded = await loadNextChunk({ database, snapshotDir, lease: stale, maxRows: 5 })
      for (let step = 0; step < 100 && loaded.resource === null; step += 1) {
        loaded = await loadNextChunk({ database, snapshotDir, lease: stale, maxRows: 5 })
      }
      expect(loaded.resource).toBe('organization')
      const before = {
        progress: count('_ezacto_load_progress'),
        users: count('users'),
      }
      const files = fileSnapshotSource(snapshotDir)
      let takeovers = 0
      const source: SnapshotSource = {
        ...files,
        openRaw: (resource, byteOffset) =>
          (async function* () {
            if (takeovers === 0) {
              takeovers += 1
              await claim(T0 + TTL, files)
            }
            yield* files.openRaw(resource, byteOffset)
          })(),
      }
      await expect(
        loadNextChunk({ database, snapshotDir, source, lease: stale, maxRows: 5 }),
      ).rejects.toThrow(LoadLeaseLostError)
      expect(takeovers).toBe(1)
      expect({ progress: count('_ezacto_load_progress'), users: count('users') }).toEqual(before)
    }, 90_000)

    it('[container] a holder whose lease ran out stops too, even if nobody took it over', async () => {
      let now = T0
      const lease = await claimLoadLease({ database, snapshotDir, ttlMs: TTL, now: () => now })
      // Renewal succeeds at T0, then the clock jumps past the expiry before the write.
      const files = fileSnapshotSource(snapshotDir)
      const source: SnapshotSource = {
        ...files,
        openRaw: (resource, byteOffset) => {
          now = T0 + TTL * 10
          return files.openRaw(resource, byteOffset)
        },
      }
      await expect(
        loadNextChunk({ database, snapshotDir, source, lease, maxRows: 5 }),
      ).rejects.toThrow(LoadLeaseLostError)
      expect(count('_ezacto_load_admission')).toBe(0)
    }, 60_000)

    it('[container] refuses a released holder, which has nothing left to write under', async () => {
      const lease = await claim(T0)
      await releaseLoadLease(database, lease)
      await expect(loadNextChunk({ database, snapshotDir, lease, maxRows: 1 })).rejects.toThrow(
        LoadLeaseLostError,
      )
    })
  })

  describe('snapshot integrity', () => {
    it('[container] pins the manifest at claim time and refuses one that changed', async () => {
      const lease = await claim(T0)
      const manifest = await readManifest(snapshotDir)
      manifest.preflight.organization_currency = 'EUR'
      await writeManifest(snapshotDir, manifest)
      await expect(loadNextChunk({ database, snapshotDir, lease, maxRows: 1 })).rejects.toThrow(
        LoadSnapshotChangedError,
      )
      expect(count('_ezacto_load_admission')).toBe(0)
    })

    it('[container] refuses an object rewritten under the load, even to the same length', async () => {
      const lease = await claim(T0)
      const path = join(snapshotDir, 'raw', 'clients.jsonl')
      const bytes = await readFile(path)
      await writeFile(path, bytes)
      await utimes(path, new Date(T0 + 3_600_000), new Date(T0 + 3_600_000))
      await expect(loadNextChunk({ database, snapshotDir, lease, maxRows: 1 })).rejects.toThrow(
        /a raw object was replaced or rewritten/u,
      )
      expect(count('_ezacto_load_admission')).toBe(0)
    })

    it('[container] refuses a source whose entity tag changed though its bytes did not', async () => {
      const files = fileSnapshotSource(snapshotDir)
      let etag = 'etag-1'
      const tagged: SnapshotSource = {
        ...files,
        fingerprint: async (resource) => `${await files.size(resource)}:${etag}`,
      }
      const lease = await claim(T0, tagged)
      await loadNextChunk({ database, snapshotDir, source: tagged, lease, maxRows: 1 })
      etag = 'etag-2'
      await expect(
        loadNextChunk({ database, snapshotDir, source: tagged, lease, maxRows: 1 }),
      ).rejects.toThrow(LoadSnapshotChangedError)
    })
  })

  describe('the CLI path', () => {
    it('[container] refuses to run beside a live lease, and runs once it is released', async () => {
      const lease = await claim(Date.now())
      sqlite.close()
      await expect(
        runLoad({ snapshotDir, databasePath: join(dir, 'target.sqlite') }),
      ).rejects.toThrow(LoadLeaseHeldError)
      sqlite = new BetterSqlite3(join(dir, 'target.sqlite'))
      database = createContainerDatabase(sqlite)
      await releaseLoadLease(database, lease)
      const result = await loadNextChunk({ database, snapshotDir, maxRows: 1 })
      expect(result.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u)
    }, 60_000)

    it('[container] a load that never claims a lease is not fenced and writes no guard row', async () => {
      await loadNextChunk({ database, snapshotDir, maxRows: 1 })
      expect(count('_ezacto_load_lease')).toBe(0)
      expect(count('_ezacto_load_fence')).toBe(0)
    })
  })

  describe('on D1', () => {
    it('[d1] fences and takes over through a real D1 batch', async () => {
      const miniflare = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok") } }',
        d1Databases: ['DB'],
      })
      try {
        const d1 = await miniflare.getD1Database('DB')
        await migrateD1(d1)
        const target = createD1Database(d1)
        const checksums = JSON.parse(
          await readFile(join(snapshotDir, 'checksums.json'), 'utf8'),
        ) as { snapshot_sha256: string }
        const immutableSnapshotSha256 = checksums.snapshot_sha256
        const holder = await claimLoadLease({
          database: target,
          snapshotDir,
          ttlMs: TTL,
          now: () => T0,
        })
        await loadNextChunk({
          database: target,
          snapshotDir,
          lease: holder,
          immutableSnapshotSha256,
          maxRows: 5,
        })
        const taker = await claimLoadLease({
          database: target,
          snapshotDir,
          ttlMs: TTL,
          now: () => T0 + TTL,
        })
        expect(taker.fence).toBe(2)
        await expect(
          loadNextChunk({
            database: target,
            snapshotDir,
            lease: holder,
            immutableSnapshotSha256,
            maxRows: 5,
          }),
        ).rejects.toThrow(LoadLeaseLostError)
        await loadNextChunk({
          database: target,
          snapshotDir,
          lease: taker,
          immutableSnapshotSha256,
          maxRows: 5,
        })
        const events = await d1
          .prepare('SELECT fence, event FROM _ezacto_load_lease_log ORDER BY seq')
          .all<{ fence: number; event: string }>()
        expect(events.results).toEqual([
          { fence: 1, event: 'claimed' },
          { fence: 2, event: 'taken_over' },
        ])
      } finally {
        await miniflare.dispose()
      }
    }, 90_000)
  })
})
