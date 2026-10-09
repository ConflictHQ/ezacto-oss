import type { Hono } from "hono";
import {
  AccountClosureError,
  type AppleCleanupPort,
  type AppleCleanupStatus,
  type AccountClosureStore,
} from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
} from "./resources/support.js";

export function installAccountClosureRoutes<Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    store: AccountClosureStore;
    clock(): string;
    appleCleanup?: AppleCleanupPort;
    performAppleCleanup?(requestId: string): Promise<void>;
  },
): void {
  const actor = (
    context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
  ) => {
    const principal = requireSessionPrincipal(context);
    if (principal.profile !== "administrator")
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Only administrators can fulfil account deletion requests.",
      });
    return principal.userId;
  };
  const fail = (error: unknown): never => {
    if (error instanceof AccountClosureError)
      throw new ApiError({
        status:
          error.code === "administrator_required"
            ? 403
            : error.code === "request_not_found"
              ? 404
              : 409,
        code: error.code,
        message: error.message,
      });
    throw error;
  };
  // A remote outage cannot undo a successful local closure. Never report that
  // local erasure failed merely because provider cleanup still needs attention.
  const performCleanup = async (
    requestId: string,
  ): Promise<AppleCleanupStatus> => {
    try {
      await options.performAppleCleanup?.(requestId);
      return (
        (await options.appleCleanup?.status(requestId)) ?? "manual_required"
      );
    } catch {
      return "manual_required";
    }
  };
  const path = "/admin/deletion-requests/:id/closure";
  api.get(path, async (context) => {
    const userId = actor(context);
    try {
      const data = await options.store.preview(userId, context.req.param("id"));
      if (data.closure && options.performAppleCleanup)
        data.apple_cleanup_retry_available = true;
      if (data.closure && options.appleCleanup)
        data.closure = {
          ...data.closure,
          apple_cleanup: await options.appleCleanup.status(data.request_id),
        };
      return context.json({ data }, 200, { "cache-control": "no-store" });
    } catch (error) {
      return fail(error);
    }
  });
  api.post(path, async (context) => {
    const userId = actor(context);
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set([
        "expected_version",
        "expected_policy_version",
        "review_token",
        "acknowledged",
      ]),
    );
    for (const field of ["expected_version", "expected_policy_version"])
      if (
        typeof body[field] !== "number" ||
        !Number.isSafeInteger(body[field]) ||
        (body[field] as number) < 1
      )
        errors.push({
          field,
          code: "invalid",
          message: "Use the positive version returned by the closure review.",
        });
    if (body.acknowledged !== true)
      errors.push({
        field: "acknowledged",
        code: "invalid",
        message:
          "Confirm that you reviewed actual retained records, the operator policy and the irreversible closure disclaimer.",
      });
    if (
      typeof body.review_token !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.review_token)
    )
      errors.push({
        field: "review_token",
        code: "invalid",
        message: "Use the token returned by the current closure review.",
      });
    assertFields(errors);
    try {
      if (options.appleCleanup) {
        const preview = await options.store.preview(
          userId,
          context.req.param("id"),
        );
        await options.appleCleanup.begin(preview.user_id, preview.request_id);
      }
      const data = await options.store.close({
        actorUserId: userId,
        id: context.req.param("id"),
        expectedVersion: body.expected_version as number,
        reviewToken: body.review_token as string,
        expectedPolicyVersion: body.expected_policy_version as number,
        acknowledged: true,
        now: options.clock(),
      });
      if (options.performAppleCleanup)
        data.apple_cleanup = await performCleanup(data.request_id);
      return context.json({ data }, 200, { "cache-control": "no-store" });
    } catch (error) {
      return fail(error);
    }
  });
  api.post("/admin/deletion-requests/:id/apple-cleanup", async (context) => {
    const userId = actor(context);
    const body = await readObjectBody(context);
    assertFields(unknownFieldErrors(body, new Set()));
    try {
      const preview = await options.store.preview(
        userId,
        context.req.param("id"),
      );
      if (!preview.closure)
        throw new ApiError({
          status: 409,
          code: "local_closure_required",
          message:
            "Close local account access before retrying provider cleanup.",
        });
      if (!options.performAppleCleanup)
        throw new ApiError({
          status: 503,
          code: "apple_cleanup_unavailable",
          message: "Server-managed Apple cleanup is not configured.",
        });
      const apple_cleanup = await performCleanup(preview.request_id);
      return context.json({ data: { apple_cleanup } }, 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      return fail(error);
    }
  });
}
