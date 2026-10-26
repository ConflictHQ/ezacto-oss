export interface DeelStageAuthority {
  userId: number;
  sessionId: number;
}
export interface DeelStageSelection {
  from: string;
  to: string;
  userIds: readonly number[];
}
export interface DeelStageCommand extends DeelStageSelection {
  id: string;
  fingerprint: string;
}
export interface DeelStageResult {
  status: "staged" | "attention" | "running" | "stale" | "busy";
  commandId: string;
  runId: number | null;
  timesheetsStaged: number;
  entriesStaged: number;
  alreadyStaged: number;
  unresolved: readonly number[];
  code: string | null;
}
export interface DeelStagePreview {
  status: "ready";
  selection: DeelStageSelection;
  fingerprint: string;
  entryIds: readonly number[];
  seconds: number;
  timesheets: number;
  alreadyStaged: number;
  people: readonly {
    userId: number;
    contractId: string | null;
    seconds: number;
    entries: number;
  }[];
  conflicts: readonly number[];
  unsyncable: readonly number[];
  unmatched: readonly { userId: number; reason: string }[];
  unresolved: readonly number[];
}
export class DeelStageError extends Error {
  constructor(
    readonly code:
      | "unconfigured"
      | "invalid"
      | "forbidden"
      | "stale"
      | "provider_unavailable"
      | "command_reused",
  ) {
    super("The Deel staging request could not be completed.");
    this.name = "DeelStageError";
  }
}
