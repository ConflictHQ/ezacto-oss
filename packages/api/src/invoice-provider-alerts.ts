import type { Hono } from "hono";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError, validationError } from "./errors.js";
import {
  readObjectBody,
  unknownFieldErrors,
  assertFields,
} from "./resources/support.js";
export interface InvoiceProviderAlert {
  id: string;
  event_type: string;
  kind: "refund" | "dispute";
  amount_cents: number;
  currency: string;
  provider_status: string;
  occurred_at: string;
  reviewed_at: string | null;
  reviewed_by: number | null;
}
export interface InvoiceProviderAlertService {
  list(invoiceId: number): Promise<InvoiceProviderAlert[]>;
  review(
    invoiceId: number,
    alertId: string,
    authority: { userId: number; sessionId: string },
    now: string,
  ): Promise<InvoiceProviderAlert | null>;
}
export const installInvoiceProviderAlertRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: InvoiceProviderAlertService,
): void => {
  const invoiceId = (value: string) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1)
      throw validationError([
        {
          field: "id",
          code: "invalid",
          message: "Provide a valid invoice id.",
        },
      ]);
    return id;
  };
  api.get("/invoices/:id/provider-alerts", async (c) => {
    const principal = requireSessionPrincipal(c);
    if (
      !["administrator", "accounting", "executive_manager"].includes(
        principal.profile,
      )
    )
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Invoice money access is required.",
      });
    return c.json(
      { data: await service.list(invoiceId(c.req.param("id"))) },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.post("/invoices/:id/provider-alerts/:alertId/review", async (c) => {
    const principal = requireSessionPrincipal(c);
    if (principal.type !== "user" || principal.profile !== "administrator")
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Only administrators can review a provider report.",
      });
    const body = await readObjectBody(c);
    assertFields(unknownFieldErrors(body, new Set()));
    const alertId = c.req.param("alertId");
    if (!/^[a-zA-Z0-9_]{1,255}$/.test(alertId))
      throw validationError([
        {
          field: "alertId",
          code: "invalid",
          message: "Provide a valid provider report id.",
        },
      ]);
    const result = await service.review(
      invoiceId(c.req.param("id")),
      alertId,
      {
        userId: principal.userId,
        sessionId: principal.authentication.sessionId,
      },
      new Date().toISOString(),
    );
    if (!result)
      throw new ApiError({
        status: 409,
        code: "provider_report_unavailable",
        message:
          "The report or current administrator session is no longer available.",
      });
    return c.json({ data: result }, 200, { "cache-control": "no-store" });
  });
};
