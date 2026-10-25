import type {
  GeneralMutationInput,
  GeneralResourceRecord,
} from "./general-resources.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
const sha256Hex = (value: string): string =>
  bytesToHex(sha256(new TextEncoder().encode(value)));

export const CSV_BROWSER_MAX_DATA_ROWS = 50_000;

/** The administrator an HTTP caller acts as. There is deliberately no CLI-owner variant. */
export interface AdministratorActor {
  kind: "administrator";
  userId: string;
}

/** What a reviewer confirmed. Every field is part of the plan identity. */
export interface CsvPlanInput {
  /** Stable source workspace/dataset identity, chosen once per instance. */
  datasetId: string;
  fileSha256: string;
  mappingSha256: string;
  adapterId: string;
  /** Frozen per run; a bump never reinterprets a prior run. */
  identityVersion: number;
  /** `iso` only for the browser contract. */
  dateFormat: "iso";
  /** IANA zone the exporter wrote wall-clock values in. */
  exporterZone: string;
  /** Physical line numbers the reviewer excluded; empty means apply everything. */
  excludedLines: readonly number[];
  /** Opaque digest of destination state the plan depends on (assignments, rates, locks, policy). */
  destinationVersion: string;
  /** Logical data rows, excluding the header. Required by the native ledger. */
  fileRows?: number;
  /** Immutable selected rows after explicit exclusions. Required natively. */
  selectedRows?: number;
  /** Server-owned selector/facts manifest for the native atomic predicate.
   * Never include this private field in a browser-facing preview response. */
  destinationFacts?: string;
}

export type CsvRunStatus = "draft" | "partial" | "complete" | "cancelled";

export interface CsvDatasetRun {
  runId: string;
  planId: string;
  plan: CsvPlanInput;
  status: CsvRunStatus;
  /** The administrator who confirmed; null while a draft. */
  actor: AdministratorActor | null;
  written: number;
  alreadyImported: number;
}

export type SealRefusal =
  | "actor_required"
  | "different_file"
  | "different_mapping"
  | "different_adapter"
  | "different_selection"
  | "different_destination"
  | "stale_plan"
  | "unknown_run"
  | "not_confirmed";

export type SealResult =
  | { outcome: "created"; run: CsvDatasetRun }
  | { outcome: "reopened"; run: CsvDatasetRun }
  | { outcome: "blocked"; reason: SealRefusal; run: CsvDatasetRun | null };

export type CommitResult = { outcome: "written" } | { outcome: "duplicate" };

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );

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
  );

/** Why two plans for the same dataset are not the same sealed dataset. */
export const csvPlanDifference = (
  sealed: CsvPlanInput,
  next: CsvPlanInput,
): Exclude<
  SealRefusal,
  "actor_required" | "stale_plan" | "unknown_run" | "not_confirmed"
> | null => {
  if (sealed.fileSha256 !== next.fileSha256) return "different_file";
  if (sealed.mappingSha256 !== next.mappingSha256) return "different_mapping";
  if (
    sealed.adapterId !== next.adapterId ||
    sealed.identityVersion !== next.identityVersion
  )
    return "different_adapter";
  const sealedSelection = { ...sealed, destinationVersion: "" };
  const nextSelection = { ...next, destinationVersion: "" };
  delete sealedSelection.destinationFacts;
  delete nextSelection.destinationFacts;
  if (csvPlanId(sealedSelection) !== csvPlanId(nextSelection))
    return "different_selection";
  if (
    sealed.destinationVersion !== next.destinationVersion ||
    sealed.destinationFacts !== next.destinationFacts
  )
    return "different_destination";
  return null;
};

/** Canonical stopped time-entry input, structurally accepted by the tracked writer.
 * Source seconds are separate: organization rounding remains the writer's policy. */
export interface CsvBrowserTimeEntry {
  userId?: number;
  projectId: number;
  taskId: number;
  spentDate: string;
  seconds?: number;
  startedTime?: string;
  endedTime?: string;
  notes?: string | null;
  budgeted?: boolean;
}
export interface CsvBrowserLease {
  holder: string;
  generation: number;
  expiresAt: number;
}
export interface CsvBrowserCommit {
  runId: string;
  planId: string;
  holder: string;
  leaseGeneration: number;
  /** Durable, zero-based chunk position. This first native adapter commits one row per chunk. */
  chunkIndex: number;
  sourceKey: string;
  line: number;
  sourceSeconds: number;
  entry: CsvBrowserTimeEntry;
}
export type CsvBrowserSetupKind =
  | "users"
  | "clients"
  | "projects"
  | "tasks"
  | "user-assignments"
  | "task-assignments";
export interface CsvBrowserSetup {
  runId: string;
  planId: string;
  holder: string;
  leaseGeneration: number;
  setupKey: string;
  kind: CsvBrowserSetupKind;
  input: GeneralMutationInput;
}
export type CsvBrowserExisting = Omit<CsvBrowserCommit, 'entry'>
export interface CsvBrowserDatasetLedger {
  acknowledgeExisting(actor: AdministratorActor, input: CsvBrowserExisting): Promise<CommitResult>
  setup(
    actor: AdministratorActor,
    input: CsvBrowserSetup,
  ): Promise<GeneralResourceRecord>;

  registerDataset(
    actor: AdministratorActor,
    input: { workspaceIdentity: string },
  ): Promise<string>;
  seal(
    actor: AdministratorActor,
    plan: CsvPlanInput,
    confirm: boolean,
  ): Promise<SealResult>;
  getRun(
    actor: AdministratorActor,
    runId: string,
  ): Promise<CsvDatasetRun | null>;
  claimLease(
    actor: AdministratorActor,
    input: { runId: string; holder: string; ttlMs: number },
  ): Promise<
    | { outcome: "claimed"; lease: CsvBrowserLease }
    | { outcome: "held"; retryAfterMs: number }
  >;
  commitEntry(
    actor: AdministratorActor,
    input: CsvBrowserCommit,
  ): Promise<CommitResult>;
  finish(
    actor: AdministratorActor,
    input: {
      runId: string;
      planId: string;
      holder: string;
      leaseGeneration: number;
      status: "complete" | "cancelled";
    },
  ): Promise<void>;
}
export class CsvBrowserLedgerRefusal extends Error {
  constructor(
    readonly code:
      | "actor_required"
      | "unknown_run"
      | "not_confirmed"
      | "stale_plan"
      | "stale_lease"
      | "cancelled"
      | "excluded_line"
      | "chunk_conflict"
      | "dataset_required"
      | "dataset_conflict"
      | "source_key_required"
      | "source_identity_unavailable"
      | "incomplete_run",
  ) {
    super(code);
    this.name = "CsvBrowserLedgerRefusal";
  }
}

/** The existing CSV resolver's exact Unicode/name matching policy. */
export const csvNameKey = (value: string): string =>
  value.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
