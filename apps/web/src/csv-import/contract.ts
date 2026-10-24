/**
 * Browser-side contract for the CSV import mapping and preview interface
 * (issue 1182, under the plan in docs/import-tools-plan.md).
 *
 * CONTRACT ONLY. Nothing here calls the network or mounts UI. The routes behind
 * `ImportPreviewApi` are issue 1181 and do not exist yet; these types state the
 * shape the interface needs from them, so that work and the interface can be
 * built against the same thing. Wire fields are snake_case, as in the rest of
 * the API. The container runtime is the only supported one; callers must
 * check `ImportCapability` before any call.
 */

export type EntityKind = "person" | "client" | "project" | "task";

export interface EntityTally {
  matched: number;
  new: number;
  rejected: number;
}

/** `invalid` breaks the file contract; `unsupported` is a good row this instance cannot take. */
export type ErrorCategory = "invalid" | "unsupported";

export interface RowError {
  /** Physical source line, never a row index after filtering. */
  line: number;
  category: ErrorCategory;
  /** Safe machine code. Never a cell value, email, note or filename. */
  code: string;
  message: string;
}

export interface ErrorPage {
  items: RowError[];
  /** Opaque; null on the last page. */
  next_cursor: string | null;
  /** Totals are full-file and identical on every page. */
  total: { invalid: number; unsupported: number };
}

export type CapabilityState =
  "available" | "unsupported_runtime" | "not_administrator";

export interface ImportCapability {
  state: CapabilityState;
  /** Truthful guidance, shown before any upload call when not `available`. */
  guidance: string | null;
}

/** What the administrator chose before preview; any change invalidates the preview. */
export interface ImportChoices {
  /** Stable source workspace/dataset identity for the sealed dataset. */
  source_id: string;
  /** The only accepted date format for the first contract. */
  date_format: "YYYY-MM-DD";
  export_zone: string;
  destination_interpretation: "wall_clock_as_written";
  /** Reviewed destination currency for new clients. */
  new_client_currency: string;
  mapping: EntityMapping;
}

export type MappingTarget =
  | { action: "match"; id: number }
  | { action: "create"; name: string; inactive?: true };

export interface EntityMapping {
  /** Keyed by the normalized source value, per kind. Ambiguous or archived matches never auto-resolve. */
  people: Record<string, MappingTarget>;
  clients: Record<string, MappingTarget>;
  projects: Record<string, MappingTarget>;
  tasks: Record<string, MappingTarget>;
}

export interface CurrencyEstimate {
  currency: string;
  amount_minor: number;
}

export interface ImportPreview {
  /** Immutable. Binds target, file hash, adapter version, choices, selection and destination versions. */
  preview_id: string;
  destination: { organization_name: string };
  file: { sha256: string; bytes: number; data_rows: number };
  dataset: {
    source_id: string;
    export_from: string | null;
    export_to: string | null;
  };
  choices: ImportChoices;
  supported_entities: string[];
  excluded_entities: string[];
  ignored_columns: string[];
  unknown_columns: string[];
  people: EntityTally;
  clients: EntityTally;
  projects: EntityTally;
  tasks: EntityTally;
  assignments: {
    user_project: number;
    project_task: number;
    billable_overrides: number;
  };
  entries: {
    total: number;
    new: number;
    already_imported: number;
    rejected: number;
  };
  seconds: { source: number; rounded: number };
  unpriced_entries: number;
  /** Grouped by currency; sources of money are never summed across currencies. */
  destination_estimates: CurrencyEstimate[];
  errors: { invalid: number; unsupported: number };
  warnings: number;
  /** At most this long after completion or expiry. */
  retention_expires_at: string;
}

export interface ApplyAcknowledgements {
  /** Required when `seconds.source !== seconds.rounded`. */
  rounding: boolean;
  /** Required to apply with rejected rows; the run is then partial. */
  partial: boolean;
  /** Must equal `entries.rejected`, so the reviewer saw the count they exclude. */
  excluded_count: number;
}

export interface ApplyCommand {
  preview_id: string;
  acknowledgements: ApplyAcknowledgements;
}

export type ApplyOutcome =
  | { status: "accepted"; run_id: string }
  | {
      status: "stale";
      reason: "preview_replaced" | "destination_changed" | "session_changed";
    }
  | { status: "refused"; reason: "rejected_rows" | "acknowledgement_missing" };

/**
 * The calls the interface makes. Every method requires a current administrator
 * session; a real implementation rejects tokens and other profiles before
 * reading content. `preview` and `errors` write nothing outside staging.
 */
export interface ImportPreviewApi {
  capability(): Promise<ImportCapability>;
  upload(bytes: Uint8Array): Promise<{ upload_id: string; sha256: string }>;
  preview(uploadId: string, choices: ImportChoices): Promise<ImportPreview>;
  errors(previewId: string, cursor: string | null): Promise<ErrorPage>;
  apply(command: ApplyCommand): Promise<ApplyOutcome>;
  /** Safe purge of staged input; never deletes imported time. */
  purge(uploadId: string): Promise<void>;
}

/**
 * Cancellation is a stop, not a rollback. The wording is fixed here so no
 * screen can claim otherwise.
 */
export const cancelNotice = (committed: number, createdSetup: number): string =>
  `Import stopped. ${committed} time entries already written stay, along with ${createdSetup} created people, clients, projects or tasks. Nothing was rolled back.`;
