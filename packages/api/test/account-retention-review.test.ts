import { expect, it, vi } from "vitest";
import {
  RetentionReviewError,
  type AccountRetentionReviewStore,
  type AppleCleanupStatus,
} from "@ezacto/core";
import {
  createApiApp,
  installAccountRetentionReviewRoutes,
} from "../src/index.js";
const at = "2026-10-09T00:00:00.000Z";
function harness(apple: AppleCleanupStatus = "manual_required") {
  const store: AccountRetentionReviewStore = {
    list: vi.fn(async () => []),
    read: vi.fn(async () => []),
    review: vi.fn(async () => {
      throw new RetentionReviewError("review_changed");
    }),
    complete: vi.fn(async () => ({
      completed_at: at,
      confirmation:
        "Historical disconnect manually verified; retained records disclosed.",
    })),
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
      installAccountRetentionReviewRoutes(api, {
        store,
        clock: () => at,
        appleCleanup: { begin: async () => {}, status: async () => apple },
      }),
  });
  const call = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "admin",
    origin = "http://localhost",
  ) =>
    app.request(`/api/v1/admin/${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, store };
}
const complete = {
  expected_request_version: 2,
  expected_reviews: { apple_authorization: 3 },
  acknowledged: true,
  apple_historical_manual_verified: true,
};
it("protects review and completion with administrator access and CSRF", async () => {
  const { call, store } = harness();
  expect(
    (await call("retention-reviews", "GET", undefined, "member")).status,
  ).toBe(403);
  expect(
    (
      await call(
        "deletion-requests/request-one/completion",
        "POST",
        complete,
        "admin",
        "https://wrong.test",
      )
    ).status,
  ).toBe(403);
  expect(store.complete).not.toHaveBeenCalled();
  const response = await call("retention-reviews");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
});
it("requires exact review versions and a boolean historical acknowledgment", async () => {
  const { call, store } = harness();
  for (const body of [
    { ...complete, apple_historical_manual_verified: ["true"] },
    { ...complete, expected_reviews: [] },
    { ...complete, acknowledged: false },
    { ...complete, unexpected: true },
  ])
    expect(
      (await call("deletion-requests/request-one/completion", "POST", body))
        .status,
    ).toBe(422);
  expect(store.complete).not.toHaveBeenCalled();
});
it("passes historical manual evidence separately from signed provider resolution", async () => {
  const { call, store } = harness();
  const response = await call(
    "deletion-requests/request-one/completion",
    "POST",
    complete,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(store.complete).toHaveBeenCalledWith(
    expect.objectContaining({
      appleResolved: false,
      appleHistoricalManualVerified: true,
      actorUserId: 1,
      expectedRequestVersion: 2,
      expectedReviews: { apple_authorization: 3 },
    }),
  );
  const pending = harness("pending");
  await pending.call(
    "deletion-requests/request-one/completion",
    "POST",
    complete,
  );
  expect(pending.store.complete).toHaveBeenCalledWith(
    expect.objectContaining({
      appleResolved: false,
      appleHistoricalManualVerified: false,
    }),
  );
});
it("returns actionable conflict when the atomic completion guard sees changed evidence", async () => {
  const { call, store } = harness();
  vi.mocked(store.complete).mockRejectedValueOnce(
    new RetentionReviewError("review_changed"),
  );
  expect(
    (await call("deletion-requests/request-one/completion", "POST", complete))
      .status,
  ).toBe(409);
});
