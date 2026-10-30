import type { Hono } from "hono";
import { DeelStageError, validPaymentMonth } from "@ezacto/core";
import type { DeelPaymentStatusRuntime } from "@ezacto/integrations";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
} from "./resources/support.js";
export const installDeelPaymentStatusRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  runtime: DeelPaymentStatusRuntime,
) => {
  api.post("/deel-staging/payment-status", async (context) => {
    const principal = requireSessionPrincipal(context),
      sessionId = Number(principal.authentication.sessionId);
    if (
      principal.profile !== "administrator" ||
      !Number.isSafeInteger(sessionId) ||
      sessionId < 1
    )
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message:
          "A current administrator session is required to check Deel payment status.",
      });
    const body = await readObjectBody(context);
    assertFields(unknownFieldErrors(body, new Set(["month"])));
    if (typeof body.month !== "string" || !validPaymentMonth(body.month))
      throw new ApiError({
        status: 422,
        code: "invalid_month",
        message: "Choose a valid payment month.",
        fields: [{ field: "month", code: "invalid", message: "Choose a valid payment month." }],
      });
    try {
      const result = await runtime.refresh(body.month, {
        userId: principal.userId,
        sessionId,
      });
      return context.json({ data: result }, 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      if (error instanceof DeelStageError && error.code === "forbidden")
        throw new ApiError({
          status: 403,
          code: "profile_forbidden",
          message: "The administrator session is no longer current.",
        });
      throw new ApiError({
        status: 503,
        code: "deel_status_unavailable",
        message:
          "Deel status could not be refreshed. Previously confirmed status is retained.",
      });
    }
  });
};
