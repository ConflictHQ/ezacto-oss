import { Hono } from "hono";
import { describe, it, expect, vi } from "vitest";
import { installScheduledRunRoutes } from "../src/scheduled-runs.js";
import { errorResponse } from "../src/errors.js";
import type { ApiContext } from "../src/context.js";
import type { ScheduledRun, ScheduledRunsService } from "@ezacto/core";

const run: ScheduledRun = {
  id: 7,
  job_id: 1,
  occurrence_key: "2026-08",
  state: "proposed",
  proposed_at: "2026-09-13T09:00:00.000Z",
  expires_at: "2026-09-13T21:00:00.000Z",
  confirmed_by: null,
  confirmed_at: null,
  settled_reason: null,
  items: [],
};
const fixture = (profile = "administrator", kind = "session") => {
  const api = new Hono<ApiContext<object>>();
  const service = {
    consumeReviewLink: vi.fn<NonNullable<ScheduledRunsService["consumeReviewLink"]>>(
      async () => "accepted",
    ),
    retry: vi.fn(async () => ({ outcome: "ok", run }) as never),
    read: vi.fn(async () => run as ScheduledRun | null),
    confirm: vi.fn(async () => ({ outcome: "ok", run }) as never),
    cancel: vi.fn(async () => ({ outcome: "ok", run }) as never),
  };
  api.use("*", async (c, next) => {
    c.set("principal", {
      type: "user",
      userId: 3,
      profile,
      authentication: { kind, sessionId: "test" },
    } as never);
    c.set("requestId", "request");
    await next();
  });
  api.onError((e, c) => errorResponse(e, c, vi.fn()));
  installScheduledRunRoutes(api, service as unknown as ScheduledRunsService);
  return { api, service };
};
const post = (api: Hono<ApiContext<object>>, path: string) =>
  api.request(`/scheduled-runs/${path}`, { method: "POST" });

describe("scheduled run authorization", () => {
  it.each([
    ["member", "session"],
    ["accounting", "session"],
    ["administrator", "token"],
  ])("refuses %s %s for read, confirm and cancel", async (profile, kind) => {
    const { api, service } = fixture(profile, kind);
    expect((await api.request("/scheduled-runs/7")).status).toBe(403);
    expect((await post(api, "7/confirm")).status).toBe(403);
    expect((await post(api, "7/cancel")).status).toBe(403);
    expect((await post(api, "7/retry")).status).toBe(403);
    expect((await api.request("/scheduled-runs/7/items/1/report")).status).toBe(403);
    expect(
      (
        await api.request("/scheduled-runs/7/review-link", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "A".repeat(43) + "." + "B".repeat(43) }),
        })
      ).status,
    ).toBe(403);
    expect(service.consumeReviewLink).not.toHaveBeenCalled();
    expect(service.read).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });
});

describe("scheduled run routes", () => {
  it("consumes a review link as the session actor, maps reuse/expiry, and never answers the proposal", async () => {
    const { api, service } = fixture(),
      token = "A".repeat(43) + "." + "B".repeat(43);
    const review = (body: object) =>
      api.request("/scheduled-runs/7/review-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const opened = await review({ token });
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ data: { path: "/scheduled-runs/7" } });
    expect(service.consumeReviewLink).toHaveBeenCalledWith(7, 3, token, expect.any(String));
    service.consumeReviewLink.mockResolvedValueOnce("used");
    expect((await review({ token })).status).toBe(409);
    service.consumeReviewLink.mockResolvedValueOnce("expired");
    expect((await review({ token })).status).toBe(409);
    service.consumeReviewLink.mockResolvedValueOnce("invalid");
    expect((await review({ token })).status).toBe(404);
    expect((await review({ token, user_id: 99 })).status).toBe(422);
    expect((await review({ token: "bad" })).status).toBe(422);
    expect(service.confirm).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
    expect(service.retry).not.toHaveBeenCalled();
  });

  it("binds explicit warning acknowledgement to the session and refuses unknown mutation fields", async () => {
    const { api, service } = fixture();
    const postBody = (body: object) =>
      api.request("/scheduled-runs/7/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await postBody({ acknowledge_report_warnings: true })).status).toBe(200);
    expect(service.confirm).toHaveBeenCalledWith(7, 3, expect.any(String), true);
    expect((await postBody({ acknowledge_report_warnings: "yes" })).status).toBe(422);
    expect((await postBody({ user_id: 99 })).status).toBe(422);
    expect(service.confirm).toHaveBeenCalledTimes(1);
  });
  it("reads a run", async () => {
    const { api } = fixture();
    const response = await api.request("/scheduled-runs/7");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: run });
  });

  it("answers 404 for an unknown run and 422 for a malformed id", async () => {
    const { api, service } = fixture();
    service.read.mockResolvedValueOnce(null);
    expect((await api.request("/scheduled-runs/8")).status).toBe(404);
    expect((await api.request("/scheduled-runs/abc")).status).toBe(422);
    expect((await post(api, "0/confirm")).status).toBe(422);
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it("confirms and cancels as the session user", async () => {
    const { api, service } = fixture();
    expect((await post(api, "7/confirm")).status).toBe(200);
    expect(service.confirm).toHaveBeenCalledWith(7, 3, expect.any(String), false);
    expect((await post(api, "7/cancel")).status).toBe(200);
    expect(service.cancel).toHaveBeenCalledWith(7, 3, expect.any(String));
    expect((await post(api, "7/retry")).status).toBe(200);
    expect(service.retry).toHaveBeenCalledWith(7, 3, expect.any(String));
  });

  it("maps a lapsed or answered run to 409 and a missing one to 404", async () => {
    const { api, service } = fixture();
    service.confirm.mockResolvedValueOnce({ outcome: "expired", run } as never);
    const lapsed = await post(api, "7/confirm");
    expect(lapsed.status).toBe(409);
    expect(await lapsed.json()).toMatchObject({ error: { code: "expired" } });
    service.cancel.mockResolvedValueOnce({ outcome: "not_proposed", run } as never);
    expect((await post(api, "7/cancel")).status).toBe(409);
    service.confirm.mockResolvedValueOnce({ outcome: "not_found" } as never);
    expect((await post(api, "9/confirm")).status).toBe(404);
  });
});
