import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { installBankDepositRoutes } from "../src/bank-deposits.js";
import { errorResponse } from "../src/errors.js";
import type { ApiContext } from "../src/context.js";
const fixture = (profile = "administrator", kind = "session") => {
  const app = new Hono<ApiContext<object>>();
  app.use("*", async (c, next) => {
    c.set("principal", {
      type: "user",
      userId: 1,
      profile,
      authentication: { kind, sessionId: "1" },
    } as never);
    c.set("requestId", "owned");
    await next();
  });
  app.onError((e, c) => errorResponse(e, c));
  const service = {
    accounts: vi.fn(async () => []),
    list: vi.fn(async () => ({ data: [], page: 1, per_page: 25, total: 0 })),
    candidates: vi.fn(async () => []),
    act: vi.fn(async () => ({ id: 1 })),
    confirm: vi.fn(async () => ({ id: 1 })),
  };
  const feed = {
    status: vi.fn(async () => []),
    processDue: vi.fn(async () => ({ checked: 1, failed: 0 })),
  };
  installBankDepositRoutes(app, service as never, feed);
  return { app, service, feed };
};
const command = (body: unknown) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "Idempotency-Key": "owned-command",
  },
  body: JSON.stringify(body),
});
describe("bank deposit review API boundary", () => {
  it.each([
    ["member", "session"],
    ["administrator", "token"],
    ["executive_manager", "session"],
  ])("denies %s %s for reads and mutations", async (profile, kind) => {
    const f = fixture(profile, kind);
    for (const path of [
      "/bank-deposits",
      "/bank-deposit-accounts",
      "/bank-feed-status",
    ])
      expect((await f.app.request(path)).status).toBe(403);
    expect((await f.app.request("/bank-feeds/sync", command({}))).status).toBe(
      403,
    );
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/confirm",
          command({
            expected_version: 0,
            invoice_id: 1,
            expected_invoice_version: 1,
            confirm_overpayment: false,
          }),
        )
      ).status,
    ).toBe(403);
    expect(f.service.list).not.toHaveBeenCalled();
    expect(f.feed.processDue).not.toHaveBeenCalled();
  });
  it("accounting can review and confirm but cannot attest uncertain provider evidence", async () => {
    const f = fixture("accounting");
    expect((await f.app.request("/bank-deposits")).status).toBe(200);
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/confirm",
          command({
            expected_version: 0,
            invoice_id: 1,
            expected_invoice_version: 1,
            confirm_overpayment: false,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/verify-source",
          command({
            expected_version: 0,
            verification_reference: "provider reference",
            confirm_posted_funds: true,
            confirm_external_credit: true,
          }),
        )
      ).status,
    ).toBe(403);
  });
  it("requires versioned explicit review and rejects raw provider/credential fields", async () => {
    const f = fixture();
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/confirm",
          command({
            expected_version: 0,
            invoice_id: 1,
            expected_invoice_version: 1,
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/reject",
          command({ expected_version: 0, token: "private" }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/verify-source",
          command({
            expected_version: 0,
            verification_reference: "ref",
            confirm_posted_funds: false,
            confirm_external_credit: true,
          }),
        )
      ).status,
    ).toBe(422);
    expect(
      (await f.app.request("/bank-deposits/import", command({ deposits: [] })))
        .status,
    ).toBe(404);
  });
  it("passes native identity, version and stable command to the service", async () => {
    const f = fixture();
    expect(
      (
        await f.app.request(
          "/bank-deposits/1/assign",
          command({ expected_version: 2, invoice_id: 3 }),
        )
      ).status,
    ).toBe(200);
    expect(f.service.act).toHaveBeenCalledWith(
      { userId: 1, sessionId: "1" },
      {
        command_id: "owned-command",
        deposit_id: 1,
        expected_version: 2,
        operation: "assign",
        invoice_id: 3,
      },
    );
  });
});
