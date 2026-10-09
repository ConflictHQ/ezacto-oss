import type { Hono } from "hono";
import {
  AccountDeletionError,
  hasAccountDeletionControlCharacters,
  type AccountDeletionRecord,
  type AccountDeletionStore,
  type AppleCleanupPort,
  type AccountDeletionStatusStore,
  type AccountDeletionUpdate,
} from "@ezacto/core";
import { requireApiScope, requireSessionPrincipal } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
} from "./resources/support.js";
import type { AccountDeletionMailer } from "./profile.js";

const errors = (error: unknown): never => {
  if (error instanceof AccountDeletionError)
    throw new ApiError({
      status:
        error.code === "administrator_required" ||
        error.code === "account_unavailable"
          ? 403
          : error.code === "request_not_found"
            ? 404
            : 409,
      code: error.code,
      message: error.message,
    });
  throw error;
};
const id = (value: string): string => {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(value))
    throw new ApiError({
      status: 404,
      code: "not_found",
      message: "Deletion request not found.",
    });
  return value;
};
const ownPath = "/api/v1/profile/deletion-request";
const adminPath = "/api/v1/admin/deletion-requests";
const envelope = (data: AccountDeletionRecord | null, self: string) => ({
  data,
  links: { self },
});
const noStore = { "cache-control": "no-store" };
const administrator = <Bindings extends object>(
  context: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
) => {
  const principal = requireSessionPrincipal(context);
  if (principal.profile !== "administrator")
    throw new ApiError({
      status: 403,
      code: "profile_forbidden",
      message: "Only administrators can manage deletion requests.",
    });
  return principal.userId;
};

export function installAccountDeletionRequestRoutes<Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    store: AccountDeletionStore;
    tracking?: AccountDeletionStatusStore;
    appleCleanup?: AppleCleanupPort;
    clock(): string;
    mailer?: AccountDeletionMailer;
  },
): void {
  const withApple = async(record: AccountDeletionRecord | null) => record===null || options.appleCleanup===undefined ? record : {...record,apple_cleanup:await options.appleCleanup.status(record.id)};
  const notify = async (record: AccountDeletionRecord, actor: number) => {
    const now = options.clock();
    if (!(await options.store.claimNotification(record.id, actor, now)))
      return false;
    let outcome: "queued" | "failed" | "unavailable" = "unavailable";
    let deliveryId: number | null = null;
    try {
      const recipients = await options.store.notificationRecipients(record.id);
      if (
        options.mailer !== undefined &&
        recipients.administrators.length > 0
      ) {
        const sent = await options.mailer.notify({
          ...recipients,
          requestedAt: record.requested_at,
          recorded: true,
        });
        outcome = sent?.queued === false ? "failed" : "queued";
        deliveryId = sent?.deliveryId ?? null;
      }
    } catch {
      // The durable request succeeds even when enqueueing email fails. Never
      // persist provider error text, which can contain credentials or addresses.
      outcome = "failed";
    }
    await options.store.finishNotification(record.id, now, outcome, deliveryId);
    return true;
  };

  api.get("/profile/deletion-request", async (context) => {
    requireApiScope(context, "time_entries:read");
    try {
      return context.json(
        envelope(
          await withApple(await options.store.readOwn(context.get("principal").userId)),
          ownPath,
        ),
        200,
        noStore,
      );
    } catch (error) {
      return errors(error);
    }
  });
  api.post("/profile/deletion-request", async (context) => {
    requireApiScope(context, "time_entries:write");
    const userId = context.get("principal").userId;
    // Empty-body requests from older clients remain supported, but do not
    // claim that the user reviewed a disclosure they never received.
    const body =
      context.req.raw.body === null ? {} : await readObjectBody(context);
    const problems = unknownFieldErrors(
      body,
      new Set(["expected_policy_version"]),
    );
    if (
      body.expected_policy_version !== undefined &&
      body.expected_policy_version !== null &&
      (typeof body.expected_policy_version !== "number" ||
        !Number.isSafeInteger(body.expected_policy_version) ||
        body.expected_policy_version < 1)
    )
      problems.push({
        field: "expected_policy_version",
        code: "invalid_integer",
        message:
          "Use the policy version reviewed, or null when no policy was published.",
      });
    assertFields(problems);
    try {
      const result = await options.store.request({
        userId,
        id: crypto.randomUUID(),
        now: options.clock(),
        ...(body.expected_policy_version === undefined
          ? {}
          : {
              expectedPolicyVersion: body.expected_policy_version as
                number | null,
            }),
      });
      await options.appleCleanup?.begin(userId,result.record.id);
      const statusAccess = await options.tracking?.issue({ requestId: result.record.id, userId, now: options.clock() });
      if (result.created) await notify(result.record, userId);
      return context.json(
        { ...envelope(await withApple((await options.store.readOwn(userId)) ?? result.record), ownPath), ...(statusAccess === undefined ? {} : { status_access: statusAccess }) },
        202,
        noStore,
      );
    } catch (error) {
      return errors(error);
    }
  });
  api.get("/admin/deletion-requests", async (context) => {
    const actor = administrator(context);
    const after = context.req.query("after");
    try {
      const rows = await options.store.list(
        actor,
        after === undefined ? null : id(after),
      );
      const data = rows.slice(0, 50);
      return context.json(
        {
          data,
          links: {
            self: adminPath,
            next:
              rows.length > 50
                ? `${adminPath}?after=${encodeURIComponent(data[49]!.id)}`
                : null,
          },
        },
        200,
        noStore,
      );
    } catch (error) {
      return errors(error);
    }
  });
  api.get("/admin/deletion-requests/:id", async (context) => {
    const actor = administrator(context);
    const requestId = id(context.req.param("id"));
    try {
      return context.json(
        envelope(
          await options.store.readAdmin(actor, requestId),
          `${adminPath}/${requestId}`,
        ),
        200,
        noStore,
      );
    } catch (error) {
      return errors(error);
    }
  });
  api.patch("/admin/deletion-requests/:id", async (context) => {
    const actor = administrator(context);
    const requestId = id(context.req.param("id"));
    const body = await readObjectBody(context);
    const problems = unknownFieldErrors(
      body,
      new Set([
        "expected_version",
        "status",
        "message",
        "expected_completion_at",
      ]),
    );
    if (
      typeof body.expected_version !== "number" ||
      !Number.isSafeInteger(body.expected_version) ||
      body.expected_version < 1 ||
      body.expected_version >= Number.MAX_SAFE_INTEGER
    )
      problems.push({
        field: "expected_version",
        code: "invalid_integer",
        message: "Use the current request version.",
      });
    if (
      typeof body.status !== "string" ||
      !["pending", "in_progress", "action_required"].includes(body.status)
    )
      problems.push({
        field: "status",
        code: "invalid_status",
        message:
          "Choose pending, in_progress or action_required. Completion requires actual fulfilment.",
      });
    if (
      typeof body.message !== "string" ||
      body.message.length > 5000 ||
      hasAccountDeletionControlCharacters(String(body.message)) ||
      (body.status === "action_required" && body.message.trim() === "")
    )
      problems.push({
        field: "message",
        code: "invalid_message",
        message:
          "Provide a user-visible message of at most 5000 characters; explain any required action.",
      });
    if (
      body.expected_completion_at !== null &&
      (typeof body.expected_completion_at !== "string" ||
        !Number.isFinite(Date.parse(body.expected_completion_at)) ||
        new Date(body.expected_completion_at).toISOString() !==
          body.expected_completion_at)
    )
      problems.push({
        field: "expected_completion_at",
        code: "invalid_timestamp",
        message:
          "Provide a UTC ISO timestamp, or null if completion timing has not been established.",
      });
    assertFields(problems);
    try {
      const data = await options.store.update({
        id: requestId,
        actorUserId: actor,
        expectedVersion: body.expected_version as number,
        status: body.status as AccountDeletionUpdate["status"],
        message: body.message as string,
        expectedCompletionAt: body.expected_completion_at as string | null,
        now: options.clock(),
      });
      return context.json(
        envelope(data, `${adminPath}/${requestId}`),
        200,
        noStore,
      );
    } catch (error) {
      return errors(error);
    }
  });
  api.post("/admin/deletion-requests/:id/notification", async (context) => {
    const actor = administrator(context);
    const requestId = id(context.req.param("id"));
    try {
      const record = await options.store.readAdmin(actor, requestId);
      if (!(await notify(record, actor)))
        throw new AccountDeletionError("notification_busy");
      return context.json(
        envelope(
          await options.store.readAdmin(actor, requestId),
          `${adminPath}/${requestId}`,
        ),
        200,
        noStore,
      );
    } catch (error) {
      return errors(error);
    }
  });
}
