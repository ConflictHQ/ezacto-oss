import { describe, expect, it, vi } from "vitest";
import {
  createWiseRuntime,
  type WisePayoutAccountPort,
} from "../src/wise/runtime.js";

/**
 * Issue 543, on the app token.
 *
 * The rule under all of this is unchanged from the OAuth pass it replaced: a
 * payout resolves to an identifier the provider gave us, never to a guess about
 * somebody's email address (#421). What changed is where the identifier comes
 * from -- a Wise recipient the organisation can actually pay, rather than a
 * profile the contractor authorised.
 */

const NOW = new Date("2026-09-13T12:00:00.000Z");

const PROFILES = [
  { id: "22239672", type: "BUSINESS", fullName: "Example Firm LLC" },
  { id: "22239725", type: "PERSONAL", fullName: "A Person" },
];

const RECIPIENTS = [
  {
    id: 701234567,
    currency: "USD",
    type: "Aba",
    active: true,
    ownedByCustomer: false,
    email: "contractor@example.test",
    name: { fullName: "R. Adeyemi" },
    accountSummary: "(Bank) 123456789012",
    longAccountSummary: "ABA routing number ending in 9012",
  },
  {
    id: 701234568,
    currency: "USD",
    type: "SwiftCode",
    active: true,
    // One of ours. Offering it as a payout destination would send money in a
    // circle.
    ownedByCustomer: true,
    name: { fullName: "Example Firm LLC" },
    longAccountSummary: "SWIFT account ending in 7666",
  },
  {
    id: 701234569,
    currency: "USD",
    type: "Aba",
    active: false,
    ownedByCustomer: false,
    name: { fullName: "Former Contractor" },
    longAccountSummary: "ABA routing number ending in 3333",
  },
];

const transport = () =>
  vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = url.includes("/v2/profiles") ? PROFILES : RECIPIENTS;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

const accountPort = (overrides: Partial<WisePayoutAccountPort> = {}): WisePayoutAccountPort => ({
  listForUser: vi.fn(async () => []),
  listForProvider: vi.fn(async () => []),
  link: vi.fn(async () => ({ outcome: "linked" as const, account: { id: 77 } })),
  markVerified: vi.fn(async () => undefined),
  detach: vi.fn(async () => true),
  ...overrides,
});

const runtime = (
  parts: {
    accounts?: WisePayoutAccountPort;
    token?: string | undefined;
    profileId?: string;
    webhookPublicKey?: string;
    fetch?: typeof fetch;
  } = {},
) => {
  const accounts = parts.accounts ?? accountPort();
  const call = parts.fetch ?? (transport() as unknown as typeof fetch);
  return {
    accounts,
    call,
    wise: createWiseRuntime({
      config: {
        token: "token" in parts ? parts.token : "token-value",
        profileId: parts.profileId,
        webhookPublicKey: parts.webhookPublicKey,
      },
      accounts,
      fetch: call,
      now: () => NOW,
    }),
  };
};

describe("the connection (#543)", () => {
  it("[unit] is configured by a token and nothing else", () => {
    expect(runtime().wise.service.configured()).toBe(true);
    expect(runtime({ token: undefined }).wise.service.configured()).toBe(false);
    expect(runtime({ token: "   " }).wise.service.configured()).toBe(false);
  });

  it("[money] pays from the business profile, not the personal one beside it", async () => {
    // A personal profile on the same login is the operator's own money. Paying
    // contractors out of it is a different act with different consequences.
    const status = await runtime().wise.service.readStatus();
    expect(status).toMatchObject({ profileId: "22239672", profileName: "Example Firm LLC" });
  });

  it("[money] lets a configured profile id win over the guess", async () => {
    const status = await runtime({ profileId: "22239725" }).wise.service.readStatus();
    expect(status?.profileId).toBe("22239725");
  });

  it("[unit] counts only the people it could actually pay", async () => {
    // Three recipients, of which one is ours and one is deactivated.
    const status = await runtime().wise.service.readStatus();
    expect(status?.payableRecipients).toBe(1);
  });

  it("[money] says when deliveries cannot be believed", async () => {
    // A connection that can send money and cannot be told what became of it is
    // a thing an operator should see before they rely on it.
    expect((await runtime().wise.service.readStatus())?.webhooksVerifiable).toBe(false);
    expect(
      (await runtime({ webhookPublicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----" })
        .wise.service.readStatus())?.webhooksVerifiable,
    ).toBe(true);
  });

  it("[unit] has no status and no webhook at all without a token", async () => {
    const { wise } = runtime({ token: undefined });
    expect(await wise.service.readStatus()).toBeNull();
    expect(wise.webhook).toBeUndefined();
  });
});

describe("who we can pay (#543)", () => {
  it("[money] leaves out our own accounts and the deactivated ones", async () => {
    const recipients = await runtime().wise.service.listRecipients();
    expect(recipients.map((r) => r.id)).toEqual(["701234567"]);
  });

  it("[security] never carries an account number, only the masked form", async () => {
    const recipients = await runtime().wise.service.listRecipients();
    const serialised = JSON.stringify(recipients);
    expect(serialised).not.toContain("123456789012");
    expect(serialised).toContain("ending in 9012");
  });
});

describe("linking a person to a destination (#543)", () => {
  it("[money] stores the id Wise confirmed, and marks it verified", async () => {
    const { wise, accounts } = runtime();
    const result = await wise.service.linkRecipient({
      userId: 2,
      recipientId: "701234567",
      linkedByUserId: 1,
    });
    expect(result).toMatchObject({ outcome: "linked" });
    expect(accounts.link).toHaveBeenCalledWith({
      userId: 2,
      provider: "wise",
      externalId: "701234567",
      linkedByUserId: 1,
      now: "2026-09-13T12:00:00.000Z",
    });
    // The recipient was read back from Wise before the link was made, which is
    // exactly what verified_at means: the provider says this id resolves.
    expect(accounts.markVerified).toHaveBeenCalledWith(77, "2026-09-13T12:00:00.000Z");
  });

  it("[money] refuses one of our own accounts, saying which kind of no it is", async () => {
    // Told apart from "does not exist" so an operator is not left hunting a
    // recipient that is sitting right there.
    const { wise, accounts } = runtime();
    expect(
      await wise.service.linkRecipient({ userId: 2, recipientId: "701234568", linkedByUserId: 1 }),
    ).toEqual({ outcome: "recipient_is_ours" });
    expect(accounts.link).not.toHaveBeenCalled();
  });

  it("[money] refuses a deactivated recipient rather than storing a dead destination", async () => {
    const { wise } = runtime();
    expect(
      await wise.service.linkRecipient({ userId: 2, recipientId: "701234569", linkedByUserId: 1 }),
    ).toEqual({ outcome: "recipient_inactive" });
  });

  it("[unit] refuses an id Wise has never heard of", async () => {
    const { wise } = runtime();
    expect(
      await wise.service.linkRecipient({ userId: 2, recipientId: "999", linkedByUserId: 1 }),
    ).toEqual({ outcome: "unknown_recipient" });
  });

  it("[money] carries the log's own refusals through unchanged in meaning", async () => {
    for (const [stored, expected] of [
      ["already_linked", "already_linked"],
      ["external_id_taken", "recipient_taken"],
      ["unknown_user", "unknown_user"],
    ] as const) {
      const { wise } = runtime({
        accounts: accountPort({ link: vi.fn(async () => ({ outcome: stored }) as never) }),
      });
      expect(
        await wise.service.linkRecipient({ userId: 2, recipientId: "701234567", linkedByUserId: 1 }),
        stored,
      ).toEqual({ outcome: expected });
    }
  });

  it("[unit] trims the id, because a pasted one arrives with whitespace", async () => {
    const { wise, accounts } = runtime();
    await wise.service.linkRecipient({
      userId: 2,
      recipientId: "  701234567  ",
      linkedByUserId: 1,
    });
    expect(accounts.link).toHaveBeenCalledWith(expect.objectContaining({ externalId: "701234567" }));
  });
});

describe("onboarding somebody we have never paid (#543)", () => {
  const CREATED = {
    id: 701234599,
    profile: 22239672,
    accountHolderName: "R. Adeyemi",
    currency: "USD",
    type: "email",
    active: true,
    ownedByCustomer: false,
    details: { email: "newcomer@example.test" },
  };

  /** Profiles, the recipient list, and the create call, told apart by path. */
  const onboardingTransport = () =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes("/v2/profiles")
        ? PROFILES
        : init?.method === "POST"
          ? CREATED
          : RECIPIENTS;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

  const onboarding = (accounts?: WisePayoutAccountPort) =>
    runtime({
      accounts: accounts ?? accountPort(),
      fetch: onboardingTransport() as unknown as typeof fetch,
    });

  const input = {
    userId: 7,
    email: "newcomer@example.test",
    legalName: "R. Adeyemi",
    currency: "USD",
    linkedByUserId: 1,
  };

  it("[money] creates the destination on the paying profile and links it, verified", async () => {
    const { wise, accounts, call } = onboarding();
    const result = await wise.service.onboardRecipient(input);
    expect(result).toEqual({
      outcome: "linked",
      recipient: {
        id: "701234599",
        holderName: "R. Adeyemi",
        currency: "USD",
        type: "email",
        maskedSummary: null,
        email: "newcomer@example.test",
        active: true,
        ownedByUs: false,
      },
    });
    // The business profile, not the personal one beside it -- the same choice
    // that decides which balance a payout leaves from.
    const created = (call as ReturnType<typeof onboardingTransport>).mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(JSON.parse(String(created?.[1]?.body)).profile).toBe("22239672");
    expect(accounts.link).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 7, provider: "wise", externalId: "701234599" }),
    );
    // Wise made it, so Wise says it resolves. That is what verified means here.
    expect(accounts.markVerified).toHaveBeenCalledWith(77, NOW.toISOString());
  });

  it("[money] asks whether they already have one before creating anything at Wise", async () => {
    // A recipient created here cannot be deleted from here. A second one for
    // somebody who already has a destination is a payout nobody will ever make.
    const { wise, call } = onboarding(
      accountPort({
        listForUser: vi.fn(async () => [
          { id: 12, provider: "wise", externalId: "701234567", verifiedAt: NOW.toISOString() },
        ]),
      }),
    );
    expect(await wise.service.onboardRecipient(input)).toEqual({ outcome: "already_linked" });
    const posts = (call as ReturnType<typeof onboardingTransport>).mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(0);
  });

  it("[money] names the recipient it made when the link does not take", async () => {
    // It exists at Wise by then. Reporting a bare failure would leave a
    // destination sitting in the account that nothing here knows about.
    const { wise } = onboarding(
      accountPort({ link: vi.fn(async () => ({ outcome: "external_id_taken" as const })) }),
    );
    const result = await wise.service.onboardRecipient(input);
    expect(result).toMatchObject({ outcome: "created_not_linked", refusal: "recipient_taken" });
    expect(result).toMatchObject({ recipient: { id: "701234599" } });
  });

  it("[security] asks Wise for an email recipient, which is why no rails reach us", async () => {
    // The whole of the onboarding decision. We send an email address; the
    // contractor fills their bank details in at Wise. Nothing here ever holds
    // an account number, so there is nothing to log, back up or leak.
    const { wise, call } = onboarding();
    await wise.service.onboardRecipient(input);
    const created = (call as ReturnType<typeof onboardingTransport>).mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    const body = JSON.parse(String(created?.[1]?.body));
    expect(body.type).toBe("email");
    expect(Object.keys(body.details)).toEqual(["email"]);
  });

  it("[unit] says so rather than creating anything where there is no token", async () => {
    const { wise } = runtime({ token: undefined });
    expect(await wise.service.onboardRecipient(input)).toEqual({ outcome: "not_configured" });
  });
});

describe("a contractor sharing their own Wise account (#543)", () => {
  const CONTACT = { contactId: "00000000-0000-4000-8000-000000000001", name: "R. Adeyemi" };

  /** Profiles, and the contact lookup, told apart by path. */
  const shareTransport = (contactStatus = 200) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/contacts")) {
        return new Response(
          JSON.stringify(
            contactStatus === 200
              ? CONTACT
              : { errors: [{ code: "request.not.valid", message: "not discoverable" }] },
          ),
          { status: contactStatus, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(url.includes("/v2/profiles") ? PROFILES : RECIPIENTS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

  const sharing = (accounts?: WisePayoutAccountPort, contactStatus = 200) =>
    runtime({
      accounts: accounts ?? accountPort(),
      fetch: shareTransport(contactStatus) as unknown as typeof fetch,
    });

  const input = {
    userId: 7,
    identifier: "@theirtag",
    currency: "USD",
    linkedByUserId: 7,
  };

  it("[money] stores the contact id, which is what survives them changing bank", async () => {
    const { wise, accounts } = sharing();
    expect(await wise.service.shareWiseProfile(input)).toEqual({
      outcome: "linked",
      contact: { id: CONTACT.contactId, name: "R. Adeyemi" },
    });
    expect(accounts.link).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 7,
        provider: "wise",
        externalId: CONTACT.contactId,
        // A contact id and a recipient account id are different id spaces.
        // Stored without saying which, a payout has to guess.
        kind: "contact",
      }),
    );
    // Wise resolved the identifier itself, so this is the provider's fact
    // rather than a claim somebody typed.
    expect(accounts.markVerified).toHaveBeenCalledWith(77, NOW.toISOString());
  });

  it("[unit] says not discoverable rather than failing, and links nothing", async () => {
    const { wise, accounts } = sharing(undefined, 422);
    expect(await wise.service.shareWiseProfile(input)).toEqual({ outcome: "not_discoverable" });
    expect(accounts.link).not.toHaveBeenCalled();
  });

  it("[money] refuses a second destination before it asks Wise anything", async () => {
    const { wise, call } = sharing(
      accountPort({
        listForUser: vi.fn(async () => [
          { id: 12, provider: "wise", externalId: "701234567", verifiedAt: NOW.toISOString() },
        ]),
      }),
    );
    expect(await wise.service.shareWiseProfile(input)).toEqual({ outcome: "already_linked" });
    const lookups = (call as ReturnType<typeof shareTransport>).mock.calls.filter(([url]) =>
      String(url).includes("/contacts"),
    );
    expect(lookups).toHaveLength(0);
  });

  it("[money] says when the tag belongs to somebody already being paid", async () => {
    // Two people on one destination means one is paid for the other's work.
    const { wise } = sharing(
      accountPort({ link: vi.fn(async () => ({ outcome: "external_id_taken" as const })) }),
    );
    expect(await wise.service.shareWiseProfile(input)).toEqual({ outcome: "recipient_taken" });
  });

  it("[security] sends the identifier and nothing about anybody's bank", async () => {
    const { wise, call } = sharing();
    await wise.service.shareWiseProfile(input);
    const lookup = (call as ReturnType<typeof shareTransport>).mock.calls.find(([url]) =>
      String(url).includes("/contacts"),
    );
    expect(JSON.parse(String(lookup?.[1]?.body))).toEqual({
      identifier: "@theirtag",
      targetCurrency: "USD",
    });
  });

  it("[unit] says so rather than looking anything up where there is no token", async () => {
    const { wise } = runtime({ token: undefined });
    expect(await wise.service.shareWiseProfile(input)).toEqual({ outcome: "not_configured" });
  });
});
