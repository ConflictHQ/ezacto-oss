/**
 * Assembling the QuickBooks connection from deployment configuration, the
 * store, and Intuit.
 *
 * This is where the pieces meet: the routes know the handshake, the store knows
 * the tables, the integrations package knows Intuit, and none of them knows
 * about the others. The wiring is here so that stays true.
 */

import {
  QUICKBOOKS_ACCOUNTING_SCOPE,
  QUICKBOOKS_PRODUCTION_BASE_URL,
  QUICKBOOKS_SANDBOX_BASE_URL,
  QuickBooksClient,
  accessTokenNeedsRefresh,
  authorizeUrl,
  canonicalLastUpdated,
  exchangeAuthorizationCode,
  inboundPayments,
  mirrorInvoice,
  parseWebhookNotification,
  refreshAccessToken,
  revokeConnection,
  verifyWebhookSignature,
  type MirrorClient,
  type MirrorInvoice,
  type MirrorOutcome,
} from "../index.js";


/**
 * The connection as a caller sees it. Structurally the same shape the API
 * package's route contract expects -- stated here rather than imported, because
 * this package must not depend on the one that serves it.
 */
export interface QuickBooksConnectionStatus {
  realmId: string;
  companyName: string | null;
  scope: string;
  allowOnlinePayment: boolean;
  connectedAt: string;
}

/** Likewise structural: what the routes call, without importing the routes. */
export interface QuickBooksService {
  clientId(): string | null;
  callbackUrl(): string | null;
  settingsUrl(): string;
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  beginAuthorization(input: {
    state: string;
    userId: number;
    redirectUri: string;
  }): Promise<void>;
  completeAuthorization(input: {
    state: string;
    code: string;
    realmId: string;
  }): Promise<QuickBooksConnectionStatus>;
  readStatus(): Promise<QuickBooksConnectionStatus | null>;
  setAllowOnlinePayment(allow: boolean): Promise<void>;
  disconnect(): Promise<void>;
  receiveWebhook(input: {
    payload: string;
    signature: string | null;
  }): Promise<{ accepted: boolean; reason?: string }>;
  newState(): string;
}

/**
 * Where the connection and its links are kept. The database package implements
 * this; naming it structurally keeps the dependency pointing one way.
 */
export interface QuickBooksConnectionStore {
  readConnection(): Promise<
    | (QuickBooksConnectionStatus & {
        accessToken: string;
        refreshToken: string;
        accessTokenExpiresAt: string;
        refreshTokenExpiresAt: string;
      })
    | null
  >;
  beginAuthorization(input: {
    state: string;
    userId: number;
    redirectUri: string;
    now: string;
    expiresAt: string;
  }): Promise<void>;
  consumeAuthorization(input: {
    state: string;
    now: string;
  }): Promise<{ userId: number; redirectUri: string } | null>;
  saveConnection(input: {
    realmId: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    scope: string;
    connectedByUserId: number;
    companyName: string | null;
    now: string;
  }): Promise<void>;
  saveTokens(input: {
    realmId: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
    now: string;
  }): Promise<void>;
  setAllowOnlinePayment(input: { allow: boolean; now: string }): Promise<void>;
  disconnect(input: { now: string }): Promise<void>;
  readLink(input: {
    realmId: string;
    kind: "customer" | "invoice";
    ezactoId: number;
  }): Promise<{ quickBooksId: string; syncToken: string } | null>;
  saveLink(input: {
    realmId: string;
    kind: "customer" | "invoice";
    ezactoId: number;
    quickBooksId: string;
    syncToken: string;
    now: string;
  }): Promise<void>;
  claimWebhookDelivery(input: {
    realmId: string;
    entityName: string;
    entityId: string;
    operation: string;
    lastUpdated: string;
    now: string;
  }): Promise<boolean>;
  completeWebhookDelivery(input: {
    realmId: string;
    entityName: string;
    entityId: string;
    operation: string;
    lastUpdated: string;
    now: string;
    skippedReason?: string;
  }): Promise<void>;
}

export interface QuickBooksConfig {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly webhookVerifierToken: string | undefined;
  /** `sandbox` reaches Intuit's test companies only; anything else is live books. */
  readonly environment: string | undefined;
  readonly appBaseUrl: string | undefined;
}

/**
 * Reading an invoice and the clients it hangs off, for the mirror.
 *
 * Narrow on purpose: the mirror needs an invoice and an ancestry, not the
 * money repository. Implemented against the database by the caller.
 */
export interface QuickBooksMirrorSource {
  readInvoice(invoiceId: number): Promise<MirrorInvoice | null>;
  readClients(clientId: number): Promise<ReadonlyMap<number, MirrorClient>>;
  /** Our invoice id for a QuickBooks invoice id, for payments coming back. */
  ezactoInvoiceFor(realmId: string, quickBooksInvoiceId: string): Promise<number | null>;
  recordPayment(input: {
    invoiceId: number;
    amountCents: number;
    paidOn: string | null;
    realmId: string;
    /** QuickBooks' own id for the payment; the receipt's provider reference. */
    quickBooksPaymentId: string;
  }): Promise<void>;
}

export interface QuickBooksRuntimeOptions {
  readonly config: QuickBooksConfig;
  readonly store: QuickBooksConnectionStore;
  readonly source: QuickBooksMirrorSource;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly now: () => Date;
  /** Injected so a test can state the value rather than tolerate randomness. */
  readonly newState?: () => string;
}

const CALLBACK_PATH = "/api/v1/integrations/quickbooks/callback";
const SETTINGS_PATH = "/settings/integrations";
/** A consent screen is answered in minutes; an hour-old state is a link somebody kept. */
const STATE_LIFETIME_MS = 10 * 60 * 1000;

const randomState = (): string => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const trimmed = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text === undefined || text === "" ? null : text;
};

export interface QuickBooksRuntime {
  readonly service: QuickBooksService;
  /** Mirrors one invoice, or says why it could not. Used by the outbox subscriber. */
  mirror(invoiceId: number): Promise<MirrorOutcome>;
}

export const createQuickBooksRuntime = (
  options: Readonly<QuickBooksRuntimeOptions>,
): QuickBooksRuntime => {
  const { config, store, source } = options;
  const clientId = trimmed(config.clientId);
  const clientSecret = trimmed(config.clientSecret);
  const appBaseUrl = trimmed(config.appBaseUrl);
  const verifierToken = trimmed(config.webhookVerifierToken);
  const baseUrl =
    config.environment?.trim().toLowerCase() === "sandbox"
      ? QUICKBOOKS_SANDBOX_BASE_URL
      : QUICKBOOKS_PRODUCTION_BASE_URL;

  const callbackUrl = (): string | null =>
    appBaseUrl === null ? null : new URL(CALLBACK_PATH, appBaseUrl).toString();

  const requireSecret = (): string => {
    if (clientId === null || clientSecret === null) {
      throw new Error("QuickBooks client credentials are not configured");
    }
    return clientSecret;
  };

  /**
   * A client whose token is good for the next call.
   *
   * The refreshed pair is stored *before* the client is handed back, because
   * Intuit rotates the refresh token on use: a crash between the refresh and
   * the write leaves a connection that cannot be refreshed and cannot be told
   * apart from one the operator revoked.
   */
  const authorizedClient = async (): Promise<QuickBooksClient | null> => {
    const connection = await store.readConnection();
    if (connection === null) return null;
    const now = options.now();
    let accessToken = connection.accessToken;
    if (accessTokenNeedsRefresh(connection, now)) {
      const refreshed = await refreshAccessToken({
        clientId: clientId ?? "",
        clientSecret: requireSecret(),
        refreshToken: connection.refreshToken,
        fetch: options.fetch,
        now,
      });
      await store.saveTokens({
        realmId: connection.realmId,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        refreshTokenExpiresAt: refreshed.refreshTokenExpiresAt,
        now: now.toISOString(),
      });
      accessToken = refreshed.accessToken;
    }
    return new QuickBooksClient({
      realmId: connection.realmId,
      accessToken,
      fetch: options.fetch,
      baseUrl,
    });
  };

  const status = (connection: {
    realmId: string;
    companyName: string | null;
    scope: string;
    allowOnlinePayment: boolean;
    connectedAt: string;
  }): QuickBooksConnectionStatus => ({
    realmId: connection.realmId,
    companyName: connection.companyName,
    scope: connection.scope,
    allowOnlinePayment: connection.allowOnlinePayment,
    connectedAt: connection.connectedAt,
  });

  const mirror = async (invoiceId: number): Promise<MirrorOutcome> => {
    const connection = await store.readConnection();
    if (connection === null) {
      return { kind: "refused", reason: "QuickBooks is not connected" };
    }
    const invoice = await source.readInvoice(invoiceId);
    if (invoice === null) {
      return { kind: "refused", reason: "the invoice no longer exists" };
    }
    const client = await authorizedClient();
    if (client === null) {
      return { kind: "refused", reason: "QuickBooks is not connected" };
    }
    const clients = await source.readClients(invoice.clientId);
    return mirrorInvoice({
      invoice,
      clients,
      links: {
        readLink: async (kind, ezactoId) => {
          const link = await store.readLink({ realmId: connection.realmId, kind, ezactoId });
          return link === null
            ? null
            : { quickBooksId: link.quickBooksId, syncToken: link.syncToken };
        },
        saveLink: async (kind, ezactoId, link) => {
          await store.saveLink({
            realmId: connection.realmId,
            kind,
            ezactoId,
            quickBooksId: link.quickBooksId,
            syncToken: link.syncToken,
            now: options.now().toISOString(),
          });
        },
      },
      quickBooks: client,
      allowOnlinePayment: connection.allowOnlinePayment,
    });
  };

  const service: QuickBooksService = {
    clientId: () => clientId,
    callbackUrl,
    settingsUrl: () => SETTINGS_PATH,
    newState: options.newState ?? randomState,

    authorizeUrl: ({ state, redirectUri }) =>
      authorizeUrl({
        clientId: clientId ?? "",
        redirectUri,
        state,
        scopes: [QUICKBOOKS_ACCOUNTING_SCOPE],
      }),

    beginAuthorization: async ({ state, userId, redirectUri }) => {
      const now = options.now();
      await store.beginAuthorization({
        state,
        userId,
        redirectUri,
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + STATE_LIFETIME_MS).toISOString(),
      });
    },

    completeAuthorization: async ({ state, code, realmId }) => {
      const now = options.now();
      // Consumed first. Everything after this is done on behalf of a request
      // this instance actually started.
      const issued = await store.consumeAuthorization({ state, now: now.toISOString() });
      if (issued === null) {
        throw Object.assign(new Error("unknown or expired state"), { code: "state_unknown" });
      }
      const tokens = await exchangeAuthorizationCode({
        clientId: clientId ?? "",
        clientSecret: requireSecret(),
        redirectUri: issued.redirectUri,
        code,
        fetch: options.fetch,
        now,
      });
      // Asked for rather than assumed: it is the first real call on the new
      // token, so it proves the connection works before an operator is told it
      // does. A failure here is not fatal -- the name is decoration.
      let companyName: string | null = null;
      try {
        companyName = await new QuickBooksClient({
          realmId,
          accessToken: tokens.accessToken,
          fetch: options.fetch,
          baseUrl,
        }).companyName();
      } catch {
        companyName = null;
      }
      await store.saveConnection({
        realmId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
        scope: QUICKBOOKS_ACCOUNTING_SCOPE,
        connectedByUserId: issued.userId,
        companyName,
        now: now.toISOString(),
      });
      const saved = await store.readConnection();
      if (saved === null) throw new Error("the connection did not persist");
      return status(saved);
    },

    readStatus: async () => {
      const connection = await store.readConnection();
      return connection === null ? null : status(connection);
    },

    setAllowOnlinePayment: async (allow) => {
      await store.setAllowOnlinePayment({ allow, now: options.now().toISOString() });
    },

    disconnect: async () => {
      const connection = await store.readConnection();
      await store.disconnect({ now: options.now().toISOString() });
      // Told to Intuit as well as forgotten here. A local-only disconnect
      // leaves the grant standing on the operator's Intuit account, where it
      // reads as an app that still has access to their books.
      if (connection !== null && clientId !== null && clientSecret !== null) {
        try {
          await revokeConnection({
            clientId,
            clientSecret,
            token: connection.refreshToken,
            fetch: options.fetch,
          });
        } catch {
          // Already forgotten locally, which is what the operator asked for.
        }
      }
    },

    receiveWebhook: async ({ payload, signature }) => {
      if (verifierToken === null) {
        // Nothing can be verified, so nothing may be accepted. An unconfigured
        // deployment with a public endpoint is the case to fail closed on.
        return { accepted: false, reason: "no verifier token configured" };
      }
      if (!(await verifyWebhookSignature({ payload, signature, verifierToken }))) {
        return { accepted: false, reason: "signature did not match" };
      }
      const connection = await store.readConnection();
      const changes = parseWebhookNotification(payload);
      const now = options.now().toISOString();
      for (const change of changes) {
        // A delivery for a company we are not connected to is not ours to act
        // on, whatever it says.
        if (connection === null || change.realmId !== connection.realmId) continue;
        const lastUpdated = canonicalLastUpdated(change.lastUpdated);
        const claimed = await store.claimWebhookDelivery({
          realmId: change.realmId,
          entityName: change.name,
          entityId: change.id,
          operation: change.operation,
          lastUpdated,
          now,
        });
        if (!claimed) continue;

        const complete = (skippedReason?: string): Promise<void> =>
          store.completeWebhookDelivery({
            realmId: change.realmId,
            entityName: change.name,
            entityId: change.id,
            operation: change.operation,
            lastUpdated,
            now: options.now().toISOString(),
            ...(skippedReason === undefined ? {} : { skippedReason }),
          });

        if (change.name !== "Payment" || change.operation === "Delete") {
          await complete(`${change.name} ${change.operation} is not mirrored back`);
          continue;
        }
        const client = await authorizedClient();
        if (client === null) {
          await complete("QuickBooks is not connected");
          continue;
        }
        const payment = await client.readPayment(change.id);
        if (payment === null) {
          await complete("the payment no longer exists");
          continue;
        }
        const resolved = new Map<string, number | null>();
        for (const line of payment.Line ?? []) {
          for (const linked of line.LinkedTxn ?? []) {
            if (linked.TxnType !== "Invoice" || resolved.has(linked.TxnId)) continue;
            resolved.set(
              linked.TxnId,
              await source.ezactoInvoiceFor(change.realmId, linked.TxnId),
            );
          }
        }
        const ours = inboundPayments(payment, (id) => resolved.get(id) ?? null);
        for (const row of ours) {
          await source.recordPayment({
            invoiceId: row.ezactoInvoiceId,
            amountCents: row.amountCents,
            paidOn: row.paidOn,
            realmId: change.realmId,
            quickBooksPaymentId: row.quickBooksPaymentId,
          });
        }
        await complete(ours.length === 0 ? "no line settles an invoice we mirrored" : undefined);
      }
      return { accepted: true };
    },
  };

  return { service, mirror };
};

/**
 * The subscriber that mirrors an invoice when it becomes a real document.
 *
 * `invoice.sent` and nothing else. A draft is not a document of record -- it
 * can still be edited or thrown away -- and mirroring one would put an invoice
 * in somebody's books that they may never raise. A later edit to a sent invoice
 * arrives as its own `invoice.sent` when it is re-sent, which the mirror
 * handles as an update because the link already exists.
 *
 * Failures throw. The outbox retries, and the mirror is safe to retry: that is
 * what the adopt path and the link table are for.
 */
export const createQuickBooksMirrorSubscriber = (
  runtime: Readonly<QuickBooksRuntime>,
): {
  readonly id: "quickbooks_mirror";
  deliver(event: Readonly<{ eventType: string; aggregateType: string; aggregateId: number }>): Promise<void>;
} => ({
  id: "quickbooks_mirror",
  async deliver(event) {
    if (event.aggregateType !== "invoice" || event.eventType !== "invoice.sent") return;
    const outcome = await runtime.mirror(event.aggregateId);
    if (outcome.kind === "refused") {
      // A refusal is a decision, not a failure: no connection, or a document in
      // QuickBooks this mirror did not write. Retrying cannot change either, so
      // it is recorded rather than thrown -- the outbox would otherwise retry
      // it until it gave up and called a correct decision an error.
      return;
    }
  },
});
