import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { StaffPaymentError } from "@ezacto/core";
import type { ApiContext } from "../src/context.js";
import { errorResponse } from "../src/errors.js";
import { installContractorReviewRoutes } from "../src/contractor-review.js";
const now = "2026-10-01T12:00:00.000Z";
const fixture = (profile = "administrator", kind = "session") => {
  const api = new Hono<ApiContext<object>>();
  const store = {
    review: vi.fn(async (month: string) => ({
      month,
      completed: true,
      credit_period: { from: `${month}-01`, to: "2026-10-01" },
      version: "a".repeat(64),
      people: [],
    })),
  };
  api.use("*", async (context, next) => {
    context.set("principal", {
      type: "user",
      userId: 1,
      profile,
      authentication: { kind, sessionId: "test" },
    } as never);
    context.set("requestId", "review-request");
    await next();
  });
  api.onError((error, context) => errorResponse(error, context));
  installContractorReviewRoutes(api, store, () => now);
  return { api, store };
};
describe("contractor combined review API", () => {
  it.each([
    ["member", "session"],
    ["accounting", "session"],
    ["executive_manager", "session"],
    ["administrator", "token"],
  ])("rejects %s/%s before any financial read", async (profile, kind) => {
    const { api, store } = fixture(profile, kind);
    expect(
      (await api.request("/staff-payments/contractor-review?month=2026-09"))
        .status,
    ).toBe(403);
    expect(store.review).not.toHaveBeenCalled();
  });
  it("returns one uncached administrator review with its source version", async () => {
    const { api, store } = fixture();
    const response = await api.request(
      "/staff-payments/contractor-review?month=2026-08",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      data: {
        month: "2026-08",
        completed: true,
        credit_period: { from: "2026-08-01", to: "2026-10-01" },
        version: "a".repeat(64),
        people: [],
      },
    });
    expect(store.review).toHaveBeenCalledWith("2026-08", now);
    await api.request("/staff-payments/contractor-review");
    expect(store.review).toHaveBeenLastCalledWith("2026-09", now);
  });
  it("validates the work month and returns source conflicts without caching a stale review", async () => {
    const { api, store } = fixture();
    expect(
      (await api.request("/staff-payments/contractor-review?month=2026-99"))
        .status,
    ).toBe(422);
    expect(store.review).not.toHaveBeenCalled();
    store.review.mockRejectedValueOnce(
      new StaffPaymentError("conflict", "Sources disagree. Reload."),
    );
    const response = await api.request(
      "/staff-payments/contractor-review?month=2026-09",
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    store.review.mockRejectedValueOnce(
      new StaffPaymentError("invalid", "Unsupported month."),
    );
    expect(
      (await api.request("/staff-payments/contractor-review?month=2026-09"))
        .status,
    ).toBe(422);
  });
  it("offers no mutation or execution operation", async () => {
    const { api, store } = fixture();
    expect(
      (
        await api.request("/staff-payments/contractor-review?month=2026-09", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        })
      ).status,
    ).toBe(404);
    expect(store.review).not.toHaveBeenCalled();
  });
});
