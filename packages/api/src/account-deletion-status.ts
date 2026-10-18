import type { Hono } from "hono";
import type { AccountDeletionStatusStore, AppleCleanupPort } from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { ApiError, readJsonBody, validationError } from "./errors.js";
export function installAccountDeletionStatusRoutes<Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: { store: AccountDeletionStatusStore; clock(): string; appleCleanup?: AppleCleanupPort },
): void {
  app.post("/account-deletion/requests/:id/status", async (context) => {
    context.header("cache-control", "no-store");
    const body = await readJsonBody<unknown>(context, { maxBytes: 512 });
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "token") ||
      !("token" in body) ||
      typeof body.token !== "string" ||
      body.token.length > 100
    )
      throw validationError([
        {
          field: "token",
          code: "invalid",
          message: "Provide the private request tracking token.",
        },
      ]);
    const now = options.clock();
    if (!(await options.store.allowRead(now))) {
      context.header("retry-after", "60");
      throw new ApiError({
        status: 429,
        code: "rate_limit_exceeded",
        message: "Request tracking is busy. Retry shortly.",
      });
    }
    const data = await options.store.read({
      requestId: context.req.param("id"),
      token: body.token,
      now,
    });
    if (data === null)
      throw new ApiError({
        status: 401,
        code: "tracking_unavailable",
        message:
          "Tracking access expired or is unavailable. Contact the operator for the request outcome; this does not mean erasure completed.",
      });
    return context.json({ data: options.appleCleanup===undefined ? data : {...data, apple_cleanup:await options.appleCleanup.status(data.request_id)} }, 200, { "cache-control": "no-store" });
  });
}
