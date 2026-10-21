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
    advances: { report: vi.fn(async () => ({ from: '2026-10-01', to: '2026-10-31', advances: [] })), apply: vi.fn(async () => {}), reverse: vi.fn(async () => {}), recordReturn: vi.fn(async () => {}) },
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

describe('advance credit commands', () => {
  it.each([['member','session'],['accounting','session'],['executive_manager','session'],['administrator','token']])('refuses %s %s on every credit route', async (profile, kind) => {
    const { api, service } = fixture(profile, kind);
    for (const [path, method] of [['','GET'],['/applications','POST'],['/reversals','POST'],['/returns','POST']] as const) {
      const response = await api.request(`/payment-runs/advances${path}`, { method });
      expect(response.status).toBe(403);
    }
    expect(service.advances.report).not.toHaveBeenCalled();
    expect(service.advances.apply).not.toHaveBeenCalled();
  });
  it('passes reviewed advance selections and explicit applications through the administrator session', async () => {
    const { api, service } = fixture();
    const post = (path: string, body: unknown) => api.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const item = { user_id: 2, month: '2026-11', amount_cents: 15000, expected_version: 0, purpose: 'advance', currency: 'USD', advance_project_id: 7, advance_reason: 'Deposit' };
    expect((await post('/payment-runs/preview', { id: 'run', name: 'Deposit', source_currency: 'USD', scheduled_at: '2026-10-21T00:00:00.000Z', timezone: 'UTC', items: [item] })).status).toBe(201);
    expect(service.preview).toHaveBeenCalledWith(expect.objectContaining({ items: [item] }), 1, 'request', expect.any(String));
    expect((await api.request('/payment-runs/advances?from=2026-10-01&to=2026-10-31')).status).toBe(200);
    expect(service.advances.report).toHaveBeenCalledWith('2026-10-01','2026-10-31');
    const command = { id: 'apply', reason: 'Pay reviewed work', advance_item_id: 'item', user_id: 2, currency: 'USD', month: '2026-09', amount_cents: 4000, scope: 'entry', project_id: 7, entry_id: 10 };
    expect((await post('/payment-runs/advances/applications', command)).status).toBe(204);
    expect(service.advances.apply).toHaveBeenCalledWith(command, 1, 'request', expect.any(String));
    expect((await post('/payment-runs/advances/reversals', { id: 'reverse', application_id: 'apply', reason: 'Wrong period' })).status).toBe(204);
    expect(service.advances.reverse).toHaveBeenCalledWith({ id: 'reverse', application_id: 'apply', reason: 'Wrong period' }, 1, 'request', expect.any(String));
    expect((await post('/payment-runs/advances/returns', { id: 'return', advance_item_id: 'item', amount_cents: 1000, reference: 'confirmed-return', reason: 'Unused deposit' })).status).toBe(204);
    expect(service.advances.recordReturn).toHaveBeenCalledWith(expect.objectContaining({ amount_cents: 1000, reference: 'confirmed-return' }), 1, 'request', expect.any(String));
    expect((await post('/payment-runs/advances/applications', { ...command, amount_cents: '4000' })).status).toBe(422);
  });
});
