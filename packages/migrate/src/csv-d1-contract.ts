/**
 * The Worker/D1 runtime contract of the CSV time import (issue 1184, parent 1012).
 *
 * Types and pure budget checks only. Nothing here reads a file, opens a database,
 * touches a queue or imports a Node-only module, so a Worker bundle can import it.
 * A real D1 implementation must satisfy `test/csv-d1-contract.test.ts`; the
 * in-memory fake in `test/csv-d1-fake.ts` is the reference for the semantics.
 * The prose is `docs/csv-d1-contract.md`.
 *
 * It composes with, and does not replace, the planner/ports of issue 1180 and the
 * apply orchestration of issue 1183: those decide what a chunk contains; this says
 * what a D1 store must guarantee when a chunk is written.
 */

/** Cloudflare D1 limits this contract budgets against. Check them when adopting. */
export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_MAX_STATEMENT_BYTES = 100_000
/** Statements one Worker invocation may issue; a chunk uses a fraction of it. */
export const D1_MAX_QUERIES_PER_INVOCATION = 1_000
/** A queue message is a pointer to a chunk, never the rows. */
export const QUEUE_MAX_MESSAGE_BYTES = 128 * 1024

/** Rows per chunk. Each row is one time insert plus one ledger insert. */
export const CSV_D1_CHUNK_ROWS = 25
export const CSV_D1_STATEMENTS_PER_ROW = 2
/** One lease/actor guard statement leads every batch. */
export const CSV_D1_GUARD_STATEMENTS = 1

export type CsvD1RunStatus = 'partial' | 'complete' | 'aborted' | 'cancelled' | 'failed'

/** Identity of a run: the sealed dataset. Matches `csv_import_runs` today. */
export interface CsvD1RunIdentity {
  sourceId: string
  fileSha256: string
  mappingSha256: string
  /** Adapter and dedup-identity version; a retry may not change it. */
  identityVersion: string
  /** Hash of the explicit exclusion list persisted with the plan. */
  exclusionsSha256: string
}

/** One planned row, already decided by the planner. The store never re-plans. */
export interface CsvD1PlannedRow {
  /** Source key from `sourceKeys` (content hash plus identical-row occurrence). */
  sourceKey: string
  /** Physical line, for safe status codes; never row content. */
  line: number
  /** Opaque to the store: the time-entry values the normal writer will insert. */
  entry: Readonly<Record<string, string | number | null>>
}

/** What a store must prove current at write time, all inside the same batch. */
export interface CsvD1ChunkRequest {
  runId: number
  /** Position in the immutable plan. (runId, chunkIndex) is the idempotency key. */
  chunkIndex: number
  rows: readonly CsvD1PlannedRow[]
  /** Lease generation this writer claimed. A newer generation fences this one out. */
  leaseGeneration: number
  /** The administrator who confirmed the run; rechecked, never impersonated. */
  actorId: string
  /** Version stamp of the mappings/policies/assignments the preview bound to. */
  destinationVersion: string
  now: string
}

export type CsvD1ChunkOutcome =
  | { kind: 'applied'; inserted: number; alreadyImported: number }
  /** Same (runId, chunkIndex) was already committed; counts repeat, nothing written. */
  | { kind: 'replayed'; inserted: number; alreadyImported: number }
  | { kind: 'stale_lease' }
  | { kind: 'cancelled' }
  /** Actor is no longer an active administrator. Run pauses; nothing written. */
  | { kind: 'actor_unauthorized' }
  /** Destination changed since preview. Run pauses for a fresh preview. */
  | { kind: 'destination_stale' }

export type CsvD1LeaseClaim =
  | { kind: 'claimed'; generation: number; expiresAt: number }
  /** Another unexpired lease holds the run. Redeliver later; do not write. */
  | { kind: 'held'; retryAfterMs: number }
  | { kind: 'cancelled' }

export interface CsvD1RunStatusView {
  status: CsvD1RunStatus
  totalChunks: number
  committedChunks: number
  insertedRows: number
  alreadyImportedRows: number
  /** Safe code only: no emails, notes, cell content or filenames. */
  lastErrorCode: string | null
  /** Staged input is purged by this instant; dedup and audit outlive it. */
  retainUntil: string | null
}

/**
 * What a D1-backed apply store must implement. Implementations use `D1Database.batch`
 * (atomic) and never interactive transactions, which D1 does not provide.
 */
export interface CsvD1ApplyStore {
  /**
   * Claim the run. A lapsed lease is replaced with generation + 1; a live one is
   * `held`. Generations only increase.
   */
  claimLease(input: {
    runId: number
    holder: string
    now: number
    ttlMs: number
  }): Promise<CsvD1LeaseClaim>

  /**
   * Write one chunk as a single atomic batch: a guard statement (lease generation,
   * run not cancelled, actor still admin, destination version) followed by, per row
   * not already keyed, the time insert and its ledger insert together. A failed
   * guard writes nothing. A duplicate source key is skipped and counted, never an
   * error and never a second time entry.
   */
  applyChunk(request: CsvD1ChunkRequest): Promise<CsvD1ChunkOutcome>

  /**
   * The lowest uncommitted chunk index of a live run, or null when every chunk is
   * committed. Continuation publication is recoverable because the next message is
   * derived from committed state, not from an acknowledged send.
   */
  nextChunk(runId: number): Promise<number | null>

  /** Stops future chunks. Committed rows stay; there is no rollback. */
  cancel(runId: number): Promise<void>

  status(runId: number): Promise<CsvD1RunStatusView>
}

/**
 * Preview on D1 must be a read-only planner. This is the whole surface it may
 * call; it has no write method by construction, and a conforming fake counts any
 * attempt to reach a write path.
 */
export interface CsvD1PreviewReader {
  importedKeys(sourceId: string): Promise<ReadonlySet<string>>
  destinationVersion(): Promise<string>
}

/** A chunk's statement count and per-statement parameters must fit D1 before it is sent. */
export interface CsvD1Budget {
  statements: number
  /** The most bound parameters any one statement in the chunk uses. */
  maxStatementParameters: number
}

export const chunkStatementCount = (rows: number): number =>
  CSV_D1_GUARD_STATEMENTS + rows * CSV_D1_STATEMENTS_PER_ROW

/** Throws when a chunk could not be sent as one batch; the planner must split it. */
export const assertChunkWithinBudget = (budget: CsvD1Budget): void => {
  if (budget.statements > D1_MAX_QUERIES_PER_INVOCATION) {
    throw new RangeError('csv_d1_chunk_too_many_statements')
  }
  if (budget.maxStatementParameters > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError('csv_d1_chunk_too_many_parameters')
  }
}

/**
 * Queue message for a chunk. Carries identifiers only, so it is far below the
 * message limit and holds no row content. Delivery is at-least-once and unordered.
 */
export interface CsvD1ChunkMessage {
  runId: number
  chunkIndex: number
}

export const encodeChunkMessage = (message: CsvD1ChunkMessage): string => {
  if (!Number.isSafeInteger(message.runId) || !Number.isSafeInteger(message.chunkIndex)) {
    throw new RangeError('csv_d1_message_invalid')
  }
  const body = JSON.stringify({ runId: message.runId, chunkIndex: message.chunkIndex })
  if (new TextEncoder().encode(body).byteLength > QUEUE_MAX_MESSAGE_BYTES) {
    throw new RangeError('csv_d1_message_too_large')
  }
  return body
}
