import type { CsvStagingAuthority } from '@ezacto/core'
import type { CsvBrowserPlan } from './csv-planner.js'
import type { CsvBrowserMapping } from './csv-browser-mapping.js'

/** Server-only composition between private admission (#1181) and apply (#1183).
 * No method here is a browser DTO or authorizes a write merely by possessing an id. */
export interface CsvOwnedStagedPreview {
  stageId: string
  stageVersion: number
  targetNonce: string
  creatorUserId: number
  authority: CsvStagingAuthority
  previewId: string
  sourceId: string
  fileSha256: string
  fileBytes: number
  mappingSha256: string
  stagingExpiresAt: string
  inputExpiresAt: string
  retentionDeadline: string | null
  stale: boolean
  choices: {
    workspaceIdentity: string
    exporterZone: string
    mapping: CsvBrowserMapping
    excludedLines: readonly number[]
  }
  plan: CsvBrowserPlan
  bytes: Uint8Array
}
export interface CsvStagingApplyBinding {
  stageId: string
  stageVersion: number
  targetNonce: string
  previewId: string
  nativeRunId: number
  leaseGeneration: number
  commandId: string
}
export type CsvStagingApplyState =
  'queued' | 'running' | 'paused' | 'partial' | 'completed' | 'cancelled' | 'failed'
export interface CsvStagingApplyPort {
  /** Claim before reading cached bytes can lead to a native seal. Blocks purge;
   * a repeated command returns the same claim, a different command refuses. */
  claimConfirmation(
    authority: CsvStagingAuthority,
    input: { stageId: string; previewId: string; expectedVersion: number; commandId: string },
  ): Promise<{ stageVersion: number; commandId: string; targetNonce: string }>

  loadOwnedPreview(
    authority: CsvStagingAuthority,
    stageId: string,
    previewId: string,
  ): Promise<CsvOwnedStagedPreview>
  bindConfirmedRun(
    authority: CsvStagingAuthority,
    binding: CsvStagingApplyBinding,
  ): Promise<CsvStagingApplyBinding>
  /** Trusted system metadata only. Verify current native input association,
   * incarnation, generation and CAS; never read raw files after session loss. */
  markSystemProgress(
    binding: CsvStagingApplyBinding,
    state: CsvStagingApplyState,
    code?: string,
    terminalAt?: string,
  ): Promise<CsvStagingApplyBinding | null>
}
