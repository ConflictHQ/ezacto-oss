import type { CsvStagingAuthority } from "@ezacto/core";

/** Apply data is metadata only. No CSV cells, session references or disk paths may be serialized. */
export type CsvApplyPublicState =
  | "not_confirmed"
  | "queued"
  | "running"
  | "paused"
  | "partial"
  | "completed"
  | "cancelled"
  | "failed"
  | "superseded";
export type CsvApplyPublicCode =
  | "authority_expired"
  | "authority_revoked"
  | "input_expired"
  | "input_unavailable"
  | "policy_changed"
  | "parse_rejected"
  | "storage_unavailable"
  | "cancelled_by_administrator"
  | null;
export interface CsvApplyRunData {
  stage_id: string;
  preview_id: string | null;
  state: CsvApplyPublicState;
  code: CsvApplyPublicCode;
  command_id: string | null;
  command_known: boolean;
  pending_command: CsvApplyCommand | null;
  file_rows: number;
  selected_rows: number;
  excluded_rows: number;
  committed_rows: number;
  inserted_rows: number;
  already_imported_rows: number;
  created_setup: number;
  source_seconds_total: number | null;
  source_seconds_committed: number;
  destination_seconds: number;
  destination_delta_seconds: number;
  deleted_imported_rows: number;
  retention_deadline: string | null;
  retryable: boolean;
  allowed_actions: readonly (
    "apply" | "resume" | "cancel" | "inspect" | "purge" | "reconcile"
  )[];
}
export type { CsvApplyCommand } from "@ezacto/core";
import type { CsvApplyCommand } from "@ezacto/core";
export interface CsvCancelCommand {
  command_id: string;
}
/** Actual Container composition installs this only when the complete owned chain is enabled. */
export interface CsvImportApplyPort {
  apply(
    authority: CsvStagingAuthority,
    stageId: string,
    command: CsvApplyCommand,
  ): Promise<CsvApplyRunData>;
  resume(
    authority: CsvStagingAuthority,
    stageId: string,
    command: CsvApplyCommand,
  ): Promise<CsvApplyRunData>;
  status(
    authority: CsvStagingAuthority,
    stageId: string,
    commandId?: string,
  ): Promise<CsvApplyRunData>;
  cancel(
    authority: CsvStagingAuthority,
    stageId: string,
    command: CsvCancelCommand,
  ): Promise<CsvApplyRunData>;
}
