import type { ApiContractOperation } from "./contract.js";
const s = { type: "string" },
  n = { type: "integer" };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const base = { id: s, reason: s };
const application = {
  ...base,
  advance_item_id: s,
  user_id: n,
  currency: s,
  month: s,
  amount_cents: n,
  scope: { type: "string", enum: ["month", "project", "entry"] },
  project_id: nullable(n),
  entry_id: nullable(n),
};
const returned = { ...base, advance_item_id: s, amount_cents: n, reference: s };
export const advanceCreditSchemas = {
  ApplyAdvanceCredit: object(application),
  ReverseAdvanceCredit: object({ ...base, application_id: s }),
  ReturnAdvanceCredit: object(returned),
  AdvanceCreditApplication: object({
    ...application,
    actor_id: n,
    recorded_at: s,
    reversed_at: nullable(s),
    reversal_reason: nullable(s),
  }),
  AdvanceCreditReturn: object({ ...returned, actor_id: n, recorded_at: s }),
  AdvanceCredit: object({
    advance_item_id: s,
    user_id: n,
    name: s,
    currency: s,
    month: s,
    advance_project_id: nullable(n),
    advance_reason: s,
    state: s,
    amount_cents: n,
    settled_cents: n,
    settled_at: nullable(s),
    applied_cents: n,
    returned_cents: n,
    reserved_cents: n,
    available_cents: n,
    opening_cents: n,
    period_settled_cents: n,
    period_applied_cents: n,
    period_returned_cents: n,
    closing_cents: n,
    applications: { type: "array", items: ref("AdvanceCreditApplication") },
    returns: { type: "array", items: ref("AdvanceCreditReturn") },
  }),
  AdvanceCreditReport: object({
    from: s,
    to: s,
    advances: { type: "array", items: ref("AdvanceCredit") },
  }),
  AdvanceCreditReportEnvelope: object({ data: ref("AdvanceCreditReport") }),
};
export const advanceCreditOperations: readonly ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/payment-runs/advances",
    operationId: "getAdvanceCreditReport",
    summary:
      "Reconcile contractor advance credit by settlement and application date",
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "AdvanceCreditReportEnvelope",
    parameters: ["from", "to"].map((name) => ({
      name,
      location: "query" as const,
      schema: s,
    })),
  },
  ...[
    [
      "applications",
      "applyAdvanceCredit",
      "ApplyAdvanceCredit",
      "Apply settled advance credit to reviewed earnings without moving funds",
    ],
    [
      "reversals",
      "reverseAdvanceCredit",
      "ReverseAdvanceCredit",
      "Reverse an advance application and restore credit",
    ],
    [
      "returns",
      "returnAdvanceCredit",
      "ReturnAdvanceCredit",
      "Record a confirmed return of unapplied advance credit",
    ],
  ].map(([path, operationId, requestSchema, summary]) => ({
    method: "post" as const,
    path: `/api/v1/payment-runs/advances/${path}`,
    operationId: operationId!,
    summary: summary!,
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 204,
    requestSchema: requestSchema!,
    requestRequired: true,
  })),
];
