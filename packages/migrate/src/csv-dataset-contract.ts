/**
 * The sealed-dataset contract of the browser CSV import (issue 1180, plan in
 * docs/import-tools-plan.md). Types, pure identity functions and the ledger
 * port only: no Node fs/crypto/better-sqlite3, so it can load in a Worker.
 * The SQLite and D1 ledgers implement `CsvDatasetLedger`; both must pass
 * `test/csv-dataset-ledger.contract.ts`.
 */

export { csvPlanId, csvPlanDifference } from '@ezacto/core'
export type {
  AdministratorActor,
  CsvPlanInput,
  CsvRunStatus,
  CsvDatasetRun,
  SealRefusal,
  SealResult,
  CommitResult,
} from '@ezacto/core'
import type {
  AdministratorActor,
  CsvPlanInput,
  CsvDatasetRun,
  SealResult,
  CommitResult,
} from '@ezacto/core'

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
