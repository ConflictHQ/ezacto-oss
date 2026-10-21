import type { ApiContractOperation } from "./contract.js";
const s = { type: "string" } as const;
const n = { type: "integer" } as const;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
});
export const scheduledRunSchemas = {
  ScheduledRunItem: object({
    id: n,
    subject_type: s,
    subject_id: n,
    description: s,
    amount_cents: nullable(n),
    currency: nullable(s),
    target: nullable(s),
    quantity_seconds: nullable({type:"integer",minimum:0}),
    client_name: nullable(s),
    state: {
      type: "string",
      enum: ["pending", "running", "done", "failed"],
    },
    attempt_count: n,
    failure_reason: nullable(s),
    completed_at: nullable(s),
  }),
  ScheduledRun: object({
    id: n,
    job_id: n,
    occurrence_key: s,
    state: {
      type: "string",
      enum: ["proposed", "confirmed", "cancelled", "expired", "completed"],
    },
    proposed_at: s,
    expires_at: s,
    confirmed_by: nullable(n),
    confirmed_at: nullable(s),
    settled_reason: nullable(s),
    items: { type: "array", items: ref("ScheduledRunItem") },
  }),
  ScheduledRunEnvelope: object({ data: ref("ScheduledRun") }),
};
const id = { name: "id", location: "path", required: true, schema: n } as const;
export const scheduledRunOperations: readonly ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/scheduled-runs/:id",
    operationId: "getScheduledRun",
    summary: "Read a proposed run and the concrete items it would act on",
    tag: "scheduled-runs",
    responseStatus: 200,
    responseSchema: "ScheduledRunEnvelope",
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: "post",
    path: "/api/v1/scheduled-runs/:id/confirm",
    operationId: "confirmScheduledRun",
    summary: "Confirm a proposed run; a second confirmation changes nothing",
    description:
      "Refused with 409 once the run has lapsed, which also settles it as expired, or if it was cancelled.",
    tag: "scheduled-runs",
    responseStatus: 200,
    responseSchema: "ScheduledRunEnvelope",
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: "post",
    path: "/api/v1/scheduled-runs/:id/cancel",
    operationId: "cancelScheduledRun",
    summary: "Cancel a proposed run that has not been confirmed",
    tag: "scheduled-runs",
    responseStatus: 200,
    responseSchema: "ScheduledRunEnvelope",
    sessionOnly: true,
    parameters: [id],
  },
];
