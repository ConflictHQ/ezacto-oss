import type {
  CsvD1ApplyStore,
  CsvD1ChunkOutcome,
  CsvD1ChunkRequest,
  CsvD1LeaseClaim,
  CsvD1PreviewReader,
  CsvD1RunStatusView,
} from '../src/csv-d1-contract.js'

interface Run {
  totalChunks: number
  generation: number
  holder: string | null
  expiresAt: number
  cancelled: boolean
  committed: Map<number, { inserted: number; alreadyImported: number }>
  inserted: number
  alreadyImported: number
  lastErrorCode: string | null
}

/**
 * In-memory reference for the CSV D1 contract. `applyChunk` computes everything
 * first and commits at the end, which models D1 batch atomicity: no path writes
 * part of a chunk. Not a real D1; it states the semantics a real store must match.
 */
export class FakeCsvD1 implements CsvD1ApplyStore, CsvD1PreviewReader {
  readonly timeEntries: Array<{ sourceKey: string; entry: unknown; actorId: string }> = []
  private readonly keys = new Set<string>()
  private readonly runs = new Map<number, Run>()
  admins = new Set<string>()
  version = 'v1'
  /** Writes attempted through any path; preview must leave this at zero. */
  writes = 0
  /** Make the next batch fail after computing, to prove nothing is half-written. */
  failNextBatch = false

  constructor(private readonly sourceId = 'src') {}

  addRun(runId: number, totalChunks: number): void {
    this.runs.set(runId, {
      totalChunks,
      generation: 0,
      holder: null,
      expiresAt: 0,
      cancelled: false,
      committed: new Map(),
      inserted: 0,
      alreadyImported: 0,
      lastErrorCode: null,
    })
  }

  private run(runId: number): Run {
    const run = this.runs.get(runId)
    if (!run) throw new Error('csv_d1_unknown_run')
    return run
  }

  async importedKeys(sourceId: string): Promise<ReadonlySet<string>> {
    return sourceId === this.sourceId ? new Set(this.keys) : new Set()
  }

  async destinationVersion(): Promise<string> {
    return this.version
  }

  async claimLease(input: {
    runId: number
    holder: string
    now: number
    ttlMs: number
  }): Promise<CsvD1LeaseClaim> {
    const run = this.run(input.runId)
    if (run.cancelled) return { kind: 'cancelled' }
    if (run.holder !== null && run.expiresAt > input.now && run.holder !== input.holder) {
      return { kind: 'held', retryAfterMs: run.expiresAt - input.now }
    }
    this.writes += 1
    run.generation += 1
    run.holder = input.holder
    run.expiresAt = input.now + input.ttlMs
    return { kind: 'claimed', generation: run.generation, expiresAt: run.expiresAt }
  }

  async applyChunk(request: CsvD1ChunkRequest): Promise<CsvD1ChunkOutcome> {
    const run = this.run(request.runId)
    // Guard, in the order a batch's first statement would fail.
    if (run.cancelled) return { kind: 'cancelled' }
    if (request.leaseGeneration !== run.generation) return { kind: 'stale_lease' }
    const prior = run.committed.get(request.chunkIndex)
    if (prior) return { kind: 'replayed', ...prior }
    if (!this.admins.has(request.actorId)) return { kind: 'actor_unauthorized' }
    if (request.destinationVersion !== this.version) return { kind: 'destination_stale' }

    const seen = new Set<string>()
    const fresh: CsvD1ChunkRequest['rows'][number][] = []
    let alreadyImported = 0
    for (const row of request.rows) {
      if (this.keys.has(row.sourceKey) || seen.has(row.sourceKey)) alreadyImported += 1
      else {
        seen.add(row.sourceKey)
        fresh.push(row)
      }
    }
    if (this.failNextBatch) {
      this.failNextBatch = false
      run.lastErrorCode = 'storage_failure'
      throw new Error('batch failed')
    }
    this.writes += 1
    for (const row of fresh) {
      this.keys.add(row.sourceKey)
      this.timeEntries.push({
        sourceKey: row.sourceKey,
        entry: row.entry,
        actorId: request.actorId,
      })
    }
    const counts = { inserted: fresh.length, alreadyImported }
    run.committed.set(request.chunkIndex, counts)
    run.inserted += counts.inserted
    run.alreadyImported += counts.alreadyImported
    run.lastErrorCode = null
    return { kind: 'applied', ...counts }
  }

  async nextChunk(runId: number): Promise<number | null> {
    const run = this.run(runId)
    if (run.cancelled) return null
    for (let index = 0; index < run.totalChunks; index += 1) {
      if (!run.committed.has(index)) return index
    }
    return null
  }

  async cancel(runId: number): Promise<void> {
    this.run(runId).cancelled = true
  }

  async status(runId: number): Promise<CsvD1RunStatusView> {
    const run = this.run(runId)
    const complete = run.committed.size === run.totalChunks
    return {
      status: run.cancelled ? 'cancelled' : complete ? 'complete' : 'partial',
      totalChunks: run.totalChunks,
      committedChunks: run.committed.size,
      insertedRows: run.inserted,
      alreadyImportedRows: run.alreadyImported,
      lastErrorCode: run.lastErrorCode,
      retainUntil: null,
    }
  }
}
