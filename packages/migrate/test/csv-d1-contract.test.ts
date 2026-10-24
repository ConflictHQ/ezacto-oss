import { describe, expect, it } from 'vitest'
import {
  CSV_D1_CHUNK_ROWS,
  D1_MAX_QUERIES_PER_INVOCATION,
  assertChunkWithinBudget,
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
    setup: (runId: number, chunks: number) => void
    keyCount: () => number
    previewWrites: () => number
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

    it('[unit] a revoked administrator or a changed destination pauses without writing', async () => {
      const subject = await ready()
      expect(await subject.store.applyChunk(request({ actorId: 'nobody' }))).toEqual({
        kind: 'actor_unauthorized',
      })
      subject.bumpDestination()
      expect(await subject.store.applyChunk(request())).toEqual({ kind: 'destination_stale' })
      expect(subject.keyCount()).toBe(0)
    })

    it('[unit] a failed batch leaves no time and no key, and the chunk can be retried', async () => {
      const subject = await ready()
      ;(subject.store as FakeCsvD1).failNextBatch = true
      await expect(subject.store.applyChunk(request())).rejects.toThrow()
      expect(subject.keyCount()).toBe(0)
      expect((await subject.store.status(1)).lastErrorCode).toBe('storage_failure')
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

    it('[unit] preview reads never reach a write path', async () => {
      const { store, previewWrites } = await ready()
      const before = previewWrites()
      await store.importedKeys('src')
      await store.destinationVersion()
      expect(previewWrites()).toBe(before)
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
    setup: (runId, chunks) => fake.addRun(runId, chunks),
    keyCount: () => fake.timeEntries.length,
    previewWrites: () => fake.writes,
  }
})

describe('CSV D1 budgets and messages', () => {
  it('[unit] the default chunk fits one batch with room to spare', () => {
    const statements = chunkStatementCount(CSV_D1_CHUNK_ROWS)
    expect(statements).toBe(51)
    expect(() => assertChunkWithinBudget({ statements, maxStatementParameters: 20 })).not.toThrow()
  })

  it('[unit] a chunk past the per-invocation statement budget is refused', () => {
    const rows = D1_MAX_QUERIES_PER_INVOCATION
    expect(() =>
      assertChunkWithinBudget({ statements: chunkStatementCount(rows), maxStatementParameters: 0 }),
    ).toThrow('csv_d1_chunk_too_many_statements')
  })

  it('[unit] a statement over the bound-parameter budget is refused', () => {
    expect(() => assertChunkWithinBudget({ statements: 1, maxStatementParameters: 101 })).toThrow(
      'csv_d1_chunk_too_many_parameters',
    )
  })

  it('[unit] a queue message carries identifiers only', () => {
    expect(encodeChunkMessage({ runId: 7, chunkIndex: 3 })).toBe('{"runId":7,"chunkIndex":3}')
    expect(() => encodeChunkMessage({ runId: 1.5, chunkIndex: 0 })).toThrow(
      'csv_d1_message_invalid',
    )
  })
})
