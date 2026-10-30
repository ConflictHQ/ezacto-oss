import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  StaffPaymentError,
  previousPaymentMonth,
  type SaveStaffInvoice,
  type StaffInvoiceLine,
  type StaffInvoicesStore,
} from "@ezacto/core";
import { requireSessionPrincipal } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError, validationError } from "./errors.js";
import { readObjectBody, resourceId } from "./resources/support.js";
import {
  MAX_ATTACHMENT_BYTES,
  readAttachmentFile,
  attachmentContentHash,
  type AttachmentObjectPort,
} from "./attachments.js";
const invalid = (): never => {
  throw validationError([
    {
      field: "staff_invoice",
      code: "invalid",
      message:
        "Provide a contractor invoice, its version, line values and a reason.",
    },
  ]);
};
const commandOf = (b: Record<string, unknown>): SaveStaffInvoice => {
  const allowed = [
    "id",
    "invoice_id",
    "expected_version",
    "user_id",
    "month",
    "currency",
    "reference",
    "kind",
    "from_review",
    "lines",
    "document_id",
    "reason",
    "acknowledge_paid_history",
  ];
  if (Object.keys(b).some((key) => !allowed.includes(key))) invalid();
  if (
    !["id", "currency", "month", "reference", "kind", "reason"].every(
      (key) => typeof b[key] === "string",
    ) ||
    !["user_id", "expected_version"].every(
      (key) => typeof b[key] === "number",
    ) ||
    !(b.invoice_id === null || typeof b.invoice_id === "number") ||
    !(b.document_id === null || typeof b.document_id === "string") ||
    typeof b.from_review !== "boolean" ||
    typeof b.acknowledge_paid_history !== "boolean" ||
    !Array.isArray(b.lines)
  )
    invalid();
  const lines = (b.lines as unknown[]).map((line) => {
    if (!line || typeof line !== "object" || Array.isArray(line)) invalid();
    const item = line as Record<string, unknown>;
    if (
      Object.keys(item).some(
        (key) =>
          ![
            "description",
            "project_id",
            "entry_id",
            "seconds",
            "rate_cents",
          ].includes(key),
      )
    )
      invalid();
    if (
      typeof item.description !== "string" ||
      typeof item.seconds !== "number" ||
      typeof item.rate_cents !== "number" ||
      !["entry_id", "project_id"].every(
        (key) => item[key] === null || typeof item[key] === "number",
      )
    )
      invalid();
    return {
      description: item.description,
      project_id: item.project_id,
      entry_id: item.entry_id,
      seconds: item.seconds,
      rate_cents: item.rate_cents,
    } as StaffInvoiceLine;
  });
  return {
    id: b.id as string,
    invoice_id: b.invoice_id as number | null,
    expected_version: b.expected_version as number,
    user_id: b.user_id as number,
    month: b.month as string,
    currency: b.currency as string,
    reference: b.reference as string,
    kind: b.kind as SaveStaffInvoice["kind"],
    reason: b.reason as string,
    from_review: b.from_review as boolean,
    acknowledge_paid_history: b.acknowledge_paid_history as boolean,
    document_id: b.document_id as string | null,
    lines,
  };
};
export const installStaffInvoiceRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  store: StaffInvoicesStore,
  objects?: AttachmentObjectPort,
) => {
  const execute = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StaffPaymentError) {
        if (error.code === "invalid")
          throw validationError([
            { field: "staff_invoice", code: "invalid", message: error.message },
          ]);
        throw new ApiError({
          status: error.code === "not_found" ? 404 : 409,
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  };
  const admin = (c: Context<ApiContext<Bindings>>) => {
    const principal = requireSessionPrincipal(c);
    if (principal.profile !== "administrator")
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Only administrators can record contractor invoices.",
      });
    return principal;
  };
  api.get("/staff-invoices", async (c) => {
    admin(c);
    const month =
      c.req.query("month") ?? previousPaymentMonth(new Date().toISOString());
    return c.json({ data: await execute(() => store.report(month)) }, 200, {
      "cache-control": "no-store",
    });
  });
  api.get("/me/staff-invoices", async (c) => {
    const principal = requireSessionPrincipal(c);
    if (principal.ownMoneyVisible !== true)
      throw new ApiError({
        status: 403,
        code: "own_money_disabled",
        message: "Viewing your own money is disabled on this instance.",
      });
    return c.json(
      {
        data: await execute(() =>
          store.report(
            c.req.query("month") ??
              previousPaymentMonth(new Date().toISOString()),
            principal.userId,
          ),
        ),
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.post("/staff-invoices", async (c) => {
    const principal = admin(c);
    const body = await readObjectBody(c);
    return c.json(
      {
        data: await execute(() =>
          store.save(
            commandOf(body),
            principal.userId,
            c.get("requestId"),
            new Date().toISOString(),
          ),
        ),
      },
      201,
      { "cache-control": "no-store" },
    );
  });
  api.use(
    "/staff-invoices/:invoiceId/documents",
    bodyLimit({
      maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
      onError: () => {
        throw new ApiError({
          status: 413,
          code: "payload_too_large",
          message: "The invoice document exceeds the 25 MiB upload limit.",
        });
      },
    }),
  );
  api.post("/staff-invoices/:invoiceId/documents", async (c) => {
    const principal = admin(c);
    if (!objects)
      throw new ApiError({
        status: 503,
        code: "unavailable",
        message: "Invoice file storage is unavailable.",
      });
    const invoiceId = resourceId(
      c.req.param("invoiceId"),
      "contractor invoice",
    );
    // Verify the invoice before accepting bytes. No arbitrary object key ever
    // enters through a request: it is always derived from the uploaded content.
    const month = c.req.query("month");
    if (
      !month ||
      !(await execute(() => store.report(month))).people.some((p) =>
        p.invoices.some((i) => i.id === invoiceId),
      )
    )
      throw new ApiError({
        status: 404,
        code: "not_found",
        message: "Contractor invoice not found for this month.",
      });
    const id = c.req.header("idempotency-key") ?? "";
    if (!/^[a-zA-Z0-9._-]{1,100}$/u.test(id)) invalid();
    const file = await readAttachmentFile(c),
      hash = await attachmentContentHash(file.bytes);
    const command = {
      id,
      invoice_id: invoiceId,
      content_hash: hash,
      file_key: `sha256/${hash.slice(0, 2)}/${hash}`,
      name: file.name,
      content_type: file.contentType,
      byte_size: file.bytes.byteLength,
    };
    await objects.put(command.file_key, file.bytes, file.contentType);
    await execute(() =>
      store.recordDocument(
        command,
        principal.userId,
        c.get("requestId"),
        new Date().toISOString(),
      ),
    );
    return c.json(
      {
        data: {
          id,
          invoice_id: invoiceId,
          name: file.name,
          content_type: file.contentType,
          byte_size: file.bytes.byteLength,
        },
      },
      201,
      { "cache-control": "no-store" },
    );
  });
  api.get(
    "/staff-invoices/:invoiceId/documents/:documentId/content",
    async (c) => {
      const principal = requireSessionPrincipal(c);
      if (
        principal.profile !== "administrator" &&
        principal.ownMoneyVisible !== true
      )
        throw new ApiError({
          status: 403,
          code: "own_money_disabled",
          message: "Viewing your own money is disabled on this instance.",
        });
      const document = await execute(() =>
        store.document(
          resourceId(c.req.param("invoiceId"), "contractor invoice"),
          c.req.param("documentId"),
          principal.profile === "administrator" ? undefined : principal.userId,
        ),
      );
      if (!document || !objects)
        throw new ApiError({
          status: 404,
          code: "not_found",
          message: "Invoice document not found.",
        });
      const object = await objects.get(document.file_key);
      if (!object)
        throw new ApiError({
          status: 404,
          code: "not_found",
          message: "Invoice document not found.",
        });
      return new Response(object.body, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/octet-stream",
          "x-content-type-options": "nosniff",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`,
        },
      });
    },
  );
};
