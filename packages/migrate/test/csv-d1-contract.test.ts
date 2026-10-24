import { describe, expect, it } from 'vitest'
import {
  CSV_D1_CHUNK_ROWS,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_QUERIES_PER_INVOCATION,
  D1_MAX_STATEMENT_BYTES,
  assertChunkWithinBudget,
  chunkBudget,
  chunkStatementCount,
  encodeChunkMessage,
  type CsvD1ApplyStore,
  type CsvD1ChunkRequest,
  type CsvD1PreviewReader,
} from '../src/csv-d1-contract.js'
import { FakeCsvD1 } from './csv-d1-fake.js'

/** The suite any real D1 store must pass. The fake is the first subject. */
const runStoreContract = (
  name: string,
  make: () => Promise<{
    store: CsvD1ApplyStore & CsvD1PreviewReader
    admit: (actor: string) => void
    bumpDestination: () => void
    setup: (runId: number, chunks: number, sourceId?: string) => void
    keyCount: () => number
    previewWrites: () => number
    /** Make the next applyChunk batch fail partway, whatever the store's mechanism. */
    failBatch: () => void
  }>,
) =>
  describe(`CSV D1 store contract: ${name}`, () => {
    const request = (
      over: Partial<CsvD1ChunkRequest> & { keys?: string[] } = {},
    ): CsvD1ChunkRequest => ({
      runId: 1,
      chunkIndex: 0,
      leaseGeneration: 1,
      actorId: 'admin-1',
      destinationVersion: 'v1',
      now: '2026-10-24T00:00:00.000Z',
      rows: (over.keys ?? ['a', 'b']).map((sourceKey, index) => ({
        sourceKey,
        line: index + 2,
        entry: { seconds: 3600 },
      })),
      ...over,
    })
    const ready = async (chunks = 3) => {
      const subject = await make()
      subject.admit('admin-1')
      subject.setup(1, chunks)
      const claim = await subject.store.claimLease({ runId: 1, holder: 'w1', now: 0, ttlMs: 1000 })
      expect(claim).toMatchObject({ kind: 'claimed', generation: 1 })
      return subject
    }
    /** A second run on its own source, leased to its own writer at generation 1. */
    const secondRun = async (subject: Awaited<ReturnType<typeof ready>>, sourceId: string) => {
      subject.setup(2, 1, sourceId)
      const claim = await subject.store.claimLease({ runId: 2, holder: 'w9', now: 0, ttlMs: 1000 })
      expect(claim).toMatchObject({ kind: 'claimed', generation: 1 })
    }

    it('[unit] applies a chunk and records each key with its entry', async () => {
      const { store, keyCount } = await ready()
      expect(await store.applyChunk(request())).toEqual({
        kind: 'applied',
        inserted: 2,
        alreadyImported: 0,
      })
      expect(keyCount()).toBe(2)
    })

    it('[unit] duplicate or out-of-order delivery adds no time', async () => {
      const { store, keyCount } = await ready()
      await store.applyChunk(request({ chunkIndex: 1, keys: ['c'] }))
      await store.applyChunk(request({ chunkIndex: 0 }))
      const again = await store.applyChunk(request({ chunkIndex: 0 }))
      expect(again).toEqual({ kind: 'replayed', inserted: 2, alreadyImported: 0 })
      expect(keyCount()).toBe(3)
      expect((await store.status(1)).insertedRows).toBe(3)
    })

    it('[unit] a source key already imported is counted, never inserted twice', async () => {
      const { store, keyCount } = await ready()
      await store.applyChunk(request({ chunkIndex: 0, keys: ['a'] }))
      const outcome = await store.applyChunk(request({ chunkIndex: 1, keys: ['a', 'a', 'z'] }))
      expect(outcome).toEqual({ kind: 'applied', inserted: 1, alreadyImported: 2 })
      expect(keyCount()).toBe(2)
    })

    it('[unit] an expired lease replaced by a new generation fences the old writer', async () => {
      const { store, keyCount } = await ready()
      expect(await store.claimLease({ runId: 1, holder: 'w2', now: 500, ttlMs: 1000 })).toEqual({
        kind: 'held',
        retryAfterMs: 500,
      })
      const taken = await store.claimLease({ runId: 1, holder: 'w2', now: 2000, ttlMs: 1000 })
      expect(taken).toMatchObject({ kind: 'claimed', generation: 2 })
      expect(await store.applyChunk(request({ leaseGeneration: 1 }))).toEqual({
        kind: 'stale_lease',
      })
      expect(keyCount()).toBe(0)
      expect(await store.applyChunk(request({ leaseGeneration: 2 }))).toMatchObject({
        kind: 'applied',
      })
    })

    it('[unit] a live lease is held for its own holder too and keeps its generation', async () => {
      const { store, keyCount } = await ready()
      expect(await store.claimLease({ runId: 1, holder: 'w1', now: 500, ttlMs: 1000 })).toEqual({
        kind: 'held',
        retryAfterMs: 500,
      })
      // The holder's in-flight write is not fenced out by its own re-claim.
      expect(await store.applyChunk(request({ leaseGeneration: 1 }))).toMatchObject({
        kind: 'applied',
      })
      expect(keyCount()).toBe(2)
      const lapsed = await store.claimLease({ runId: 1, holder: 'w1', now: 1000, ttlMs: 1000 })
      expect(lapsed).toMatchObject({ kind: 'claimed', generation: 2 })
    })

    it('[unit] a cancelled run writes nothing more and keeps what committed', async () => {
      const { store, keyCount } = await ready()
      await store.applyChunk(request({ chunkIndex: 0 }))
      await store.cancel(1)
      expect(await store.applyChunk(request({ chunkIndex: 1, keys: ['x'] }))).toEqual({
        kind: 'cancelled',
      })
      expect(await store.claimLease({ runId: 1, holder: 'w3', now: 9000, ttlMs: 1 })).toEqual({
        kind: 'cancelled',
      })
      expect(keyCount()).toBe(2)
      expect(await store.nextChunk(1)).toBeNull()
      expect((await store.status(1)).status).toBe('cancelled')
    })

    it('[unit] a revoked administrator pauses the run without writing', async () => {
      const subject = await ready()
      expect(await subject.store.applyChunk(request({ actorId: 'nobody' }))).toEqual({
        kind: 'actor_unauthorized',
      })
      expect(subject.keyCount()).toBe(0)
      expect(await subject.store.status(1)).toMatchObject({
        status: 'paused',
        lastErrorCode: 'actor_unauthorized',
        committedChunks: 0,
      })
      expect(await subject.store.nextChunk(1)).toBe(0)
      // Reauthorized, the same chunk applies and the run is no longer paused.
      expect(await subject.store.applyChunk(request())).toMatchObject({ kind: 'applied' })
      expect(await subject.store.status(1)).toMatchObject({
        status: 'partial',
        lastErrorCode: null,
      })
    })

    it('[unit] a changed destination pauses the run without writing', async () => {
      const subject = await ready()
      subject.bumpDestination()
      expect(await subject.store.applyChunk(request())).toEqual({ kind: 'destination_stale' })
      expect(subject.keyCount()).toBe(0)
      expect(await subject.store.status(1)).toMatchObject({
        status: 'paused',
        lastErrorCode: 'destination_stale',
      })
      expect(await subject.store.applyChunk(request({ destinationVersion: 'v2' }))).toMatchObject({
        kind: 'applied',
      })
      expect((await subject.store.status(1)).status).toBe('partial')
    })

    it('[unit] dedup is per source: the same key under two sources is two rows', async () => {
      const subject = await ready()
      await secondRun(subject, 'other')
      await subject.store.applyChunk(request({ keys: ['a'] }))
      const other = await subject.store.applyChunk(
        request({ runId: 2, keys: ['a'], leaseGeneration: 1 }),
      )
      expect(other).toEqual({ kind: 'applied', inserted: 1, alreadyImported: 0 })
      expect(subject.keyCount()).toBe(2)
      expect([...(await subject.store.importedKeys('src'))]).toEqual(['a'])
      expect([...(await subject.store.importedKeys('other'))]).toEqual(['a'])
      expect((await subject.store.importedKeys('nobody')).size).toBe(0)
    })

    it('[unit] dedup spans runs of the same source', async () => {
      const subject = await ready()
      await secondRun(subject, 'src')
      await subject.store.applyChunk(request({ keys: ['a'] }))
      const later = await subject.store.applyChunk(
        request({ runId: 2, keys: ['a', 'b'], leaseGeneration: 1 }),
      )
      expect(later).toEqual({ kind: 'applied', inserted: 1, alreadyImported: 1 })
      expect(subject.keyCount()).toBe(2)
    })

    it('[unit] a failed batch leaves no time and no key, and the chunk can be retried', async () => {
      const subject = await ready()
      subject.failBatch()
      await expect(subject.store.applyChunk(request())).rejects.toThrow()
      expect(subject.keyCount()).toBe(0)
      expect(await subject.store.status(1)).toMatchObject({
        status: 'partial',
        committedChunks: 0,
        lastErrorCode: 'storage_failure',
      })
      expect(await subject.store.applyChunk(request())).toMatchObject({ kind: 'applied' })
      expect((await subject.store.status(1)).lastErrorCode).toBeNull()
    })

    it('[unit] the next message derives from committed state, so a lost ack is recoverable', async () => {
      const { store } = await ready(3)
      expect(await store.nextChunk(1)).toBe(0)
      await store.applyChunk(request({ chunkIndex: 0 }))
      // The worker died before publishing chunk 1; a redelivery recomputes it.
      expect(await store.nextChunk(1)).toBe(1)
      await store.applyChunk(request({ chunkIndex: 2, keys: ['q'] }))
      expect(await store.nextChunk(1)).toBe(1)
      await store.applyChunk(request({ chunkIndex: 1, keys: ['r'] }))
      expect(await store.nextChunk(1)).toBeNull()
      expect((await store.status(1)).status).toBe('complete')
    })

    it('[unit] preview reads report committed state and change none of it', async () => {
      const { store, previewWrites, keyCount } = await ready()
      await store.applyChunk(request({ keys: ['a', 'b'] }))
      const before = { writes: previewWrites(), keys: keyCount(), status: await store.status(1) }
      expect([...(await store.importedKeys('src'))].sort()).toEqual(['a', 'b'])
      expect(await store.destinationVersion()).toBe('v1')
      expect([...(await store.importedKeys('src'))].sort()).toEqual(['a', 'b'])
      expect(previewWrites()).toBe(before.writes)
      expect(keyCount()).toBe(before.keys)
      expect(await store.status(1)).toEqual(before.status)
      // No lease side effect either: the next claim is still the live lease.
      expect(await store.claimLease({ runId: 1, holder: 'w2', now: 10, ttlMs: 1 })).toMatchObject({
        kind: 'held',
      })
    })
  })

runStoreContract('in-memory fake', async () => {
  const fake = new FakeCsvD1()
  return {
    store: fake,
    admit: (actor) => fake.admins.add(actor),
    bumpDestination: () => {
      fake.version = 'v2'
    },
    setup: (runId, chunks, sourceId) => fake.addRun(runId, chunks, sourceId),
    keyCount: () => fake.timeEntries.length,
    previewWrites: () => fake.writes,
    failBatch: () => {
      fake.failNextBatch = true
    },
  }
})

describe('CSV D1 budgets and messages', () => {
  const row = (sourceKey: string, entry: Record<string, string | number | null> = {}) => ({
    sourceKey,
    line: 2,
    entry,
  })

  it('[unit] the default chunk fits the Workers Free query budget of 50', () => {
    expect(D1_MAX_QUERIES_PER_INVOCATION).toBe(50)
    const statements = chunkStatementCount(CSV_D1_CHUNK_ROWS)
    expect(statements).toBe(49)
    expect(() =>
      assertChunkWithinBudget({ statements, maxStatementParameters: 20, maxStatementBytes: 1000 }),
    ).not.toThrow()
    expect(() =>
      assertChunkWithinBudget({
        statements: chunkStatementCount(CSV_D1_CHUNK_ROWS + 1),
        maxStatementParameters: 20,
        maxStatementBytes: 1000,
      }),
    ).toThrow('csv_d1_chunk_too_many_statements')
  })

  it('[unit] the budget is derived from the rows, not supplied by the caller', () => {
    const rows = Array.from({ length: CSV_D1_CHUNK_ROWS }, (_, i) => row(`k${i}`, { seconds: 1 }))
    const budget = chunkBudget(rows)
    expect(budget.statements).toBe(chunkStatementCount(CSV_D1_CHUNK_ROWS))
    expect(budget.maxStatementParameters).toBe(4)
    expect(() => assertChunkWithinBudget(budget)).not.toThrow()

    const wide = Object.fromEntries(
      Array.from({ length: D1_MAX_BOUND_PARAMETERS + 1 }, (_, i) => [`c${i}`, i]),
    )
    expect(() => assertChunkWithinBudget(chunkBudget([row('w', wide)]))).toThrow(
      'csv_d1_chunk_too_many_parameters',
    )
  })

  it('[unit] a statement over the byte budget is refused', () => {
    const big = row('big', { note: 'x'.repeat(D1_MAX_STATEMENT_BYTES) })
    expect(() => assertChunkWithinBudget(chunkBudget([big]))).toThrow(
      'csv_d1_chunk_statement_too_large',
    )
  })

  it('[unit] a chunk past the per-invocation statement budget is refused', () => {
    const rows = D1_MAX_QUERIES_PER_INVOCATION
    expect(() =>
      assertChunkWithinBudget({
        statements: chunkStatementCount(rows),
        maxStatementParameters: 0,
        maxStatementBytes: 0,
      }),
    ).toThrow('csv_d1_chunk_too_many_statements')
  })

  it('[unit] a statement over the bound-parameter budget is refused', () => {
    expect(() =>
      assertChunkWithinBudget({ statements: 1, maxStatementParameters: 101, maxStatementBytes: 0 }),
    ).toThrow('csv_d1_chunk_too_many_parameters')
  })

  it('[unit] a queue message carries identifiers only', () => {
    expect(encodeChunkMessage({ runId: 7, chunkIndex: 3 })).toBe('{"runId":7,"chunkIndex":3}')
    expect(() => encodeChunkMessage({ runId: 1.5, chunkIndex: 0 })).toThrow(
      'csv_d1_message_invalid',
    )
  })
})
