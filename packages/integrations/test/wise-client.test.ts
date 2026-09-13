import { describe, expect, it, vi } from "vitest";
import {
  choosePayingProfile,
  createWiseClient,
  WiseApiError,
  type WiseProfileSummary,
} from "../src/wise/client.js";

/**
 * Issue 543, after the app token replaced OAuth.
 *
 * The fixtures below are the shapes the live Wise API actually returns, read
 * back from a real account: profile `type` arrives UPPERCASE, recipient `type`
 * is CamelCase on v2, ids are JSON numbers, and `accountSummary` is the full
 * account number while `longAccountSummary` is the masked one.
 *
 * That last pair is the reason these tests exist in this shape. A field called
 * "summary" that is really a bank account number is the kind of thing a client
 * written from an assumption puts straight onto a screen.
 */

const PROFILES = JSON.stringify([
  { id: 22239672, type: "BUSINESS", fullName: "Example Firm LLC" },
  { id: 22239725, type: "PERSONAL", fullName: "A Person" },
]);

const RECIPIENTS = JSON.stringify([
  {
    id: 701234567,
    profileId: 22239672,
    currency: "USD",
    type: "Aba",
    active: true,
    ownedByCustomer: false,
    email: "contractor@example.test",
    name: { fullName: "R. Adeyemi", givenName: "R", familyName: "Adeyemi" },
    accountSummary: "(Chase) 123456789012",
    longAccountSummary: "ABA routing number ending in 9012",
    details: { accountNumber: "123456789012", bic: "EXAMPLEXXX" },
  },
  {
    id: 701234568,
    profileId: 22239672,
    currency: "USD",
    type: "SwiftCode",
    active: true,
    ownedByCustomer: true,
    email: null,
    name: { fullName: "Example Firm LLC" },
    accountSummary: "(Bank) 999888777666",
    longAccountSummary: "SWIFT account ending in 7666",
    details: { accountNumber: "999888777666" },
  },
]);

const transport = (body: string, status = 200) =>
  vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } }));

const client = (body: string, status = 200) => {
  const call = transport(body, status);
  return {
    call,
    wise: createWiseClient({ token: "token-value", fetchImplementation: call as unknown as typeof fetch }),
  };
};

describe("proving the token works (#543)", () => {
  it("[unit] reads profiles, keeping ids as text and types in their own case", async () => {
    const { wise } = client(PROFILES);
    expect(await wise.profiles()).toEqual([
      { id: "22239672", type: "business", name: "Example Firm LLC" },
      { id: "22239725", type: "personal", name: "A Person" },
    ]);
  });

  it("[security] sends the token as a bearer header, never in the URL", async () => {
    const { wise, call } = client(PROFILES);
    await wise.profiles();
    const [url, init] = call.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.wise.com/v2/profiles");
    expect(url).not.toContain("token-value");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer token-value");
  });

  it("[unit] carries the status, because 401 and 403 send an operator elsewhere", async () => {
    const { wise } = client("nope", 403);
    // A token that is wrong and a token that is right but not permitted are
    // different problems; "Wise refused" alone is not an answer.
    await expect(wise.profiles()).rejects.toThrow(WiseApiError);
    await expect(wise.profiles()).rejects.toThrow(/403/u);
  });
});

describe("which profile pays (#543)", () => {
  const profiles: readonly WiseProfileSummary[] = [
    { id: "1", type: "personal", name: "A Person" },
    { id: "2", type: "business", name: "Example Firm LLC" },
  ];

  it("[money] prefers business, because a personal balance is somebody's own money", () => {
    expect(choosePayingProfile(profiles)?.id).toBe("2");
  });

  it("[money] lets a configured id win, and refuses to fall back when it misses", () => {
    expect(choosePayingProfile(profiles, "1")?.id).toBe("1");
    // Falling back to the business profile here would pay out of an account the
    // operator did not name, which is the opposite of what naming one means.
    expect(choosePayingProfile(profiles, "9")).toBeNull();
  });

  it("[money] returns nothing rather than guessing where there is no business profile", () => {
    expect(choosePayingProfile([{ id: "1", type: "personal", name: null }])).toBeNull();
  });
});

describe("who we can pay (#543)", () => {
  it("[unit] reads recipients from v2, where the rails and the mask both live", async () => {
    const { wise, call } = client(RECIPIENTS);
    const recipients = await wise.recipients("22239672");
    expect((call.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.wise.com/v2/accounts?profileId=22239672",
    );
    expect(recipients[0]).toEqual({
      id: "701234567",
      holderName: "R. Adeyemi",
      currency: "USD",
      type: "Aba",
      maskedSummary: "ABA routing number ending in 9012",
      email: "contractor@example.test",
      active: true,
      ownedByUs: false,
    });
  });

  it("[security] never carries the full account number off the wire", async () => {
    // Wise's `accountSummary` is the whole account number despite the name, and
    // `details.accountNumber` is too. Neither is on the type, so neither can
    // reach a screen, a log or a row by accident.
    const { wise } = client(RECIPIENTS);
    const recipients = await wise.recipients("22239672");
    const serialised = JSON.stringify(recipients);
    expect(serialised).not.toContain("123456789012");
    expect(serialised).not.toContain("999888777666");
    expect(serialised).toContain("ending in 9012");
  });

  it("[money] says which accounts are our own rather than somebody we pay", async () => {
    const { wise } = client(RECIPIENTS);
    const recipients = await wise.recipients("22239672");
    expect(recipients.map((r) => r.ownedByUs)).toEqual([false, true]);
  });

  it("[money] keeps a recipient id past 2^53 intact", async () => {
    // Raw text: a JS number literal would round it in the fixture and the test
    // would pass against a client that also rounds. A rounded recipient id is
    // somebody else's bank account.
    const { wise } = client('[{"id":9007199254740993,"currency":"USD","type":"Aba","name":{}}]');
    expect((await wise.recipients("1"))[0]?.id).toBe("9007199254740993");
  });

  it("[unit] reads a paged response as well as a bare list", async () => {
    const { wise } = client(JSON.stringify({ content: JSON.parse(RECIPIENTS) }));
    expect(await wise.recipients("22239672")).toHaveLength(2);
  });
});
