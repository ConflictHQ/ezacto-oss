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
  type WiseEnvironment,
  type WiseProfile,
} from "./oauth.js";

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
}

export interface WiseRuntimeOptions {
  readonly config: WiseConfig;
  readonly grants: WiseGrantPort;
  readonly accounts: WisePayoutAccountPort;
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

  return {
    service: {
      clientId: () => clientId,
      callbackUrl,
      settingsUrl: () => SETTINGS_PATH,
      authorizeUrl: ({ state, redirectUri }) => {
        if (clientId === null) throw new Error("Wise client credentials are not configured");
        return wiseAuthorizeUrl({ clientId, redirectUri, state, environment });
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
          fetchImplementation: call,
          now: options.now,
        });

        const profile = choosePayoutProfile(
          await fetchWiseProfiles({
            accessToken: tokens.accessToken,
            environment: claimed.state.environment,
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
