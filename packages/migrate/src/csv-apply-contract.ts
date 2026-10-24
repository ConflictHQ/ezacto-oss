/**
 * Contract only (issue 1183, plan: docs/import-tools-plan.md). The interface a
 * durable browser apply of a sealed CSV dataset must satisfy, and the reference
 * driver that orchestrates it. No storage, queue, route or runtime lives here:
 * rows are written by the existing CSV writer behind `ApplyStore`, so this adds
 * no second loader. Nothing imports this module from production code until the
 * staging API (issue 1181) and planner (issue 1180) exist.
 *
 * Invariants any `ApplyStore` must hold (pinned by test/csv-apply-suite.ts):
 *  1. One run per (destination, sourceId, fileSha256); creating it again returns it.
 *  2. At most one live lease per (destination, sourceId). Each acquisition gets a
 *     strictly larger fence; a write under any other fence throws `stale-lease`.
 *  3. A row's time and its source key commit together or not at all; a key that
 *     is already recorded counts as `alreadyImported`, never as a second entry.
 *  4. The plan (selection, mapping hash, adapter version, actor) never changes
 *     after creation.
 *  5. Cancel stops future chunks; committed rows stay. Nothing is rolled back.
 *  6. Status carries counts, safe codes and the retention deadline only, never
 *     emails, notes, cell contents or file names.
 */

export const MAX_CHUNK_ROWS = 500
export const MAX_ATTEMPTS = 3
export const LEASE_TTL_MS = 60_000
export const RETENTION_MS = 24 * 60 * 60 * 1000

export type ApplyState =
  'ready' | 'running' | 'paused' | 'cancelled' | 'complete' | 'partial' | 'failed'

/** Safe, enumerable codes; the only error text status may carry. */
export type ApplyCode =
  | 'authority-revoked'
  | 'authority-expired'
  | 'policy-changed'
  | 'parse-rejected'
  | 'storage-unavailable'
  | 'cancelled-by-administrator'

export type ApplyErrorClass = 'parse' | 'policy' | 'storage' | 'stale-lease'

export class ApplyError extends Error {
  constructor(readonly errorClass: ApplyErrorClass) {
    super(errorClass)
  }
}

/** Immutable once created. Rejected rows are never applied; exclusions are explicit. */
export interface SealedPlan {
  destinationId: string
  sourceId: string
  fileSha256: string
  mappingSha256: string
  adapterVersion: string
  actorId: string
  totalRows: number
  excludedRows: number
  /** Source seconds of every row in the selection, before destination rounding. */
  sourceSeconds: number
}

export interface ApplyRow {
  sourceKey: string
  sourceSeconds: number
  /** Seconds after the destination's normal rounding. */
  destinationSeconds: number
}

export interface ApplyChunk {
  index: number
  rows: ApplyRow[]
}

export interface Lease {
  runId: string
  holder: string
  fence: number
  expiresAt: string
}

export interface ChunkResult {
  inserted: number
  alreadyImported: number
  destinationSeconds: number
}

export interface ApplyStatus {
  runId: string
  state: ApplyState
  code: ApplyCode | null
  totalRows: number
  excludedRows: number
  applied: number
  alreadyImported: number
  sourceSeconds: number
  destinationSeconds: number
  retentionDeadline: string
}

export interface ApplyStore {
  /** Idempotent on (destinationId, sourceId, fileSha256) (invariant 1). */
  createRun(plan: SealedPlan, chunks: ApplyChunk[], now: string): Promise<ApplyStatus>
  plan(runId: string): Promise<SealedPlan>
  /** Null when another live lease holds the destination/source (invariant 2). */
  acquireLease(runId: string, holder: string, now: string): Promise<Lease | null>
  /** The first chunk not yet committed, or null when none remain. */
  nextChunk(runId: string): Promise<ApplyChunk | null>
  /** Atomic per row (invariant 3); idempotent when the chunk is delivered twice. */
  commitChunk(lease: Lease, chunk: ApplyChunk, now: string): Promise<ChunkResult>
  /** Fenced; throws `stale-lease` for an old generation. */
  setState(lease: Lease, state: ApplyState, code: ApplyCode | null, now: string): Promise<void>
  /** Not fenced: an administrator may cancel while another worker holds the lease. */
  cancel(runId: string, now: string): Promise<void>
  status(runId: string): Promise<ApplyStatus>
}

/** Rechecked before every chunk against the current administrator and row policies. */
export interface AuthorityPort {
  check(actorId: string): Promise<'ok' | 'revoked' | 'expired'>
  policyVersionMatches(runId: string): Promise<boolean>
}

const TERMINAL: ReadonlySet<ApplyState> = new Set(['cancelled', 'complete', 'failed'])

/**
 * Drives one lease until the run completes, pauses or fails. Returns the status
 * it ends on. Safe to call again after any outcome except a terminal one.
 */
export const driveApply = async (
  deps: { store: ApplyStore; authority: AuthorityPort; now: () => string },
  runId: string,
  holder: string,
): Promise<ApplyStatus> => {
  const { store, authority, now } = deps
  const before = await store.status(runId)
  if (TERMINAL.has(before.state)) return before
  const lease = await store.acquireLease(runId, holder, now())
  if (lease === null) return before
  const { actorId } = await store.plan(runId)
  try {
    await store.setState(lease, 'running', null, now())
    for (;;) {
      if ((await store.status(runId)).state === 'cancelled') return await store.status(runId)
      const access = await authority.check(actorId)
      if (access !== 'ok') {
        await store.setState(
          lease,
          'paused',
          access === 'revoked' ? 'authority-revoked' : 'authority-expired',
          now(),
        )
        break
      }
      if (!(await authority.policyVersionMatches(runId))) {
        await store.setState(lease, 'paused', 'policy-changed', now())
        break
      }
      const chunk = await store.nextChunk(runId)
      if (chunk === null) {
        await store.setState(lease, 'complete', null, now())
        break
      }
      let attempt = 0
      for (;;) {
        attempt += 1
        try {
          await store.commitChunk(lease, chunk, now())
          break
        } catch (error) {
          const errorClass = error instanceof ApplyError ? error.errorClass : 'storage'
          if (errorClass === 'storage' && attempt < MAX_ATTEMPTS) continue
          throw new ApplyError(errorClass)
        }
      }
    }
  } catch (error) {
    if (!(error instanceof ApplyError) || error.errorClass === 'stale-lease') {
      if (error instanceof ApplyError) return await store.status(runId)
      throw error
    }
    if (error.errorClass === 'parse') {
      await store.setState(lease, 'failed', 'parse-rejected', now())
    } else if (error.errorClass === 'policy') {
      await store.setState(lease, 'paused', 'policy-changed', now())
    } else {
      await store.setState(lease, 'partial', 'storage-unavailable', now())
    }
  }
  return await store.status(runId)
}

export interface Reconciliation {
  countsMatch: boolean
  /** Destination minus source seconds; any nonzero value needs acknowledgement. */
  roundingDeltaSeconds: number
  needsRoundingAcknowledgement: boolean
  /** Monetary source parity is excluded by the plan; there is deliberately no money field. */
  excluded: { rows: number }
}

/** Exact source/destination counts and seconds for a finished or partial run. */
export const reconcile = (plan: SealedPlan, status: ApplyStatus): Reconciliation => {
  const expected = plan.totalRows - plan.excludedRows
  const roundingDeltaSeconds = status.destinationSeconds - status.sourceSeconds
  return {
    countsMatch: status.applied + status.alreadyImported === expected,
    roundingDeltaSeconds,
    needsRoundingAcknowledgement: roundingDeltaSeconds !== 0,
    excluded: { rows: plan.excludedRows },
  }
}
