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
const kind = { type: "string", enum: ["draft", "received", "void"] };
export const staffInvoiceSchemas = {
  StaffInvoiceLine: object({
    description: s,
    project_id: nullable(n),
    entry_id: nullable(n),
    seconds: n,
    rate_cents: n,
  }),
  SaveStaffInvoice: object({
    id: s,
    invoice_id: nullable(n),
    expected_version: n,
    user_id: n,
    month: s,
    currency: s,
    reference: s,
    kind,
    from_review: b,
    lines: array("StaffInvoiceLine"),
    document_id: nullable(s),
    reason: s,
    acknowledge_paid_history: b,
  }),
  StaffInvoiceVersion: object({
    command_id: s,
    version: n,
    month: s,
    currency: s,
    kind,
    lines: array("StaffInvoiceLine"),
    amount_cents: n,
    review_id: nullable(s),
    document_id: nullable(s),
    reason: s,
    actor_id: n,
    recorded_at: s,
    paid_cents_at_recording: n,
    has_payment_history: b,
  }),
  StaffInvoice: object({
    id: n,
    user_id: n,
    month: s,
    currency: s,
    reference: s,
    versions: array("StaffInvoiceVersion"),
    matched_cents: n,
    flags: { type: "array", items: s },
    line_flags: { type: "array", items: { type: "array", items: s } },
  }),
  StaffInvoicePerson: object({
    user_id: n,
    name: s,
    currency: nullable(s),
    earned_cents: nullable(n),
    paid_cents: n,
    invoiced_cents: n,
    matched_invoice_cents: n,
    uninvoiced_cents: nullable(n),
    invoices: array("StaffInvoice"),
  }),
  StaffInvoiceReport: object({ month: s, people: array("StaffInvoicePerson") }),
  StaffInvoiceReportEnvelope: object({ data: ref("StaffInvoiceReport") }),
  StaffInvoiceEnvelope: object({ data: ref("StaffInvoice") }),
  StaffInvoiceDocumentInfo: object({
    id: s,
    invoice_id: n,
    name: s,
    byte_size: n,
    content_type: s,
  }),
  StaffInvoiceDocumentEnvelope: object({
    data: ref("StaffInvoiceDocumentInfo"),
  }),
};
const month = { name: "month", location: "query" as const, schema: s };
const invoicePath = {
  name: "invoiceId",
  location: "path" as const,
  schema: n,
  required: true,
};
export const staffInvoiceOperations: readonly ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/staff-invoices",
    operationId: "getStaffInvoiceReport",
    summary:
      "Reconcile contractor payable invoices against existing reviewed earnings",
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "StaffInvoiceReportEnvelope",
    parameters: [month],
  },
  {
    method: "get",
    path: "/api/v1/me/staff-invoices",
    operationId: "getMyStaffInvoices",
    summary:
      "Read only your received payable invoices when own-money viewing is enabled",
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "StaffInvoiceReportEnvelope",
    parameters: [month],
  },
  {
    method: "post",
    path: "/api/v1/staff-invoices",
    operationId: "saveStaffInvoice",
    summary:
      "Record an immutable contractor invoice version without changing amounts owed",
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 201,
    responseSchema: "StaffInvoiceEnvelope",
    requestSchema: "SaveStaffInvoice",
    requestRequired: true,
  },
  {
    method: "post",
    path: "/api/v1/staff-invoices/:invoiceId/documents",
    operationId: "uploadStaffInvoiceDocument",
    summary:
      "Stage a contractor invoice document for explicit inclusion in a version",
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 201,
    responseSchema: "StaffInvoiceDocumentEnvelope",
    requestSchema: "AttachmentUpload",
    requestRequired: true,
    requestContentType: "multipart/form-data",
    parameters: [
      invoicePath,
      { ...month, required: true },
      {
        name: "Idempotency-Key",
        location: "header",
        schema: s,
        required: true,
      },
    ],
  },
  {
    method: "get",
    path: "/api/v1/staff-invoices/:invoiceId/documents/:documentId/content",
    operationId: "getStaffInvoiceDocumentContent",
    summary: "Download an authorized contractor invoice document",
    tag: "staff-payments",
    sessionOnly: true,
    responseStatus: 200,
    binaryResponse: true,
    parameters: [
      invoicePath,
      { name: "documentId", location: "path", schema: s, required: true },
    ],
  },
];
