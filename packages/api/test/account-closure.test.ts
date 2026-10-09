import { describe, expect, it, vi } from "vitest";
import {
  AccountClosureError,
  type AccountClosurePreview,
  type AccountClosureStore,
  type AccountClosureRecord,
  type AppleCleanupPort,
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
function harness(cleanup?: {
  appleCleanup: AppleCleanupPort;
  performAppleCleanup(requestId: string): Promise<void>;
}) {
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
      installAccountClosureRoutes(api, { store, clock: () => at, ...cleanup }),
  });
  const call = (
    method = "GET",
    body?: unknown,
    cookie = "admin",
    origin = "http://localhost",
    suffix = "closure",
  ) =>
    app.request(`/api/v1/admin/deletion-requests/request-1/${suffix}`, {
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

describe("post-closure Apple cleanup", () => {
  const input = {
    expected_version: 1,
    expected_policy_version: 3,
    review_token: "a".repeat(64),
    acknowledged: true,
  };
  const closed = {
    request_id: "request-1",
    user_id: 2,
    actor_user_id: 1,
    closed_at: at,
    policy_version: 3,
    policy_snapshot: {frameworks:[],retained_records:[],response_target_days:14,operator_contact:"privacy@example.test",user_notice:"Close local access.",backup_handling:"Replay closure.",acknowledged:true},
    inventory: [],
    retained_identity: false,
    apple_cleanup: "pending",
  } as AccountClosureRecord;
  const cleanup = () => ({
    appleCleanup: {
      begin: vi.fn(async () => {}),
      status: vi.fn(async () => "pending" as const),
    },
    performAppleCleanup: vi.fn(async () => {}),
  });
  it("never revokes during review or when local closure rejects a stale authorization", async () => {
    const ports = cleanup(),
      { call, store } = harness(ports);
    expect((await call()).status).toBe(200);
    expect(ports.appleCleanup.begin).not.toHaveBeenCalled();
    vi.mocked(store.close).mockRejectedValue(
      new AccountClosureError("concurrent_change"),
    );
    expect((await call("POST", input)).status).toBe(409);
    expect(ports.appleCleanup.begin).toHaveBeenCalledOnce();
    expect(ports.performAppleCleanup).not.toHaveBeenCalled();
  });
  it("performs only after successful closure and preserves truthful local success if cleanup persistence fails", async () => {
    const ports = cleanup(),
      { call, store } = harness(ports);
    vi.mocked(store.close).mockResolvedValue({ ...closed });
    ports.performAppleCleanup.mockImplementation(async () => {
      expect(store.close).toHaveBeenCalledOnce();
      throw new Error("unavailable");
    });
    const result = await call("POST", input);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      data: { closed_at: at, apple_cleanup: "manual_required" },
    });
  });
  it("requires existing closure, administrator and CSRF for explicit retry", async () => {
    const ports = cleanup(),
      { call, store } = harness(ports);
    const retry = (
      cookie = "admin",
      origin = "http://localhost",
      body: unknown = {},
    ) => call("POST", body, cookie, origin, "apple-cleanup");
    expect((await retry("member")).status).toBe(403);
    expect((await retry("admin", "https://stranger.test")).status).toBe(403);
    expect(
      (await retry("admin", "http://localhost", { user_id: 2 })).status,
    ).toBe(422);
    expect((await retry()).status).toBe(409);
    expect(ports.performAppleCleanup).not.toHaveBeenCalled();
    vi.mocked(store.preview).mockResolvedValue({ ...preview, closure: closed });
    const result = await retry();
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({ data: { apple_cleanup: "pending" } });
    expect(ports.performAppleCleanup).toHaveBeenCalledWith("request-1");
  });
});
