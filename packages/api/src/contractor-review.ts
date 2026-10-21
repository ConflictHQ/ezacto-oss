import type { Hono } from "hono";
import {
  StaffPaymentError,
  previousPaymentMonth,
  validPaymentMonth,
  type ContractorReviewStore,
} from "@ezacto/core";
import { requireSessionPrincipal } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError, validationError } from "./errors.js";

export const installContractorReviewRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  store: ContractorReviewStore,
  clock: () => string = () => new Date().toISOString(),
): void => {
  api.get("/staff-payments/contractor-review", async (context) => {
    const principal = requireSessionPrincipal(context);
    if (principal.profile !== "administrator")
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Only administrators can review contractor payment records.",
      });
    context.header("cache-control", "no-store");
    const now = clock(),
      month = context.req.query("month") ?? previousPaymentMonth(now);
    if (!validPaymentMonth(month))
      throw validationError([
        {
          field: "month",
          code: "invalid",
          message: "Choose a valid work month.",
        },
      ]);
    try {
      return context.json({ data: await store.review(month, now) }, 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      if (!(error instanceof StaffPaymentError)) throw error;
      if (error.code === "invalid")
        throw validationError([
          { field: "review", code: "invalid", message: error.message },
        ]);
      throw new ApiError({
        status: error.code === "not_found" ? 404 : 409,
        code: error.code,
        message: error.message,
      });
    }
  });
};
