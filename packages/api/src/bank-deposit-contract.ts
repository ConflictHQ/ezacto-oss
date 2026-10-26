import type { ApiContractOperation } from "./contract.js";
const str = { type: "string" },
  integer = { type: "integer" },
  bool = { type: "boolean" };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(properties),
  properties,
  additionalProperties: false,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] });
const invoice = object({
  id: integer,
  number: str,
  currency: str,
  due_amount_cents: integer,
  version: integer,
  state: str,
});
const account = object({
  id: integer,
  provider: { type: "string", enum: ["mercury", "wise"] },
  name: str,
});
const row = object({
  id: integer,
  account_id: integer,
  account_name: str,
  provider: { type: "string", enum: ["mercury", "wise"] },
  provider_transaction_id: str,
  currency: str,
  posted_at: str,
  amount_cents: integer,
  memo: nullable(str),
  counterparty: nullable(str),
  state: {
    type: "string",
    enum: ["unmatched", "suggested", "confirmed", "rejected"],
  },
  version: integer,
  suggested_invoice: nullable(ref("BankReviewInvoice")),
  source_status: {
    type: "string",
    enum: ["final", "pending", "reversed", "unknown"],
  },
  classification: {
    type: "string",
    enum: ["external_credit", "internal_transfer", "ambiguous_credit"],
  },
  source_reason: nullable(str),
  verified_at: nullable(str),
  verified_by_user_id: nullable(integer),
  verification_reference: nullable(str),
  confirmation_basis: nullable({
    type: "string",
    enum: ["provider", "operator"],
  }),
  confirmation_ready: bool,
  payment_id: nullable(integer),
  confirmed_invoice_id: nullable(integer),
});
export const bankDepositSchemas = {
  BankReviewInvoice: invoice,
  BankFeedAccount: account,
  BankDeposit: row,
  BankDepositAccountsEnvelope: object({
    data: { type: "array", items: ref("BankFeedAccount") },
  }),
  BankDepositListEnvelope: object({
    data: { type: "array", items: ref("BankDeposit") },
    page: integer,
    per_page: integer,
    total: integer,
  }),
  BankDepositInvoicesEnvelope: object({
    data: { type: "array", items: ref("BankReviewInvoice") },
  }),
  BankDepositEnvelope: object({ data: ref("BankDeposit") }),
  BankDepositAssignInput: object({
    expected_version: integer,
    invoice_id: integer,
  }),
  BankDepositDecisionInput: object({ expected_version: integer }),
  BankDepositConfirmInput: object({
    expected_version: integer,
    invoice_id: integer,
    expected_invoice_version: integer,
    confirm_overpayment: bool,
  }),
  BankDepositVerifyInput: object({
    expected_version: integer,
    verification_reference: { type: "string", minLength: 1, maxLength: 200 },
    confirm_posted_funds: { const: true },
    confirm_external_credit: { const: true },
  }),
};
const id = {
  name: "id",
  location: "path" as const,
  required: true,
  schema: { type: "integer", minimum: 1 },
};
const command = {
  name: "Idempotency-Key",
  location: "header" as const,
  required: true,
  schema: { type: "string", maxLength: 128 },
};
export const bankDepositOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/bank-deposit-accounts",
    operationId: "listBankDepositAccounts",
    summary: "List bank feed accounts visible to the review queue",
    tag: "invoices",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "BankDepositAccountsEnvelope",
  },
  {
    method: "get",
    path: "/api/v1/bank-deposits",
    operationId: "listBankDeposits",
    summary: "Review staged credits without creating receipts",
    tag: "invoices",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "BankDepositListEnvelope",
    parameters: [
      { name: "state", location: "query", schema: { type: "string", enum: ["unmatched", "suggested", "confirmed", "rejected"] } },
      { name: "page", location: "query", schema: integer },
      { name: "per_page", location: "query", schema: integer },
    ],
  },
  {
    method: "get",
    path: "/api/v1/bank-deposits/:id/invoices",
    operationId: "listBankDepositInvoices",
    summary: "Find same-currency invoices for an explicit assignment",
    tag: "invoices",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "BankDepositInvoicesEnvelope",
    parameters: [id, { name: "query", location: "query", schema: str }],
  },
  ...(
    [
      [
        "assign",
        "assignBankDeposit",
        "BankDepositAssignInput",
        "Choose the invoice to review for this credit",
      ],
      [
        "reject",
        "rejectBankDeposit",
        "BankDepositDecisionInput",
        "Reject this credit without altering an invoice",
      ],
      [
        "reopen",
        "reopenBankDeposit",
        "BankDepositDecisionInput",
        "Reopen a rejected credit for review",
      ],
      [
        "confirm",
        "confirmBankDeposit",
        "BankDepositConfirmInput",
        "Explicitly confirm one credit against one invoice",
      ],
      [
        "verify-source",
        "verifyBankDepositSource",
        "BankDepositVerifyInput",
        "Record an administrator verification of an uncertain external credit",
      ],
    ] as const
  ).map(([path, operationId, requestSchema, summary]) => ({
    method: "post" as const,
    path: "/api/v1/bank-deposits/:id/" + path,
    operationId,
    summary,
    tag: "invoices",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "BankDepositEnvelope",
    requestSchema,
    requestRequired: true,
    parameters: [id, command],
  })),
];
