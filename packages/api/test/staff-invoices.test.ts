import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { installStaffInvoiceRoutes } from "../src/staff-invoices.js";
import { errorResponse } from "../src/errors.js";
import type { ApiContext } from "../src/context.js";
import type {
  StaffInvoicesStore,
  StaffInvoiceReport,
  StaffInvoice,
} from "@ezacto/core";
const invoice: StaffInvoice = {
  id: 7,
  user_id: 2,
  month: "2026-09",
  currency: "USD",
  reference: "C-001",
  versions: [],
  matched_cents: 0,
  flags: [],
  line_flags: [],
};
const report: StaffInvoiceReport = {
  month: "2026-09",
  people: [
    {
      user_id: 2,
      name: "Person Two",
      currency: "USD",
      earned_cents: 10000,
      paid_cents: 0,
      invoiced_cents: 0,
      matched_invoice_cents: 0,
      uninvoiced_cents: 10000,
      invoices: [invoice],
    },
  ],
};
const fixture = (
  profile = "administrator",
  kind = "session",
  ownMoney = true,
) => {
  const store = {
    save: vi.fn(async () => invoice),
    report: vi.fn(async () => report),
    recordDocument: vi.fn(async () => {}),
    document: vi.fn<StaffInvoicesStore["document"]>(async () => null),
  };
  const objects = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => ({ body: "pdf bytes" })),
  };
  const app = new Hono<ApiContext<object>>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request");
    c.set("principal", {
      type: "user",
      userId: 2,
      profile,
      ownMoneyVisible: ownMoney,
      authentication: { kind, sessionId: "session" },
    } as never);
    await next();
  });
  app.onError((error, c) => errorResponse(error, c));
  installStaffInvoiceRoutes(app, store, objects);
  return { app, store, objects };
};
const command = {
  id: "create",
  invoice_id: null,
  expected_version: 0,
  user_id: 2,
  month: "2026-09",
  currency: "USD",
  reference: "C-001",
  kind: "draft",
  from_review: true,
  lines: [],
  document_id: null,
  reason: "Reviewed earnings",
  acknowledge_paid_history: false,
};
const post = (app: ReturnType<typeof fixture>["app"], body: unknown) =>
  app.request("/staff-invoices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
describe("contractor invoice boundaries", () => {
  it.each(["member", "accounting", "executive_manager", "project_manager"])(
    "denies %s access to administrator reports, writes and uploads",
    async (profile) => {
      const f = fixture(profile);
      expect(
        (await f.app.request("/staff-invoices?month=2026-09")).status,
      ).toBe(403);
      expect((await post(f.app, command)).status).toBe(403);
      expect(
        (
          await f.app.request("/staff-invoices/7/documents?month=2026-09", {
            method: "POST",
          })
        ).status,
      ).toBe(403);
      expect(f.store.report).not.toHaveBeenCalled();
      expect(f.store.save).not.toHaveBeenCalled();
      expect(f.objects.put).not.toHaveBeenCalled();
    },
  );
  it("denies every token and binds own-person reads to the signed-in user rather than a query subject", async () => {
    const token = fixture("administrator", "token");
    expect((await post(token.app, command)).status).toBe(403);
    expect((await token.app.request("/staff-invoices")).status).toBe(403);
    expect((await token.app.request("/me/staff-invoices")).status).toBe(403);
    const own = fixture("member");
    expect(
      (await own.app.request("/me/staff-invoices?month=2026-09&user_id=999"))
        .status,
    ).toBe(200);
    expect(own.store.report).toHaveBeenCalledWith("2026-09", 2);
    const off = fixture("member", "session", false);
    expect((await off.app.request("/me/staff-invoices")).status).toBe(403);
    expect(
      (await off.app.request("/staff-invoices/7/documents/file/content"))
        .status,
    ).toBe(403);
    expect(off.store.document).not.toHaveBeenCalled();
  });
  it("records an explicit version and rejects malformed lines without calling the store", async () => {
    const f = fixture();
    expect((await post(f.app, command)).status).toBe(201);
    expect(f.store.save).toHaveBeenCalledWith(
      command,
      2,
      "request",
      expect.any(String),
    );
    f.store.save.mockClear();
    expect((await post(f.app,{...command,tax_amount_cents:1000})).status).toBe(422);
    expect(
      (
        await post(f.app, {
          ...command,
          lines: [
            {
              description: "Work",
              seconds: "3600",
              rate_cents: 5000,
              project_id: 1,
              entry_id: 10,
            },
          ],
        })
      ).status,
    ).toBe(422);
    expect(f.store.save).not.toHaveBeenCalled();
  });
  it("uploads with shared multipart rules and never exposes storage keys; own-person content is a download guarded by document ownership", async () => {
    const f = fixture(),
      body = new FormData();
    body.set(
      "file",
      new File(["pdf bytes"], "invoice.pdf", { type: "application/pdf" }),
    );
    const upload = await f.app.request(
      "/staff-invoices/7/documents?month=2026-09",
      { method: "POST", headers: { "idempotency-key": "document" }, body },
    );
    expect(upload.status).toBe(201);
    expect(await upload.json()).toEqual({
      data: {
        id: "document",
        invoice_id: 7,
        name: "invoice.pdf",
        content_type: "application/pdf",
        byte_size: 9,
      },
    });
    expect(f.store.recordDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice_id: 7,
        name: "invoice.pdf",
        content_hash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
      2,
      "request",
      expect.any(String),
    );
    const own = fixture("member");
    expect(
      (await own.app.request("/staff-invoices/7/documents/document/content"))
        .status,
    ).toBe(404);
    expect(own.store.document).toHaveBeenCalledWith(7, "document", 2);
    expect(own.objects.get).not.toHaveBeenCalled();
    own.store.document.mockResolvedValue({
      id: "document",
      invoice_id: 7,
      name: "invoice.pdf",
      byte_size: 9,
      content_type: "application/pdf",
      file_key: "private-key",
      content_hash: "a".repeat(64),
    });
    const download = await own.app.request(
      "/staff-invoices/7/documents/document/content",
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(
      "attachment;",
    );
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await download.text()).toBe("pdf bytes");
  });
});
