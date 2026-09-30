import { Hono } from "hono";
import { describe, it, expect, vi } from "vitest";
import { installPaymentRunRoutes } from "../src/payment-runs.js";
import { errorResponse } from "../src/errors.js";
import type { ApiContext } from "../src/context.js";
import { PaymentProviderError, type PaymentRunsService } from "@ezacto/core";
const fixture = (profile = "administrator", kind = "session") => {
  const api = new Hono<ApiContext<object>>();
  const service = {
    preview: vi.fn(async () => ({ id: "run" })),
    approve: vi.fn(async () => ({ id: "run" })),
    cancel: vi.fn(async () => ({ id: "run" })),
    retry: vi.fn(async () => ({ id: "run" })),
    report: vi.fn(async () => ({
      from: "2026-09",
      to: "2026-09",
      ledgers: [],
      runs: [],
    })),
    processDue: vi.fn(),
  };
  api.use("*", async (c, next) => {
    c.set("principal", {
      type: "user",
      userId: 1,
      profile,
      authentication: { kind, sessionId: "test" },
    } as never);
    c.set("requestId", "request");
    await next();
  });
  const reportError = vi.fn();
  api.onError((e, c) => errorResponse(e, c, reportError));
  installPaymentRunRoutes(api, service as unknown as PaymentRunsService);
  return { api, service, reportError };
};
describe("payment run authorization", () => {
  it("reports provider failures with the request ID through the API reporter", async () => {
    const { api, service, reportError } = fixture();
    service.approve.mockRejectedValueOnce(
      new PaymentProviderError("Wise 403 during lookup. Trace: fixture", 403),
    );
    const response = await api.request("/payment-runs/id/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limits: [{ item_id: "item", max_source_cents: 5000 }],
      }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ request_id: "request" });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Wise 403 during lookup. Trace: fixture",
      }),
      "request",
    );
  });
  it.each([
    ["member", "session"],
    ["accounting", "session"],
    ["administrator", "token"],
  ])("refuses %s %s for reports and all commands", async (profile, kind) => {
    const { api, service } = fixture(profile, kind);
    for (const [path, method] of [
      ["report", "GET"],
      ["preview", "POST"],
      ["id/approve", "POST"],
      ["id/cancel", "POST"],
      ["id/items/item/reconcile", "POST"],
    ])
      expect(
        (await api.request(`/payment-runs/${path}`, { method: method! }))
          .status,
      ).toBe(403);
    expect(service.approve).not.toHaveBeenCalled();
    expect(service.report).not.toHaveBeenCalled();
  });
  it("validates preview and approval shapes before invoking a payment operation", async () => {
    const { api, service } = fixture();
    for (const path of ["preview", "id/approve"])
      expect(
        (
          await api.request(`/payment-runs/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(422);
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.approve).not.toHaveBeenCalled();
  });
  it("records the authenticated approver and request ID; never processes synchronously in the API", async () => {
    const { api, service } = fixture();
    const approval = { limits: [{ item_id: "item", max_source_cents: 5000 }] };
    expect(
      (
        await api.request("/payment-runs/id/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...approval, actor_id: 99 }),
        })
      ).status,
    ).toBe(200);
    expect(service.approve).toHaveBeenCalledWith(
      "id",
      approval,
      1,
      "request",
      expect.any(String),
    );
    expect(service.processDue).not.toHaveBeenCalled();
  });
});
