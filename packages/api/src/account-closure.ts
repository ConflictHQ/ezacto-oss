import type { Hono } from "hono";
import { AccountClosureError, type AccountClosureStore } from "@ezacto/core";
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
  options: { store: AccountClosureStore; clock(): string },
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
  const path = "/admin/deletion-requests/:id/closure";
  api.get(path, async (context) => {
    const userId = actor(context);
    try {
      return context.json(
        { data: await options.store.preview(userId, context.req.param("id")) },
        200,
        { "cache-control": "no-store" },
      );
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
      return context.json(
        {
          data: await options.store.close({
            actorUserId: userId,
            id: context.req.param("id"),
            expectedVersion: body.expected_version as number,
            reviewToken: body.review_token as string,
            expectedPolicyVersion: body.expected_policy_version as number,
            acknowledged: true,
            now: options.clock(),
          }),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return fail(error);
    }
  });
}
