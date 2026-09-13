/**
 * The Wise connection, assembled (issue 543).
 *
 * The routes in `@ezacto/api` know the shape of the handshake; the client in
 * `./oauth.js` knows Wise's wire format. This is the part in between: what
 * actually happens when a contractor comes back from the consent screen.
 *
 * Five steps, and the order is the whole of the design:
 *
 *   1. Claim the state. Single-use, and it is what says whose grant this is --
 *      Wise has never heard of our users, so the callback cannot name a person.
 *   2. Exchange the code for tokens.
 *   3. Ask Wise who just authorised. The profile id is the fact a payout
 *      follows; a name or an address is a guess, and #421 exists because the
 *      failure mode of guessing is paying the wrong person.
 *   4. Record the grant.
 *   5. Link the payout account, and mark it verified -- the provider itself
 *      just confirmed the id resolves, which is exactly what `verified_at`
 *      means and the only way it is ever legitimately set.
 *
 * Step 5 is what makes this a payout rather than a credential. A grant recorded
 * without it is a token for an account nothing will ever pay into, which is why
 * a failure there un-records the grant rather than leaving the pair half-made.
 */

import {
  exchangeWiseAuthorizationCode,
  fetchWiseProfiles,
  wiseAuthorizeUrl,
  wiseHosts,
  type WiseEnvironment,
  type WiseHosts,
  type WiseProfile,
} from "./oauth.js";
import {
  WISE_SANDBOX_WEBHOOK_PUBLIC_KEY,
  parseWiseEvent,
  payoutOutcomeFor,
  verifyWiseSignature,
} from "./webhook.js";

export interface WiseConnectionStatus {
  readonly profileId: string;
  readonly profileType: "personal" | "business";
  readonly environment: WiseEnvironment;
  readonly grantedAt: string;
  readonly payable: boolean;
}

export type WiseConnectRefusal =
  | "state_unknown"
  | "state_expired"
  | "already_connected"
  | "profile_taken"
  | "no_profile"
  | "exchange_failed";

export type WiseConnectOutcome =
  | { outcome: "connected"; status: WiseConnectionStatus }
  | { outcome: WiseConnectRefusal };

/**
 * What the runtime needs from the database, as two narrow ports.
 *
 * Two rather than one because they are two tables with two lifetimes, and a
 * single port would invite an implementation that writes them together and
 * loses the distinction.
 */
export interface WiseGrantPort {
  readCurrent(userId: number): Promise<{
    id: number;
    profileId: string;
    profileType: "personal" | "business";
    environment: WiseEnvironment;
    grantedAt: string;
  } | null>;
  beginAuthorization(input: {
    state: string;
    userId: number;
    environment: WiseEnvironment;
    redirectUri: string;
    now: string;
    expiresAt: string;
  }): Promise<void>;
  claimState(
    state: string,
    now: string,
  ): Promise<
    | {
        claim: "valid";
        state: { requestedByUserId: number; environment: WiseEnvironment; redirectUri: string };
      }
    | { claim: "expired" }
    | { claim: "unknown" }
  >;
  record(input: {
    userId: number;
    environment: WiseEnvironment;
    profileId: string;
    profileType: "personal" | "business";
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    now: string;
  }): Promise<
    | { outcome: "granted"; grant: { id: number; grantedAt: string } }
    | { outcome: "already_connected" | "profile_taken" | "unknown_user" }
  >;
  revoke(userId: number, now: string): Promise<boolean>;
}

export interface WisePayoutAccountPort {
  listForUser(
    userId: number,
  ): Promise<readonly { id: number; provider: string; externalId: string; verifiedAt: string | null }[]>;
  link(input: {
    userId: number;
    provider: "wise";
    externalId: string;
    linkedByUserId: number;
    now: string;
  }): Promise<
    | { outcome: "linked"; account: { id: number } }
    | { outcome: "already_linked" | "external_id_taken" | "unknown_user" }
  >;
  markVerified(id: number, now: string): Promise<unknown>;
}

export interface WiseConfig {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** `sandbox` reaches Wise's test accounts only; anything else moves real money. */
  readonly environment: string | undefined;
  readonly appBaseUrl: string | undefined;
  /**
   * The PEM Wise signs deliveries with.
   *
   * Configured rather than compiled in, because Wise rotates the live key and a
   * stale hard-coded one is a webhook that stops believing real events with no
   * deploy to explain it. Absent on sandbox means Wise's published sandbox key,
   * which never rotates quietly and is what the fixtures are signed with.
   * Absent on live means deliveries are refused: an unverifiable claim about
   * money is not one to act on because a key was not configured.
   */
  readonly webhookPublicKey: string | undefined;
  /**
   * Where Wise is, for a deployment that is not pointing at the live hosts.
   *
   * Both or neither. Live defaults to Wise's own; sandbox has no default at
   * all, because the sandbox this was written against was decommissioned and
   * guessing a replacement hostname is not a thing to do with money.
   */
  readonly apiBase: string | undefined;
  readonly authorizeUrl: string | undefined;
}

/**
 * The ledger and the payout log, as this runtime needs them.
 *
 * `claim` is first and is the arbiter: Wise retries anything it did not get a
 * 2xx for, and only the first caller for a delivery id may act.
 */
export interface WiseDeliveryPort {
  claim(input: {
    deliveryId: string;
    subscriptionId: string;
    eventType: string;
    transferId: string | null;
    currentState: string | null;
    occurredAt: string | null;
    now: string;
  }): Promise<{ claim: "fresh" } | { claim: "duplicate" }>;
  finish(deliveryId: string, now: string, skippedReason: string | null): Promise<void>;
  settleTransfer(input: {
    transferId: string;
    outcome: "sent" | "failed";
    failureReason: string | null;
    now: string;
  }): Promise<
    | { settled: "sent" | "failed"; transferId: string }
    | { settled: "none"; reason: string }
  >;
}

export interface WiseRuntimeOptions {
  readonly config: WiseConfig;
  readonly grants: WiseGrantPort;
  readonly accounts: WisePayoutAccountPort;
  /** Absent where a deployment does not receive webhooks; the route is then not mounted. */
  readonly deliveries?: WiseDeliveryPort;
  readonly fetch?: typeof fetch;
  readonly now: () => Date;
  /** Injected so a test can state the value rather than tolerate randomness. */
  readonly newState?: () => string;
}

const CALLBACK_PATH = "/api/v1/integrations/wise/callback";
const SETTINGS_PATH = "/settings/payouts";
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
 * Which profile to be paid into, where Wise returns more than one.
 *
 * A contractor with a business profile is asking to be paid as that business --
 * it is the one with the invoicing details attached, and it is the answer a
 * person who set one up expects. Personal otherwise. Where there are two of the
 * same kind Wise's own order decides, which is arbitrary but stable; guessing
 * from the name would be the same class of mistake as matching on an address.
 */
export const choosePayoutProfile = (
  profiles: readonly WiseProfile[],
): WiseProfile | null =>
  profiles.find((profile) => profile.type === "business") ?? profiles[0] ?? null;

export interface WiseRuntime {
  /** Absent unless a delivery port was supplied. */
  readonly webhook?: {
    receiveWebhook(input: {
      payload: string;
      signature: string | null;
      deliveryId: string | null;
      isTest: boolean;
    }): Promise<{ accepted: boolean }>;
  };
  readonly service: {
    clientId(): string | null;
    callbackUrl(): string | null;
    settingsUrl(): string;
    authorizeUrl(input: { state: string; redirectUri: string }): string;
    beginAuthorization(input: {
      state: string;
      userId: number;
      redirectUri: string;
    }): Promise<void>;
    completeAuthorization(input: { state: string; code: string }): Promise<WiseConnectOutcome>;
    readStatus(userId: number): Promise<WiseConnectionStatus | null>;
    disconnect(userId: number): Promise<boolean>;
    newState(): string;
  };
}

export const createWiseRuntime = (options: Readonly<WiseRuntimeOptions>): WiseRuntime => {
  const { config, grants, accounts } = options;
  const clientId = trimmed(config.clientId);
  const clientSecret = trimmed(config.clientSecret);
  const appBaseUrl = trimmed(config.appBaseUrl);
  // Anything but an explicit `sandbox` is live. A deployment that mistypes the
  // variable gets real money, which is the safe way round for a misconfiguration
  // to fail: a live token against sandbox is refused loudly, where a sandbox
  // token against live would look like a payout that silently went nowhere.
  const environment: WiseEnvironment =
    config.environment?.trim().toLowerCase() === "sandbox" ? "sandbox" : "live";
  const apiBase = trimmed(config.apiBase);
  const authorizeBase = trimmed(config.authorizeUrl);
  const hosts: WiseHosts | null = wiseHosts(
    environment,
    apiBase !== null && authorizeBase !== null
      ? { api: apiBase, authorize: authorizeBase }
      : undefined,
  );
  const newState = options.newState ?? randomState;
  const call = options.fetch ?? fetch;

  const callbackUrl = (): string | null =>
    appBaseUrl === null ? null : new URL(CALLBACK_PATH, appBaseUrl).toString();

  const instant = (): string => options.now().toISOString();

  /**
   * Whether a grant has something a payout can resolve to.
   *
   * A connection whose account is linked but unverified is not payable. That
   * pairing should not occur -- the callback verifies what it links -- but a
   * status that assumed so would turn an inconsistency into a payment.
   */
  const payable = async (userId: number, profileId: string): Promise<boolean> => {
    const linked = await accounts.listForUser(userId);
    return linked.some(
      (account) =>
        account.provider === "wise" &&
        account.externalId === profileId &&
        account.verifiedAt !== null,
    );
  };

  const status = async (
    userId: number,
    grant: { profileId: string; profileType: "personal" | "business"; environment: WiseEnvironment; grantedAt: string },
  ): Promise<WiseConnectionStatus> => ({
    profileId: grant.profileId,
    profileType: grant.profileType,
    environment: grant.environment,
    grantedAt: grant.grantedAt,
    payable: await payable(userId, grant.profileId),
  });

  /**
   * Wise's key for this environment.
   *
   * Sandbox falls back to the published key; live does not fall back at all. A
   * deployment that forgot to configure it refuses deliveries, which is the
   * right failure: an unverifiable claim about money should not be acted on
   * because a value was missing.
   */
  const webhookPublicKey =
    trimmed(config.webhookPublicKey) ??
    (environment === "sandbox" ? WISE_SANDBOX_WEBHOOK_PUBLIC_KEY : null);

  const deliveries = options.deliveries;

  /**
   * One delivery, start to finish.
   *
   * Order matters and is the whole of the correctness here: verify, then parse,
   * then claim, then act. Verifying last would mean parsing a forged body;
   * claiming last would let two concurrent retries both act, and settling a
   * payout twice is the failure the log exists to prevent.
   */
  const receiveWebhook = async (input: {
    payload: string;
    signature: string | null;
    deliveryId: string | null;
    isTest: boolean;
  }): Promise<{ accepted: boolean }> => {
    if (deliveries === undefined || webhookPublicKey === null) return { accepted: false };
    const verified = await verifyWiseSignature({
      body: input.payload,
      signature: input.signature,
      publicKeyPem: webhookPublicKey,
    });
    if (!verified) return { accepted: false };

    // Wise's ping when a subscription is created. Signed, so it proves the
    // endpoint and the key agree, which is the only thing it is for. Accepted
    // and not recorded: a test is not a fact about anybody's money.
    if (input.isTest) return { accepted: true };

    const event = parseWiseEvent(input.payload);
    // Signed by Wise and unreadable by us. Accepted, because a retry of
    // something we cannot parse will not parse the second time either.
    if (event === null) return { accepted: true };

    const now = instant();
    const transferId = event.kind === "transfer_state" ? event.transferId : null;
    // A delivery with no id of its own is keyed on the event's own identity,
    // which is stable across a retry for the same reason: a retry is the same
    // event again.
    const deliveryId =
      trimmed(input.deliveryId ?? undefined) ??
      [
        event.subscriptionId,
        event.kind === "transfer_state" ? "transfers#state-change" : event.eventType,
        transferId ?? "-",
        event.kind === "transfer_state" ? event.currentState : "-",
        event.occurredAt ?? "-",
      ].join("|");

    const claimed = await deliveries.claim({
      deliveryId,
      subscriptionId: event.subscriptionId,
      eventType: event.kind === "transfer_state" ? "transfers#state-change" : event.eventType,
      transferId,
      currentState: event.kind === "transfer_state" ? event.currentState : null,
      occurredAt: event.occurredAt,
      now,
    });
    // Told already. The right answer to a retry is 2xx and no further work.
    if (claimed.claim === "duplicate") return { accepted: true };

    if (event.kind !== "transfer_state") {
      await deliveries.finish(deliveryId, now, `event type ${event.eventType} is not acted on`);
      return { accepted: true };
    }

    const outcome = payoutOutcomeFor(event.currentState);
    if (outcome === null) {
      // In flight. Writing 'sent' here would mark money as moved while it is
      // still reversible, and a sent row cannot be corrected afterwards.
      await deliveries.finish(deliveryId, now, `state ${event.currentState} is not final`);
      return { accepted: true };
    }

    const settlement = await deliveries.settleTransfer({
      transferId: event.transferId,
      outcome,
      failureReason: outcome === "failed" ? `wise reported ${event.currentState}` : null,
      now,
    });
    await deliveries.finish(
      deliveryId,
      now,
      settlement.settled === "none" ? settlement.reason : null,
    );
    return { accepted: true };
  };

  return {
    ...(deliveries === undefined ? {} : { webhook: { receiveWebhook } }),
    service: {
      // A deployment whose Wise has no address is not configured, whatever
      // credentials it holds, and "not configured" is a thing the routes
      // already say clearly.
      clientId: () => (hosts === null ? null : clientId),
      callbackUrl,
      settingsUrl: () => SETTINGS_PATH,
      authorizeUrl: ({ state, redirectUri }) => {
        if (clientId === null) throw new Error("Wise client credentials are not configured");
        return wiseAuthorizeUrl({ clientId, redirectUri, state, environment, ...(hosts === null ? {} : { hosts }) });
      },
      beginAuthorization: async ({ state, userId, redirectUri }) => {
        const now = options.now();
        await grants.beginAuthorization({
          state,
          userId,
          environment,
          redirectUri,
          now: now.toISOString(),
          expiresAt: new Date(now.getTime() + STATE_LIFETIME_MS).toISOString(),
        });
      },

      completeAuthorization: async ({ state, code }) => {
        if (clientId === null || clientSecret === null) return { outcome: "exchange_failed" };
        const claimed = await grants.claimState(state, instant());
        if (claimed.claim !== "valid") {
          return { outcome: claimed.claim === "expired" ? "state_expired" : "state_unknown" };
        }
        const { requestedByUserId: userId, redirectUri } = claimed.state;

        // The redirect URI the authorization was built with, not the one this
        // deployment would build now. They differ where an operator changed the
        // app's base URL mid-flow, and Wise checks the pair.
        const tokens = await exchangeWiseAuthorizationCode({
          clientId,
          clientSecret,
          redirectUri,
          code,
          environment: claimed.state.environment,
          ...(hosts === null ? {} : { hosts }),
          fetchImplementation: call,
          now: options.now,
        });

        const profile = choosePayoutProfile(
          await fetchWiseProfiles({
            accessToken: tokens.accessToken,
            environment: claimed.state.environment,
            ...(hosts === null ? {} : { hosts }),
            fetchImplementation: call,
          }),
        );
        // An authorisation that reaches no profile is a token with nothing to
        // pay into. Saying so beats storing it and finding out on payday.
        if (profile === null) return { outcome: "no_profile" };

        const now = instant();
        const recorded = await grants.record({
          userId,
          environment: claimed.state.environment,
          profileId: profile.id,
          profileType: profile.type,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
          now,
        });
        if (recorded.outcome !== "granted") {
          return {
            outcome:
              recorded.outcome === "unknown_user" ? "state_unknown" : recorded.outcome,
          };
        }

        // The payout destination. A grant without one is a credential for an
        // account nothing will ever pay into, so a refusal here takes the grant
        // back out rather than leaving the pair half-made.
        const existing = (await accounts.listForUser(userId)).find(
          (account) => account.provider === "wise",
        );
        if (existing === undefined) {
          const linked = await accounts.link({
            userId,
            provider: "wise",
            externalId: profile.id,
            // Nobody attached this on their behalf. The person authorised it
            // themselves, which is the entire point of doing it by OAuth.
            linkedByUserId: userId,
            now,
          });
          if (linked.outcome !== "linked") {
            await grants.revoke(userId, now);
            return {
              outcome: linked.outcome === "external_id_taken" ? "profile_taken" : "state_unknown",
            };
          }
          await accounts.markVerified(linked.account.id, now);
        } else if (existing.externalId === profile.id) {
          // Reconnecting the account they already had. Verifying it again is
          // the honest record: Wise confirmed it resolves just now.
          await accounts.markVerified(existing.id, now);
        } else {
          // They authorised a different Wise profile than the one on file.
          // Repointing a payment destination is not something a consent screen
          // should be able to do silently, and detaching is final, so this is
          // refused and left for a person to resolve deliberately.
          await grants.revoke(userId, now);
          return { outcome: "profile_taken" };
        }

        return {
          outcome: "connected",
          status: await status(userId, {
            profileId: profile.id,
            profileType: profile.type,
            environment: claimed.state.environment,
            grantedAt: recorded.grant.grantedAt,
          }),
        };
      },

      readStatus: async (userId) => {
        const grant = await grants.readCurrent(userId);
        return grant === null ? null : status(userId, grant);
      },

      disconnect: async (userId) => grants.revoke(userId, instant()),

      newState,
    },
  };
};
