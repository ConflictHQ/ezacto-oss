import type { ApiContractOperation } from "./contract.js";

/** Container-only administrator staging and immutable preview contract.
 * Confirmation/apply are deliberately unavailable until the separate apply chain lands. */

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
  | "source_choice_required"
  | "mapping_invalid"
  | "upload_aborted"
  | "run_busy"
  | "storage_unavailable";

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
  mapping_invalid: 422,
  upload_aborted: 400,
  run_busy: 409,
  storage_unavailable: 503,
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

const boolean = { type: "boolean" } as const;
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (items: unknown) => ({ type: "array", items });
const counts = object({ matched: integer, new: integer, rejected: integer });
const mappingChoices = {
  workspace_identity: string,
  source_id: string,
  adapter_id: string,
  date_format: { type: "string", enum: ["iso"] },
  exporter_zone: string,
  destination_interpretation: { type: "string", enum: ["source_wall_time"] },
  currency_policy: { type: "string", enum: ["destination_rates"] },
  excluded_lines: array(integer),
  mapping: { type: "object", additionalProperties: true },
};
const stagingSchemas = {
  CsvImportUploadBytes: { type: "string", format: "binary" },
  CsvImportCapabilities: object({
    runtime: { type: "string", enum: ["container", "worker"] },
    staging_supported: boolean,
    browser_ready: { type: "boolean" },
    apply_supported: { type: "boolean" },
    max_csv_bytes: integer,
    max_mapping_bytes: integer,
    raw_retention_hours: { const: 24 },
  }),
  CsvImportTallies: object({
    file_rows: integer,
    selected_rows: integer,
    new_rows: integer,
    already_imported_rows: integer,
    rejected_row_count: integer,
    diagnostic_count: integer,
    file_error_count: integer,
    invalid_rows: integer,
    unsupported_rows: integer,
    source_seconds: integer,
    destination_seconds: integer,
    destination_delta_seconds: integer,
    deleted_imported_rows: integer,
    organization_currency: string,
    unpriced: { const: true },
    ignored_columns: array(string),
    ignored_column_count: integer,
    warning_count: integer,
    people: counts,
    clients: counts,
    projects: counts,
    tasks: counts,
    assignments: object({ user_project: integer, project_task: integer }),
  }),
  CsvImportChoices: object(mappingChoices),
  CsvImportMapping: object({
    workspace_identity: string,
    exporter_zone: string,
    date_format: mappingChoices.date_format,
    destination_interpretation: mappingChoices.destination_interpretation,
    currency_policy: mappingChoices.currency_policy,
    excluded_lines: mappingChoices.excluded_lines,
    mapping: mappingChoices.mapping,
    version: integer,
  }),
  CsvImportMappingState: object({
    version: integer,
    choices: nullable(ref("CsvImportChoices")),
    preview_id: nullable(string),
  }),
  CsvImportRun: object({
    id: string,
    status: { type: "string", enum: [...csvRunStatuses] },
    version: integer,
    file_sha256: string,
    bytes: integer,
    staging_expires_at: string,
    retention_deadline: nullable(string),
    purge_allowed: boolean,
    allowed_actions: array({
      type: "string",
      enum: ["map", "preview", "purge"],
    }),
    retryable: boolean,
    preview_id: nullable(string),
    preview_stale: boolean,
    source_id: nullable(string),
    tallies: nullable(ref("CsvImportTallies")),
  }),
  CsvImportPreviewRequest: {
    type: "object",
    additionalProperties: false,
    properties: { preview_id: string },
  },
  CsvImportPreview: object({
    organization_name: string,
    preview_id: string,
    run: ref("CsvImportRun"),
    choices: ref("CsvImportChoices"),
    tallies: ref("CsvImportTallies"),
  }),
  CsvImportLineError: object({
    line: integer,
    scope: { type: "string", enum: ["file", "row"] },
    excludable: boolean,
    kind: { type: "string", enum: ["invalid", "unsupported", "warning"] },
    code: string,
    message: string,
  }),
  CsvImportErrorPage: object({
    items: array(ref("CsvImportLineError")),
    total: integer,
    next_cursor: nullable(string),
    preview_id: nullable(string),
  }),
  CsvImportSourceEntity: object({
    kind: { type: "string", enum: ["people", "clients", "projects", "tasks"] },
    source_key: string,
    label: string,
    parent_source_key: nullable(string),
    parents: array(
      object({
        kind: { type: "string", enum: ["clients", "projects"] },
        source_key: string,
        label: string,
      }),
    ),
    state: { type: "string", enum: ["matched", "new", "rejected", "excluded"] },
    selected_id: nullable(integer),
    selected_destination: nullable(ref("CsvImportCandidate")),
    ambiguous: boolean,
  }),
  CsvImportCandidate: object({
    id: integer,
    name: string,
    parent_id: nullable(integer),
    parent_name: nullable(string),
    is_active: boolean,
    selectable: boolean,
    currency: nullable(string),
  }),
  CsvImportCatalogPage: object({
    items: array({
      anyOf: [ref("CsvImportSourceEntity"), ref("CsvImportCandidate")],
    }),
    total: integer,
    next_cursor: nullable(string),
    preview_id: nullable(string),
  }),
} as const;
export const csvImportStagingSchemas = {
  ...stagingSchemas,
  ...Object.fromEntries(
    [
      "CsvImportCapabilities",
      "CsvImportRun",
      "CsvImportMappingState",
      "CsvImportPreview",
      "CsvImportErrorPage",
      "CsvImportCatalogPage",
    ].map((name) => [`${name}Envelope`, object({ data: ref(name) })]),
  ),
} as const;
const common = { tag: "csv-import", sessionOnly: true } as const;
const query = (
  name: string,
  schema: Readonly<Record<string, unknown>> = string,
  required = false,
) => ({ name, location: "query" as const, schema, required });
const page = [
  query("preview_id"),
  query("cursor"),
  query("per_page", { type: "integer", minimum: 1, maximum: 100 }),
];
/** No confirmation or apply operation is reachable through these routes. */
const stagingOperations: readonly ApiContractOperation[] = [
  {
    tag: "csv-import",
    public: true,
    method: "get",
    path: "/api/v1/csv-import-capabilities",
    operationId: "getCsvImportCapabilities",
    summary: "Discover private CSV staging support",
    responseStatus: 200,
    responseSchema: "CsvImportCapabilitiesEnvelope",
  },
  {
    ...common,
    method: "post",
    path: "/api/v1/csv-imports",
    operationId: "uploadCsvImport",
    additionalErrorResponseStatuses: [415],
    summary: "Stream CSV bytes into private administrator staging",
    responseStatus: 201,

    responseSchema: "CsvImportRunEnvelope",
    requestContentType: "application/octet-stream",
    requestSchema: "CsvImportUploadBytes",
    requestRequired: true,
    parameters: [
      {
        name: "X-CSV-SHA256",
        location: "header",
        required: true,
        schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      {
        name: "X-CSV-Bytes",
        location: "header",
        required: true,
        schema: {
          type: "integer",
          minimum: 1,
          maximum: CSV_STAGING_LIMITS.maxBytes,
        },
      },
    ],
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId/mapping",
    operationId: "getCsvImportMapping",
    summary: "Read current administrator-owned source and mapping choices",
    responseStatus: 200,
    responseSchema: "CsvImportMappingStateEnvelope",
  },
  {
    ...common,
    method: "patch",
    path: "/api/v1/csv-imports/:runId/mapping",
    operationId: "mapCsvImport",
    summary:
      "Explicitly register the workspace and set source, zone, mapping and exclusions",
    responseStatus: 200,

    responseSchema: "CsvImportRunEnvelope",
    requestSchema: "CsvImportMapping",
    requestRequired: true,
  },
  {
    ...common,
    method: "post",
    path: "/api/v1/csv-imports/:runId/preview",
    operationId: "previewCsvImport",
    summary: "Compute an immutable preview without writing organization rows",
    responseStatus: 200,

    responseSchema: "CsvImportPreviewEnvelope",
    requestSchema: "CsvImportPreviewRequest",
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId",
    operationId: "getCsvImport",
    summary: "Read private run status, tallies and retention deadline",
    responseStatus: 200,
    responseSchema: "CsvImportRunEnvelope",
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId/errors",
    operationId: "listCsvImportErrors",
    summary: "Read paginated static physical-line diagnostics",
    responseStatus: 200,
    responseSchema: "CsvImportErrorPageEnvelope",
    parameters: [
      ...page,
      query("kind", {
        type: "string",
        enum: ["invalid", "unsupported", "warning"],
      }),
    ],
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId/catalog",
    operationId: "listCsvImportCatalog",
    summary:
      "Read immutable private source labels and explicit destination candidates",
    responseStatus: 200,
    responseSchema: "CsvImportCatalogPageEnvelope",
    parameters: [
      ...page,
      query(
        "kind",
        { type: "string", enum: ["people", "clients", "projects", "tasks"] },
        true,
      ),
      query("source_key"),
    ],
  },
  {
    ...common,
    method: "get",
    path: "/api/v1/csv-imports/:runId/diagnostics",
    operationId: "downloadCsvImportDiagnostics",
    summary: "Download static diagnostics JSON without CSV cells or notes",
    responseStatus: 200,
    binaryResponse: true,
    parameters: [query("preview_id")],
  },
  {
    ...common,
    method: "delete",
    path: "/api/v1/csv-imports/:runId/input",
    operationId: "purgeCsvImportInput",
    summary:
      "Purge private input and diagnostics, preserving minimal dedup facts and imported time",
    responseStatus: 204,
  },
];

export const csvImportStagingOperations: readonly ApiContractOperation[] =
  stagingOperations.map((operation) =>
    operation.path.includes(":runId")
      ? {
          ...operation,
          parameters: [
            { name: "runId", location: "path", required: true, schema: string },
            ...(operation.parameters ?? []),
          ],
        }
      : operation,
  );
