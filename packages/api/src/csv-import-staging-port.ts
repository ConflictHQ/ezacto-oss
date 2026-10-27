import type { CsvRunStatus } from "./csv-import-staging-contract.js";

import type { CsvStagingAuthority } from "@ezacto/core";
export type { CsvStagingAuthority } from "@ezacto/core";
export interface CsvStagingChoices {
  workspace_identity: string;
  source_id: string;
  adapter_id: string;
  date_format: "iso";
  exporter_zone: string;
  destination_interpretation: "source_wall_time";
  currency_policy: "destination_rates";
  excluded_lines: readonly number[];
  mapping: Readonly<Record<string, unknown>>;
}
export interface CsvStagingTallies {
  file_rows: number;
  selected_rows: number;
  new_rows: number;
  already_imported_rows: number;
  rejected_row_count: number;
  diagnostic_count: number;
  file_error_count: number;
  invalid_rows: number;
  unsupported_rows: number;
  source_seconds: number;
  destination_seconds: number;
  destination_delta_seconds: number;
  deleted_imported_rows: number;
  organization_currency: string;
  unpriced: true;
  ignored_columns: readonly string[];
  ignored_column_count: number;
  warning_count: number;
  people: { matched: number; new: number; rejected: number };
  clients: { matched: number; new: number; rejected: number };
  projects: { matched: number; new: number; rejected: number };
  tasks: { matched: number; new: number; rejected: number };
  assignments: { user_project: number; project_task: number };
}
export interface CsvStagingRunData {
  id: string;
  status: CsvRunStatus;
  version: number;
  file_sha256: string;
  bytes: number;
  staging_expires_at: string;
  retention_deadline: string | null;
  purge_allowed: boolean;
  allowed_actions: readonly ("map" | "preview" | "purge")[];
  retryable: boolean;
  preview_id: string | null;
  preview_stale: boolean;
  source_id: string | null;
  tallies: CsvStagingTallies | null;
}
export interface CsvStagingDiagnostic {
  line: number;
  scope: "file" | "row";
  excludable: boolean;
  kind: "invalid" | "unsupported" | "warning";
  code: string;
  message: string;
}
export interface CsvStagingPage<Row> {
  items: readonly Row[];
  total: number;
  next_cursor: string | null;
  preview_id: string | null;
}
export interface CsvStagingPreview {
  organization_name: string;
  preview_id: string;
  run: CsvStagingRunData;
  choices: CsvStagingChoices;
  tallies: CsvStagingTallies;
}
export interface CsvStagingSourceEntity {
  kind: "people" | "clients" | "projects" | "tasks";
  source_key: string;
  label: string;
  parent_source_key: string | null;
  parents: readonly {
    kind: "clients" | "projects";
    source_key: string;
    label: string;
  }[];
  state: "matched" | "new" | "rejected" | "excluded";
  selected_id: number | null;
  selected_destination: CsvStagingCandidate | null;
  ambiguous: boolean;
}
export interface CsvStagingCandidate {
  id: number;
  name: string;
  parent_id: number | null;
  parent_name: string | null;
  is_active: boolean;
  selectable: boolean;
  currency: string | null;
}
export interface CsvStagingCapabilities {
  runtime: "container" | "worker";
  staging_supported: boolean;
  browser_ready: boolean;
  apply_supported: boolean;
  max_csv_bytes: number;
  max_mapping_bytes: number;
  raw_retention_hours: 24;
}
export interface CsvStagingMappingInput {
  workspace_identity: string;
  exporter_zone: string;
  date_format: "iso";
  destination_interpretation: "source_wall_time";
  currency_policy: "destination_rates";
  mapping: Readonly<Record<string, unknown>>;
  excluded_lines: readonly number[];
  version: number;
}
/** No apply/confirm operation exists here. Node storage is an entry-owned port. */
export interface CsvImportStagingPort {
  readonly runtime: "container" | "worker";
  authorize(authority: CsvStagingAuthority): Promise<void>;
  authorizeRun(authority: CsvStagingAuthority, runId: string): Promise<void>;
  upload(
    authority: CsvStagingAuthority,
    body: AsyncIterable<Uint8Array>,
    expected: { sha256: string; bytes: number },
    signal: AbortSignal,
  ): Promise<CsvStagingRunData>;
  read(
    authority: CsvStagingAuthority,
    runId: string,
  ): Promise<CsvStagingRunData>;
  mapping(
    authority: CsvStagingAuthority,
    runId: string,
  ): Promise<{
    version: number;
    choices: CsvStagingChoices | null;
    preview_id: string | null;
  }>;
  map(
    authority: CsvStagingAuthority,
    runId: string,
    input: CsvStagingMappingInput,
  ): Promise<CsvStagingRunData>;
  preview(
    authority: CsvStagingAuthority,
    runId: string,
    expectedPreviewId: string | undefined,
    signal: AbortSignal,
  ): Promise<CsvStagingPreview>;
  errors(
    authority: CsvStagingAuthority,
    runId: string,
    query: {
      previewId?: string;
      cursor?: string;
      limit: number;
      kind?: "invalid" | "unsupported" | "warning";
    },
  ): Promise<CsvStagingPage<CsvStagingDiagnostic>>;
  catalog(
    authority: CsvStagingAuthority,
    runId: string,
    query: {
      previewId: string;
      kind: "people" | "clients" | "projects" | "tasks";
      sourceKey?: string;
      cursor?: string;
      limit: number;
    },
  ): Promise<CsvStagingPage<CsvStagingSourceEntity | CsvStagingCandidate>>;
  diagnostics(
    authority: CsvStagingAuthority,
    runId: string,
    previewId?: string,
  ): Promise<string>;
  purge(authority: CsvStagingAuthority, runId: string): Promise<void>;
}
