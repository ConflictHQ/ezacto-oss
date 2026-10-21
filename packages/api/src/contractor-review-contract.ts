import type { ApiContractOperation } from "./contract.js";
const s = { type: "string" },
  n = { type: "integer" },
  b = { type: "boolean" };
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (name: string) => ({ type: "array", items: ref(name) });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const strings = { type: "array", items: s },
  phase = {
    ...s,
    enum: ["review", "queued", "processing", "settled", "failed", "attention"],
  };
export const contractorReviewSchemas = {
  ContractorEarningsReview: object({
    id: s,
    user_id: n,
    currency: s,
    amount_cents: n,
    expected_version: n,
    actor_id: n,
    note: s,
    recorded_at: s,
  }),
  ContractorReviewEntry: object({
    entry_id: n,
    project_id: n,
    project_name: s,
    spent_date: s,
    rounded_seconds: n,
    cost_rate_cents: nullable(n),
    selected_seconds: n,
  }),
  ContractorReviewEarnings: object({
    user_id: n,
    name: s,
    proposed_cents: n,
    confirmed_cents: nullable(n),
    status: { ...s, enum: ["new", "converged", "differs", "attention"] },
    exceptions: {
      type: "array",
      items: object({
        code: { ...s, enum: ["missing_rate", "changed_source"] },
        entry_ids: { type: "array", items: n },
      }),
    },
  }),
  ContractorAllocationProposal: object({
    payment_kind: { ...s, enum: ["event", "run_item"] },
    payment_id: s,
    amount_cents: n,
    scope: { ...s, enum: ["month"] },
  }),
  ContractorCreditProposal: object({
    advance_item_id: s,
    amount_cents: n,
    scope: { ...s, enum: ["month"] },
  }),
  ContractorReviewItem: object({
    id: s,
    run_id: s,
    run_name: s,
    purpose: { ...s, enum: ["earnings", "advance"] },
    amount_cents: n,
    state: {
      ...s,
      enum: [
        "draft",
        "queued",
        "creating",
        "funding",
        "processing",
        "paid",
        "failed",
        "attention",
        "cancelled",
      ],
    },
    phase: {
      ...s,
      enum: [
        "draft",
        "queued",
        "processing",
        "settled",
        "failed",
        "attention",
        "cancelled",
      ],
    },
    failure: nullable(s),
    attempts: n,
  }),
  ContractorCurrencyReview: object({
    currency: s,
    recorded_earnings_cents: nullable(n),
    proposed_earnings_cents: nullable(n),
    paid_cents: n,
    reserved_cents: n,
    available_to_pay_cents: nullable(n),
    available_credit_cents: n,
    proposed_credit_cents: n,
    remaining_after_credit_cents: nullable(n),
    invoices: array("StaffInvoice"),
    advances: array("AdvanceCredit"),
    allocations: array("PaymentAllocation"),
    allocation_proposals: array("ContractorAllocationProposal"),
    credit_proposals: array("ContractorCreditProposal"),
    items: array("ContractorReviewItem"),
    proposal_blocked: b,
    flags: strings,
  }),
  ContractorReviewPerson: object({
    user_id: n,
    name: s,
    active: b,
    ledger_version: nullable(n),
    settled_through: nullable(s),
    ledger_events: array("StaffPaymentEvent"),
    phase,
    latest_review: nullable(ref("ContractorEarningsReview")),
    earnings: nullable(ref("ContractorReviewEarnings")),
    entries: array("ContractorReviewEntry"),
    currencies: array("ContractorCurrencyReview"),
  }),
  ContractorReview: object({
    month: s,
    completed: b,
    credit_period: object({ from: s, to: s }),
    version: { ...s, pattern: "^[a-f0-9]{64}$" },
    people: array("ContractorReviewPerson"),
  }),
  ContractorReviewEnvelope: object({ data: ref("ContractorReview") }),
};
export const contractorReviewOperations: readonly ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/staff-payments/contractor-review",
    operationId: "getContractorReview",
    summary:
      "Review contractor earnings, invoices, existing payments, advance credit and allocation proposals without executing them",
    tag: "staff-payments",
    responseStatus: 200,
    responseSchema: "ContractorReviewEnvelope",
    sessionOnly: true,
    parameters: [{ name: "month", location: "query", schema: s }],
  },
];
