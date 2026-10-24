import type { ApiContractOperation } from "./contract.js";

/**
 * CONTRACT ONLY (issue 1181, parent 1012). Nothing here is mounted: these
 * operations are not in the registered contract, no route exists, and no
 * runtime advertises browser CSV import. The implementation depends on 1180
 * (portable planner, actor port, sealed dataset identity). This file fixes the
 * shapes, limits, error codes, state machine and invariants that the real
 * routes and any real StagingStore must satisfy; see
 * docs/csv-import-staging-contract.md and the contract tests.
 */

/** Must equal the limits in packages/migrate/src/csv-contract.ts. */
export const CSV_STAGING_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 40,
  maxFieldLength: 10_000,
  maxNameLength: 255,
  maxMappingBytes: 1024 * 1024,
} as const;

export const CSV_RAW_RETENTION_MS = 24 * 60 * 60 * 1000;

export type CsvImportRuntime = "container" | "worker";
/** Container/SQLite only. A worker runtime reports unsupported and every route answers 404. */
export const CSV_IMPORT_SUPPORTED_RUNTIMES: readonly CsvImportRuntime[] = [
  "container",
];

export const csvRunStatuses = [
  "uploading",
  "staged",
  "previewed",
  "confirmed",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "purged",
] as const;
export type CsvRunStatus = (typeof csvRunStatuses)[number];

/** Raw input is deleted a fixed time after a run reaches one of these. */
export const CSV_TERMINAL_STATUSES: ReadonlySet<CsvRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

const transitions: Readonly<Record<CsvRunStatus, readonly CsvRunStatus[]>> = {
  uploading: ["staged", "failed", "cancelled", "expired"],
  staged: ["previewed", "failed", "cancelled", "expired"],
  // A changed mapping or stale policy returns to staged; confirm is the only way forward.
  previewed: [
    "staged",
    "previewed",
    "confirmed",
    "failed",
    "cancelled",
    "expired",
  ],
  confirmed: ["completed", "failed", "cancelled"],
  completed: ["purged"],
  failed: ["purged"],
  cancelled: ["purged"],
  expired: ["purged"],
  purged: [],
};

export const canTransition = (from: CsvRunStatus, to: CsvRunStatus): boolean =>
  transitions[from].includes(to);

/** The instant raw input and row diagnostics must be gone; null while the run is not terminal. */
export const rawRetentionDeadline = (
  status: CsvRunStatus,
  terminalAt: Date | null,
): string | null =>
  CSV_TERMINAL_STATUSES.has(status) && terminalAt !== null
    ? new Date(terminalAt.getTime() + CSV_RAW_RETENTION_MS).toISOString()
    : null;

export type CsvStagingErrorCode =
  | "session_required"
  | "token_denied"
  | "administrator_required"
  | "csrf_failed"
  | "run_not_found"
  | "capability_unsupported"
  | "file_too_large"
  | "too_many_rows"
  | "too_many_columns"
  | "field_too_long"
  | "name_too_long"
  | "mapping_too_large"
  | "not_csv"
  | "invalid_utf8"
  | "hash_mismatch"
  | "length_mismatch"
  | "parse_budget_exceeded"
  | "preview_stale"
  | "source_choice_required";

export const csvStagingErrorStatus: Readonly<
  Record<CsvStagingErrorCode, number>
> = {
  session_required: 401,
  token_denied: 403,
  administrator_required: 403,
  csrf_failed: 403,
  run_not_found: 404,
  capability_unsupported: 404,
  file_too_large: 413,
  too_many_rows: 422,
  too_many_columns: 422,
  field_too_long: 422,
  name_too_long: 422,
  mapping_too_large: 413,
  not_csv: 415,
  invalid_utf8: 422,
  hash_mismatch: 422,
  length_mismatch: 422,
  parse_budget_exceeded: 422,
  preview_stale: 409,
  source_choice_required: 422,
};

export interface CsvStagingCaller {
  kind: "session" | "token" | "anonymous";
  administrator: boolean;
  /** The administrator the session belongs to; the actor recorded on the run. */
  profileId: string | null;
  /** True only when Origin/CSRF token checks passed for this request. */
  sameOrigin: boolean;
}

export interface CsvStagingRunRef {
  id: string;
  /** The target binding: this instance's single organization. */
  target: string;
  createdByProfileId: string;
}

/**
 * Checked in this order, before any run content or metadata is read. A run that
 * is missing and a run that belongs to someone else are indistinguishable
 * (run_not_found), so a caller cannot probe ids.
 */
export const authorizeCsvStaging = (
  runtime: CsvImportRuntime,
  caller: CsvStagingCaller,
  mutating: boolean,
  target: string,
  loadRun: (() => CsvStagingRunRef | null) | null,
): CsvStagingErrorCode | null => {
  if (!CSV_IMPORT_SUPPORTED_RUNTIMES.includes(runtime))
    return "capability_unsupported";
  if (caller.kind === "anonymous") return "session_required";
  if (caller.kind === "token") return "token_denied";
  if (!caller.administrator || caller.profileId === null)
    return "administrator_required";
  if (mutating && !caller.sameOrigin) return "csrf_failed";
  if (loadRun === null) return null;
  const run = loadRun();
  return run === null ||
    run.target !== target ||
    run.createdByProfileId !== caller.profileId
    ? "run_not_found"
    : null;
};

/** Everything a confirmation is bound to. Any change yields a different preview id. */
export interface CsvPreviewBinding {
  target: string;
  fileSha256: string;
  adapter: string;
  identityVersion: string;
  sourceId: string;
  mappingSha256: string;
  dateFormat: "iso";
  exportTimeZone: string;
  destinationInterpretation: string;
  currency: string;
  /** Sorted physical line numbers excluded by the administrator; empty means refuse rejected rows. */
  excludedLines: readonly number[];
  /** Versions/hashes of destination policy (rates, assignments, locks, approvals) the plan read. */
  destinationVersions: Readonly<Record<string, string>>;
}

export type CsvHash = (value: string) => string;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
};

/** Immutable, opaque, deterministic: same binding, same id. The hash is injected (no Node crypto). */
export const csvPreviewId = (
  binding: CsvPreviewBinding,
  hash: CsvHash,
): string =>
  "prv_" +
  hash(
    canonical({
      ...binding,
      excludedLines: [...binding.excludedLines].sort((a, b) => a - b),
    }),
  );

export const isCsvPreviewCurrent = (
  previewId: string,
  current: CsvPreviewBinding,
  hash: CsvHash,
): boolean => previewId === csvPreviewId(current, hash);

export interface CsvTallies {
  dataRows: number;
  newRows: number;
  alreadyImportedRows: number;
  invalidRows: number;
  unsupportedRows: number;
  sourceSeconds: number;
  destinationSeconds: number;
  ignoredColumns: readonly string[];
  warnings: number;
}

export interface CsvLineError {
  /** Physical 1-based line of the source file; 1 is the header. */
  line: number;
  kind: "invalid" | "unsupported";
  code: string;
  /** A safe code's own text. Never contains a cell value, email, note or filename. */
  message: string;
}

export interface CsvErrorPage {
  items: readonly CsvLineError[];
  /** Full count of errors of the requested kind, independent of the page. */
  total: number;
  nextCursor: string | null;
}

export interface CsvRunStatusView {
  id: string;
  status: CsvRunStatus;
  fileSha256: string;
  bytes: number;
  /** Present once terminal; the deadline by which raw input and diagnostics are purged. */
  retentionDeadline: string | null;
  purgeAllowed: boolean;
  tallies: CsvTallies | null;
  previewId: string | null;
}

/** Private staging port. Real implementations: container disk/object storage. Never a public URL. */
export interface CsvStagingStore {
  /** Verifies sha256 and byte length of exactly what was streamed, then stores under a generated key. */
  put(
    runId: string,
    body: AsyncIterable<Uint8Array>,
    expected: { sha256: string; bytes: number },
  ): Promise<{ objectKey: string }>;
  /** Server-side only; there is no URL-producing method. */
  read(objectKey: string): Promise<Uint8Array | null>;
  delete(objectKey: string): Promise<void>;
}

/** Appends a byte count and refuses past the limit before the chunk is retained. */
export class CsvByteBudget {
  private seen = 0;
  take(chunk: Uint8Array): void {
    if (this.seen + chunk.byteLength > CSV_STAGING_LIMITS.maxBytes)
      throw new CsvStagingError("file_too_large");
    this.seen += chunk.byteLength;
  }
  get bytes(): number {
    return this.seen;
  }
}

export class CsvStagingError extends Error {
  constructor(readonly code: CsvStagingErrorCode) {
    super(code);
  }
}

const string = { type: "string" } as const;
const integer = { type: "integer" } as const;
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
});

export const csvImportStagingSchemas = {
  CsvImportRun: object({
    id: string,
    status: { type: "string", enum: [...csvRunStatuses] },
    file_sha256: string,
    bytes: integer,
    retention_deadline: { anyOf: [string, { type: "null" }] },
    purge_allowed: { type: "boolean" },
    preview_id: { anyOf: [string, { type: "null" }] },
  }),
  CsvImportUpload: object({
    file: { type: "string", format: "binary" },
    sha256: string,
  }),
  CsvImportMapping: object({
    source_id: string,
    export_time_zone: string,
    destination_interpretation: string,
    currency: string,
    mapping: { type: "object", additionalProperties: true },
    excluded_lines: { type: "array", items: integer },
  }),
  CsvImportPreview: object({
    preview_id: string,
    run: { $ref: "#/components/schemas/CsvImportRun" },
    tallies: { type: "object", additionalProperties: true },
  }),
  CsvImportLineError: object({
    line: integer,
    kind: { type: "string", enum: ["invalid", "unsupported"] },
    code: string,
    message: string,
  }),
  CsvImportErrorPage: object({
    items: {
      type: "array",
      items: { $ref: "#/components/schemas/CsvImportLineError" },
    },
    total: integer,
    next_cursor: { anyOf: [string, { type: "null" }] },
  }),
} as const;

const common = { tag: "csv-import", sessionOnly: true } as const;

/**
 * Deliberately no apply operation: confirmation and apply belong to 1183 and
 * cannot be reached from staging or preview.
 */
export const csvImportStagingOperations: readonly ApiContractOperation[] = [
  {
    ...common,
    method: "post",
    path: "/api/v1/csv-imports",
    operationId: "uploadCsvImport",
    summary: "Stream a CSV into private staging",
    description:
      "Administrator session and same-origin CSRF only; tokens are denied before any content or metadata is read. Bytes are limited while streaming. Container runtimes only.",
    responseStatus: 201,
    additionalResponseStatuses: [413, 415, 422],
    responseSchema: "CsvImportRun",
    requestContentType: "multipart/form-data",
    requestSchema: "CsvImportUpload",
    requestRequired: true,
  },
  {
    ...common,
    method: "patch",
    path: "/api/v1/csv-imports/:runId/mapping",
    operationId: "mapCsvImport",
    summary: "Set the source, date-zone, currency and entity mappings",
    responseStatus: 200,
    additionalResponseStatuses: [413, 422],
    responseSchema: "CsvImportRun",
    requestSchema: "CsvImportMapping",
    requestRequired: true,
  },
  {
    ...common,
    method: "post",
    path: "/api/v1/csv-imports/:runId/preview",
    operationId: "previewCsvImport",
    summary: "Plan the import without writing organization rows",
    description:
      "Returns an immutable preview id bound to target, file hash, mappings, adapter/identity version, date-zone choices, exclusions and destination versions.",
    responseStatus: 200,
    additionalResponseStatuses: [409, 422],
    responseSchema: "CsvImportPreview",
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId",
    operationId: "getCsvImport",
    summary: "Run status, tallies and retention deadline",
    responseStatus: 200,
    responseSchema: "CsvImportRun",
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId/errors",
    operationId: "listCsvImportErrors",
    summary: "Paginated invalid and unsupported line errors",
    responseStatus: 200,
    responseSchema: "CsvImportErrorPage",
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId/diagnostics",
    operationId: "downloadCsvImportDiagnostics",
    summary: "Diagnostic CSV with formula-leading cells escaped",
    responseStatus: 200,
    binaryResponse: true,
  },
  {
    ...common,
    method: "delete",
    path: "/api/v1/csv-imports/:runId/input",
    operationId: "purgeCsvImportInput",
    summary: "Purge staged input and diagnostics now",
    description:
      "Keeps hashes, counts and audit/dedup records; never deletes imported time.",
    responseStatus: 204,
  },
];
