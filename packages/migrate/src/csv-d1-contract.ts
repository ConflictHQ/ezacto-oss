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

/**
 * Cloudflare D1 limits this contract budgets against. They come from the D1 limits
 * page as understood when this was written; they are not checked against a live
 * account, so re-verify them when adopting.
 */
export const D1_MAX_BOUND_PARAMETERS = 100
export const D1_MAX_STATEMENT_BYTES = 100_000
/**
 * Queries one Worker invocation may issue. This is the Workers Free plan figure (50);
 * the paid plan allows 1,000. The contract budgets against the lower one so a chunk
 * is valid on either plan.
 */
export const D1_MAX_QUERIES_PER_INVOCATION = 50
export const D1_MAX_QUERIES_PER_INVOCATION_PAID = 1_000
/** A queue message is a pointer to a chunk, never the rows. */
export const QUEUE_MAX_MESSAGE_BYTES = 128 * 1024

/**
 * Rows per chunk. Each row is one time insert plus one ledger insert, and one guard
 * statement leads: 1 + 24 * 2 = 49, inside the 50-query budget.
 */
export const CSV_D1_CHUNK_ROWS = 24
export const CSV_D1_STATEMENTS_PER_ROW = 2
/** One lease/actor guard statement leads every batch. */
export const CSV_D1_GUARD_STATEMENTS = 1

/**
 * `paused` is a run stopped by `actor_unauthorized` or `destination_stale`; its
 * `lastErrorCode` carries that outcome. A later chunk that applies clears it.
 * A failed batch is not a status: the run stays `partial` and records `storage_failure`.
 */
export type CsvD1RunStatus = 'partial' | 'paused' | 'complete' | 'cancelled'

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

/**
 * What a store must prove current at write time, all inside the same batch. The
 * dedup source is the run's `sourceId` (see `CsvD1RunIdentity`); the request does
 * not repeat it.
 */
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
  /**
   * An unexpired lease holds the run, whoever the holder is, including the caller
   * itself. Redeliver later; do not write; the generation does not change.
   */
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
   * `held` for every holder, so a re-claim never fences out the holder's own
   * in-flight write. Generations only increase.
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
   * The lowest uncommitted chunk index of a live (not cancelled) run, or null when
   * every chunk is committed or the run is cancelled. A paused run still reports its
   * next index. Continuation publication is recoverable because the next message is
   * derived from committed state, not from an acknowledged send.
   */
  nextChunk(runId: number): Promise<number | null>

  /** Stops future chunks. Committed rows stay; there is no rollback. */
  cancel(runId: number): Promise<void>

  status(runId: number): Promise<CsvD1RunStatusView>
}

/**
 * Preview on D1 must be a read-only planner. This is the whole surface it may
 * call; it has no write method by construction. Dedup is scoped by source:
 * `importedKeys(sourceId)` returns only the keys recorded under that source, across
 * every run of it, and the same source key under another source is a different row.
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
  /** The largest single statement, in bytes of SQL text plus bound text values. */
  maxStatementBytes: number
}

/** Guard binds run id, lease generation, actor id and destination version. */
export const CSV_D1_GUARD_PARAMETERS = 4
/** Ledger insert binds run id, source id and source key. */
export const CSV_D1_LEDGER_PARAMETERS = 3
/** Allowance for the SQL text of one insert, on top of its bound values. */
export const CSV_D1_STATEMENT_OVERHEAD_BYTES = 1_000

export const chunkStatementCount = (rows: number): number =>
  CSV_D1_GUARD_STATEMENTS + rows * CSV_D1_STATEMENTS_PER_ROW

/**
 * The budget a set of planned rows needs, derived from the rows: statements from
 * the row count, parameters from the widest entry (one bind per entry field) or the
 * guard/ledger statements, bytes from the largest entry plus its source key.
 */
export const chunkBudget = (rows: readonly CsvD1PlannedRow[]): CsvD1Budget => {
  const encoder = new TextEncoder()
  let maxStatementParameters = Math.max(CSV_D1_GUARD_PARAMETERS, CSV_D1_LEDGER_PARAMETERS)
  let maxStatementBytes = CSV_D1_STATEMENT_OVERHEAD_BYTES
  for (const row of rows) {
    maxStatementParameters = Math.max(maxStatementParameters, Object.keys(row.entry).length)
    const bytes =
      CSV_D1_STATEMENT_OVERHEAD_BYTES +
      encoder.encode(JSON.stringify(row.entry)).byteLength +
      encoder.encode(row.sourceKey).byteLength
    maxStatementBytes = Math.max(maxStatementBytes, bytes)
  }
  return { statements: chunkStatementCount(rows.length), maxStatementParameters, maxStatementBytes }
}

/** Throws when a chunk could not be sent as one batch; the planner must split it. */
export const assertChunkWithinBudget = (budget: CsvD1Budget): void => {
  if (budget.statements > D1_MAX_QUERIES_PER_INVOCATION) {
    throw new RangeError('csv_d1_chunk_too_many_statements')
  }
  if (budget.maxStatementParameters > D1_MAX_BOUND_PARAMETERS) {
    throw new RangeError('csv_d1_chunk_too_many_parameters')
  }
  if (budget.maxStatementBytes > D1_MAX_STATEMENT_BYTES) {
    throw new RangeError('csv_d1_chunk_statement_too_large')
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
