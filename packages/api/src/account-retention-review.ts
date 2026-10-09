import type { Hono } from "hono";
import {
  RetentionReviewError,
  type AccountRetentionReviewStore,
  type AppleCleanupPort,
  type RetentionReviewArea,
  type RetentionDecision,
} from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  readObjectBody,
  unknownFieldErrors,
  assertFields,
} from "./resources/support.js";
export function installAccountRetentionReviewRoutes<Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    store: AccountRetentionReviewStore;
    appleCleanup?: AppleCleanupPort;
    clock(): string;
  },
): void {
  const actor = (
    context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
  ) => {
    const user = requireSessionPrincipal(context);
    if (user.profile !== "administrator")
      throw new ApiError({
        status: 403,
        code: "administrator_required",
        message: "Only administrators can review retained records.",
      });
    return user.userId;
  };
  const fail = (error: unknown): never => {
    if (error instanceof RetentionReviewError)
      throw new ApiError({
        status:
          error.code === "administrator_required"
            ? 403
            : error.code === "invalid_review"
              ? 422
              : 409,
        code: error.code,
        message: error.message,
      });
    throw error;
  };
  api.get("/admin/retention-reviews", async (context) => {
    try {
      return context.json(
        {
          data: await options.store.list(
            actor(context),
            options.clock(),
            context.req.query("after"),
          ),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return fail(error);
    }
  });
  api.get("/admin/deletion-requests/:id/retention-reviews", async (context) => {
    try {
      return context.json(
        {
          data: await options.store.read(
            actor(context),
            context.req.param("id"),
          ),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return fail(error);
    }
  });
  api.patch(
    "/admin/deletion-requests/:id/retention-reviews/:area",
    async (context) => {
      const userId = actor(context),
        body = await readObjectBody(context);
      const errors = unknownFieldErrors(
        body,
        new Set([
          "expected_version",
          "decision",
          "basis",
          "release_condition",
          "evidence",
          "next_review_at",
          "acknowledged",
        ]),
      );
      if (
        !Number.isSafeInteger(body.expected_version) ||
        Number(body.expected_version) < 1
      )
        errors.push({
          field: "expected_version",
          code: "invalid",
          message: "Use the displayed review version.",
        });
      if (
        typeof body.decision !== "string" ||
        ![
          "retain",
          "removed",
          "not_applicable",
          "failed",
          "release_hold",
        ].includes(body.decision)
      )
        errors.push({
          field: "decision",
          code: "invalid",
          message: "Choose a review decision.",
        });
      for (const key of ["basis", "release_condition", "evidence"])
        if (typeof body[key] !== "string")
          errors.push({
            field: key,
            code: "invalid",
            message: "Supply review text.",
          });
      if (
        body.next_review_at !== null &&
        typeof body.next_review_at !== "string"
      )
        errors.push({
          field: "next_review_at",
          code: "invalid",
          message: "Supply a review date or null.",
        });
      if (body.acknowledged !== true)
        errors.push({
          field: "acknowledged",
          code: "invalid",
          message:
            "Confirm actual evidence and that saving this review does not automatically delete records.",
        });
      assertFields(errors);
      try {
        return context.json(
          {
            data: await options.store.review({
              actorUserId: userId,
              requestId: context.req.param("id"),
              area: context.req.param("area") as RetentionReviewArea,
              expectedVersion: body.expected_version as number,
              decision: body.decision as Exclude<RetentionDecision, "pending">,
              basis: body.basis as string,
              releaseCondition: body.release_condition as string,
              evidence: body.evidence as string,
              nextReviewAt: body.next_review_at as string | null,
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
    },
  );
  api.post("/admin/deletion-requests/:id/completion", async (context) => {
    const userId = actor(context),
      body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set(["expected_request_version", "expected_reviews", "acknowledged"]),
    );
    if (
      !Number.isSafeInteger(body.expected_request_version) ||
      Number(body.expected_request_version) < 1
    )
      errors.push({
        field: "expected_request_version",
        code: "invalid",
        message: "Use the current request version.",
      });
    if (body.acknowledged !== true)
      errors.push({
        field: "acknowledged",
        code: "invalid",
        message: "Confirm the documented outcome and remaining retention.",
      });
    if (
      typeof body.expected_reviews !== "object" ||
      body.expected_reviews === null ||
      Array.isArray(body.expected_reviews) ||
      Object.values(body.expected_reviews).some(
        (value) => !Number.isSafeInteger(value) || Number(value) < 1,
      )
    )
      errors.push({
        field: "expected_reviews",
        code: "invalid",
        message: "Use the exact reviewed versions.",
      });
    assertFields(errors);
    try {
      const apple = await options.appleCleanup?.status(context.req.param("id"));
      return context.json(
        {
          data: await options.store.complete({
            actorUserId: userId,
            requestId: context.req.param("id"),
            expectedRequestVersion: body.expected_request_version as number,
            expectedReviews: body.expected_reviews as Record<string, number>,
            acknowledged: true,
            now: options.clock(),
            appleResolved: apple === "not_linked" || apple === "revoked",
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
