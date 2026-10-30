import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQuickBooksRuntime } from "@ezacto/integrations";
import { createContainerDatabase } from "../src/adapters.js";
import { executeInvoiceLifecycleCommand, recordInvoicePayment } from "../src/invoice-state.js";
import { migrateContainer } from "../src/migrate.js";
import {
  createQuickBooksMirrorSource,
  createQuickBooksReconciliationSource,
} from "../src/quickbooks-source.js";
import { createQuickBooksStore } from "../src/quickbooks.js";

const t = (minute: number): string => `2026-10-18T12:${String(minute).padStart(2, "0")}:00.000Z`;

let sqlite: BetterSqlite3.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

/**
 * Three sent invoices over the real migrated schema: 1001 ($1000, unpaid),
 * 1002 ($500, $200 received here), 1003 ($300, never mirrored), plus a draft
 * that is not a document of record.
 */
const seed = async (): Promise<void> => {
  sqlite = new BetterSqlite3(":memory:");
  await migrateContainer(sqlite);
  sqlite.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO invoices
      (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1001', 'USD', '2026-10-01', '2026-11-01', 'draft', '${t(0)}', '${t(0)}'),
             (2, 1, '1002', 'USD', '2026-10-01', '2026-11-01', 'draft', '${t(0)}', '${t(0)}'),
             (3, 1, '1003', 'USD', '2026-10-01', '2026-11-01', 'draft', '${t(0)}', '${t(0)}'),
             (4, 1, '1004', 'USD', '2026-10-01', '2026-11-01', 'draft', '${t(0)}', '${t(0)}');
    INSERT INTO invoice_line_items
      (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents,
       created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 10, 10000, 100000, '${t(0)}', '${t(0)}'),
             (2, 0, 'Service', 'Advisory', 5, 10000, 50000, '${t(0)}', '${t(0)}'),
             (3, 0, 'Service', 'Advisory', 3, 10000, 30000, '${t(0)}', '${t(0)}'),
             (4, 0, 'Service', 'Advisory', 1, 10000, 10000, '${t(0)}', '${t(0)}');
  `);
  for (const id of [1, 2, 3]) {
    await executeInvoiceLifecycleCommand(createContainerDatabase(sqlite), {
      invoiceId: id,
      commandId: `send-${String(id)}`,
      command: "send",
      actor: { type: "user", id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: t(0),
      messageId: 9000 + id,
      eventId: `send-${String(id)}-event`,
    });
  }
  const version = (
    sqlite.prepare("SELECT version FROM invoices WHERE id = 2").get() as { version: number }
  ).version;
  await recordInvoicePayment(createContainerDatabase(sqlite), {
    invoiceId: 2,
    commandId: "record-1",
    actor: { type: "user", id: 1 },
    authorize: async () => true,
    expectedVersion: version,
    occurredAt: t(2),
    eventIds: ["evt-1-a", "evt-1-b"],
    payment: {
      type: "manual",
      id: 1,
      currency: "USD",
      amountCents: 20_000,
      paidAt: null,
      paidDate: "2026-10-10",
      notes: null,
      recordedByUserId: 1,
    },
  });
};

const intuitInvoices = [
  // 1001: linked, matches.
  { Id: "q1", SyncToken: "0", DocNumber: "1001", TotalAmt: 1000, Balance: 1000, CustomerRef: { value: "c" }, Line: [] },
  // 1002: linked; QuickBooks has $300 received, we recorded $200.
  { Id: "q2", SyncToken: "0", DocNumber: "1002", TotalAmt: 500, Balance: 200, CustomerRef: { value: "c" }, Line: [] },
  // 1003 is not linked and QuickBooks has no 1003: missing in QuickBooks.
  // Nothing here for 9999: missing here.
  { Id: "q9", SyncToken: "0", DocNumber: "9999", TotalAmt: 50, Balance: 50, CustomerRef: { value: "c" }, Line: [] },
];

const build = async (calls: { method: string }[]) => {
  await seed();
  const database = createContainerDatabase(sqlite!);
  const store = createQuickBooksStore(database);
  await store.saveConnection({
    realmId: "realm-a",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: t(59),
    refreshTokenExpiresAt: t(59),
    scope: "com.intuit.quickbooks.accounting",
    connectedByUserId: 1,
    companyName: "Sandbox Company",
    now: t(1),
  });
  for (const [id, remote] of [
    [1, "q1"],
    [2, "q2"],
  ] as const) {
    await store.saveLink({
      realmId: "realm-a",
      kind: "invoice",
      ezactoId: id,
      quickBooksId: remote,
      syncToken: "0",
      now: t(1),
    });
  }
  const fetchImpl = vi.fn(async (request: Request) => {
    calls.push({ method: request.method });
    return new Response(JSON.stringify({ QueryResponse: { Invoice: intuitInvoices } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const runtime = createQuickBooksRuntime({
    config: {
      clientId: "client-id",
      clientSecret: "client-secret",
      webhookVerifierToken: "verifier-token",
      environment: "sandbox",
      appBaseUrl: "https://app.example.test",
    },
    store,
    source: createQuickBooksMirrorSource(database, () => new Date(t(1))),
    reconciliation: createQuickBooksReconciliationSource(database),
    fetch: fetchImpl,
    now: () => new Date(t(1)),
  });
  return runtime;
};

const snapshot = (): unknown =>
  [
    "invoices",
    "invoice_payments",
    "quickbooks_links",
    "quickbooks_payment_links",
    "quickbooks_webhook_deliveries",
  ].map((table) => sqlite!.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

describe("the QuickBooks reconciliation report", () => {
  it("[e2e] classifies stored invoices against the faked company, partial payments included", async () => {
    const runtime = await build([]);
    const report = await runtime.reconcile();
    expect(report).not.toBeNull();
    const byNumber = new Map(report!.rows.map((row) => [row.number, row]));

    expect(byNumber.get("1001")).toMatchObject({ status: "matched", linked: true });
    expect(byNumber.get("1002")).toMatchObject({
      status: "payments_differ",
      ezactoPaidCents: 20_000,
      quickBooksPaidCents: 30_000,
    });
    expect(byNumber.get("1002")!.detail).toContain("partly paid there");
    expect(byNumber.get("1003")).toMatchObject({ status: "missing_in_quickbooks", linked: false });
    expect(byNumber.get("9999")).toMatchObject({ status: "missing_here", quickBooksId: "q9" });
    // The draft is not a document of record, so it is not reported at all.
    expect(byNumber.has("1004")).toBe(false);
    expect(report!.counts).toMatchObject({
      matched: 1,
      payments_differ: 1,
      missing_in_quickbooks: 1,
      missing_here: 1,
    });
  });

  it("[security] changes nothing: only GETs reach QuickBooks and no table is written", async () => {
    const calls: { method: string }[] = [];
    const runtime = await build(calls);
    const before = snapshot();
    await runtime.reconcile();
    await runtime.reconcile();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((request) => request.method === "GET")).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it("answers null where QuickBooks is not connected, and sends nothing", async () => {
    const calls: { method: string }[] = [];
    const runtime = await build(calls);
    sqlite!.exec("DELETE FROM quickbooks_connections");
    expect(await runtime.reconcile()).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
