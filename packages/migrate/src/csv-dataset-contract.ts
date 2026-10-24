import { sha256Hex } from './portable-hash.js'

/**
 * The sealed-dataset contract of the browser CSV import (issue 1180, plan in
 * docs/import-tools-plan.md). Types, pure identity functions and the ledger
 * port only: no Node fs/crypto/better-sqlite3, so it can load in a Worker.
 * The SQLite and D1 ledgers implement `CsvDatasetLedger`; both must pass
 * `test/csv-dataset-ledger.contract.ts`.
 */

/** The administrator an HTTP caller acts as. There is deliberately no CLI-owner variant. */
export interface AdministratorActor {
  kind: 'administrator'
  userId: string
}

/** What a reviewer confirmed. Every field is part of the plan identity. */
export interface CsvPlanInput {
  /** Stable source workspace/dataset identity, chosen once per instance. */
  datasetId: string
  fileSha256: string
  mappingSha256: string
  adapterId: string
  /** Frozen per run; a bump never reinterprets a prior run. */
  identityVersion: number
  /** `iso` only for the browser contract. */
  dateFormat: 'iso'
  /** IANA zone the exporter wrote wall-clock values in. */
  exporterZone: string
  /** Physical line numbers the reviewer excluded; empty means apply everything. */
  excludedLines: readonly number[]
  /** Opaque digest of destination state the plan depends on (assignments, rates, locks, policy). */
  destinationVersion: string
}

export type CsvRunStatus = 'draft' | 'partial' | 'complete' | 'cancelled'

export interface CsvDatasetRun {
  runId: string
  planId: string
  plan: CsvPlanInput
  status: CsvRunStatus
  /** The administrator who confirmed; null while a draft. */
  actor: AdministratorActor | null
  written: number
  alreadyImported: number
}

export type SealRefusal =
  | 'actor_required'
  | 'different_file'
  | 'different_mapping'
  | 'different_adapter'
  | 'different_selection'
  | 'different_destination'
  | 'stale_plan'
  | 'unknown_run'
  | 'not_confirmed'

export type SealResult =
  | { outcome: 'created'; run: CsvDatasetRun }
  | { outcome: 'reopened'; run: CsvDatasetRun }
  | { outcome: 'blocked'; reason: SealRefusal; run: CsvDatasetRun | null }

export type CommitResult = { outcome: 'written' } | { outcome: 'duplicate' }

/** A time entry as the ledger sees it; the real writer owns every other column. */
export interface CsvTimeEntry {
  line: number
  seconds: number
}

/**
 * Persistence for sealed datasets. Implementations must make `commitEntry`
 * insert the time and record its dedup key as one atomic unit, so double
 * delivery or concurrent replay can never produce a second time entry.
 */
export interface CsvDatasetLedger {
  /**
   * Draft: no run exists for the dataset, or its run is still a draft (the old
   * preview is discarded, nothing else changes). Once confirmed, only an
   * identical plan reopens the run; anything else is blocked. Never mints a
   * new dataset id.
   */
  seal(actor: AdministratorActor, plan: CsvPlanInput, confirm: boolean): Promise<SealResult>
  getRun(runId: string): Promise<CsvDatasetRun | null>
  /**
   * Record one row under the confirmed plan. `planId` must match the run's
   * sealed plan, `line` must not be excluded, and the actor must be a
   * current administrator (`actor_required` otherwise).
   */
  commitEntry(
    actor: AdministratorActor,
    runId: string,
    planId: string,
    sourceKey: string,
    entry: CsvTimeEntry,
  ): Promise<CommitResult>
  finish(runId: string, status: 'complete' | 'cancelled'): Promise<void>
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )

/**
 * The opaque identity a confirmation binds to. Exclusions are sorted and
 * de-duplicated first, so order cannot change it; any other field change does.
 */
export const csvPlanId = (plan: CsvPlanInput): string =>
  sha256Hex(
    canonical({
      ...plan,
      excludedLines: [...new Set(plan.excludedLines)].sort((a, b) => a - b),
    }),
  )

/** Why two plans for the same dataset are not the same sealed dataset. */
export const csvPlanDifference = (
  sealed: CsvPlanInput,
  next: CsvPlanInput,
): Exclude<
  SealRefusal,
  'actor_required' | 'stale_plan' | 'unknown_run' | 'not_confirmed'
> | null => {
  if (sealed.fileSha256 !== next.fileSha256) return 'different_file'
  if (sealed.mappingSha256 !== next.mappingSha256) return 'different_mapping'
  if (sealed.adapterId !== next.adapterId || sealed.identityVersion !== next.identityVersion)
    return 'different_adapter'
  if (
    csvPlanId({ ...sealed, destinationVersion: '' }) !==
    csvPlanId({ ...next, destinationVersion: '' })
  )
    return 'different_selection'
  if (sealed.destinationVersion !== next.destinationVersion) return 'different_destination'
  return null
}
