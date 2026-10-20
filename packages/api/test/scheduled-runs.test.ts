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
    expect(service.read).not.toHaveBeenCalled();
    expect(service.confirm).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });
});

describe("scheduled run routes", () => {
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
    expect(service.confirm).toHaveBeenCalledWith(7, 3, expect.any(String));
    expect((await post(api, "7/cancel")).status).toBe(200);
    expect(service.cancel).toHaveBeenCalledWith(7, 3, expect.any(String));
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
