import type { Hono } from "hono";
import {
  AccountRetentionPolicyError,
  AccountRetentionWriteError,
  parseAccountRetentionPolicy,
  type AccountRetentionPolicyRecord,
} from "@ezacto/core";
import { requireApiScope, requireSessionPrincipal } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError, validationError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
} from "./resources/support.js";

export interface AccountRetentionService {
  read(): Promise<AccountRetentionPolicyRecord | null>;
  publish(input: {
    expectedVersion: number;
    policy: unknown;
    actorUserId: number;
    now: string;
  }): Promise<AccountRetentionPolicyRecord>;
}

const envelope = (record: AccountRetentionPolicyRecord | null) => ({
  data:
    record === null
      ? null
      : {
          version: record.version,
          policy: record.policy,
          published_at: record.publishedAt,
        },
  links: { self: "/api/v1/profile/retention-policy" },
});

export function installAccountRetentionRoutes<Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: { service: AccountRetentionService; clock(): string },
): void {
  api.get("/profile/retention-policy", async (context) => {
    requireApiScope(context, "time_entries:read");
    return context.json(envelope(await options.service.read()), 200, {
      "cache-control": "no-store",
    });
  });

  api.post("/admin/retention-policy", async (context) => {
    const principal = requireSessionPrincipal(context);
    if (principal.profile !== "administrator") {
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message:
          "Only administrators can publish an erasure and retention policy.",
      });
    }
    const body = await readObjectBody(context);
    const errors = unknownFieldErrors(
      body,
      new Set(["expected_version", "policy"]),
    );
    if (
      typeof body.expected_version !== "number" ||
      !Number.isSafeInteger(body.expected_version) ||
      body.expected_version < 0 ||
      body.expected_version >= Number.MAX_SAFE_INTEGER
    ) {
      errors.push({
        field: "expected_version",
        code: "invalid_integer",
        message: "Use the current policy version, or 0 for the first policy.",
      });
    }
    assertFields(errors);
    try {
      const policy = parseAccountRetentionPolicy(body.policy);
      const result = await options.service.publish({
        expectedVersion: body.expected_version as number,
        policy,
        actorUserId: principal.userId,
        now: options.clock(),
      });
      return context.json(envelope(result), 200, {
        "cache-control": "no-store",
      });
    } catch (error) {
      if (error instanceof AccountRetentionPolicyError) {
        throw validationError(
          error.problems.map(({ field, message }) => ({
            field: `policy.${field}`,
            code: "invalid_policy",
            message,
          })),
        );
      }
      if (error instanceof AccountRetentionWriteError) {
        throw new ApiError({
          status: error.code === "stale_policy" ? 409 : 403,
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });
}
