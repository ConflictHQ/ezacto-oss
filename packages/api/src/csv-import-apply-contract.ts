import type { ApiContractOperation } from "./contract.js";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: "string", format: "uuid" };
const preview = { type: "string", pattern: "^preview_[a-f0-9]{64}$" };
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const schemaEntries: readonly [string, Record<string, unknown>][] = [
  [
    "CsvImportApplyCommand",
    object({
      preview_id: preview,
      command_id: uuid,
      version: { type: "integer", minimum: 1 },
      expected_selected_rows: { ...count, maximum: 50000 },
      expected_source_seconds: { ...count, maximum: 4320000000 },
      expected_destination_seconds: count,
      acknowledge_exclusions: { type: "boolean" },
      acknowledge_destination_difference: { type: "boolean" },
      acknowledge_new_people: { type: "boolean" },
    }),
  ],
  ["CsvImportCancelCommand", object({ command_id: uuid })],
  [
    "CsvImportApplyRun",
    object({
      stage_id: { type: "string" },
      preview_id: nullable(preview),
      state: {
        type: "string",
        enum: [
          "not_confirmed",
          "queued",
          "running",
          "paused",
          "partial",
          "completed",
          "cancelled",
          "failed",
          "superseded",
        ],
      },
      code: nullable({
        type: "string",
        enum: [
          "authority_expired",
          "authority_revoked",
          "input_expired",
          "input_unavailable",
          "policy_changed",
          "parse_rejected",
          "storage_unavailable",
          "cancelled_by_administrator",
        ],
      }),
      command_id: nullable(uuid),
      command_known: { type: "boolean" },
      pending_command: nullable(ref("CsvImportApplyCommand")),
      file_rows: count,
      selected_rows: count,
      excluded_rows: count,
      committed_rows: count,
      inserted_rows: count,
      already_imported_rows: count,
      created_setup: count,
      source_seconds_total: nullable(count),
      source_seconds_committed: count,
      destination_seconds: count,
      destination_delta_seconds: {
        type: "integer",
        minimum: -Number.MAX_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      deleted_imported_rows: count,
      retention_deadline: nullable({ type: "string", format: "date-time" }),
      retryable: { type: "boolean" },
      allowed_actions: {
        type: "array",
        items: {
          type: "string",
          enum: ["apply", "resume", "cancel", "inspect", "purge", "reconcile"],
        },
      },
    }),
  ],
  ["CsvImportApplyEnvelope", object({ data: ref("CsvImportApplyRun") })],
];
export const csvImportApplySchemas: Record<
  string,
  Record<string, unknown>
> = Object.fromEntries(schemaEntries);
const path = {
  name: "runId",
  location: "path" as const,
  required: true,
  schema: { type: "string" },
};
const idempotency = {
  name: "Idempotency-Key",
  location: "header" as const,
  required: true,
  schema: uuid,
  description:
    "Must equal command_id in the body; reuse the exact command after an unknown outcome.",
};
const base = {
  tag: "csv-imports",
  responseStatus: 200,
  responseSchema: "CsvImportApplyEnvelope",
  description:
    "Container-only administrator session operation. Current native session, owned stage and target incarnation are checked before content. No source values or credentials are returned. Cancel stops future writes and retains committed time and setup.",
};
export const csvImportApplyOperations: ApiContractOperation[] = [
  {
    ...base,
    method: "post",
    path: "/api/v1/csv-imports/:runId/apply",
    operationId: "applyCsvImport",
    summary: "Confirm and queue the immutable reviewed CSV selection",
    parameters: [path, idempotency],
    requestSchema: "CsvImportApplyCommand",
    requestRequired: true,
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/csv-imports/:runId/resume",
    operationId: "resumeCsvImport",
    summary:
      "Explicitly resume the same sealed selection under a current session",
    parameters: [path, idempotency],
    requestSchema: "CsvImportApplyCommand",
    requestRequired: true,
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/csv-imports/:runId/cancel",
    operationId: "cancelCsvImport",
    summary: "Stop future CSV writes without rolling back committed rows",
    parameters: [path, idempotency],
    requestSchema: "CsvImportCancelCommand",
    requestRequired: true,
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/csv-imports/:runId/apply",
    operationId: "getCsvImportApply",
    summary: "Recover authoritative CSV progress and a pending command receipt",
    parameters: [path, { name: "command_id", location: "query", schema: uuid }],
  },
];
