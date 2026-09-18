import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MirrorClient } from "@ezacto/integrations";
import {
  createQuickBooksMirrorSubscriber,
  createQuickBooksRuntime,
  type QuickBooksMirrorSource,
  type QuickBooksRuntime,
  type QuickBooksSourceInvoice,
} from "@ezacto/integrations";
import { createContainerDatabase } from "../src/adapters.js";
import { recordInvoicePayment } from "../src/invoice-state.js";
import { migrateContainer } from "../src/migrate.js";
import { createQuickBooksMirrorSource } from "../src/quickbooks-source.js";
import { createQuickBooksStore } from "../src/quickbooks.js";

const t = (minute: number): string => `2026-09-11T12:${String(minute).padStart(2, "0")}:00.000Z`;

let sqlite: BetterSqlite3.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

const invoice: QuickBooksSourceInvoice = {
  id: 41,
  number: "1315",
  clientId: 2,
  currency: "USD",
  issueDate: "2026-09-11",
  dueDate: "2026-10-11",
  subject: "September retainer",
  notes: null,
  amountCents: 250_000,
  state: "open",
  lines: [{ description: "Advisory", amountCents: 250_000, quantity: 10, unitPriceCents: 25_000 }],
};

const clients = new Map<number, MirrorClient>(
  [
    { id: 1, name: "Kestrel Environmental", parentClientId: null, currency: "USD" },
    { id: 2, name: "Northpeak", parentClientId: 1, currency: "USD" },
  ].map((row) => [row.id, row]),
);

const recordedPayments: {
  invoiceId: number;
  amountCents: number;
  quickBooksPaymentId: string;
  realmId: string;
}[] = [];

/**
 * The real source over the fixture database, bound late because the database
 * is made per test. The receipts are read through it rather than a test-local
 * query, so a wrong column in the real `readPayments` fails here and not on a
 * pressed Sync in production.
 */
const realSource = () =>
  createQuickBooksMirrorSource(createContainerDatabase(sqlite!) as never, () => new Date(t(1)));

const source = (overrides: Partial<QuickBooksMirrorSource> = {}): QuickBooksMirrorSource => ({
  readInvoice: vi.fn(async () => invoice),
  readPayments: vi.fn((invoiceId: number) => realSource().readPayments(invoiceId)),
  readClients: vi.fn(async () => clients),
  ezactoInvoiceFor: vi.fn(async (_realm: string, id: string) => (id === "qb-inv-7" ? 41 : null)),
  invoiceByNumber: vi.fn(async () => null),
  recordPayment: vi.fn(async (input) => {
    recordedPayments.push({
      invoiceId: input.invoiceId,
      amountCents: input.amountCents,
      quickBooksPaymentId: input.quickBooksPaymentId,
      realmId: input.realmId,
    });
  }),
  ...overrides,
});

/** Intuit, as a function. Every response is stated by the test that needs it. */
const intuit = (
  routes: {
    match: RegExp;
    method?: string;
    body: unknown | ((body: Record<string, unknown>) => unknown);
    status?: number;
  }[],
) =>
  vi.fn(async (request: Request) => {
    for (const route of routes) {
      if (!route.match.test(request.url)) continue;
      if (route.method !== undefined && route.method !== request.method) continue;
      const sent =
        typeof route.body === "function"
          ? (route.body as (body: Record<string, unknown>) => unknown)(
              request.body === null
                ? {}
                : ((await request.clone().json()) as Record<string, unknown>),
            )
          : route.body;
      return new Response(JSON.stringify(sent), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ Fault: { Error: [{ code: "404" }] } }), { status: 404 });
  });

/**
 * A customer id per display name. The unique index on
 * (realm, kind, quickbooks_id) is real: handing the same id back for two
 * clients is two of our records pointing at one QuickBooks customer, and the
 * schema refuses it -- which it should.
 */
const customerResponse = (body: Record<string, unknown>): unknown => ({
  Customer: {
    Id: body["DisplayName"] === "Kestrel Environmental" ? "qb-1" : "qb-2",
    SyncToken: "0",
    DisplayName: String(body["DisplayName"] ?? ""),
  },
});

const runtime = async (
  fetchImpl: (request: Request) => Promise<Response>,
  mirrorSource = source(),
  config: Partial<Parameters<typeof createQuickBooksRuntime>[0]["config"]> = {},
): Promise<QuickBooksRuntime & { store: ReturnType<typeof createQuickBooksStore> }> => {
  sqlite = new BetterSqlite3(":memory:");
  await migrateContainer(sqlite);
  sqlite.exec(`
    INSERT INTO organizations (name, modules, created_at, updated_at)
      VALUES ('Fixture', '{}', '${t(0)}', '${t(0)}');
    INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Operator', 'One', 'administrator', '[]', '${t(0)}', '${t(0)}');
    INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Kestrel Environmental', 'USD', '${t(0)}', '${t(0)}'),
             (2, 'Northpeak', 'USD', '${t(0)}', '${t(0)}');
    INSERT INTO invoices
      (id, client_id, number, currency, issue_date, due_date, state, created_at, updated_at)
      VALUES (41, 2, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '${t(0)}', '${t(0)}'),
             (42, 2, '1316', 'USD', '2026-09-11', '2026-10-11', 'open', '${t(0)}', '${t(0)}');
  `);
  const store = createQuickBooksStore(createContainerDatabase(sqlite));
  const built = createQuickBooksRuntime({
    config: {
      clientId: "client-id",
      clientSecret: "client-secret",
      webhookVerifierToken: "verifier-token",
      environment: "sandbox",
      appBaseUrl: "https://app.example.test",
      ...config,
    },
    store,
    source: mirrorSource,
    fetch: fetchImpl,
    now: () => new Date(t(1)),
    newState: () => "state-value-0123456789",
  });
  return { ...built, store };
};

const tokenBody = {
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 3_600,
  x_refresh_token_expires_in: 8_726_400,
};

const sign = async (payload: string, token = "verifier-token"): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
};

describe("connecting", () => {
  it("[e2e] completes the handshake and records the company", async () => {
    const fetchImpl = intuit([
      { match: /oauth2\/v1\/tokens\/bearer/u, body: tokenBody },
      { match: /companyinfo/u, body: { CompanyInfo: { CompanyName: "Sandbox Company" } } },
    ]);
    const { service } = await runtime(fetchImpl);

    await service.beginAuthorization({
      state: "state-value-0123456789",
      userId: 1,
      redirectUri: service.callbackUrl()!,
    });
    const status = await service.completeAuthorization({
      state: "state-value-0123456789",
      code: "auth-code",
      realmId: "realm-a",
    });

    expect(status).toMatchObject({
      realmId: "realm-a",
      // Asked for rather than assumed: it is the first real call on the new
      // token, so it proves the connection works before an operator is told it does.
      companyName: "Sandbox Company",
      scope: "com.intuit.quickbooks.accounting",
    });
    // Sandbox environment means sandbox host -- a development key cannot reach
    // real books, and this is what keeps a test from trying.
    const urls = fetchImpl.mock.calls.map((call) => call[0].url);
    expect(urls.some((url) => url.includes("sandbox-quickbooks.api.intuit.com"))).toBe(true);
  });

  it("[security] a state this instance never issued is refused before any exchange", async () => {
    const fetchImpl = intuit([{ match: /tokens\/bearer/u, body: tokenBody }]);
    const { service } = await runtime(fetchImpl);
    await expect(
      service.completeAuthorization({ state: "never-issued", code: "c", realmId: "realm-a" }),
    ).rejects.toThrow(/unknown or expired state/u);
    // Nothing was sent to Intuit: the authorization code is never redeemed for
    // a request this instance did not start.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[security] connecting is unavailable where the deployment has no keys", async () => {
    const { service } = await runtime(intuit([]), source(), { clientId: undefined });
    expect(service.clientId()).toBeNull();
  });
});

describe("mirroring an invoice", () => {
  const connected = async (store: ReturnType<typeof createQuickBooksStore>): Promise<void> => {
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
  };

  it("[e2e] creates the customer chain and the invoice, and records both links", async () => {
    const fetchImpl = intuit([
      { match: /\/query\?/u, body: { QueryResponse: {} } },
      { match: /\/customer\?/u, body: customerResponse },
      { match: /\/invoice\?/u, body: { Invoice: { Id: "qb-inv-7", SyncToken: "0", CustomerRef: { value: "qb-2" } } } },
    ]);
    const { mirror, store } = await runtime(fetchImpl);
    await connected(store);

    const outcome = await mirror(41);
    expect(outcome).toMatchObject({ kind: "created", quickBooksId: "qb-inv-7" });
    expect(
      await store.readLink({ realmId: "realm-a", kind: "invoice", ezactoId: 41 }),
    ).toMatchObject({ quickBooksId: "qb-inv-7" });
  });

  it("[security] refuses to mirror when nothing is connected", async () => {
    const fetchImpl = intuit([]);
    const { mirror } = await runtime(fetchImpl);
    expect(await mirror(41)).toMatchObject({ kind: "refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[e2e] refreshes an expired access token and stores the rotated pair first", async () => {
    const fetchImpl = intuit([
      {
        match: /tokens\/bearer/u,
        body: { ...tokenBody, access_token: "access-2", refresh_token: "refresh-2" },
      },
      { match: /\/query\?/u, body: { QueryResponse: {} } },
      { match: /\/customer\?/u, body: customerResponse },
      { match: /\/invoice\?/u, body: { Invoice: { Id: "qb-inv-7", SyncToken: "0", CustomerRef: { value: "qb-2" } } } },
    ]);
    const { mirror, store } = await runtime(fetchImpl);
    await store.saveConnection({
      realmId: "realm-a",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      // Already expired at the runtime's clock.
      accessTokenExpiresAt: t(0),
      refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting",
      connectedByUserId: 1,
      companyName: null,
      now: t(1),
    });

    await mirror(41);
    // Intuit rotates the refresh token on use. Storing it before the next call
    // is what stops a crash leaving a connection nobody can refresh.
    expect(await store.readConnection()).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
  });
});

describe("payments coming back", () => {
  const notification = (realmId = "realm-a"): string =>
    JSON.stringify({
      eventNotifications: [
        {
          realmId,
          dataChangeEvent: {
            entities: [
              {
                name: "Payment",
                id: "qb-pay-1",
                operation: "Create",
                lastUpdated: "2026-09-11T12:05:00",
              },
            ],
          },
        },
      ],
    });

  const paymentRoutes = [
    {
      match: /\/payment\//u,
      body: {
        Payment: {
          Id: "qb-pay-1",
          SyncToken: "0",
          TotalAmt: 2_500,
          TxnDate: "2026-09-20",
          Line: [{ Amount: 2_500, LinkedTxn: [{ TxnId: "qb-inv-7", TxnType: "Invoice" }] }],
        },
      },
    },
  ];

  it("[e2e] records a payment against the invoice it settles", async () => {
    recordedPayments.length = 0;
    const fetchImpl = intuit(paymentRoutes);
    const { service, store } = await runtime(fetchImpl);
    await store.saveConnection({
      realmId: "realm-a",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: t(59),
      refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting",
      connectedByUserId: 1,
      companyName: null,
      now: t(1),
    });

    const payload = notification();
    const result = await service.receiveWebhook({
      payload,
      signature: await sign(payload),
    });
    expect(result.accepted).toBe(true);
    expect(recordedPayments).toEqual([
      {
        invoiceId: 41,
        amountCents: 250_000,
        // The QuickBooks id, which becomes the payment's provider reference --
        // so a person reading the invoice can find the document it came from,
        // and a second delivery cannot record it twice.
        quickBooksPaymentId: "qb-pay-1",
        realmId: "realm-a",
      },
    ]);
  });

  it("[reliability] a payment gone before it is read is skipped, not retried forever", async () => {
    // QuickBooks answers a missing object with 400 and fault code 610, not a
    // 404 (seen on the sandbox, 2026-09-17). Left as a thrown error the
    // delivery was a 500, and Intuit retries a non-2xx until it gives up.
    recordedPayments.length = 0;
    const fetchImpl = intuit([
      {
        match: /\/payment\//u,
        status: 400,
        body: { Fault: { Error: [{ code: "610", Message: "Object Not Found", Detail: "Object Not Found : Something you're trying to use has been made inactive." }] } },
      },
    ]);
    const { service, store } = await runtime(fetchImpl);
    await store.saveConnection({
      realmId: "realm-a",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: t(59),
      refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting",
      connectedByUserId: 1,
      companyName: null,
      now: t(1),
    });
    const payload = notification();
    const result = await service.receiveWebhook({ payload, signature: await sign(payload) });
    expect(result.accepted).toBe(true);
    expect(recordedPayments).toEqual([]);
    const row = sqlite!
      .prepare("SELECT skipped_reason FROM quickbooks_webhook_deliveries WHERE entity_id = 'qb-pay-1'")
      .get() as { skipped_reason: string | null };
    expect(row.skipped_reason).toBe("the payment no longer exists");
  });

  it("[money #853] a payment made in QuickBooks against an invoice never linked adopts it by number, then records", async () => {
    // The books hold every invoice from before the mirror existed. A client
    // paying one of those inside QuickBooks was "no line settles an invoice we
    // mirrored", and the invoice stayed open here.
    recordedPayments.length = 0;
    const fetchImpl = intuit([
      {
        match: /\/payment\//u,
        body: {
          Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: 2_500, TxnDate: "2026-09-20",
            Line: [{ Amount: 2_500, LinkedTxn: [{ TxnId: "qb-inv-harvest", TxnType: "Invoice" }] }] },
        },
      },
      {
        match: /\/invoice\/qb-inv-harvest/u,
        body: { Invoice: { Id: "qb-inv-harvest", SyncToken: "3", DocNumber: "1316", TotalAmt: 2_500, CustomerRef: { value: "300" }, Line: [] } },
      },
    ]);
    const { service, store } = await runtime(
      fetchImpl,
      source({ invoiceByNumber: vi.fn(async (number: string) => (number === "1316" ? { id: 42, amountCents: 250_000 } : null)) }),
    );
    await store.saveConnection({
      realmId: "realm-a", accessToken: "access-1", refreshToken: "refresh-1",
      accessTokenExpiresAt: t(59), refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting", connectedByUserId: 1, companyName: null, now: t(1),
    });
    const payload = JSON.stringify({ eventNotifications: [{ realmId: "realm-a", dataChangeEvent: { entities: [
      { name: "Payment", id: "qb-pay-9", operation: "Create", lastUpdated: "2026-09-11T12:05:00" } ] } }] });
    expect((await service.receiveWebhook({ payload, signature: await sign(payload) })).accepted).toBe(true);
    expect(recordedPayments).toEqual([
      { invoiceId: 42, amountCents: 250_000, quickBooksPaymentId: "qb-pay-9", realmId: "realm-a" },
    ]);
    expect(await store.readLink({ realmId: "realm-a", kind: "invoice", ezactoId: 42 })).toMatchObject({
      quickBooksId: "qb-inv-harvest", syncToken: "3",
    });
  });

  it("[money #853] a QuickBooks payment on an invoice whose total disagrees is left alone", async () => {
    recordedPayments.length = 0;
    const fetchImpl = intuit([
      {
        match: /\/payment\//u,
        body: { Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: 2_499, TxnDate: "2026-09-20",
          Line: [{ Amount: 2_499, LinkedTxn: [{ TxnId: "qb-inv-harvest", TxnType: "Invoice" }] }] } },
      },
      {
        match: /\/invoice\/qb-inv-harvest/u,
        body: { Invoice: { Id: "qb-inv-harvest", SyncToken: "3", DocNumber: "1316", TotalAmt: 2_499, CustomerRef: { value: "300" }, Line: [] } },
      },
    ]);
    const { service, store } = await runtime(
      fetchImpl,
      source({ invoiceByNumber: vi.fn(async () => ({ id: 42, amountCents: 250_000 })) }),
    );
    await store.saveConnection({
      realmId: "realm-a", accessToken: "access-1", refreshToken: "refresh-1",
      accessTokenExpiresAt: t(59), refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting", connectedByUserId: 1, companyName: null, now: t(1),
    });
    const payload = JSON.stringify({ eventNotifications: [{ realmId: "realm-a", dataChangeEvent: { entities: [
      { name: "Payment", id: "qb-pay-9", operation: "Create", lastUpdated: "2026-09-11T12:05:00" } ] } }] });
    expect((await service.receiveWebhook({ payload, signature: await sign(payload) })).accepted).toBe(true);
    expect(recordedPayments).toEqual([]);
    expect(await store.readLink({ realmId: "realm-a", kind: "invoice", ezactoId: 42 })).toBeNull();
  });

  it("[security] a retried delivery does not record the payment twice", async () => {
    recordedPayments.length = 0;
    const fetchImpl = intuit(paymentRoutes);
    const { service, store } = await runtime(fetchImpl);
    await store.saveConnection({
      realmId: "realm-a",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: t(59),
      refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting",
      connectedByUserId: 1,
      companyName: null,
      now: t(1),
    });

    const payload = notification();
    const signature = await sign(payload);
    await service.receiveWebhook({ payload, signature });
    await service.receiveWebhook({ payload, signature });
    // Intuit retries, and a retry after a slow-but-successful handler is
    // indistinguishable from a first delivery. Twice is money.
    expect(recordedPayments).toHaveLength(1);
  });

  it("[security] a forged delivery is refused and touches nothing", async () => {
    recordedPayments.length = 0;
    const fetchImpl = intuit(paymentRoutes);
    const { service } = await runtime(fetchImpl);
    const payload = notification();
    const result = await service.receiveWebhook({
      payload,
      signature: await sign(payload, "not-the-verifier"),
    });
    expect(result.accepted).toBe(false);
    expect(recordedPayments).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[security] a delivery for a company we are not connected to is ignored", async () => {
    recordedPayments.length = 0;
    const fetchImpl = intuit(paymentRoutes);
    const { service, store } = await runtime(fetchImpl);
    await store.saveConnection({
      realmId: "realm-a",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: t(59),
      refreshTokenExpiresAt: t(59),
      scope: "com.intuit.quickbooks.accounting",
      connectedByUserId: 1,
      companyName: null,
      now: t(1),
    });

    const payload = notification("realm-somebody-else");
    const result = await service.receiveWebhook({ payload, signature: await sign(payload) });
    // Accepted -- the signature was real -- but not acted on. Intuit would
    // retry a non-2xx forever for something we will never apply.
    expect(result.accepted).toBe(true);
    expect(recordedPayments).toEqual([]);
  });

  it("[security] an unconfigured verifier refuses every delivery", async () => {
    const { service } = await runtime(intuit(paymentRoutes), source(), {
      webhookVerifierToken: undefined,
    });
    const payload = notification();
    // A public endpoint that cannot verify must not accept. Failing open here
    // is the whole exposure.
    expect(
      await service.receiveWebhook({ payload, signature: await sign(payload) }),
    ).toMatchObject({ accepted: false });
  });
});

describe("payments going out (issue 799)", () => {
  const connected = async (store: ReturnType<typeof createQuickBooksStore>): Promise<void> => {
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
  };

  /** Mark paid, as the settle button does it: the whole balance, today, no note. */
  const markPaid = async (paymentId: number, provider: "manual" = "manual"): Promise<void> => {
    await recordInvoicePayment(createContainerDatabase(sqlite!), {
      invoiceId: 42,
      commandId: `record-${String(paymentId)}`,
      actor: { type: "user", id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: t(2),
      eventIds: [`evt-${String(paymentId)}-a`, `evt-${String(paymentId)}-b`],
      payment: {
        type: provider,
        id: paymentId,
        currency: "USD",
        amountCents: 250_000,
        paidAt: null,
        paidDate: "2026-09-20",
        notes: null,
        recordedByUserId: 1,
      },
    });
  };

  /** The events the command wrote, as the outbox would hand them to a subscriber. */
  const outboxEvents = () =>
    sqlite!
      .prepare(
        `SELECT aggregate_type, aggregate_id, event_type, payload_json
         FROM event_outbox WHERE aggregate_id = 42 ORDER BY aggregate_sequence`,
      )
      .all() as { aggregate_type: string; aggregate_id: number; event_type: string; payload_json: string }[];

  const invoiceRoutes = [
    { match: /\/query\?/u, body: { QueryResponse: {} } },
    { match: /\/customer\?/u, body: customerResponse },
    { match: /\/invoice\?/u, body: { Invoice: { Id: "qb-inv-8", SyncToken: "0", CustomerRef: { value: "qb-2" } } } },
    // The invoice as QuickBooks holds it now: one token on from the create,
    // as it is once a payment has been applied to it there.
    { match: /\/invoice\/qb-inv-8\?/u, method: "GET", body: { Invoice: { Id: "qb-inv-8", SyncToken: "1", CustomerRef: { value: "qb-2" } } } },
  ];
  const paymentRoute = {
    match: /\/payment\?/u,
    method: "POST",
    body: (sent: Record<string, unknown>) => ({
      Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: sent["TotalAmt"], PaymentRefNum: sent["PaymentRefNum"] },
    }),
  };

  const invoice42 = { ...invoice, id: 42, number: "1316" };

  it("[e2e] mark paid on a mirrored invoice files one receipt against it, once", async () => {
    const fetchImpl = intuit([paymentRoute, ...invoiceRoutes]);
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    await built.mirror(42);
    await markPaid(9);

    const subscriber = createQuickBooksMirrorSubscriber(built);
    const deliver = async () => {
      for (const event of outboxEvents()) {
        await subscriber.deliver({
          aggregateType: event.aggregate_type,
          aggregateId: event.aggregate_id,
          eventType: event.event_type,
          payload: JSON.parse(event.payload_json) as Record<string, unknown>,
        });
      }
    };
    await deliver();
    // Once more, as the outbox does after a timeout. The link is what stops
    // the second delivery filing a second receipt.
    await deliver();

    const sent = fetchImpl.mock.calls
      .map((call) => call[0])
      .filter((request) => request.method === "POST" && request.url.includes("/payment?"));
    expect(sent).toHaveLength(1);
    expect(await sent[0]!.clone().json()).toEqual({
      CustomerRef: { value: "qb-2" },
      TotalAmt: 2500,
      TxnDate: "2026-09-20",
      PaymentRefNum: "ez-9",
      Line: [{ Amount: 2500, LinkedTxn: [{ TxnId: "qb-inv-8", TxnType: "Invoice" }] }],
    });
    expect(await built.store.readPaymentLink({ realmId: "realm-a", paymentId: 9 })).toMatchObject({
      quickBooksId: "qb-pay-9",
    });
    // The event set the command wrote is what the subscriber was fed, so this
    // is also the statement that `payment.recorded` carries the receipt.
    expect(outboxEvents().map((event) => event.event_type)).toEqual(["payment.recorded", "invoice.paid"]);
  });

  it("[e2e] an invoice never mirrored is mirrored first, then paid", async () => {
    const fetchImpl = intuit([paymentRoute, ...invoiceRoutes]);
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    await markPaid(9);

    const outcome = await built.mirrorPayment({
      invoiceId: 42,
      payment: { id: 9, amountCents: 250_000, paidOn: "2026-09-20", provider: "manual" },
    });
    expect(outcome).toEqual({ kind: "created", quickBooksId: "qb-pay-9" });
    expect(await built.store.readLink({ realmId: "realm-a", kind: "invoice", ezactoId: 42 })).toMatchObject({
      quickBooksId: "qb-inv-8",
    });
    const order = fetchImpl.mock.calls
      .map((call) => call[0])
      .filter((request) => request.method === "POST")
      .map((request) => new URL(request.url).pathname.split("/").at(-1));
    expect(order.at(-1)).toBe("payment");
    expect(order.indexOf("invoice")).toBeLessThan(order.indexOf("payment"));
  });

  it("[security] refuses without a connection and sends nothing", async () => {
    const fetchImpl = intuit([]);
    const built = await runtime(fetchImpl);
    await markPaid(9);
    expect(
      await built.mirrorPayment({
        invoiceId: 42,
        payment: { id: 9, amountCents: 250_000, paidOn: "2026-09-20", provider: "manual" },
      }),
    ).toMatchObject({ kind: "refused" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[security] the link table refuses a receipt that does not exist", async () => {
    const built = await runtime(intuit([]));
    await expect(
      built.store.savePaymentLink({
        realmId: "realm-a",
        paymentId: 999,
        quickBooksId: "qb-pay-x",
        syncToken: "0",
        now: t(3),
      }),
    ).rejects.toThrow();
    expect(await built.store.readPaymentLink({ realmId: "realm-a", paymentId: 999 })).toBeNull();
  });
});

describe("sync from the invoice page (issue 819)", () => {
  const connected = async (store: ReturnType<typeof createQuickBooksStore>): Promise<void> => {
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
  };

  const markPaid = async (paymentId: number): Promise<void> => {
    await recordInvoicePayment(createContainerDatabase(sqlite!), {
      invoiceId: 42,
      commandId: `record-${String(paymentId)}`,
      actor: { type: "user", id: 1 },
      authorize: async () => true,
      expectedVersion: 0,
      occurredAt: t(2),
      eventIds: [`evt-${String(paymentId)}-a`, `evt-${String(paymentId)}-b`],
      payment: {
        type: "manual",
        id: paymentId,
        currency: "USD",
        amountCents: 250_000,
        paidAt: null,
        paidDate: "2026-09-20",
        notes: null,
        recordedByUserId: 1,
      },
    });
  };

  const invoiceRoutes = [
    { match: /\/query\?/u, body: { QueryResponse: {} } },
    { match: /\/customer\?/u, body: customerResponse },
    { match: /\/invoice\?/u, body: { Invoice: { Id: "qb-inv-8", SyncToken: "0", CustomerRef: { value: "qb-2" } } } },
    // The invoice as QuickBooks holds it now: one token on from the create,
    // as it is once a payment has been applied to it there.
    { match: /\/invoice\/qb-inv-8\?/u, method: "GET", body: { Invoice: { Id: "qb-inv-8", SyncToken: "1", CustomerRef: { value: "qb-2" } } } },
  ];
  const paymentRoute = {
    match: /\/payment\?/u,
    method: "POST",
    body: (sent: Record<string, unknown>) => ({
      Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: sent["TotalAmt"] },
    }),
  };
  const invoice42 = { ...invoice, id: 42, number: "1316" };
  const posted = (fetchImpl: ReturnType<typeof intuit>): string[] =>
    fetchImpl.mock.calls
      .map((call) => call[0])
      .filter((request) => request.method === "POST")
      .map((request) => new URL(request.url).pathname.split("/").at(-1)!);

  it("[e2e] an invoice sent before Connect is refused with the reason, and the page can say so", async () => {
    const fetchImpl = intuit([]);
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    const subscriber = createQuickBooksMirrorSubscriber(built);
    await subscriber.deliver({ aggregateType: "invoice", aggregateId: 42, eventType: "invoice.sent" });

    // Recorded by the subscriber, not by a pressed Sync: the line is honest
    // before anybody looks for a button.
    expect(await built.syncState(42)).toEqual({
      connected: false,
      invoice: null,
      payments: [],
      lastOutcome: { kind: "refused", reason: "QuickBooks is not connected", at: t(1) },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("[e2e] after Connect, Sync mirrors the invoice and its receipts, and a second press creates nothing", async () => {
    const fetchImpl = intuit([paymentRoute, ...invoiceRoutes]);
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    // Sent, then paid, all before the connection existed.
    await createQuickBooksMirrorSubscriber(built).deliver({
      aggregateType: "invoice",
      aggregateId: 42,
      eventType: "invoice.sent",
    });
    await markPaid(9);
    await connected(built.store);

    const result = await built.sync(42);
    expect(result).toEqual({
      invoice: { kind: "created", quickBooksId: "qb-inv-8" },
      payments: [{ paymentId: 9, outcome: { kind: "created", quickBooksId: "qb-pay-9" } }],
    });
    expect(posted(fetchImpl).filter((path) => path === "invoice")).toHaveLength(1);
    expect(posted(fetchImpl).filter((path) => path === "payment")).toHaveLength(1);
    expect(await built.syncState(42)).toEqual({
      connected: true,
      invoice: { quickBooksId: "qb-inv-8", mirroredAt: t(1) },
      payments: [{ paymentId: 9, quickBooksId: "qb-pay-9", mirroredAt: t(1) }],
      lastOutcome: { kind: "created", reason: null, at: t(1) },
    });

    // Pressed twice, as a nervous operator does. The links are what stop the
    // second press filing a second invoice or a second receipt.
    const again = await built.sync(42);
    expect(again).toEqual({ invoice: { kind: "updated", quickBooksId: "qb-inv-8" }, payments: [] });
    expect(posted(fetchImpl).filter((path) => path === "invoice")).toHaveLength(2);
    expect(posted(fetchImpl).filter((path) => path === "payment")).toHaveLength(1);
    // The update carries the token QuickBooks holds after the receipt was
    // applied there, not the one the create returned: the stored token is
    // stale by then, and sending it is a Stale Object Error on every press.
    const update = fetchImpl.mock.calls
      .map((call) => call[0])
      .filter((request) => request.method === "POST" && /\/invoice\?/u.test(request.url))
      .at(-1)!;
    expect(await update.clone().json()).toMatchObject({ Id: "qb-inv-8", SyncToken: "1" });
  });

  it("[security] a draft or a closed invoice is refused by the runtime, not only by the button", async () => {
    // Anything that can name an invoice -- the generated client, the CLI, curl --
    // reaches sync() without the page's disabled button in the way.
    for (const [state, reason] of [
      ["draft", "a draft is not mirrored until it is sent"],
      ["closed", "a closed invoice is not mirrored"],
    ] as const) {
      const fetchImpl = intuit([paymentRoute, ...invoiceRoutes]);
      const built = await runtime(
        fetchImpl,
        source({ readInvoice: vi.fn(async () => ({ ...invoice42, state })) }),
      );
      await connected(built.store);
      expect(await built.sync(42)).toEqual({ invoice: { kind: "refused", reason }, payments: [] });
      expect(await built.syncState(42)).toMatchObject({
        connected: true,
        invoice: null,
        lastOutcome: { kind: "refused", reason },
      });
      expect(posted(fetchImpl)).toEqual([]);
    }
  });

  it("[security] the real source carries the state, so a draft in the database is refused", async () => {
    // Fixture invoice 41 is a draft in the database. Read through the real
    // source rather than the fake, which is how production reaches it.
    const fetchImpl = intuit([...invoiceRoutes]);
    const built = await runtime(
      fetchImpl,
      source({ readInvoice: vi.fn((invoiceId: number) => realSource().readInvoice(invoiceId)) }),
    );
    await connected(built.store);
    expect(await built.sync(41)).toEqual({
      invoice: { kind: "refused", reason: "a draft is not mirrored until it is sent" },
      payments: [],
    });
    expect(posted(fetchImpl)).toEqual([]);
  });

  it("[e2e] a receipt that came from QuickBooks is counted, never sent back, and leaves the outcome alone", async () => {
    const fetchImpl = intuit([paymentRoute, ...invoiceRoutes]);
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    const subscriber = createQuickBooksMirrorSubscriber(built);
    await subscriber.deliver({ aggregateType: "invoice", aggregateId: 42, eventType: "invoice.sent" });
    // The customer paid inside QuickBooks; the webhook recorded it here through
    // the real source, which is the command path.
    await realSource().recordPayment({
      invoiceId: 42,
      amountCents: 250_000,
      paidOn: "2026-09-20",
      realmId: "realm-a",
      quickBooksPaymentId: "qb-pay-from-qbo",
    });
    const recorded = sqlite!
      .prepare(`SELECT id, created_at FROM invoice_payments WHERE invoice_id = 42`)
      .get() as { id: number; created_at: string };

    // The outbox hands the command's own payment.recorded to the subscriber,
    // provider and all. That is the normal path for a mirrored invoice, and it
    // must not become "last attempt refused" on the page.
    const event = sqlite!
      .prepare(
        `SELECT payload_json FROM event_outbox
         WHERE aggregate_id = 42 AND event_type = 'payment.recorded'`,
      )
      .get() as { payload_json: string };
    await subscriber.deliver({
      aggregateType: "invoice",
      aggregateId: 42,
      eventType: "payment.recorded",
      payload: JSON.parse(event.payload_json) as Record<string, unknown>,
    });
    const expected = {
      connected: true,
      invoice: { quickBooksId: "qb-inv-8", mirroredAt: t(1) },
      payments: [{ paymentId: recorded.id, quickBooksId: "qb-pay-from-qbo", mirroredAt: recorded.created_at }],
      lastOutcome: { kind: "created", reason: null, at: t(1) },
    };
    expect(await built.syncState(42)).toEqual(expected);

    // And a pressed Sync afterwards: nothing to send, nothing recorded.
    expect(await built.sync(42)).toEqual({
      invoice: { kind: "updated", quickBooksId: "qb-inv-8" },
      payments: [],
    });
    expect(posted(fetchImpl).filter((path) => path === "payment")).toHaveLength(0);
    expect(await built.syncState(42)).toEqual({
      ...expected,
      lastOutcome: { kind: "updated", reason: null, at: t(1) },
    });
  });

  it("[e2e] a refused receipt after a mirrored invoice is the last outcome, and Sync says which", async () => {
    // Harvest closes a $0 invoice with a $0 payment, and a credit note with a
    // negative one. Neither is a receipt QuickBooks takes, and the page must
    // say so rather than report the invoice as synced and leave it there.
    const fetchImpl = intuit([paymentRoute, ...invoiceRoutes]);
    const built = await runtime(
      fetchImpl,
      source({
        readInvoice: vi.fn(async () => invoice42),
        readPayments: vi.fn(async () => [
          { id: 77, amountCents: 0, paidOn: "2026-09-20", provider: "manual", providerTransactionId: null, recordedAt: t(2) },
        ]),
      }),
    );
    await connected(built.store);
    expect(await built.sync(42)).toEqual({
      invoice: { kind: "created", quickBooksId: "qb-inv-8" },
      payments: [{ paymentId: 77, outcome: { kind: "refused", reason: "QuickBooks takes receipts, not refunds" } }],
    });
    expect(posted(fetchImpl).filter((path) => path === "payment")).toHaveLength(0);
    expect(await built.syncState(42)).toEqual({
      connected: true,
      invoice: { quickBooksId: "qb-inv-8", mirroredAt: t(1) },
      payments: [],
      lastOutcome: { kind: "refused", reason: "QuickBooks takes receipts, not refunds", at: t(1) },
    });
  });

  it("[e2e #825] Sync adopts an invoice Harvest already put in the books, and Mark paid then files against it", async () => {
    // Every invoice on the real instance already exists in QuickBooks from the
    // Harvest era, under Harvest's customers and with no mark of ours. The
    // automatic mirror refused them all; the explicit sync adopts one whose
    // total agrees, writes nothing to the document, and the payment lands
    // where the invoice is.
    const fetchImpl = intuit([]);
    fetchImpl.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      const query = url.searchParams.get("query") ?? "";
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (query.includes("Invoice") && query.includes("'1316'")) {
        return json({
          QueryResponse: {
            Invoice: [{ Id: "9862", SyncToken: "7", DocNumber: "1316", TotalAmt: 2500,
              CustomerRef: { value: "300", name: "kestrel" }, Line: [] }],
          },
        });
      }
      if (url.pathname.endsWith("/invoice/9862") && request.method === "GET") {
        return json({ Invoice: { Id: "9862", SyncToken: "7", DocNumber: "1316", TotalAmt: 2500,
          CustomerRef: { value: "300", name: "kestrel" }, Line: [] } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/payment")) {
        const sent = (await request.clone().json()) as Record<string, unknown>;
        return json({ Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: sent["TotalAmt"] } });
      }
      return json({ QueryResponse: {} });
    });
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);

    // Paid here, then synced on purpose.
    await markPaid(9);
    const result = await built.sync(42);
    expect(result).toEqual({
      invoice: { kind: "adopted", quickBooksId: "9862" },
      payments: [{ paymentId: 9, outcome: { kind: "created", quickBooksId: "qb-pay-9" } }],
    });
    // Nothing written to the invoice or a customer; one receipt, against the
    // customer the books use. No customer link is made for the client: a
    // Harvest sub-customer is not where new invoices for it belong.
    expect(posted(fetchImpl)).toEqual(["payment"]);
    const paymentRequest = fetchImpl.mock.calls.map((c) => c[0]).find((r) => r.method === "POST")!;
    expect(await paymentRequest.clone().json()).toMatchObject({
      CustomerRef: { value: "300" },
      Line: [{ LinkedTxn: [{ TxnId: "9862", TxnType: "Invoice" }] }],
    });
    expect(await built.store.readLink({ realmId: "realm-a", kind: "customer", ezactoId: 2 })).toBeNull();
  });

  it("[money #830] a stale customer link neither misdirects the receipt nor moves the invoice", async () => {
    // What happened on the real instance: the automatic mirror created a
    // customer, then refused the invoice; the client's link pointed at that
    // customer while the books filed the invoice under a Harvest sub-customer.
    // The receipt named the link's customer -- QuickBooks 620 -- and the press
    // after adoption moved the invoice to it. Now the receipt names the
    // invoice's own customer, and an update leaves the customer alone.
    const fetchImpl = intuit([]);
    const updates: Record<string, unknown>[] = [];
    fetchImpl.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      const query = url.searchParams.get("query") ?? "";
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const theirs = { Id: "10120", SyncToken: "3", DocNumber: "1316", TotalAmt: 2500,
        CustomerRef: { value: "326", name: "Northpeak Support" }, Line: [] };
      if (query.includes("Invoice") && query.includes("'1316'")) {
        return json({ QueryResponse: { Invoice: [theirs] } });
      }
      if (url.pathname.endsWith("/invoice/10120") && request.method === "GET") {
        return json({ Invoice: theirs });
      }
      if (url.pathname.endsWith("/invoice") && request.method === "POST") {
        const sent = (await request.clone().json()) as Record<string, unknown>;
        updates.push(sent);
        return json({ Invoice: { ...theirs, SyncToken: "4", CustomerRef: sent["CustomerRef"] } });
      }
      if (request.method === "POST" && url.pathname.endsWith("/payment")) {
        const sent = (await request.clone().json()) as { CustomerRef: { value: string } };
        // The real refusal, when the customer is not the invoice's.
        if (sent.CustomerRef.value !== "326") {
          return new Response(JSON.stringify({ Fault: { Error: [{ code: "620", Message: "TxnID Cannot Be Linked" }] } }), { status: 400 });
        }
        return json({ Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: 2500 } });
      }
      return json({ QueryResponse: {} });
    });
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    // The stale link, as the earlier mirror left it.
    await built.store.saveLink({ realmId: "realm-a", kind: "customer", ezactoId: 2, quickBooksId: "332", syncToken: "0", now: t(0) });
    await markPaid(9);

    expect(await built.sync(42)).toEqual({
      invoice: { kind: "adopted", quickBooksId: "10120" },
      payments: [{ paymentId: 9, outcome: { kind: "created", quickBooksId: "qb-pay-9" } }],
    });
    // The second press updates the document but keeps it under Northpeak Support.
    expect(await built.sync(42)).toMatchObject({ invoice: { kind: "updated", quickBooksId: "10120" } });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ Id: "10120", SyncToken: "3", CustomerRef: { value: "326" } });
    expect(await built.store.readLink({ realmId: "realm-a", kind: "customer", ezactoId: 2 })).toMatchObject({
      quickBooksId: "332",
    });
  });

  it("[money #853] a receipt recorded here reaches QuickBooks on a Harvest-era invoice with no press", async () => {
    // What Kestrel Holdings's payment at BILL does: the reconciliation records the
    // receipt here, the outbox hands payment.recorded to this subscriber,
    // and the invoice -- sent before the mirror existed -- must be adopted
    // and the receipt filed, without anyone pressing Sync.
    const fetchImpl = intuit([]);
    fetchImpl.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      const query = url.searchParams.get("query") ?? "";
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      const theirs = { Id: "9862", SyncToken: "7", DocNumber: "1316", TotalAmt: 2500, CustomerRef: { value: "300", name: "kestrel" }, Line: [] };
      if (query.includes("Invoice") && query.includes("'1316'")) return json({ QueryResponse: { Invoice: [theirs] } });
      if (url.pathname.endsWith("/invoice/9862") && request.method === "GET") return json({ Invoice: theirs });
      if (request.method === "POST" && url.pathname.endsWith("/payment")) {
        return json({ Payment: { Id: "qb-pay-9", SyncToken: "0", TotalAmt: 2500 } });
      }
      return json({ QueryResponse: {} });
    });
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    await markPaid(9);
    const event = sqlite!
      .prepare(`SELECT payload_json FROM event_outbox WHERE aggregate_id = 42 AND event_type = 'payment.recorded'`)
      .get() as { payload_json: string };
    await createQuickBooksMirrorSubscriber(built).deliver({
      aggregateType: "invoice",
      aggregateId: 42,
      eventType: "payment.recorded",
      payload: JSON.parse(event.payload_json) as Record<string, unknown>,
    });
    expect(posted(fetchImpl)).toEqual(["payment"]);
    expect(await built.store.readLink({ realmId: "realm-a", kind: "invoice", ezactoId: 42 })).toMatchObject({ quickBooksId: "9862" });
    expect((await built.syncState(42))?.lastOutcome).toMatchObject({ kind: "created" });
    expect(await built.store.readPaymentLink({ realmId: "realm-a", paymentId: 9 })).toMatchObject({ quickBooksId: "qb-pay-9" });
  });

  it("[money #825] Sync refuses to adopt when the books hold a different total", async () => {
    const fetchImpl = intuit([]);
    fetchImpl.mockImplementation(async (request: Request) => {
      const query = new URL(request.url).searchParams.get("query") ?? "";
      const body = query.includes("'1316'")
        ? { QueryResponse: { Invoice: [{ Id: "9862", SyncToken: "7", DocNumber: "1316", TotalAmt: 2400, CustomerRef: { value: "300" }, Line: [] }] } }
        : { QueryResponse: {} };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    const result = await built.sync(42);
    expect(result?.invoice).toMatchObject({ kind: "refused", reason: expect.stringContaining("2400.00") });
    expect((result?.invoice as { reason: string }).reason).toContain("2500.00");
    expect(posted(fetchImpl)).toEqual([]);
  });

  it("[e2e] a refused sync names the reason and touches no receipt", async () => {
    // The customer name QuickBooks already holds under a different parent.
    const fetchImpl = intuit([]);
    fetchImpl.mockImplementation(async (request: Request) => {
      const url = new URL(request.url);
      const query = url.searchParams.get("query") ?? "";
      if (query.includes("Customer") && query.includes("Northpeak")) {
        return new Response(
          JSON.stringify({
            QueryResponse: {
              Customer: [
                {
                  Id: "qb-elsewhere",
                  SyncToken: "0",
                  DisplayName: "Northpeak",
                  ParentRef: { value: "qb-somebody-else" },
                },
              ],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (query.includes("Customer")) {
        return new Response(
          JSON.stringify({
            QueryResponse: {
              Customer: [{ Id: "qb-1", SyncToken: "0", DisplayName: "Kestrel Environmental" }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ QueryResponse: {} }), {
        headers: { "content-type": "application/json" },
      });
    });
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    await markPaid(9);

    // The sub-customer's display name carries its parent, which is how a
    // bookkeeper reading the reason finds the record in QuickBooks.
    const reason =
      "QuickBooks already has a customer named Kestrel Environmental \u2014 Northpeak under a different parent";
    expect(await built.sync(42)).toEqual({
      invoice: { kind: "refused", reason },
      payments: [],
    });
    // Surfaced on the page as the reason, not swallowed as a retry.
    expect(await built.syncState(42)).toMatchObject({
      connected: true,
      invoice: null,
      payments: [],
      lastOutcome: { kind: "refused", reason },
    });
    expect(posted(fetchImpl)).toEqual([]);
  });

  it("[reliability] an error is recorded as failed and still thrown, so the outbox retries", async () => {
    const fetchImpl = intuit([
      { match: /\/query\?/u, body: { Fault: { Error: [{ Message: "token lapsed" }] } }, status: 401 },
    ]);
    const built = await runtime(fetchImpl, source({ readInvoice: vi.fn(async () => invoice42) }));
    await connected(built.store);
    const subscriber = createQuickBooksMirrorSubscriber(built);
    await expect(
      subscriber.deliver({ aggregateType: "invoice", aggregateId: 42, eventType: "invoice.sent" }),
    ).rejects.toThrow();
    const state = await built.syncState(42);
    expect(state?.lastOutcome?.kind).toBe("failed");
    expect(state?.lastOutcome?.reason).not.toBe("");
  });

  it("[api] an invoice that does not exist is nothing to sync or report", async () => {
    const built = await runtime(intuit([]), source({ readInvoice: vi.fn(async () => null) }));
    expect(await built.sync(404)).toBeNull();
    expect(await built.syncState(404)).toBeNull();
  });
});
