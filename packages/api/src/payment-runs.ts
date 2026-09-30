import {
  StaffPaymentError,
  PaymentProviderError,
  type PaymentRunsService,
  type PaymentRunCommand,
  type PaymentRunApproval,
} from "@ezacto/core";
import type { Hono } from "hono";
import { requireSessionPrincipal } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError, validationError } from "./errors.js";
import { readObjectBody } from "./resources/support.js";

export const installPaymentRunRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: PaymentRunsService,
): void => {
  api.use("/payment-runs/*", async (c, next) => {
    if (requireSessionPrincipal(c).profile !== "administrator")
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Only administrators can manage payments.",
      });
    await next();
  });
  const execute = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof StaffPaymentError) {
        if (error.code === "invalid")
          throw validationError([
            { field: "payment_run", code: "invalid", message: error.message },
          ]);
        throw new ApiError({
          status: error.code === "not_found" ? 404 : 409,
          code: error.code,
          message: error.message,
        });
      }
      if (error instanceof PaymentProviderError)
        throw new ApiError({
          status: 502,
          code: "provider_error",
          message: error.message,
        });
      throw error;
    }
  };
  api.get("/payment-runs/report", async (c) => {
    const from = c.req.query("from") ?? new Date().toISOString().slice(0, 7);
    return c.json(
      {
        data: await execute(() =>
          service.report(
            from,
            c.req.query("to") ?? from,
            new Date().toISOString(),
          ),
        ),
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.post("/payment-runs/preview", async (c) => {
    const b = await readObjectBody(c);
    if (
      typeof b.id !== "string" ||
      typeof b.name !== "string" ||
      typeof b.source_currency !== "string" ||
      typeof b.scheduled_at !== "string" ||
      typeof b.timezone !== "string" ||
      !Array.isArray(b.items) ||
      b.items.some(
        (x) =>
          typeof x !== "object" ||
          x === null ||
          typeof x.user_id !== "number" ||
          typeof x.month !== "string" ||
          typeof x.amount_cents !== "number" ||
          typeof x.expected_version !== "number",
      )
    )
      throw validationError([
        {
          field: "payment_run",
          code: "invalid",
          message: "Provide a valid payment selection and schedule.",
        },
      ]);
    const command: PaymentRunCommand = {
      id: b.id,
      name: b.name,
      source_currency: b.source_currency,
      scheduled_at: b.scheduled_at,
      timezone: b.timezone,
      items: b.items.map((x) => ({
        user_id: x.user_id as number,
        month: x.month as string,
        amount_cents: x.amount_cents as number,
        expected_version: x.expected_version as number,
      })),
    };
    return c.json(
      {
        data: await execute(() =>
          service.preview(
            command,
            requireSessionPrincipal(c).userId,
            c.get("requestId"),
            new Date().toISOString(),
          ),
        ),
      },
      201,
      { "cache-control": "no-store" },
    );
  });
  api.post("/payment-runs/:id/approve", async (c) => {
    const b = await readObjectBody(c);
    if (
      !Array.isArray(b.limits) ||
      b.limits.some(
        (x) =>
          typeof x !== "object" ||
          x === null ||
          typeof x.item_id !== "string" ||
          typeof x.max_source_cents !== "number",
      )
    )
      throw validationError([
        {
          field: "limits",
          code: "invalid",
          message: "Approve a maximum cost for each payment.",
        },
      ]);
    const approval: PaymentRunApproval = {
      limits: b.limits.map((x) => ({
        item_id: x.item_id as string,
        max_source_cents: x.max_source_cents as number,
      })),
    };
    return c.json(
      {
        data: await execute(() =>
          service.approve(
            c.req.param("id"),
            approval,
            requireSessionPrincipal(c).userId,
            c.get("requestId"),
            new Date().toISOString(),
          ),
        ),
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.post("/payment-runs/:id/cancel", async (c) =>
    c.json(
      {
        data: await execute(() =>
          service.cancel(
            c.req.param("id"),
            requireSessionPrincipal(c).userId,
            c.get("requestId"),
            new Date().toISOString(),
          ),
        ),
      },
      200,
      { "cache-control": "no-store" },
    ),
  );
  api.post("/payment-runs/:id/items/:itemId/reconcile", async (c) =>
    c.json(
      {
        data: await execute(() =>
          service.retry(
            c.req.param("id"),
            c.req.param("itemId"),
            requireSessionPrincipal(c).userId,
            c.get("requestId"),
            new Date().toISOString(),
          ),
        ),
      },
      200,
      { "cache-control": "no-store" },
    ),
  );
};
