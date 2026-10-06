import type { ApiContractOperation } from "./contract.js";

const positiveInteger = { type: "integer", minimum: 1 } as const;
const ownerPath = (name: string) => ({
  name,
  location: "path" as const,
  schema: positiveInteger,
  required: true,
});
const idempotency = {
  name: "Idempotency-Key",
  location: "header" as const,
  schema: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9._:-]+$",
  },
  required: true,
};

const definitions = [
  { collection: "invoices", singular: "Invoice", parent: "invoiceId" },
  {
    collection: "recurring-invoices",
    singular: "RecurringInvoice",
    parent: "recurringInvoiceId",
  },
  { collection: "estimates", singular: "Estimate", parent: "estimateId" },
  { collection: "expenses", singular: "Expense", parent: "expenseId" },
  { collection: "projects", singular: "Project", parent: "projectId" },
] as const;

const recurringFile = "/api/v1/recurring-invoices/:recurringInvoiceId/attachments/:attachmentId";

/**
 * A recurring definition's files go with every invoice it issues, until their
 * `through` day; these say until when, and stop one going at all.
 */
const recurringStandingOperations: readonly ApiContractOperation[] = [
  {
    method: "patch",
    path: recurringFile,
    operationId: "setRecurringInvoiceAttachmentThrough",
    summary: "Set the last issue date a recurring definition's file goes with",
    tag: "attachments",
    responseStatus: 200,
    responseSchema: "AttachmentEnvelope",
    requestSchema: "RecurringAttachmentThroughInput",
    requestRequired: true,
    parameters: [ownerPath("recurringInvoiceId"), ownerPath("attachmentId")],
  },
  {
    method: "delete",
    path: recurringFile,
    operationId: "removeRecurringInvoiceAttachment",
    summary: "Stop a file going with the invoices a recurring definition issues",
    tag: "attachments",
    responseStatus: 204,
    parameters: [ownerPath("recurringInvoiceId"), ownerPath("attachmentId")],
  },
];

export const attachmentContractOperations: readonly ApiContractOperation[] = [
  ...definitions.flatMap(({ collection, singular, parent }) => {
    const route = `/api/v1/${collection}/:${parent}/attachments`;
    const parentParameter = ownerPath(parent);
    return [
      {
        method: "get",
        path: route,
        operationId: `list${singular}Attachments`,
        summary: `List attachments owned by a ${singular.toLowerCase()}`,
        tag: "attachments",
        responseStatus: 200,
        responseSchema: "AttachmentListEnvelope",
        parameters: [parentParameter],
      },
      {
        method: "post",
        path: route,
        operationId: `create${singular}Attachment`,
        summary: `Upload an attachment owned by a ${singular.toLowerCase()}`,
        tag: "attachments",
        responseStatus: 201,
        responseSchema: "AttachmentEnvelope",
        requestSchema: "AttachmentUploadInput",
        requestRequired: true,
        requestContentType: "multipart/form-data",
        parameters: [parentParameter, idempotency],
      },
      {
        method: "get",
        path: `${route}/:attachmentId`,
        operationId: `get${singular}Attachment`,
        summary: `Get metadata for a ${singular.toLowerCase()} attachment`,
        tag: "attachments",
        responseStatus: 200,
        responseSchema: "AttachmentEnvelope",
        parameters: [parentParameter, ownerPath("attachmentId")],
      },
      {
        method: "get",
        path: `${route}/:attachmentId/content`,
        operationId: `download${singular}Attachment`,
        summary: `Download an attachment owned by a ${singular.toLowerCase()}`,
        tag: "attachments",
        responseStatus: 200,
        binaryResponse: true,
        parameters: [parentParameter, ownerPath("attachmentId")],
      },
    ] satisfies ApiContractOperation[];
  }),
  ...recurringStandingOperations,
];

const stringSchema = { type: "string" } as const;
const timestampSchema = { type: "string", format: "date-time" } as const;
const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const attachmentContractSchemas = {
  AttachmentUploadInput: {
    type: "object",
    required: ["file"],
    properties: { file: { type: "string", format: "binary" } },
    additionalProperties: false,
  },
  Attachment: {
    type: "object",
    required: [
      "id",
      "name",
      "content_hash",
      "byte_size",
      "content_type",
      "uploaded_by_user_id",
      "created_at",
      "updated_at",
    ],
    properties: {
      id: positiveInteger,
      name: stringSchema,
      content_hash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      byte_size: { type: "integer", minimum: 0 },
      content_type: stringSchema,
      uploaded_by_user_id: { anyOf: [positiveInteger, { type: "null" }] },
      created_at: timestampSchema,
      updated_at: timestampSchema,
      // A recurring definition's file only: the last issue date it goes with,
      // or null for every invoice the definition issues.
      through: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
    },
    additionalProperties: false,
  },
  RecurringAttachmentThroughInput: {
    type: "object",
    required: ["through"],
    properties: { through: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] } },
    additionalProperties: false,
  },
  AttachmentEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: { data: reference("Attachment"), links: reference("Links") },
    additionalProperties: false,
  },
  AttachmentListEnvelope: {
    type: "object",
    required: ["data", "links"],
    properties: {
      data: { type: "array", items: reference("Attachment") },
      links: reference("Links"),
    },
    additionalProperties: false,
  },
} as const;
