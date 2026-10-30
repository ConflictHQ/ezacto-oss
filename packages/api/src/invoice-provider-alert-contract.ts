import type { ApiContractOperation } from "./contract.js";
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: "string" },
  integer = { type: "integer" };
const nullable = (value: object) => ({ anyOf: [value, { type: "null" }] });
export const invoiceProviderAlertSchemas = {
  InvoiceProviderAlert: object({
    id: str,
    event_type: str,
    kind: { type: "string", enum: ["refund", "dispute"] },
    amount_cents: integer,
    currency: str,
    provider_status: str,
    occurred_at: str,
    reviewed_at: nullable(str),
    reviewed_by: nullable(integer),
  }),
  InvoiceProviderAlertEnvelope: object({ data: ref("InvoiceProviderAlert") }),
  InvoiceProviderAlertListEnvelope: object({
    data: { type: "array", items: ref("InvoiceProviderAlert") },
  }),
  ReviewInvoiceProviderAlertInput: object({}),
};
const id = {
  name: "id",
  location: "path" as const,
  required: true,
  schema: { type: "integer", minimum: 1 },
};
export const invoiceProviderAlertOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/invoices/:id/provider-alerts",
    operationId: "listInvoiceProviderAlerts",
    summary:
      "List verified Stripe refund and dispute reports without changing receipts",
    tag: "invoices",
    sessionOnly: true,
    parameters: [id],
    responseStatus: 200,
    responseSchema: "InvoiceProviderAlertListEnvelope",
  },
  {
    method: "post",
    path: "/api/v1/invoices/:id/provider-alerts/:alertId/review",
    operationId: "reviewInvoiceProviderAlert",
    summary: "Mark a provider report reviewed without an accounting mutation",
    tag: "invoices",
    sessionOnly: true,
    parameters: [
      id,
      { name: "alertId", location: "path", required: true, schema: str },
    ],
    requestSchema: "ReviewInvoiceProviderAlertInput",
    requestRequired: true,
    responseStatus: 200,
    responseSchema: "InvoiceProviderAlertEnvelope",
  },
];
