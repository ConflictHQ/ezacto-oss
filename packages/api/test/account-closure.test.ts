import { describe, expect, it, vi } from "vitest";
import {
  AccountClosureError,
  type AccountClosurePreview,
  type AccountClosureStore,
} from "@ezacto/core";
import { createApiApp, installAccountClosureRoutes } from "../src/index.js";
const preview: AccountClosurePreview = {
  request_id: "request-1",
  user_id: 2,
  request_version: 1,
  review_token: "a".repeat(64),
  policy_version: 3,
  policy_snapshot: null,
  inventory: [],
  uncovered_categories: [],
  owner_transfer_required: false,
  running_timer: false,
  closure: null,
};
const at = "2026-10-09T00:00:00.000Z";
function harness() {
  const store: AccountClosureStore = {
    preview: vi.fn(async () => preview),
    close: vi.fn(async () => {
      throw new AccountClosureError("owner_transfer_required");
    }),
  };
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) =>
          request.headers.get("cookie")
            ? {
                type: "user",
                userId: 1,
                profile:
                  request.headers.get("cookie") === "admin"
                    ? "administrator"
                    : "member",
                authentication: { kind: "session", sessionId: "1" },
              }
            : null,
      },
    },
    installApi: (api) =>
      installAccountClosureRoutes(api, { store, clock: () => at }),
  });
  const call = (
    method = "GET",
    body?: unknown,
    cookie = "admin",
    origin = "http://localhost",
  ) =>
    app.request("/api/v1/admin/deletion-requests/request-1/closure", {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, store };
}
describe("account closure API", () => {
  it("limits review to administrators and never caches its inventory", async () => {
    const { call, store } = harness();
    expect((await call("GET", undefined, "member")).status).toBe(403);
    expect(store.preview).not.toHaveBeenCalled();
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: preview });
  });
  it("requires explicit disclaimer acknowledgement, exact versions and CSRF before any erasure", async () => {
    const { call, store } = harness();
    for (const body of [
      {},
      { expected_version: 1, expected_policy_version: 3, acknowledged: false },
      { expected_version: [1], expected_policy_version: 3, acknowledged: true },
      {
        expected_version: 1,
        expected_policy_version: 3,
        review_token: "a".repeat(64),
        acknowledged: true,
        user_id: 4,
      },
    ])
      expect((await call("POST", body)).status).toBe(422);
    expect(
      (
        await call(
          "POST",
          {
            expected_version: 1,
            expected_policy_version: 3,
            review_token: "a".repeat(64),
            acknowledged: true,
          },
          "admin",
          "https://stranger.test",
        )
      ).status,
    ).toBe(403);
    expect(store.close).not.toHaveBeenCalled();
  });
  it("binds fulfilment to the authenticated administrator and returns actionable conflicts", async () => {
    const { call, store } = harness();
    const response = await call("POST", {
      expected_version: 1,
      expected_policy_version: 3,
      review_token: "a".repeat(64),
      acknowledged: true,
    });
    expect(response.status).toBe(409);
    expect(store.close).toHaveBeenCalledWith({
      actorUserId: 1,
      id: "request-1",
      expectedVersion: 1,
      reviewToken: "a".repeat(64),
      expectedPolicyVersion: 3,
      acknowledged: true,
      now: at,
    });
    expect(await response.json()).toMatchObject({
      error: { code: "owner_transfer_required" },
    });
  });
});
