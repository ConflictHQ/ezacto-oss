import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireApiScope } from "./auth.js";
import type { ApiContext, UserPrincipal } from "./context.js";
import { ApiError, validationError } from "./errors.js";
import { resourceId } from "./resources/support.js";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const multipartOverheadBytes = 64 * 1024;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || codePoint === 127;
  });

export interface AttachmentRecord {
  id: number;
  fileObjectId: number;
  contentHash: string;
  fileKey: string;
  byteSize: number;
  contentType: string;
  name: string;
  uploadedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentMetadataInput {
  attachmentId: number;
  commandId: string;
  actorUserId: number;
  contentHash: string;
  fileKey: string;
  byteSize: number;
  contentType: string;
  name: string;
  uploadedByUserId?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentMetadataPort {
  createInvoiceAttachment(
    input: AttachmentMetadataInput & { invoiceId: number },
  ): Promise<AttachmentRecord>;
  createRecurringInvoiceAttachment(
    input: AttachmentMetadataInput & { recurringInvoiceId: number },
  ): Promise<AttachmentRecord>;
  createEstimateAttachment(
    input: AttachmentMetadataInput & { estimateId: number },
  ): Promise<AttachmentRecord>;
  createExpenseAttachment(
    input: AttachmentMetadataInput & { expenseId: number },
  ): Promise<AttachmentRecord>;
  createProjectAttachment(
    input: AttachmentMetadataInput & { projectId: number },
  ): Promise<AttachmentRecord>;
  listInvoiceAttachments(
    invoiceId: number,
  ): Promise<readonly AttachmentRecord[]>;
  listRecurringInvoiceAttachments(
    recurringInvoiceId: number,
  ): Promise<readonly AttachmentRecord[]>;
  listEstimateAttachments(
    estimateId: number,
  ): Promise<readonly AttachmentRecord[]>;
  listExpenseAttachments(
    expenseId: number,
  ): Promise<readonly AttachmentRecord[]>;
  listProjectAttachments(
    projectId: number,
  ): Promise<readonly AttachmentRecord[]>;
  getInvoiceAttachment(
    invoiceId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>;
  getRecurringInvoiceAttachment(
    recurringInvoiceId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>;
  getEstimateAttachment(
    estimateId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>;
  getExpenseAttachment(
    expenseId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>;
  getProjectAttachment(
    projectId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>;
}

export interface AttachmentObject {
  body: BodyInit;
}

export interface AttachmentObjectPort {
  /** Content-addressed puts must be safe to repeat for the same key and bytes. */
  put(key: string, bytes: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<AttachmentObject | null>;
}

export type AttachmentOwnerType =
  "invoice" | "recurringInvoice" | "estimate" | "expense" | "project";

export interface AttachmentOwnerAccessInput {
  owner: AttachmentOwnerType;
  parentId: number;
  access: "read" | "write";
  principal: Readonly<UserPrincipal>;
}

export interface AttachmentRouteOptions {
  metadata: AttachmentMetadataPort;
  objects: AttachmentObjectPort;
  /** Must apply row-level owner visibility; false is returned as a redacted 404. */
  authorizeOwnerAccess(input: AttachmentOwnerAccessInput): Promise<boolean>;
  clock?: () => string;
}

type OwnerDefinition = {
  owner: AttachmentOwnerType;
  collection:
    "invoices" | "recurring-invoices" | "estimates" | "expenses" | "projects";
  singular: string;
  parameter:
    | "invoiceId"
    | "recurringInvoiceId"
    | "estimateId"
    | "expenseId"
    | "projectId";
  scope: "invoices" | "expenses" | "projects";
  create(
    metadata: AttachmentMetadataPort,
    parentId: number,
    input: AttachmentMetadataInput,
  ): Promise<AttachmentRecord>;
  list(
    metadata: AttachmentMetadataPort,
    parentId: number,
  ): Promise<readonly AttachmentRecord[]>;
  get(
    metadata: AttachmentMetadataPort,
    parentId: number,
    attachmentId: number,
  ): Promise<AttachmentRecord | null>;
};

const owners: readonly OwnerDefinition[] = [
  {
    owner: "invoice",
    collection: "invoices",
    singular: "invoice",
    parameter: "invoiceId",
    scope: "invoices",
    create: (metadata, invoiceId, input) =>
      metadata.createInvoiceAttachment({ ...input, invoiceId }),
    list: (metadata, invoiceId) => metadata.listInvoiceAttachments(invoiceId),
    get: (metadata, invoiceId, attachmentId) =>
      metadata.getInvoiceAttachment(invoiceId, attachmentId),
  },
  {
    owner: "recurringInvoice",
    collection: "recurring-invoices",
    singular: "recurring invoice",
    parameter: "recurringInvoiceId",
    scope: "invoices",
    create: (metadata, recurringInvoiceId, input) =>
      metadata.createRecurringInvoiceAttachment({
        ...input,
        recurringInvoiceId,
      }),
    list: (metadata, recurringInvoiceId) =>
      metadata.listRecurringInvoiceAttachments(recurringInvoiceId),
    get: (metadata, recurringInvoiceId, attachmentId) =>
      metadata.getRecurringInvoiceAttachment(recurringInvoiceId, attachmentId),
  },
  {
    owner: "estimate",
    collection: "estimates",
    singular: "estimate",
    parameter: "estimateId",
    scope: "invoices",
    create: (metadata, estimateId, input) =>
      metadata.createEstimateAttachment({ ...input, estimateId }),
    list: (metadata, estimateId) =>
      metadata.listEstimateAttachments(estimateId),
    get: (metadata, estimateId, attachmentId) =>
      metadata.getEstimateAttachment(estimateId, attachmentId),
  },
  {
    owner: "expense",
    collection: "expenses",
    singular: "expense",
    parameter: "expenseId",
    scope: "expenses",
    create: (metadata, expenseId, input) =>
      metadata.createExpenseAttachment({ ...input, expenseId }),
    list: (metadata, expenseId) => metadata.listExpenseAttachments(expenseId),
    get: (metadata, expenseId, attachmentId) =>
      metadata.getExpenseAttachment(expenseId, attachmentId),
  },
  {
    owner: "project",
    collection: "projects",
    singular: "project",
    parameter: "projectId",
    scope: "projects",
    create: (metadata, projectId, input) =>
      metadata.createProjectAttachment({ ...input, projectId }),
    list: (metadata, projectId) => metadata.listProjectAttachments(projectId),
    get: (metadata, projectId, attachmentId) =>
      metadata.getProjectAttachment(projectId, attachmentId),
  },
];

const unavailable = (): never => {
  throw new ApiError({
    status: 503,
    code: "service_unavailable",
    message: "Attachment storage is not configured.",
  });
};

const requireOptions = (
  options: AttachmentRouteOptions | undefined,
): AttachmentRouteOptions => options ?? unavailable();

const requireOwnerAccess = async (
  options: AttachmentRouteOptions,
  owner: OwnerDefinition,
  parentId: number,
  access: "read" | "write",
  principal: Readonly<UserPrincipal>,
): Promise<void> => {
  if (
    await options.authorizeOwnerAccess({
      owner: owner.owner,
      parentId,
      access,
      principal,
    })
  ) {
    return;
  }
  throw new ApiError({
    status: 404,
    code: "not_found",
    message: `The ${owner.singular} does not exist.`,
  });
};

const serialize = (record: AttachmentRecord) => ({
  id: record.id,
  name: record.name,
  content_hash: record.contentHash,
  byte_size: record.byteSize,
  content_type: record.contentType,
  uploaded_by_user_id: record.uploadedByUserId,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
});

const attachmentEnvelope = (
  owner: OwnerDefinition,
  parentId: number,
  record: AttachmentRecord,
) => ({
  data: serialize(record),
  links: {
    self: `/api/v1/${owner.collection}/${parentId}/attachments/${record.id}`,
    content: `/api/v1/${owner.collection}/${parentId}/attachments/${record.id}/content`,
  },
});

const hash = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const commandIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

const idempotencyKey = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): string => {
  const value = context.req.header("idempotency-key");
  if (value === undefined || !commandIdPattern.test(value)) {
    throw validationError([
      {
        field: "Idempotency-Key",
        code: value === undefined ? "required" : "invalid_command_id",
        message:
          "Idempotency-Key must use 1-128 ASCII letters, digits, dot, underscore, colon, or dash.",
      },
    ]);
  }
  return value;
};

const stableAttachmentId = async (
  owner: AttachmentOwnerType,
  parentId: number,
  commandId: string,
): Promise<number> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        ["attachment", owner, parentId, commandId].join("\u001f"),
      ),
    ),
  );
  const hexadecimal = [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Number.parseInt(hexadecimal.slice(0, 13), 16) + 1;
};

const fileName = (value: string): string => {
  if (
    value.length < 1 ||
    value.length > 255 ||
    !value.trim() ||
    hasControlCharacter(value)
  ) {
    throw validationError([
      {
        field: "file.name",
        code: "invalid",
        message: "file name must be 1-255 visible characters",
      },
    ]);
  }
  return value;
};

const mediaType = (value: string): string => {
  const normalized = value.trim() || "application/octet-stream";
  if (normalized.length > 255 || hasControlCharacter(normalized)) {
    throw validationError([
      {
        field: "file.type",
        code: "invalid",
        message: "file content type is invalid",
      },
    ]);
  }
  return normalized;
};

const multipartFile = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): Promise<{ bytes: ArrayBuffer; name: string; contentType: string }> => {
  const contentType = context.req.header("content-type") ?? "";
  if (
    !/^multipart\/form-data\s*;/i.test(contentType) ||
    !/boundary\s*=\s*(?:"[^"]+"|[^;\s]+)/i.test(contentType)
  ) {
    throw new ApiError({
      status: 415,
      code: "unsupported_media_type",
      message:
        "Attachment uploads require multipart/form-data with a boundary.",
    });
  }
  let form: FormData;
  try {
    form = await context.req.raw.formData();
  } catch {
    throw new ApiError({
      status: 400,
      code: "invalid_multipart",
      message: "The multipart request body is malformed.",
    });
  }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "file") {
    throw validationError([
      {
        field: "file",
        code: "exactly_one_required",
        message: "provide exactly one file part and no other fields",
      },
    ]);
  }
  const value = entries[0][1];
  if (!(value instanceof Blob) || typeof (value as File).name !== "string") {
    throw validationError([
      {
        field: "file",
        code: "file_required",
        message: "file must be a binary file part",
      },
    ]);
  }
  if (value.size > MAX_ATTACHMENT_BYTES) {
    throw new ApiError({
      status: 413,
      code: "payload_too_large",
      message: `Attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte file limit.`,
    });
  }
  return {
    bytes: await value.arrayBuffer(),
    name: fileName((value as File).name),
    contentType: mediaType(value.type),
  };
};

const translateMetadataError = (error: unknown): never => {
  if (error instanceof ApiError) throw error;
  if (error instanceof TypeError || error instanceof RangeError) {
    throw validationError([
      {
        field: "file",
        code: "invalid",
        message: "The attachment metadata is invalid.",
      },
    ]);
  }
  if (
    error instanceof Error &&
    /foreign key constraint failed|does not exist/i.test(error.message)
  ) {
    throw new ApiError({
      status: 404,
      code: "not_found",
      message: "The attachment owner does not exist.",
    });
  }
  if (
    error instanceof Error &&
    /(unique constraint|content identity|file object|attachment identity|attachment owner guard|command id was reused|did not persist its logical row|constraint failed)/i.test(
      error.message,
    )
  ) {
    throw new ApiError({
      status: 409,
      code: "attachment_conflict",
      message: "The attachment metadata conflicts with existing content.",
    });
  }
  throw error;
};

const contentDisposition = (name: string): string => {
  const fallback =
    name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachment";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

export const installAttachmentRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  supplied?: AttachmentRouteOptions,
): void => {
  const noStore: MiddlewareHandler<ApiContext<Bindings>> = async (
    context,
    next,
  ) => {
    await next();
    context.header("cache-control", "no-store");
  };
  const uploadLimit = bodyLimit({
    maxSize: MAX_ATTACHMENT_BYTES + multipartOverheadBytes,
    onError: () => {
      throw new ApiError({
        status: 413,
        code: "payload_too_large",
        message: `Attachment upload exceeds the ${MAX_ATTACHMENT_BYTES}-byte file limit.`,
      });
    },
  });

  for (const owner of owners) {
    const collection = `/${owner.collection}/:${owner.parameter}/attachments`;
    api.use(collection, noStore);
    api.use(`${collection}/*`, noStore);
    api.use(collection, uploadLimit as MiddlewareHandler<ApiContext<Bindings>>);

    api.post(collection, async (rawContext) => {
      const context = rawContext as Context<ApiContext<Bindings>>;
      requireApiScope(context, `${owner.scope}:write`);
      const options = requireOptions(supplied);
      const parentId = resourceId(
        context.req.param(owner.parameter) ?? "",
        owner.singular,
      );
      await requireOwnerAccess(
        options,
        owner,
        parentId,
        "write",
        context.get("principal"),
      );
      const commandId = idempotencyKey(context);
      const file = await multipartFile(context);
      const contentHash = await hash(file.bytes);
      const fileKey = `sha256/${contentHash.slice(0, 2)}/${contentHash}`;
      const occurredAt = (options.clock ?? (() => new Date().toISOString()))();

      // The object write is intentionally first and content-addressed. A database
      // failure leaves a safe orphan for GC; deleting could remove shared content.
      await options.objects.put(fileKey, file.bytes, file.contentType);
      const created = await owner
        .create(options.metadata, parentId, {
          attachmentId: await stableAttachmentId(
            owner.owner,
            parentId,
            commandId,
          ),
          commandId,
          actorUserId: context.get("principal").userId,
          contentHash,
          fileKey,
          byteSize: file.bytes.byteLength,
          contentType: file.contentType,
          name: file.name,
          uploadedByUserId: context.get("principal").userId,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        })
        .catch(translateMetadataError);
      return context.json(attachmentEnvelope(owner, parentId, created), 201);
    });

    api.get(collection, async (rawContext) => {
      const context = rawContext as Context<ApiContext<Bindings>>;
      requireApiScope(context, `${owner.scope}:read`);
      const options = requireOptions(supplied);
      const parentId = resourceId(
        context.req.param(owner.parameter) ?? "",
        owner.singular,
      );
      await requireOwnerAccess(
        options,
        owner,
        parentId,
        "read",
        context.get("principal"),
      );
      return context.json({
        data: (await owner.list(options.metadata, parentId)).map(serialize),
        links: { self: `/api/v1/${owner.collection}/${parentId}/attachments` },
      });
    });

    api.get(`${collection}/:attachmentId`, async (rawContext) => {
      const context = rawContext as Context<ApiContext<Bindings>>;
      requireApiScope(context, `${owner.scope}:read`);
      const options = requireOptions(supplied);
      const parentId = resourceId(
        context.req.param(owner.parameter) ?? "",
        owner.singular,
      );
      await requireOwnerAccess(
        options,
        owner,
        parentId,
        "read",
        context.get("principal"),
      );
      const attachmentId = resourceId(
        context.req.param("attachmentId") ?? "",
        "attachment",
      );
      const record = await owner.get(options.metadata, parentId, attachmentId);
      if (record === null) {
        throw new ApiError({
          status: 404,
          code: "not_found",
          message: "The attachment does not exist.",
        });
      }
      return context.json(attachmentEnvelope(owner, parentId, record));
    });

    api.get(`${collection}/:attachmentId/content`, async (rawContext) => {
      const context = rawContext as Context<ApiContext<Bindings>>;
      requireApiScope(context, `${owner.scope}:read`);
      const options = requireOptions(supplied);
      const parentId = resourceId(
        context.req.param(owner.parameter) ?? "",
        owner.singular,
      );
      await requireOwnerAccess(
        options,
        owner,
        parentId,
        "read",
        context.get("principal"),
      );
      const attachmentId = resourceId(
        context.req.param("attachmentId") ?? "",
        "attachment",
      );
      const record = await owner.get(options.metadata, parentId, attachmentId);
      if (record === null) {
        throw new ApiError({
          status: 404,
          code: "not_found",
          message: "The attachment does not exist.",
        });
      }
      const object = await options.objects.get(record.fileKey);
      if (object === null) throw new Error("attachment object is missing");
      return new Response(object.body, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-type": record.contentType,
          "content-length": String(record.byteSize),
          "content-disposition": contentDisposition(record.name),
          // #737. The content type here is whatever the uploader claimed, and
          // an uploader is any user who can attach a file. Without nosniff a
          // browser is free to re-type the bytes by looking at them, so a file
          // uploaded as an innocuous type and containing markup can be served
          // back as HTML on this origin, where a session cookie lives.
          // Attachments already download rather than display, so nothing legit
          // depends on sniffing.
          "x-content-type-options": "nosniff",
        },
      });
    });
  }
};
