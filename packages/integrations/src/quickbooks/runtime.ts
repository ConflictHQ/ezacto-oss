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
  discoverEndpoints,
  exchangeAuthorizationCode,
  inboundPayments,
  mirrorInvoice,
  mirrorPayment,
  parseWebhookNotification,
  receiptIdFromRefNumber,
  refreshAccessToken,
  revokeConnection,
  verifyWebhookSignature,
  type MirrorClient,
  type MirrorInvoice,
  type MirrorOutcome,
  type MirrorPayment,
  type MirrorPaymentOutcome,
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

export type QuickBooksMirrorOutcomeKind =
  | "created"
  | "updated"
  | "adopted"
  | "linked"
  | "refused"
  | "failed";

/**
 * What an invoice page can say about the mirror (issue 819): whether there is
 * a company to mirror into, what this invoice and its receipts became there,
 * and how the most recent attempt went -- success, refusal, or failure --
 * whether it ran from the outbox or from a pressed Sync.
 */
export interface QuickBooksInvoiceSyncState {
  readonly connected: boolean;
  readonly invoice: { readonly quickBooksId: string; readonly mirroredAt: string } | null;
  readonly payments: readonly {
    readonly paymentId: number;
    readonly quickBooksId: string;
    readonly mirroredAt: string;
  }[];
  readonly lastOutcome: {
    readonly kind: QuickBooksMirrorOutcomeKind;
    readonly reason: string | null;
    readonly at: string;
  } | null;
}

/** What a pressed Sync did: the invoice mirror, then one entry per receipt tried. */
export interface QuickBooksSyncResult {
  readonly invoice: MirrorOutcome;
  readonly payments: readonly {
    readonly paymentId: number;
    readonly outcome: MirrorPaymentOutcome;
  }[];
}

/** Likewise structural: what the routes call, without importing the routes. */
export interface QuickBooksService {
  clientId(): string | null;
  callbackUrl(): string | null;
  settingsUrl(): string;
  authorizeUrl(input: { state: string; redirectUri: string }): Promise<string>;
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
  /**
   * Mirrors the invoice and every receipt on it not yet mirrored, now, from a
   * button rather than the outbox (issue 819). Null where the invoice does not
   * exist, so the route can say 404 rather than mirror nothing and call it done.
   */
  sync(invoiceId: number): Promise<QuickBooksSyncResult | null>;
  syncState(invoiceId: number): Promise<QuickBooksInvoiceSyncState | null>;
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
  }): Promise<{ quickBooksId: string; syncToken: string; mirroredAt: string } | null>;
  saveLink(input: {
    realmId: string;
    kind: "customer" | "invoice";
    ezactoId: number;
    quickBooksId: string;
    syncToken: string;
    now: string;
  }): Promise<void>;
  readPaymentLink(input: {
    realmId: string;
    paymentId: number;
  }): Promise<{ quickBooksId: string; syncToken: string; mirroredAt: string } | null>;
  savePaymentLink(input: {
    realmId: string;
    paymentId: number;
    quickBooksId: string;
    syncToken: string;
    now: string;
  }): Promise<void>;
  /** The receipt of ours a QuickBooks payment was made from, where the mirror made it. */
  readPaymentLinkByQuickBooksId(input: {
    realmId: string;
    quickBooksId: string;
  }): Promise<{ paymentId: number } | null>;
  /** The latest attempt per invoice, overwritten every time (issue 819). */
  recordMirrorOutcome(input: {
    invoiceId: number;
    realmId: string | null;
    kind: QuickBooksMirrorOutcomeKind;
    reason: string | null;
    quickBooksId: string | null;
    now: string;
  }): Promise<void>;
  readMirrorOutcome(invoiceId: number): Promise<{
    kind: QuickBooksMirrorOutcomeKind;
    reason: string | null;
    quickBooksId: string | null;
    attemptedAt: string;
  } | null>;
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
 * The invoice as the source reads it: what the mirror sends, plus the state
 * that decides whether it is sent at all.
 */
export interface QuickBooksSourceInvoice extends MirrorInvoice {
  /** `draft`, `open`, `paid` or `closed`. Only the middle two are documents of record. */
  readonly state: string;
}

/** A receipt as the source reads it: what the mirror sends, plus where it came from. */
export interface QuickBooksSourcePayment extends MirrorPayment {
  /** The provider's own id for the receipt: for `quickbooks`, the QuickBooks payment. */
  readonly providerTransactionId: string | null;
  readonly recordedAt: string;
}

/**
 * Reading an invoice and the clients it hangs off, for the mirror.
 *
 * Narrow on purpose: the mirror needs an invoice and an ancestry, not the
 * money repository. Implemented against the database by the caller.
 */
export interface QuickBooksMirrorSource {
  readInvoice(invoiceId: number): Promise<QuickBooksSourceInvoice | null>;
  /** Every receipt on the invoice, whichever system recorded it (issue 819). */
  readPayments(invoiceId: number): Promise<readonly QuickBooksSourcePayment[]>;
  readClients(clientId: number): Promise<ReadonlyMap<number, MirrorClient>>;
  /** Our invoice id for a QuickBooks invoice id, for payments coming back. */
  ezactoInvoiceFor(realmId: string, quickBooksInvoiceId: string): Promise<number | null>;
  /**
   * Our invoice under that number, for a payment made in QuickBooks against
   * an invoice this mirror never linked (issue 853): the books hold every
   * invoice from before the mirror existed. Null where there is none, or
   * where it is not a document of record.
   */
  invoiceByNumber(number: string): Promise<{ id: number; amountCents: number } | null>;
  recordPayment(input: {
    invoiceId: number;
    amountCents: number;
    paidOn: string | null;
    realmId: string;
    /** QuickBooks' own id for the payment; the receipt's provider reference. */
    quickBooksPaymentId: string;
  }): Promise<QuickBooksPaymentRecording>;
}

/**
 * What recording a payment that came back from QuickBooks came to. Anything
 * but `recorded` wrote nothing, and the webhook delivery keeps the reason.
 * `exceeds_balance` is a payment larger than what the invoice still owes:
 * left unrecorded rather than overpaying the invoice, for a person to look at.
 */
export type QuickBooksPaymentRecording =
  | "recorded"
  | "already_recorded"
  | "invoice_not_payable"
  | "exceeds_balance";

/** Why a line of an inbound payment was not recorded, for the delivery's record. */
const notRecorded: Record<Exclude<QuickBooksPaymentRecording, "recorded">, string> = {
  already_recorded: "already recorded",
  invoice_not_payable: "the invoice cannot take a payment",
  exceeds_balance: "more than the invoice still owes, so not recorded; needs review",
};

/** The delivery's reason for a payment the mirror made from one of our receipts. */
const mirroredFromHere = (paymentId: number): string =>
  `the payment was mirrored from ezacto (payment ${String(paymentId)})`;

/** `skipped_reason` holds 255 characters; a reason is cut, not refused. */
const maximumSkippedReasonLength = 255;

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

/**
 * Why an invoice in this state is not mirrored, or null where it is. The
 * outbox only ever offered a sent invoice; a pressed Sync can name any invoice,
 * so the same rule is stated here rather than trusted to the button. A draft
 * can still be edited or thrown away, and a closed one was cancelled or
 * written off: neither is a receivable anybody should find in their books.
 */
const notADocumentOfRecord = (state: string): string | null => {
  if (state === "open" || state === "paid") return null;
  return state === "draft"
    ? "a draft is not mirrored until it is sent"
    : "a closed invoice is not mirrored";
};

export interface QuickBooksRuntime {
  readonly service: QuickBooksService;
  /** Mirrors one invoice, or says why it could not. Used by the outbox subscriber. */
  mirror(invoiceId: number): Promise<MirrorOutcome>;
  /**
   * Copies one payment recorded here onto the mirrored invoice, mirroring the
   * invoice first where it never was. Used by the same subscriber (issue 799).
   */
  mirrorPayment(input: {
    invoiceId: number;
    payment: MirrorPayment;
  }): Promise<MirrorPaymentOutcome>;
  /** The invoice, then every unmirrored receipt on it. What the Sync button runs. */
  sync(invoiceId: number): Promise<QuickBooksSyncResult | null>;
  syncState(invoiceId: number): Promise<QuickBooksInvoiceSyncState | null>;
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

  // Intuit's current OAuth endpoints, from its discovery document (cached an
  // hour; the published defaults when it cannot be read). Resolved per
  // operation so a token refresh in a long-lived isolate follows a move.
  const endpoints = () =>
    discoverEndpoints({
      fetch: options.fetch,
      now: options.now(),
      environment: config.environment,
    });

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
        endpoints: await endpoints(),
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

  /**
   * Every attempt leaves its outcome on the invoice, whichever way it went
   * (issue 819). An error is recorded as `failed` and rethrown, so the outbox
   * still retries it and the invoice page still says what happened meanwhile.
   */
  const recorded = async <Outcome extends MirrorPaymentOutcome>(
    invoiceId: number,
    attempt: () => Promise<Outcome>,
  ): Promise<Outcome> => {
    const realmId = (await store.readConnection())?.realmId ?? null;
    let outcome: Outcome;
    try {
      outcome = await attempt();
    } catch (error) {
      await store.recordMirrorOutcome({
        invoiceId,
        realmId,
        kind: "failed",
        // Bounded because the table bounds it: an Intuit fault can carry its
        // whole response body, and the row must land for the page to say so.
        reason: (error instanceof Error && error.message !== "" ? error.message : "unknown error").slice(0, 2000),
        quickBooksId: null,
        now: options.now().toISOString(),
      });
      throw error;
    }
    await store.recordMirrorOutcome({
      invoiceId,
      realmId,
      kind: outcome.kind,
      reason: outcome.kind === "refused" ? outcome.reason : null,
      quickBooksId: outcome.kind === "refused" ? null : outcome.quickBooksId,
      now: options.now().toISOString(),
    });
    return outcome;
  };

  /**
   * A payment made in QuickBooks against an invoice this mirror never linked
   * (issue 853). The books hold every invoice from before the mirror
   * existed, under our numbers; when the document's number is an open
   * invoice here and the totals agree to the cent, the link is written and
   * the receipt lands. The same rule as the mirror's own adoption, with the
   * same silence: nothing on the QuickBooks document changes.
   */
  const adoptByNumber = async (
    client: QuickBooksClient,
    realmId: string,
    quickBooksInvoiceId: string,
  ): Promise<number | null> => {
    const theirs = await client.readInvoice(quickBooksInvoiceId);
    if (theirs === null || theirs.DocNumber === undefined) return null;
    const ours = await source.invoiceByNumber(theirs.DocNumber);
    if (ours === null) return null;
    if (theirs.TotalAmt === undefined || Math.round(theirs.TotalAmt * 100) !== ours.amountCents) {
      return null;
    }
    await store.saveLink({
      realmId,
      kind: "invoice",
      ezactoId: ours.id,
      quickBooksId: theirs.Id,
      syncToken: theirs.SyncToken,
      now: options.now().toISOString(),
    });
    return ours.id;
  };

  const mirrorUnrecorded = async (invoiceId: number): Promise<MirrorOutcome> => {
    const connection = await store.readConnection();
    if (connection === null) {
      return { kind: "refused", reason: "QuickBooks is not connected" };
    }
    const invoice = await source.readInvoice(invoiceId);
    if (invoice === null) {
      return { kind: "refused", reason: "the invoice no longer exists" };
    }
    const notOfRecord = notADocumentOfRecord(invoice.state);
    if (notOfRecord !== null) return { kind: "refused", reason: notOfRecord };
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

  const mirror = (invoiceId: number): Promise<MirrorOutcome> =>
    recorded(invoiceId, () => mirrorUnrecorded(invoiceId));

  const mirrorPaymentUnrecorded = async (input: {
    invoiceId: number;
    payment: MirrorPayment;
  }): Promise<MirrorPaymentOutcome> => {
    const connection = await store.readConnection();
    if (connection === null) {
      return { kind: "refused", reason: "QuickBooks is not connected" };
    }
    // The invoice first, always. Where it was mirrored this is one link read;
    // where it never was -- sent before the connection existed, or refused
    // then -- the payment has nothing to settle until it is.
    const invoiceLink = await store.readLink({
      realmId: connection.realmId,
      kind: "invoice",
      ezactoId: input.invoiceId,
    });
    let invoiceQuickBooksId = invoiceLink?.quickBooksId ?? null;
    if (invoiceQuickBooksId === null) {
      const mirrored = await mirrorUnrecorded(input.invoiceId);
      if (mirrored.kind === "refused") return mirrored;
      invoiceQuickBooksId = mirrored.quickBooksId;
    }
    const client = await authorizedClient();
    if (client === null) {
      return { kind: "refused", reason: "QuickBooks is not connected" };
    }
    // The receipt names the customer the invoice is filed under in the books,
    // read from the document itself. The client's customer link is where new
    // invoices go; an adopted one may sit elsewhere -- Harvest filed one client
    // under a sub-customer per project -- and QuickBooks refuses (620) a
    // receipt whose customer is not the invoice's.
    const quickBooksInvoice = await client.readInvoice(invoiceQuickBooksId);
    if (quickBooksInvoice === null) {
      return {
        kind: "refused",
        reason: "QuickBooks no longer holds the invoice; it was deleted there since it was mirrored",
      };
    }
    const realmId = connection.realmId;
    return mirrorPayment({
      payment: input.payment,
      invoiceQuickBooksId,
      customerQuickBooksId: quickBooksInvoice.CustomerRef.value,
      links: {
        readPaymentLink: async (paymentId) => {
          const link = await store.readPaymentLink({ realmId, paymentId });
          return link === null
            ? null
            : { quickBooksId: link.quickBooksId, syncToken: link.syncToken };
        },
        savePaymentLink: async (paymentId, link) => {
          await store.savePaymentLink({
            realmId,
            paymentId,
            quickBooksId: link.quickBooksId,
            syncToken: link.syncToken,
            now: options.now().toISOString(),
          });
        },
      },
      quickBooks: client,
    });
  };

  /**
   * A receipt QuickBooks itself recorded reached us through the webhook, and
   * the mirror refuses to send it back. That refusal is the normal path for a
   * mirrored invoice a customer pays inside QuickBooks, not something the
   * invoice page should report as the last attempt, so it is answered without
   * touching the invoice's recorded outcome.
   */
  const mirrorPaymentOnto = (input: {
    invoiceId: number;
    payment: MirrorPayment;
  }): Promise<MirrorPaymentOutcome> =>
    input.payment.provider === "quickbooks"
      ? mirrorPaymentUnrecorded(input)
      : recorded(input.invoiceId, () => mirrorPaymentUnrecorded(input));

  /**
   * The Sync button (issue 819). The invoice first; a refusal there stops
   * everything, because a receipt has nothing to settle. Then each receipt this
   * instance recorded that has no QuickBooks payment yet. One that came *from*
   * QuickBooks is never sent back, and one already linked is left alone -- so a
   * second press, like a redelivered event, creates nothing.
   */
  const sync = async (invoiceId: number): Promise<QuickBooksSyncResult | null> => {
    if ((await source.readInvoice(invoiceId)) === null) return null;
    // Pressed on purpose against this invoice, so an invoice the books already
    // hold under our number is adopted rather than refused (issue 825). The
    // outbox's automatic mirror keeps refusing: nobody asked it to.
    const invoice = await recorded(invoiceId, () => mirrorUnrecorded(invoiceId));
    if (invoice.kind === "refused") return { invoice, payments: [] };
    const connection = await store.readConnection();
    const payments: { paymentId: number; outcome: MirrorPaymentOutcome }[] = [];
    for (const payment of await source.readPayments(invoiceId)) {
      if (payment.provider === "quickbooks") continue;
      const linked =
        connection === null
          ? null
          : await store.readPaymentLink({ realmId: connection.realmId, paymentId: payment.id });
      if (linked !== null) continue;
      payments.push({
        paymentId: payment.id,
        outcome: await mirrorPaymentOnto({ invoiceId, payment }),
      });
    }
    return { invoice, payments };
  };

  const syncState = async (invoiceId: number): Promise<QuickBooksInvoiceSyncState | null> => {
    if ((await source.readInvoice(invoiceId)) === null) return null;
    const outcome = await store.readMirrorOutcome(invoiceId);
    const lastOutcome =
      outcome === null
        ? null
        : { kind: outcome.kind, reason: outcome.reason, at: outcome.attemptedAt };
    const connection = await store.readConnection();
    if (connection === null) {
      return { connected: false, invoice: null, payments: [], lastOutcome };
    }
    const realmId = connection.realmId;
    const invoiceLink = await store.readLink({ realmId, kind: "invoice", ezactoId: invoiceId });
    const payments: { paymentId: number; quickBooksId: string; mirroredAt: string }[] = [];
    for (const payment of await source.readPayments(invoiceId)) {
      // A receipt QuickBooks recorded is in QuickBooks by definition: the
      // webhook brought it here, and its id is the provider's transaction id.
      if (payment.provider === "quickbooks") {
        if (payment.providerTransactionId !== null) {
          payments.push({
            paymentId: payment.id,
            quickBooksId: payment.providerTransactionId,
            mirroredAt: payment.recordedAt,
          });
        }
        continue;
      }
      const link = await store.readPaymentLink({ realmId, paymentId: payment.id });
      if (link === null) continue;
      payments.push({
        paymentId: payment.id,
        quickBooksId: link.quickBooksId,
        mirroredAt: link.mirroredAt,
      });
    }
    return {
      connected: true,
      invoice:
        invoiceLink === null
          ? null
          : { quickBooksId: invoiceLink.quickBooksId, mirroredAt: invoiceLink.mirroredAt },
      payments,
      lastOutcome,
    };
  };

  /** Whether a receipt of ours, not one QuickBooks recorded, is on an invoice those lines settle. */
  const isReceiptOn = async (
    receiptId: number,
    lines: readonly { readonly ezactoInvoiceId: number }[],
  ): Promise<boolean> => {
    for (const invoiceId of new Set(lines.map((line) => line.ezactoInvoiceId))) {
      const receipts = await source.readPayments(invoiceId);
      if (receipts.some((receipt) => receipt.id === receiptId && receipt.provider !== "quickbooks")) {
        return true;
      }
    }
    return false;
  };

  const service: QuickBooksService = {
    clientId: () => clientId,
    callbackUrl,
    settingsUrl: () => SETTINGS_PATH,
    newState: options.newState ?? randomState,

    authorizeUrl: async ({ state, redirectUri }) =>
      authorizeUrl({
        clientId: clientId ?? "",
        redirectUri,
        state,
        scopes: [QUICKBOOKS_ACCOUNTING_SCOPE],
        endpoints: await endpoints(),
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
        endpoints: await endpoints(),
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
        // Already null. The name is decoration, and failing to read it is not
        // a reason to refuse a connection that otherwise works.
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
            endpoints: await endpoints(),
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
        // One of our own receipts coming back. A payment recorded here --
        // Mark paid, or a provider's -- is copied into QuickBooks by
        // `mirrorPayment`, and QuickBooks then announces the payment it made
        // like any other. Recorded again, it settled the invoice a second time
        // and left it overpaid by the whole amount. `mirrorPayment` already
        // refuses the other direction; this is its counterpart. The link is
        // the mirror's record of what it made.
        const mirrored = await store.readPaymentLinkByQuickBooksId({
          realmId: change.realmId,
          quickBooksId: payment.Id,
        });
        if (mirrored !== null) {
          await complete(mirroredFromHere(mirrored.paymentId));
          continue;
        }
        const resolved = new Map<string, number | null>();
        for (const line of payment.Line ?? []) {
          for (const linked of line.LinkedTxn ?? []) {
            if (linked.TxnType !== "Invoice" || resolved.has(linked.TxnId)) continue;
            resolved.set(
              linked.TxnId,
              (await source.ezactoInvoiceFor(change.realmId, linked.TxnId)) ??
                (await adoptByNumber(client, change.realmId, linked.TxnId)),
            );
          }
        }
        const ours = inboundPayments(payment, (id) => resolved.get(id) ?? null);
        // The same receipt with its link not yet written: the mirror saves the
        // link once QuickBooks has answered the create, and a delivery can
        // overtake that write. The reference is on the payment from the
        // start, and names a receipt on the invoice the payment settles.
        const referenced = receiptIdFromRefNumber(payment.PaymentRefNum);
        if (referenced !== null && (await isReceiptOn(referenced, ours))) {
          await complete(mirroredFromHere(referenced));
          continue;
        }
        const refusals: string[] = [];
        for (const row of ours) {
          const recording = await source.recordPayment({
            invoiceId: row.ezactoInvoiceId,
            amountCents: row.amountCents,
            paidOn: row.paidOn,
            realmId: change.realmId,
            quickBooksPaymentId: row.quickBooksPaymentId,
          });
          if (recording !== "recorded") {
            refusals.push(`invoice ${String(row.ezactoInvoiceId)}: ${notRecorded[recording]}`);
          }
        }
        await complete(
          ours.length === 0
            ? "no line settles an invoice we mirrored"
            : refusals.length === 0
              ? undefined
              : refusals.join("; ").slice(0, maximumSkippedReasonLength),
        );
      }
      return { accepted: true };
    },

    sync,
    syncState,
  };

  return { service, mirror, mirrorPayment: mirrorPaymentOnto, sync, syncState };
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
  deliver(
    event: Readonly<{
      eventType: string;
      aggregateType: string;
      aggregateId: number;
      payload?: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<void>;
} => ({
  id: "quickbooks_mirror",
  async deliver(event) {
    if (event.aggregateType !== "invoice") return;
    if (event.eventType === "invoice.sent") {
      // A refusal is a decision, not a failure: no connection, or a document in
      // QuickBooks this mirror did not write. Retrying cannot change either, so
      // it is recorded rather than thrown -- the outbox would otherwise retry
      // it until it gave up and called a correct decision an error. The runtime
      // records every outcome, refusal included, on the invoice (issue 819), so
      // the invoice page can say why and offer Sync.
      await runtime.mirror(event.aggregateId);
      return;
    }
    // `payment.recorded` and only that: an edit or a deletion here has no
    // counterpart a mirror can be trusted to apply to somebody's books, and is
    // left to the bookkeeper with the link as their pointer (issue 799).
    if (event.eventType !== "payment.recorded") return;
    const payment = recordedPayment(event.payload);
    if (payment === null) return;
    // A receipt QuickBooks recorded came in through the webhook. It is already
    // in QuickBooks, so there is nothing to mirror and nothing to report.
    if (payment.provider === "quickbooks") return;
    await runtime.mirrorPayment({ invoiceId: event.aggregateId, payment });
  },
});

/**
 * The receipt as the event carries it: `payload.payment.after` is the
 * post-write snapshot the invoice command path emits with every payment event.
 * Anything short of that shape is not a payment this can copy, and is left.
 */
const recordedPayment = (
  payload: Readonly<Record<string, unknown>> | undefined,
): MirrorPayment | null => {
  const envelope = payload?.["payment"];
  if (typeof envelope !== "object" || envelope === null) return null;
  const after = (envelope as Record<string, unknown>)["after"];
  if (typeof after !== "object" || after === null) return null;
  const row = after as Record<string, unknown>;
  const id = row["id"];
  const amountCents = row["amount_cents"];
  const provider = row["provider"];
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(amountCents)) return null;
  if (typeof provider !== "string") return null;
  const paidDate = row["paid_date"];
  const paidAt = row["paid_at"];
  const paidOn =
    typeof paidDate === "string"
      ? paidDate
      : typeof paidAt === "string"
        ? paidAt.slice(0, 10)
        : null;
  return { id: id as number, amountCents: amountCents as number, provider, paidOn };
};
