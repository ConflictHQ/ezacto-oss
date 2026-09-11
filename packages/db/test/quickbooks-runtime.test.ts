import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MirrorClient, MirrorInvoice } from "@ezacto/integrations";
import {
  createQuickBooksRuntime,
  type QuickBooksMirrorSource,
  type QuickBooksRuntime,
} from "@ezacto/integrations";
import { createContainerDatabase } from "../src/adapters.js";
import { migrateContainer } from "../src/migrate.js";
import { createQuickBooksStore } from "../src/quickbooks.js";

const t = (minute: number): string => `2026-09-11T12:${String(minute).padStart(2, "0")}:00.000Z`;

let sqlite: BetterSqlite3.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

const invoice: MirrorInvoice = {
  id: 41,
  number: "1315",
  clientId: 2,
  currency: "USD",
  issueDate: "2026-09-11",
  dueDate: "2026-10-11",
  subject: "September retainer",
  notes: null,
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

const source = (overrides: Partial<QuickBooksMirrorSource> = {}): QuickBooksMirrorSource => ({
  readInvoice: vi.fn(async () => invoice),
  readClients: vi.fn(async () => clients),
  ezactoInvoiceFor: vi.fn(async (_realm: string, id: string) => (id === "qb-inv-7" ? 41 : null)),
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
      VALUES (41, 2, '1315', 'USD', '2026-09-11', '2026-10-11', 'draft', '${t(0)}', '${t(0)}');
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
      { match: /\/invoice\?/u, body: { Invoice: { Id: "qb-inv-7", SyncToken: "0" } } },
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
      { match: /\/invoice\?/u, body: { Invoice: { Id: "qb-inv-7", SyncToken: "0" } } },
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
