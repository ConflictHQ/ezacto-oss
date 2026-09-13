import { describe, expect, it, vi } from "vitest";
import {
  choosePayoutProfile,
  createWiseRuntime,
  type WiseGrantPort,
  type WisePayoutAccountPort,
} from "../src/wise/runtime.js";

/**
 * Issue 543. What actually happens when a contractor comes back from Wise's
 * consent screen: a state claimed, a code exchanged, a profile read, a grant
 * recorded, and a payout account linked and verified.
 *
 * The last of those is the one that matters. A grant recorded without a linked
 * account is a credential for an account nothing will ever pay into, and the
 * tests below are mostly about that pair never being left half-made.
 */

const NOW = new Date("2026-09-13T12:00:00.000Z");

const tokenResponse = {
  access_token: "access-one",
  refresh_token: "refresh-one",
  expires_in: 43_200,
};

const profilesResponse = [{ id: 41_000_001, type: "personal", details: { firstName: "R", lastName: "A" } }];

/** What the token endpoint was actually posted, for the redirect-URI test. */
const sent: string[] = [];

const transport = (
  overrides: {
    token?: unknown
    profiles?: unknown
    /** Raw, so a test can state digits a JS number literal cannot hold. */
    profilesBody?: string
    profilesStatus?: number
  } = {},
) =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/oauth/token")) {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify(overrides.token ?? tokenResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(overrides.profilesBody ?? JSON.stringify(overrides.profiles ?? profilesResponse), {
      status: overrides.profilesStatus ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

const grantPort = (overrides: Partial<WiseGrantPort> = {}): WiseGrantPort => ({
  readCurrent: vi.fn(async () => null),
  beginAuthorization: vi.fn(async () => undefined),
  claimState: vi.fn(async () => ({
    claim: "valid" as const,
    state: {
      requestedByUserId: 2,
      environment: "sandbox" as const,
      redirectUri: "https://time.example.test/api/v1/integrations/wise/callback",
    },
  })),
  record: vi.fn(async () => ({
    outcome: "granted" as const,
    grant: { id: 10, grantedAt: NOW.toISOString() },
  })),
  revoke: vi.fn(async () => true),
  ...overrides,
});

const accountPort = (overrides: Partial<WisePayoutAccountPort> = {}): WisePayoutAccountPort => ({
  listForUser: vi.fn(async () => []),
  link: vi.fn(async () => ({ outcome: "linked" as const, account: { id: 77 } })),
  markVerified: vi.fn(async () => undefined),
  ...overrides,
});

const runtime = (
  parts: {
    grants?: WiseGrantPort;
    accounts?: WisePayoutAccountPort;
    fetch?: typeof fetch;
    environment?: string;
    clientId?: string;
  } = {},
) => {
  const grants = parts.grants ?? grantPort();
  const accounts = parts.accounts ?? accountPort();
  return {
    grants,
    accounts,
    runtime: createWiseRuntime({
      config: {
        clientId: parts.clientId ?? "client-id",
        clientSecret: "client-secret",
        environment: parts.environment ?? "sandbox",
        appBaseUrl: "https://time.example.test",
        webhookPublicKey: undefined,
        // Sandbox has no default address any more; the suite states one.
        apiBase: "https://api.wise.example.test",
        authorizeUrl: "https://wise.example.test/oauth/authorize",
      },
      grants,
      accounts,
      fetch: (parts.fetch ?? transport()) as typeof fetch,
      now: () => NOW,
      newState: () => "state-value-0123456789",
    }),
  };
};

describe("which profile gets paid (#543)", () => {
  it("[money] prefers a business profile, which is the one with invoicing details", () => {
    const profiles = [
      { id: "1", type: "personal" as const, fullName: null },
      { id: "2", type: "business" as const, fullName: null },
    ];
    expect(choosePayoutProfile(profiles)?.id).toBe("2");
  });

  it("[unit] falls back to the only profile there is, and to none at all", () => {
    expect(choosePayoutProfile([{ id: "1", type: "personal", fullName: null }])?.id).toBe("1");
    expect(choosePayoutProfile([])).toBeNull();
  });
});

describe("starting an authorization (#543)", () => {
  it("[unit] records the state with a short life before sending anybody anywhere", async () => {
    const { runtime: wise, grants } = runtime();
    await wise.service.beginAuthorization({
      state: "state-value-0123456789",
      userId: 2,
      redirectUri: "https://time.example.test/api/v1/integrations/wise/callback",
    });
    expect(grants.beginAuthorization).toHaveBeenCalledWith({
      state: "state-value-0123456789",
      userId: 2,
      environment: "sandbox",
      redirectUri: "https://time.example.test/api/v1/integrations/wise/callback",
      now: "2026-09-13T12:00:00.000Z",
      // Ten minutes. A consent screen is answered in minutes; an hour-old state
      // is a link somebody kept.
      expiresAt: "2026-09-13T12:10:00.000Z",
    });
  });

  it("[unit] builds the callback off the app's own base URL", () => {
    const { runtime: wise } = runtime();
    expect(wise.service.callbackUrl()).toBe(
      "https://time.example.test/api/v1/integrations/wise/callback",
    );
  });

  it("[money] treats anything but an explicit sandbox as live", () => {
    // The safe way round: a live token against sandbox is refused loudly, where
    // a sandbox token against live looks like a payout that went nowhere.
    const { runtime: sandbox } = runtime({ environment: "Sandbox" });
    expect(
      sandbox.service.authorizeUrl({ state: "s", redirectUri: "https://x.example.test" }),
    ).toContain("wise.example.test");
    // Anything else is live, and live ignores the configured override entirely
    // rather than letting a stale sandbox address redirect real money.
    const { runtime: live } = runtime({ environment: "staging" });
    expect(
      live.service.authorizeUrl({ state: "s", redirectUri: "https://x.example.test" }),
    ).toContain("//wise.com");
  });
});

describe("coming back from the consent screen (#543)", () => {
  it("[money] links the profile Wise named and marks it verified", async () => {
    const { runtime: wise, accounts } = runtime();
    const result = await wise.service.completeAuthorization({
      state: "state-value-0123456789",
      code: "auth-code",
    });
    expect(result).toMatchObject({ outcome: "connected" });
    expect(accounts.link).toHaveBeenCalledWith({
      userId: 2,
      provider: "wise",
      externalId: "41000001",
      // Nobody attached this on their behalf.
      linkedByUserId: 2,
      now: "2026-09-13T12:00:00.000Z",
    });
    // The provider itself just confirmed the id resolves, which is the only way
    // verified_at is ever legitimately set.
    expect(accounts.markVerified).toHaveBeenCalledWith(77, "2026-09-13T12:00:00.000Z");
  });

  it("[money] stores the profile id as a string, not a rounded double", async () => {
    const { runtime: wise, grants } = runtime({
      // Raw text: writing this as a JS number literal would round it here, in
      // the fixture, and the test would pass against a client that also rounds.
      fetch: transport({
        profilesBody: '[{"id": 9007199254740993, "type": "personal"}]',
      }) as unknown as typeof fetch,
    });
    await wise.service.completeAuthorization({ state: "s", code: "c" });
    // A rounded profile id addresses somebody else.
    expect(grants.record).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "9007199254740993" }),
    );
  });

  it("[money] exchanges against the redirect URI the request was built with", async () => {
    // Not the one this deployment would build now. They differ where the app's
    // base URL changed mid-flow, and Wise checks the pair.
    const call = transport();
    const { runtime: wise } = runtime({
      fetch: call as unknown as typeof fetch,
      grants: grantPort({
        claimState: vi.fn(async () => ({
          claim: "valid" as const,
          state: {
            requestedByUserId: 2,
            environment: "sandbox" as const,
            redirectUri: "https://old.example.test/api/v1/integrations/wise/callback",
          },
        })),
      }),
    });
    await wise.service.completeAuthorization({ state: "s", code: "c" });
    expect(sent.at(-1)).toContain(
      encodeURIComponent("https://old.example.test/api/v1/integrations/wise/callback"),
    );
  });

  it("[unit] refuses a state nobody issued, and an expired one, differently", async () => {
    const unknown = runtime({
      grants: grantPort({ claimState: vi.fn(async () => ({ claim: "unknown" as const })) }),
    });
    expect(await unknown.runtime.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "state_unknown",
    });
    const expired = runtime({
      grants: grantPort({ claimState: vi.fn(async () => ({ claim: "expired" as const })) }),
    });
    expect(await expired.runtime.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "state_expired",
    });
  });

  it("[money] never exchanges a code for a state it did not claim", async () => {
    const call = transport();
    const { runtime: wise } = runtime({
      fetch: call as unknown as typeof fetch,
      grants: grantPort({ claimState: vi.fn(async () => ({ claim: "unknown" as const })) }),
    });
    await wise.service.completeAuthorization({ state: "s", code: "c" });
    expect(call).not.toHaveBeenCalled();
  });

  it("[money] says so where the authorization reaches no profile", async () => {
    const { runtime: wise, grants } = runtime({
      fetch: transport({ profiles: [] }) as unknown as typeof fetch,
    });
    expect(await wise.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "no_profile",
    });
    // A token with nothing to pay into is not worth storing.
    expect(grants.record).not.toHaveBeenCalled();
  });

  it("[money] takes the grant back out where the account cannot be linked", async () => {
    const { runtime: wise, grants } = runtime({
      accounts: accountPort({
        link: vi.fn(async () => ({ outcome: "external_id_taken" as const })),
      }),
    });
    expect(await wise.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "profile_taken",
    });
    // Otherwise the person holds a credential for an account nothing will pay.
    expect(grants.revoke).toHaveBeenCalledWith(2, "2026-09-13T12:00:00.000Z");
  });

  it("[money] re-verifies the account they already had, rather than linking a second", async () => {
    const { runtime: wise, accounts } = runtime({
      accounts: accountPort({
        listForUser: vi.fn(async () => [
          { id: 77, provider: "wise", externalId: "41000001", verifiedAt: null },
        ]),
      }),
    });
    expect(await wise.service.completeAuthorization({ state: "s", code: "c" })).toMatchObject({
      outcome: "connected",
    });
    expect(accounts.link).not.toHaveBeenCalled();
    expect(accounts.markVerified).toHaveBeenCalledWith(77, "2026-09-13T12:00:00.000Z");
  });

  it("[money] refuses to repoint an existing payout account at a different profile", async () => {
    // Repointing where money goes is not something a consent screen should be
    // able to do silently, and detaching is final.
    const { runtime: wise, grants, accounts } = runtime({
      accounts: accountPort({
        listForUser: vi.fn(async () => [
          { id: 77, provider: "wise", externalId: "41000999", verifiedAt: "2026-08-01T00:00:00.000Z" },
        ]),
      }),
    });
    expect(await wise.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "profile_taken",
    });
    expect(accounts.markVerified).not.toHaveBeenCalled();
    expect(grants.revoke).toHaveBeenCalledWith(2, "2026-09-13T12:00:00.000Z");
  });

  it("[unit] carries a grant refusal through rather than inventing one", async () => {
    const { runtime: wise } = runtime({
      grants: grantPort({ record: vi.fn(async () => ({ outcome: "already_connected" as const })) }),
    });
    expect(await wise.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "already_connected",
    });
  });

  it("[unit] refuses outright where the deployment has no Wise keys", async () => {
    const { runtime: wise, grants } = runtime({ clientId: "   " });
    expect(await wise.service.completeAuthorization({ state: "s", code: "c" })).toEqual({
      outcome: "exchange_failed",
    });
    expect(grants.claimState).not.toHaveBeenCalled();
  });
});

describe("the status a screen renders (#543)", () => {
  it("[money] is payable only where the linked account is verified", async () => {
    const grant = {
      id: 10,
      profileId: "41000001",
      profileType: "personal" as const,
      environment: "sandbox" as const,
      grantedAt: NOW.toISOString(),
    };
    const verified = runtime({
      grants: grantPort({ readCurrent: vi.fn(async () => grant) }),
      accounts: accountPort({
        listForUser: vi.fn(async () => [
          { id: 77, provider: "wise", externalId: "41000001", verifiedAt: NOW.toISOString() },
        ]),
      }),
    });
    expect(await verified.runtime.service.readStatus(2)).toMatchObject({ payable: true });

    // A link nobody checked is a claim, and paying against a claim is the
    // failure the whole seam exists to prevent.
    const unverified = runtime({
      grants: grantPort({ readCurrent: vi.fn(async () => grant) }),
      accounts: accountPort({
        listForUser: vi.fn(async () => [
          { id: 77, provider: "wise", externalId: "41000001", verifiedAt: null },
        ]),
      }),
    });
    expect(await unverified.runtime.service.readStatus(2)).toMatchObject({ payable: false });
  });

  it("[unit] is null where nobody has connected, not an empty connection", async () => {
    const { runtime: wise } = runtime();
    expect(await wise.service.readStatus(2)).toBeNull();
  });
});
