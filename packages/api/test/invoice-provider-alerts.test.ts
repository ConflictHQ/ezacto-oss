import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../src/context.js";
import { errorResponse } from "../src/errors.js";
import { installInvoiceProviderAlertRoutes } from "../src/invoice-provider-alerts.js";
const setup = (profile = "administrator", kind = "session") => {
  const api = new Hono<ApiContext<object>>();
  api.use("*", async (c, next) => {
    c.set("principal", {
      type: "user",
      userId: 1,
      profile,
      authentication: { kind, sessionId: "owned" },
    } as never);
    c.set("requestId", "owned");
    await next();
  });
  api.onError((e, c) => errorResponse(e, c));
  const row = {
    id: "evt_owned",
    event_type: "charge.refunded",
    kind: "refund" as const,
    amount_cents: 100,
    currency: "USD",
    provider_status: "refunded",
    occurred_at: "2026-10-26T00:00:00.000Z",
    reviewed_at: null,
    reviewed_by: null,
  };
  const service = {
    list: vi.fn(async () => [row]),
    review: vi.fn(async () => ({
      ...row,
      reviewed_by: 1,
      reviewed_at: "2026-10-26T00:00:00.000Z",
    })),
  };
  installInvoiceProviderAlertRoutes(api, service);
  return { api, service };
};
const post = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};
describe("provider report boundary", () => {
  it.each([
    ["member", "session"],
    ["administrator", "token"],
  ])("denies %s %s before reading or reviewing", async (profile, kind) => {
    const f = setup(profile, kind);
    expect((await f.api.request("/invoices/1/provider-alerts")).status).toBe(
      403,
    );
    expect(
      (
        await f.api.request(
          "/invoices/1/provider-alerts/evt_owned/review",
          post,
        )
      ).status,
    ).toBe(403);
    expect(f.service.list).not.toHaveBeenCalled();
    expect(f.service.review).not.toHaveBeenCalled();
  });
  it("allows accounting to read, but administrator only to mark reviewed", async () => {
    const f = setup("accounting");
    expect((await f.api.request("/invoices/1/provider-alerts")).status).toBe(
      200,
    );
    expect(
      (
        await f.api.request(
          "/invoices/1/provider-alerts/evt_owned/review",
          post,
        )
      ).status,
    ).toBe(403);
  });
  it("passes native session identity to audited review and rejects injected accounting fields", async () => {
    const f = setup();
    expect(
      (
        await f.api.request("/invoices/1/provider-alerts/evt_owned/review", {
          ...post,
          body: '{"amount_cents":0}',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await f.api.request(
          "/invoices/1/provider-alerts/evt_owned/review",
          post,
        )
      ).status,
    ).toBe(200);
    expect(f.service.review).toHaveBeenCalledWith(
      1,
      "evt_owned",
      { userId: 1, sessionId: "owned" },
      expect.any(String),
    );
  });
});
