import { describe, expect, it, vi } from "vitest";
import {
  AccountDeletionError,
  type AccountDeletionRecord,
  type AccountDeletionStore,
  type AccountDeletionStatusStore,
} from "@ezacto/core";
import {
  createApiApp,
  installAccountDeletionRequestRoutes,
} from "../src/index.js";
import type { AccountDeletionMailer } from "../src/profile.js";

const at = "2026-10-09T00:00:00.000Z";
const initial: AccountDeletionRecord = {
  id: "request-1",
  user_id: 2,
  requested_at: at,
  policy_version: null,
  policy_snapshot: null,
  policy_reviewed: false,
  status: "pending",
  version: 1,
  message: "",
  response_target_at: null,
  expected_completion_at: null,
  completed_at: null,
  completion_confirmation: null,
  notification: "pending",
  notification_updated_at: at,
  notification_delivery_id: null,
  updated_at: at,
};
function harness(
  mailer?: AccountDeletionMailer,
  tracking?: AccountDeletionStatusStore,
) {
  let current: AccountDeletionRecord | null = null;
  const store: AccountDeletionStore = {
    request: vi.fn(async (input) => {
      const created = current === null;
      current ??= {
        ...initial,
        policy_reviewed: input.expectedPolicyVersion !== undefined,
      };
      return { record: current, created };
    }),
    readOwn: vi.fn(async (userId) => (userId === 2 ? current : null)),
    list: vi.fn(async () => (current ? [current] : [])),
    readAdmin: vi.fn(async () => current ?? initial),
    update: vi.fn(async () => initial),
    claimNotification: vi.fn(async () => true),
    finishNotification: vi.fn(async (_id, _claimedAt, outcome, deliveryId) => {
      if (current)
        current = {
          ...current,
          notification: outcome,
          notification_delivery_id: deliveryId,
        };
    }),
    notificationRecipients: vi.fn(async () => ({
      person: { name: "Pat Person", email: "pat@example.test" },
      administrators: ["privacy@example.test"],
    })),
  };
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) => {
          const cookie = request.headers.get("cookie");
          return cookie === null
            ? null
            : {
                type: "user",
                userId: cookie === "admin" ? 1 : cookie === "other" ? 3 : 2,
                profile: cookie === "admin" ? "administrator" : "member",
                authentication: { kind: "session", sessionId: "1" },
              };
        },
      },
    },
    installApi: (api) =>
      installAccountDeletionRequestRoutes(api, {
        store,
        clock: () => at,
        ...(mailer ? { mailer } : {}),
        ...(tracking ? { tracking } : {}),
      }),
  });
  const call = (
    path = "/profile/deletion-request",
    method = "GET",
    body?: unknown,
    cookie = "member",
    origin = "http://localhost",
  ) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, store, call };
}
describe("durable deletion API", () => {
  it("returns scoped tracking access for the durable request, including an authenticated request racing closure", async () => {
    const access = {
      token: "ezacto_deletion_" + "a".repeat(64),
      expires_at: "2027-01-07T00:00:00.000Z",
      url: "/account-deletion/requests/request-1/status",
    };
    const tracking: AccountDeletionStatusStore = {
      issue: vi.fn(async () => access),
      read: vi.fn(async () => null),
      allowRead: vi.fn(async () => true),
    };
    const { call, store } = harness(undefined, tracking);
    const first = await call(undefined, "POST", {});
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      data: { id: "request-1", version: 1 },
      status_access: access,
    });
    vi.mocked(store.readOwn).mockResolvedValue(null);
    const repeated = await call(undefined, "POST", {});
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toMatchObject({
      data: { id: "request-1", version: 1 },
      status_access: access,
    });
    expect(tracking.issue).toHaveBeenLastCalledWith({
      requestId: "request-1",
      userId: 2,
      now: at,
    });
  });
  it("returns a recorded request when mail is unavailable, and exposes only the requester’s status", async () => {
    const { call, store } = harness();
    const response = await call(undefined, "POST", {});
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: {
        status: "pending",
        notification: "unavailable",
        policy_reviewed: false,
      },
    });
    expect(await (await call()).json()).toMatchObject({
      data: { id: "request-1" },
    });
    expect(
      await (await call(undefined, "GET", undefined, "other")).json(),
    ).toMatchObject({ data: null });
    expect(store.request).toHaveBeenCalledWith({
      userId: 2,
      id: expect.any(String),
      now: at,
    });
  });
  it("preserves the request when enqueueing fails and allows an administrator retry", async () => {
    const notify = vi.fn(async () => {
      throw new Error("provider details must stay private");
    });
    const { call, store } = harness({ notify });
    const response = await call(undefined, "POST", {
      expected_policy_version: null,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      data: {
        notification: "failed",
        status: "pending",
        policy_reviewed: true,
      },
    });
    expect(store.request).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPolicyVersion: null }),
    );
    expect(
      (
        await call(
          "/admin/deletion-requests/request-1/notification",
          "POST",
          {},
          "admin",
        )
      ).status,
    ).toBe(200);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await (await call()).json())).not.toContain(
      "provider details",
    );
  });
  it("distinguishes queued mail from completion, and does not notify for duplicate requests", async () => {
    const notify = vi.fn(async () => ({ deliveryId: 8, queued: true }));
    const { call } = harness({ notify });
    await call(undefined, "POST", {});
    const second = await call(undefined, "POST", {});
    expect(await second.json()).toMatchObject({
      data: {
        notification: "queued",
        notification_delivery_id: 8,
        completed_at: null,
        status: "pending",
      },
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("does not describe a rejected queue delivery as queued", async () => {
    const { call } = harness({
      notify: async () => ({ deliveryId: 8, queued: false }),
    });
    expect(await (await call(undefined, "POST", {})).json()).toMatchObject({
      data: { notification: "failed" },
    });
  });
  it("requires administrator sessions and same-origin writes", async () => {
    const { app, call, store } = harness();
    expect((await app.request("/api/v1/profile/deletion-request")).status).toBe(
      401,
    );
    expect((await call("/admin/deletion-requests")).status).toBe(403);
    expect(
      (await call("/admin/deletion-requests/request-1", "PATCH", {}, "member"))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          "/admin/deletion-requests/request-1/notification",
          "POST",
          {},
          "admin",
          "https://elsewhere.test",
        )
      ).status,
    ).toBe(403);
    expect(store.update).not.toHaveBeenCalled();
    expect(store.claimNotification).not.toHaveBeenCalled();
  });
  it.each([
    { expected_policy_version: -1 },
    { expected_policy_version: "1" },
    { user_id: 3 },
    [],
  ])("rejects malformed or cross-user request fields", async (body) => {
    const { call, store } = harness();
    expect((await call(undefined, "POST", body)).status).toBe(422);
    expect(store.request).not.toHaveBeenCalled();
  });
  it("reports stale policy and stale operator updates without overwriting", async () => {
    const { call, store } = harness();
    vi.mocked(store.request).mockRejectedValue(
      new AccountDeletionError("stale_policy"),
    );
    expect(
      (await call(undefined, "POST", { expected_policy_version: 1 })).status,
    ).toBe(409);
    vi.mocked(store.update).mockRejectedValue(
      new AccountDeletionError("stale_request"),
    );
    expect(
      (
        await call(
          "/admin/deletion-requests/request-1",
          "PATCH",
          {
            expected_version: 1,
            status: "in_progress",
            message: "Reviewing.",
            expected_completion_at: null,
          },
          "admin",
        )
      ).status,
    ).toBe(409);
  });
  it("does not permit completion through a progress update or empty required action", async () => {
    const { call, store } = harness();
    for (const status of ["completed", "action_required", ["pending"]])
      expect(
        (
          await call(
            "/admin/deletion-requests/request-1",
            "PATCH",
            {
              expected_version: 1,
              status,
              message: "",
              expected_completion_at: null,
            },
            "admin",
          )
        ).status,
      ).toBe(422);
    expect(store.update).not.toHaveBeenCalled();
  });
});
