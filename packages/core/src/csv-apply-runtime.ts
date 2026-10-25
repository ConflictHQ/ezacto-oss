import type { CsvStagingAuthority } from "./csv-staging.js";

export type CsvApplyState =
  | "queued"
  | "running"
  | "paused"
  | "partial"
  | "failed"
  | "complete"
  | "cancelled";
export type CsvApplyCode =
  | "authority_expired"
  | "authority_revoked"
  | "input_expired"
  | "input_unavailable"
  | "policy_changed"
  | "parse_rejected"
  | "storage_unavailable"
  | "cancelled_by_administrator";

/** Private process context: sessionRowId is a database row reference, never a cookie. */
export interface CsvApplyContext {
  runId: string;
  stageId: string;
  stageVersion: number;
  previewId: string;
  targetNonce: string;
  authority: CsvStagingAuthority;
  inputExpiresAt: string;
  commandId: string;
  confirmationCommandId: string;
  requestJson: string;
  sourceSecondsTotal: number;
  acknowledgedDestinationDelta: number;
  ready: boolean;
  state: CsvApplyState;
  code: CsvApplyCode | null;
  attempts: number;
  failureChunk: number | null;
  nextAttemptAt: string | null;
  committedRows: number;
  selectedRows: number;
  fileRows: number;
  leaseGeneration: number;
  leaseHolder: string | null;
  leaseExpiresAt: number | null;
  nativeState: "draft" | "partial" | "complete" | "cancelled";
  finishedAt: string | null;
}
export interface CsvApplyAuthorization {
  runId: string;
  stageId: string;
  stageVersion: number;
  previewId: string;
  targetNonce: string;
  authority: CsvStagingAuthority;
  inputExpiresAt: string;
  commandId: string;
  confirmationCommandId: string;
  requestJson: string;
  planId: string;
  sourceSecondsTotal: number;
  acknowledgedDestinationDelta: number;
}
export interface CsvApplyLease {
  runId: string;
  holder: string;
  generation: number;
}
export class CsvApplyRefusal extends Error {
  constructor(
    readonly code:
      | "run_not_found"
      | "authority_required"
      | "input_expired"
      | "binding_mismatch"
      | "apply_busy"
      | "cancelled"
      | "stale_lease"
      | "command_conflict"
      | "invalid_command"
      | "command_limit_reached",
  ) {
    super(code);
    this.name = "CsvApplyRefusal";
  }
}

/** Safe confirmation metadata; contains no CSV cells, names, credentials or paths. */
export interface CsvApplyCommand {
  preview_id: string;
  command_id: string;
  version: number;
  expected_selected_rows: number;
  expected_source_seconds: number;
  expected_destination_seconds: number;
  acknowledge_exclusions: boolean;
  acknowledge_destination_difference: boolean;
  acknowledge_new_people: boolean;
}
export const canonicalCsvApplyCommand = (
  value: unknown,
): { command: CsvApplyCommand; json: string } => {
  const keys = [
    "preview_id",
    "command_id",
    "version",
    "expected_selected_rows",
    "expected_source_seconds",
    "expected_destination_seconds",
    "acknowledge_exclusions",
    "acknowledge_destination_difference",
    "acknowledge_new_people",
  ] as const;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CsvApplyRefusal("invalid_command");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some(
      (key) => !keys.includes(key as (typeof keys)[number]),
    )
  )
    throw new CsvApplyRefusal("invalid_command");
  if (
    typeof record.preview_id !== "string" ||
    !/^preview_[a-f0-9]{64}$/.test(record.preview_id) ||
    typeof record.command_id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(record.command_id)
  )
    throw new CsvApplyRefusal("invalid_command");
  for (const key of [
    "version",
    "expected_selected_rows",
    "expected_source_seconds",
    "expected_destination_seconds",
  ] as const) {
    const number = record[key];
    const max =
      key === "expected_selected_rows"
        ? 50000
        : key === "expected_source_seconds"
          ? 4320000000
          : Number.MAX_SAFE_INTEGER;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < (key === "version" ? 1 : 0) ||
      number > max
    )
      throw new CsvApplyRefusal("invalid_command");
  }
  for (const key of [
    "acknowledge_exclusions",
    "acknowledge_destination_difference",
    "acknowledge_new_people",
  ] as const)
    if (typeof record[key] !== "boolean")
      throw new CsvApplyRefusal("invalid_command");
  const json = JSON.stringify(
    Object.fromEntries([...keys].sort().map((key) => [key, record[key]])),
  );
  return { command: JSON.parse(json) as CsvApplyCommand, json };
};
