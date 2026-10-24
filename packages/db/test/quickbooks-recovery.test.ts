import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createQuickBooksRuntime, type QuickBooksRuntime } from "@ezacto/integrations";
import { createContainerDatabase } from "../src/adapters.js";
import { executeInvoiceLifecycleCommand, recordInvoicePayment } from "../src/invoice-state.js";
import { migrateContainer } from "../src/migrate.js";
import {
  createQuickBooksMirrorSource,
  createQuickBooksReconciliationSource,
} from "../src/quickbooks-source.js";
import { createQuickBooksStore } from "../src/quickbooks.js";

/**
 * Issue 1013, slices 2 and 3: catching up on payment changes a webhook never
 * delivered, and flagging payments QuickBooks voided or deleted.
 *
 * Every Intuit answer below is a recorded fixture of invented data, in the
 * shape Intuit documents for change data capture. Nothing reaches QuickBooks.
 */

const base = Date.parse("2026-10-19T12:00:00.000Z");
const minute = 60_000;
const day = 24 * 60 * minute;

const clock = { now: base };

let sqlite: BetterSqlite3.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

/** A payment of QuickBooks against invoice `qb-inv-1` (ours: 1001, $1000.00). */
const payment = (
  id: string,
  dollars: number,
  overrides: Record<string, unknown> = {},
  invoice = "qb-inv-1",
): Record<string, unknown> => ({
  Id: id,
  SyncToken: "0",
  TotalAmt: dollars,
  TxnDate: "2026-10-19",
  Line: [{ Amount: dollars, LinkedTxn: [{ TxnId: invoice, TxnType: "Invoice" }] }],
  MetaData: {
    CreateTime: "2026-10-19T05:10:00-07:00",
    LastUpdatedTime: "2026-10-19T05:10:00-07:00",
  },
  ...overrides,
});

const voided = (id: string, lastUpdated: string): Record<string, unknown> =>
  payment(id, 0, {
    PrivateNote: "Voided",
    Line: [{ Amount: 0, LinkedTxn: [{ TxnId: "qb-inv-1", TxnType: "Invoice" }] }],
    MetaData: { CreateTime: "2026-10-19T05:10:00-07:00", LastUpdatedTime: lastUpdated },
  });

/** Change data capture's answer: one QueryResponse holding the payments. */
const cdc = (payments: unknown[], time: string): unknown => ({
  CDCResponse: [{ QueryResponse: [{ Payment: payments, startPosition: 1, maxResults: payments.length }] }],
  time,
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

interface Intuit {
  calls: Request[];
  cdc: (request: Request) => Response;
  /** What GET /payment/<id> answers, by id. */
  payments: Map<string, Record<string, unknown>>;
  invoice: (request: Request) => Response;
}

const notFound = (): Response =>
  json({ Fault: { Error: [{ code: "610", Message: "Object Not Found" }] } }, 400);

const intuit = (): Intuit => {
  const state: Intuit = {
    calls: [],
    cdc: () => json(cdc([], iso(clock.now))),
    payments: new Map(),
    invoice: () => notFound(),
  };
  return state;
};

const fetcher =
  (state: Intuit) =>
  async (request: Request): Promise<Response> => {
    state.calls.push(request);
    const url = new URL(request.url);
    if (url.pathname.endsWith("/cdc")) return state.cdc(request);
    const payment = /\/payment\/([^/]+)$/u.exec(url.pathname);
    if (payment !== null) {
      const found = state.payments.get(decodeURIComponent(payment[1]!));
      return found === undefined ? notFound() : json({ Payment: found });
    }
    if (/\/invoice\//u.test(url.pathname)) return state.invoice(request);
    if (url.pathname.endsWith("/query")) return json({ QueryResponse: {} });
    return json({ Fault: { Error: [{ code: "404" }] } }, 404);
  };

const sign = async (payload: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("verifier-token"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
};

const notification = (
  id: string,
  operation: string,
  lastUpdated: string,
): string =>
  JSON.stringify({
    eventNotifications: [
      {
        realmId: "realm-a",
        dataChangeEvent: { entities: [{ name: "Payment", id, operation, lastUpdated }] },
      },
    ],
  });

interface Harness {
  runtime: QuickBooksRuntime;
  store: ReturnType<typeof createQuickBooksStore>;
  intuit: Intuit;
  sleeps: number[];
  restart(): QuickBooksRuntime;
  deliver(id: string, operation: string, lastUpdated: string): Promise<void>;
}

const connect = async (store: ReturnType<typeof createQuickBooksStore>): Promise<void> =>
  store.saveConnection({
    realmId: "realm-a",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAt: iso(base + 400 * day),
    refreshTokenExpiresAt: iso(base + 400 * day),
    scope: "com.intuit.quickbooks.accounting",
    connectedByUserId: 1,
    companyName: "Sandbox Company",
    now: iso(clock.now),
  });

/**
 * Two sent invoices over the real migrated schema, both linked to their
 * QuickBooks documents: 1001 ($1000.00, qb-inv-1) and 1002 ($500.00, qb-inv-2).
 */
const build = async (): Promise<Harness> => {
  clock.now = base;
  sqlite = new BetterSqlite3(":memory:");
  await migrateContainer(sqlite);
  sqlite.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${iso(base)}', '${iso(base)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${iso(base)}', '${iso(base)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${iso(base)}', '${iso(base)}');
    INSERT INTO invoices
      (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (1, 1, '1001', 'USD', '2026-10-01', '2026-11-01', 'draft', '${iso(base)}', '${iso(base)}'),
             (2, 1, '1002', 'USD', '2026-10-01', '2026-11-01', 'draft', '${iso(base)}', '${iso(base)}');
    INSERT INTO invoice_line_items
      (invoice_id, position, kind, description, quantity, unit_price_cents, amount_cents,
       created_at, updated_at)
      VALUES (1, 0, 'Service', 'Advisory', 10, 10000, 100000, '${iso(base)}', '${iso(base)}'),
             (2, 0, 'Service', 'Advisory', 5, 10000, 50000, '${iso(base)}', '${iso(base)}');
  `);
  const database = createContainerDatabase(sqlite);
  for (const id of [1, 2]) {
    await executeInvoiceLifecycleCommand(database, {
      invoiceId: id,
      commandId: `send-${String(id)}`,
      command: "send",
      actor: { type: "user", id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: iso(base),
      messageId: 9000 + id,
      eventId: `send-${String(id)}-event`,
    });
  }
  const store = createQuickBooksStore(database);
  await connect(store);
  for (const [ezactoId, quickBooksId] of [
    [1, "qb-inv-1"],
    [2, "qb-inv-2"],
  ] as const) {
    await store.saveLink({
      realmId: "realm-a",
      kind: "invoice",
      ezactoId,
      quickBooksId,
      syncToken: "0",
      now: iso(base),
    });
  }
  const server = intuit();
  const sleeps: number[] = [];
  const runtimeOptions = {
    config: {
      clientId: "client-id",
      clientSecret: "client-secret",
      webhookVerifierToken: "verifier-token",
      environment: "sandbox",
      appBaseUrl: "https://app.example.test",
    },
    store,
    source: createQuickBooksMirrorSource(database, () => new Date(clock.now)),
    reconciliation: createQuickBooksReconciliationSource(database),
    fetch: fetcher(server),
    now: () => new Date(clock.now),
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
    },
  };
  const runtime = createQuickBooksRuntime(runtimeOptions);
  return {
    runtime,
    store,
    intuit: server,
    sleeps,
    restart: () => createQuickBooksRuntime(runtimeOptions),
    deliver: async (id, operation, lastUpdated) => {
      const payload = notification(id, operation, lastUpdated);
      const result = await runtime.service.receiveWebhook({ payload, signature: await sign(payload) });
      expect(result.accepted).toBe(true);
    },
  };
};

const receipts = (): { provider_transaction_id: string; amount_cents: number }[] =>
  sqlite!
    .prepare(
      "SELECT provider_transaction_id, amount_cents FROM invoice_payments WHERE provider = 'quickbooks' ORDER BY id",
    )
    .all() as { provider_transaction_id: string; amount_cents: number }[];

const cursor = (): { cdc_cursor: string; last_run_at: string; last_outcome: string } | undefined =>
  sqlite!.prepare("SELECT * FROM quickbooks_sync_cursors WHERE realm_id = 'realm-a'").get() as
    | { cdc_cursor: string; last_run_at: string; last_outcome: string }
    | undefined;

const divergences = (): unknown[] =>
  sqlite!
    .prepare(
      "SELECT quickbooks_payment_id, kind, quickbooks_updated_at FROM quickbooks_payment_divergences ORDER BY 1",
    )
    .all();

const cdcCalls = (harness: Harness): Request[] =>
  harness.intuit.calls.filter((request) => new URL(request.url).pathname.endsWith("/cdc"));

describe("QuickBooks catch-up (slice 2)", () => {
  it("[e2e] the first run only places the cursor and reads nothing", async () => {
    const harness = await build();
    const result = await harness.runtime.catchUp();
    expect(result).toMatchObject({ seeded: true, outcome: "caught_up", examined: 0 });
    expect(cursor()).toEqual({
      realm_id: "realm-a",
      retry_not_before: null,
      cdc_cursor: iso(base),
      last_run_at: iso(base),
      last_outcome: "caught_up",
    });
    expect(harness.intuit.calls).toEqual([]);
    expect(receipts()).toEqual([]);
  });

  it("[money] recovers a payment no webhook delivered, resuming from the cursor", async () => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    harness.intuit.cdc = () => json(cdc([payment("P1", 400)], iso(clock.now)));

    const result = await harness.runtime.catchUp();

    expect(result).toMatchObject({ seeded: false, outcome: "caught_up", examined: 1, alreadyProcessed: 0 });
    expect(receipts()).toEqual([{ provider_transaction_id: "P1:qb-inv-1", amount_cents: 40_000 }]);
    // Read from the cursor less the overlap, never from a delivery's timestamp.
    const asked = new URL(cdcCalls(harness)[0]!.url).searchParams;
    expect(asked.get("changedSince")).toBe(iso(base - 5 * minute));
    expect(asked.get("entities")).toBe("Payment");
    expect(cursor()).toMatchObject({ cdc_cursor: iso(clock.now), last_outcome: "caught_up" });
  });

  it("[money] replaying the same window records nothing twice", async () => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    harness.intuit.cdc = () => json(cdc([payment("P1", 400)], iso(clock.now)));
    await harness.runtime.catchUp();

    clock.now = base + 45 * minute;
    const again = await harness.runtime.catchUp();

    expect(again).toMatchObject({ examined: 1, alreadyProcessed: 1 });
    expect(receipts()).toHaveLength(1);
    expect(
      (sqlite!.prepare("SELECT count(*) AS n FROM quickbooks_webhook_deliveries").get() as { n: number }).n,
    ).toBe(1);
  });

  it("[money] the webhook and catch-up delivering the same payment record it once, in either order", async () => {
    const webhookFirst = await build();
    webhookFirst.intuit.payments.set("P1", payment("P1", 400));
    await webhookFirst.runtime.catchUp();
    clock.now = base + 30 * minute;
    await webhookFirst.deliver("P1", "Create", "2026-10-19T12:10:00");
    webhookFirst.intuit.cdc = () => json(cdc([payment("P1", 400)], iso(clock.now)));
    const second = await webhookFirst.runtime.catchUp();
    expect(second).toMatchObject({ examined: 1, alreadyProcessed: 1 });
    expect(receipts()).toHaveLength(1);
    sqlite!.close();

    const catchUpFirst = await build();
    catchUpFirst.intuit.payments.set("P1", payment("P1", 400));
    await catchUpFirst.runtime.catchUp();
    clock.now = base + 30 * minute;
    catchUpFirst.intuit.cdc = () => json(cdc([payment("P1", 400)], iso(clock.now)));
    await catchUpFirst.runtime.catchUp();
    // The late webhook for the same change. Same instant, so it is not applied.
    await catchUpFirst.deliver("P1", "Create", "2026-10-19T12:10:00");
    expect(receipts()).toHaveLength(1);
  });

  it("[money] a change the webhook processed under another operation name is not applied again", async () => {
    // Catch-up names a change Create only when the times match; the payment and
    // the instant are what identify it, not the operation.
    const harness = await build();
    harness.intuit.payments.set("P1", payment("P1", 400));
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    await harness.deliver("P1", "Update", "2026-10-19T12:10:00");
    harness.intuit.cdc = () => json(cdc([payment("P1", 400)], iso(clock.now)));
    const result = await harness.runtime.catchUp();
    expect(result).toMatchObject({ alreadyProcessed: 1 });
    expect(receipts()).toHaveLength(1);
  });

  it("[reliability] a failure leaves the cursor where it was, and the next run finishes the window", async () => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    const second = payment("P2", 100, {}, "qb-inv-unlinked");
    harness.intuit.cdc = () => json(cdc([payment("P1", 400), second], iso(clock.now)));
    // Looking up the unlinked invoice fails outright (not a throttle).
    harness.intuit.invoice = () => json({ Fault: { Error: [{ code: "5000" }] } }, 500);

    await expect(harness.runtime.catchUp()).rejects.toThrow(/status 500/u);

    expect(cursor()).toMatchObject({ cdc_cursor: iso(base), last_outcome: "failed" });
    // The payment applied before the failure stays applied, once.
    expect(receipts()).toHaveLength(1);

    harness.intuit.invoice = () => notFound();
    const retried = await harness.runtime.catchUp();
    expect(retried).toMatchObject({ outcome: "caught_up", examined: 2, alreadyProcessed: 1 });
    expect(receipts()).toHaveLength(1);
    expect(cursor()).toMatchObject({ cdc_cursor: iso(clock.now), last_outcome: "caught_up" });
  });

  it.each(["7200", "Mon, 19 Oct 2026 14:30:00 GMT"])("[reliability] persists Retry-After %s across restart without sleeping or moving the cursor", async (retryAfter) => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    harness.intuit.cdc = () => json({ Fault: { Error: [{ code: "3001" }] } }, 429, { "retry-after": retryAfter });
    await expect(harness.runtime.catchUp()).rejects.toThrow(/status 429/u);
    const retryAt = clock.now + 120 * minute;
    expect(harness.sleeps).toEqual([]);
    expect(cursor()).toMatchObject({ cdc_cursor: iso(base), last_outcome: "failed", retry_not_before: iso(retryAt) });
    const calls = harness.intuit.calls.length;
    const restarted = harness.restart();
    clock.now += 60 * minute;
    await expect(restarted.catchUp()).rejects.toThrow(/retry_deferred/u);
    expect(harness.intuit.calls).toHaveLength(calls);
    clock.now = retryAt;
    harness.intuit.cdc = () => json(cdc([], iso(clock.now)));
    expect(await restarted.catchUp()).toMatchObject({ outcome: "caught_up", cursor: iso(clock.now) });
    expect(cursor()).toMatchObject({ cdc_cursor: iso(clock.now), last_outcome: "caught_up" });
    expect(receipts()).toHaveLength(0);
  });

  it("[reliability] uses Intuit's 60-second fallback and retries only once it is due", async () => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    harness.intuit.cdc = () => json({ Fault: { Error: [{ code: "3001" }] } }, 429);
    await expect(harness.runtime.catchUp()).rejects.toThrow(/status 429/u);
    const retryAt = clock.now + minute;
    expect(cursor()).toMatchObject({ cdc_cursor: iso(base), retry_not_before: iso(retryAt) });
    const calls = harness.intuit.calls.length;
    clock.now = retryAt - 1;
    await expect(harness.runtime.catchUp()).rejects.toThrow(/retry_deferred/u);
    expect(harness.intuit.calls).toHaveLength(calls);
    clock.now = retryAt;
    harness.intuit.cdc = () => json(cdc([], iso(clock.now)));
    expect(await harness.runtime.catchUp()).toMatchObject({ outcome: "caught_up" });
    expect(harness.sleeps).toEqual([]);
  });

  it("[reliability] a gap beyond Intuit's 30 days asks for a full reconcile and reads nothing", async () => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 40 * day;

    const result = await harness.runtime.catchUp();

    expect(result).toMatchObject({ outcome: "full_reconcile_needed", examined: 0 });
    expect(cursor()).toMatchObject({ cdc_cursor: iso(base), last_outcome: "full_reconcile_needed" });
    expect(harness.intuit.calls).toEqual([]);

    // Still asked for on the next run: nothing quietly moved the cursor.
    clock.now = base + 41 * day;
    expect(await harness.runtime.catchUp()).toMatchObject({ outcome: "full_reconcile_needed" });
    expect(cursor()?.cdc_cursor).toBe(iso(base));

    // Reconnecting is starting over: a fresh cursor, and recovery resumes.
    clock.now += minute;
    await connect(harness.store);
    expect(await harness.runtime.catchUp()).toMatchObject({ outcome: "full_reconcile_needed" });
    expect(cursor()?.cdc_cursor).toBe(iso(clock.now));
    clock.now = base + 41 * day + 30 * minute;
    expect(await harness.runtime.catchUp()).toMatchObject({ outcome: "caught_up" });
  });

  it("answers null where QuickBooks is not connected, and sends nothing", async () => {
    const harness = await build();
    sqlite!.exec("DELETE FROM quickbooks_connections");
    expect(await harness.runtime.catchUp()).toBeNull();
    expect(harness.intuit.calls).toEqual([]);
  });

  it("[reliability] a CDC ceiling preserves the cursor and applies none of the incomplete window", async () => {
    const harness = await build();
    await harness.runtime.catchUp();
    clock.now = base + 30 * minute;
    const paymentsBefore = sqlite!.prepare("SELECT * FROM invoice_payments").all();
    const invoicesBefore = sqlite!.prepare("SELECT * FROM invoices ORDER BY id").all();
    harness.intuit.cdc = () => json(cdc(
      Array.from({ length: 1000 }, (_, index) => payment(`X${String(index)}`, 0.01, {
        MetaData: { LastUpdatedTime: iso(base + 10 * minute + index * 1000) },
      })), iso(clock.now),
    ));
    const result = await harness.runtime.catchUp();
    expect(result).toMatchObject({ examined: 0, outcome: "full_reconcile_needed", cursor: iso(base) });
    expect(cursor()).toMatchObject({ cdc_cursor: iso(base), last_outcome: "full_reconcile_needed" });
    expect(harness.intuit.calls).toHaveLength(1);
    expect(sqlite!.prepare("SELECT * FROM invoice_payments").all()).toEqual(paymentsBefore);
    expect(sqlite!.prepare("SELECT * FROM invoices ORDER BY id").all()).toEqual(invoicesBefore);
    expect(sqlite!.prepare("SELECT * FROM quickbooks_webhook_deliveries").all()).toEqual([]);
    expect(sqlite!.prepare("SELECT * FROM quickbooks_payment_divergences").all()).toEqual([]);
    expect(harness.intuit.calls.every(request => request.method === "GET")).toBe(true);
  });
});

describe("payments voided or deleted in QuickBooks (slice 3)", () => {
  const withReceipt = async (): Promise<Harness> => {
    const harness = await build();
    harness.intuit.payments.set("P1", payment("P1", 400));
    await harness.deliver("P1", "Create", "2026-10-19T12:10:00");
    expect(receipts()).toHaveLength(1);
    return harness;
  };

  it("[money] a Void webhook flags the payment and leaves every record as it was", async () => {
    const harness = await withReceipt();
    const before = sqlite!.prepare("SELECT * FROM invoice_payments").all();
    const invoiceBefore = sqlite!.prepare("SELECT * FROM invoices ORDER BY id").all();
    const callsBefore = harness.intuit.calls.length;

    await harness.deliver("P1", "Void", "2026-10-19T12:20:00");

    expect(divergences()).toEqual([
      { quickbooks_payment_id: "P1", kind: "voided", quickbooks_updated_at: "2026-10-19T12:20:00.000Z" },
    ]);
    // Nothing corrected: the receipt, the invoice and QuickBooks are untouched.
    expect(sqlite!.prepare("SELECT * FROM invoice_payments").all()).toEqual(before);
    expect(sqlite!.prepare("SELECT * FROM invoices ORDER BY id").all()).toEqual(invoiceBefore);
    expect(harness.intuit.calls).toHaveLength(callsBefore);
    const delivery = sqlite!
      .prepare("SELECT skipped_reason FROM quickbooks_webhook_deliveries WHERE operation = 'Void'")
      .get() as { skipped_reason: string };
    expect(delivery.skipped_reason).toContain("flagged for review");
  });

  it("[money] a Delete webhook flags it, and a repeat or an older report changes nothing", async () => {
    const harness = await withReceipt();
    await harness.deliver("P1", "Delete", "2026-10-19T12:30:00");
    await harness.deliver("P1", "Delete", "2026-10-19T12:30:00");
    // An older report arriving late (a retried Void) does not roll the record back.
    await harness.deliver("P1", "Void", "2026-10-19T12:20:00");
    expect(divergences()).toEqual([
      { quickbooks_payment_id: "P1", kind: "deleted", quickbooks_updated_at: "2026-10-19T12:30:00.000Z" },
    ]);
  });

  it("[money] a change announced for a payment since deleted is flagged the same way", async () => {
    const harness = await withReceipt();
    harness.intuit.payments.delete("P1");
    await harness.deliver("P1", "Update", "2026-10-19T12:40:00");
    expect(divergences()).toEqual([
      { quickbooks_payment_id: "P1", kind: "deleted", quickbooks_updated_at: "2026-10-19T12:40:00.000Z" },
    ]);
  });

  it("flags nothing where no receipt of ours came from the payment", async () => {
    const harness = await build();
    await harness.deliver("P9", "Void", "2026-10-19T12:20:00");
    await harness.deliver("P8", "Delete", "2026-10-19T12:21:00");
    expect(divergences()).toEqual([]);
    const reasons = sqlite!
      .prepare("SELECT skipped_reason FROM quickbooks_webhook_deliveries ORDER BY entity_id")
      .all() as { skipped_reason: string }[];
    expect(reasons.map((row) => row.skipped_reason)).toEqual([
      "the payment was deleted in QuickBooks; no receipt of ours came from it",
      "the payment was voided in QuickBooks; no receipt of ours came from it",
    ]);
  });

  it("[money] catch-up finds a void and a delete, and a void shown as an update", async () => {
    const harness = await build();
    harness.intuit.payments.set("P1", payment("P1", 400));
    harness.intuit.payments.set("P2", payment("P2", 100, {}, "qb-inv-2"));
    await harness.deliver("P1", "Create", "2026-10-19T12:10:00");
    await harness.deliver("P2", "Create", "2026-10-19T12:10:00");
    expect(receipts()).toHaveLength(2);
    await harness.runtime.catchUp();
    clock.now = base + 60 * minute;
    harness.intuit.cdc = () =>
      json(
        cdc(
          [voided("P1", "2026-10-19T05:30:00-07:00"), { Id: "P2", status: "Deleted", domain: "QBO" }],
          iso(clock.now),
        ),
      );

    await harness.runtime.catchUp();

    expect(divergences()).toEqual([
      { quickbooks_payment_id: "P1", kind: "voided", quickbooks_updated_at: "2026-10-19T12:30:00.000Z" },
      { quickbooks_payment_id: "P2", kind: "deleted", quickbooks_updated_at: iso(clock.now) },
    ]);
    expect(receipts()).toHaveLength(2);
  });

  it("[security] a payment the mirror made from our receipt: its create echo is not flagged, its void is", async () => {
    const harness = await build();
    const database = createContainerDatabase(sqlite!);
    const version = (
      sqlite!.prepare("SELECT version FROM invoices WHERE id = 2").get() as { version: number }
    ).version;
    await recordInvoicePayment(database, {
      invoiceId: 2,
      commandId: "record-1",
      actor: { type: "user", id: 1 },
      authorize: async () => true,
      expectedVersion: version,
      occurredAt: iso(base),
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
    await harness.store.savePaymentLink({
      realmId: "realm-a",
      paymentId: 1,
      quickBooksId: "Q-EZ",
      syncToken: "0",
      now: iso(base),
    });
    harness.intuit.payments.set("Q-EZ", payment("Q-EZ", 200, { PaymentRefNum: "ez-1" }, "qb-inv-2"));

    await harness.deliver("Q-EZ", "Create", "2026-10-19T12:10:00");
    expect(divergences()).toEqual([]);
    expect(receipts()).toEqual([]);

    await harness.deliver("Q-EZ", "Void", "2026-10-19T12:20:00");
    expect(divergences()).toEqual([
      { quickbooks_payment_id: "Q-EZ", kind: "voided", quickbooks_updated_at: "2026-10-19T12:20:00.000Z" },
    ]);
  });

  it("[e2e] the report lists the divergence with its receipts and the catch-up state, and writes nothing", async () => {
    const harness = await withReceipt();
    await harness.runtime.catchUp();
    await harness.deliver("P1", "Void", "2026-10-19T12:20:00");
    const tables = [
      "invoices",
      "invoice_payments",
      "quickbooks_links",
      "quickbooks_payment_links",
      "quickbooks_webhook_deliveries",
      "quickbooks_payment_divergences",
      "quickbooks_sync_cursors",
    ];
    const snapshot = (): unknown =>
      tables.map((table) => sqlite!.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const before = snapshot();
    const callsBefore = harness.intuit.calls.length;

    const report = await harness.runtime.reconcile();

    expect(report!.paymentDivergences).toEqual([
      {
        quickBooksPaymentId: "P1",
        kind: "voided",
        quickBooksUpdatedAt: "2026-10-19T12:20:00.000Z",
        detectedAt: iso(clock.now),
        receipts: [expect.objectContaining({ invoiceId: 1, invoiceNumber: "1001", amountCents: 40_000 })],
      },
    ]);
    expect(report!.recovery).toEqual({
      cdcCursor: iso(base),
      lastRunAt: iso(base),
      lastOutcome: "caught_up",
    });
    expect(snapshot()).toEqual(before);
    expect(harness.intuit.calls.slice(callsBefore).every((request) => request.method === "GET")).toBe(true);
  });
});

describe("the recovery tables", () => {
  it("refuse a cursor that is not a canonical instant, and an outcome or kind they do not know", async () => {
    await build();
    const insertCursor = sqlite!.prepare(
      "INSERT INTO quickbooks_sync_cursors (realm_id, cdc_cursor, last_run_at, last_outcome) VALUES (?, ?, ?, ?)",
    );
    expect(() => insertCursor.run("realm-b", "yesterday", iso(base), "caught_up")).toThrow();
    expect(() => insertCursor.run("realm-b", iso(base), iso(base), "perfect")).toThrow();
    insertCursor.run("realm-b", iso(base), iso(base), "caught_up");
    expect(() => insertCursor.run("realm-b", iso(base), iso(base), "caught_up")).toThrow();

    const insertDivergence = sqlite!.prepare(
      "INSERT INTO quickbooks_payment_divergences (realm_id, quickbooks_payment_id, kind, quickbooks_updated_at, detected_at) VALUES (?, ?, ?, ?, ?)",
    );
    expect(() => insertDivergence.run("realm-b", "P1", "refunded", iso(base), iso(base))).toThrow();
    insertDivergence.run("realm-b", "P1", "voided", iso(base), iso(base));
  });

  it("[unit] the store keeps one cursor per company and moves it only when told to", async () => {
    const harness = await build();
    expect(await harness.store.readSyncCursor("realm-a")).toBeNull();
    await harness.store.saveSyncCursor({
      realmId: "realm-a",
      cdcCursor: iso(base),
      lastRunAt: iso(base),
      lastOutcome: "caught_up",
    });
    await harness.store.recordSyncOutcome({
      realmId: "realm-a",
      lastRunAt: iso(base + minute),
      lastOutcome: "failed",
    });
    expect(await harness.store.readSyncCursor("realm-a")).toEqual({
      retryNotBefore: null,
      cdcCursor: iso(base),
      lastRunAt: iso(base + minute),
      lastOutcome: "failed",
    });
    // An outcome for a company with no cursor places nothing.
    await harness.store.recordSyncOutcome({
      realmId: "realm-z",
      lastRunAt: iso(base),
      lastOutcome: "failed",
    });
    expect(await harness.store.readSyncCursor("realm-z")).toBeNull();
  });
});
