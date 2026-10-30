import { describe, expect, it, vi } from "vitest";
import {
  createWiseRuntime,
  WiseReadOnlyError,
  type WiseConnectionMode,
  type WisePayoutAccountPort,
} from "../src/wise/runtime.js";

/**
 * Issue 1237: a tenant-owned token reads and never writes.
 *
 * Every provider call goes through a counted fixture transport, so "no provider
 * I/O" is a count of zero rather than an inference.
 */

const PROFILES = [{ id: "22239672", type: "BUSINESS", fullName: "Example Firm LLC" }];
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
];

const setup = (mode: WiseConnectionMode | undefined) => {
  const transport = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify(url.includes("/v2/profiles") ? PROFILES : RECIPIENTS), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  const accounts: WisePayoutAccountPort = {
    listForUser: vi.fn(async () => []),
    listForProvider: vi.fn(async () => []),
    awaitingDestination: vi.fn(async () => []),
    link: vi.fn(async () => ({ outcome: "linked" as const, account: { id: 77 } })),
    markVerified: vi.fn(async () => undefined),
    detach: vi.fn(async () => true),
  };
  const deliveries = { process: vi.fn(async () => undefined) };
  const { service } = createWiseRuntime({
    ...(mode === undefined ? {} : { mode }),
    config: { token: "tenant-token", profileId: undefined, webhookPublicKey: undefined },
    accounts,
    deliveries,
    fetch: transport as unknown as typeof fetch,
    now: () => new Date("2026-10-24T12:00:00.000Z"),
  });
  return { service, transport, accounts };
};

describe("Wise connection mode (issue 1237)", () => {
  it("[unit] defaults to full, so a deployment token behaves as before", async () => {
    const { service } = setup(undefined);
    expect(service.writable()).toBe(true);
    expect((await service.linkRecipient({ userId: 1, recipientId: "701234567", linkedByUserId: 2 })).outcome).toBe(
      "linked",
    );
  });

  it("[unit] read_only still reports status and masked recipients", async () => {
    const { service } = setup("read_only");
    expect(service.configured()).toBe(true);
    expect(service.writable()).toBe(false);
    expect(await service.readStatus()).toMatchObject({ profileId: "22239672", payableRecipients: 1 });
    const recipients = await service.listRecipients();
    expect(recipients).toHaveLength(1);
    expect(JSON.stringify(recipients)).not.toContain("123456789012");
  });

  it("[money] read_only refuses every write before any provider or store call", async () => {
    const { service, transport, accounts } = setup("read_only");
    const refusals = [
      service.linkRecipient({ userId: 1, recipientId: "701234567", linkedByUserId: 2 }),
      service.onboardRecipient({
        userId: 1,
        email: "a@example.test",
        legalName: "A Person",
        currency: "USD",
        linkedByUserId: 2,
      }),
      service.shareWiseProfile({ userId: 1, identifier: "@person", currency: "USD", linkedByUserId: 2 }),
      service.detachFor(1),
      service.unlink(5),
    ];
    for (const attempt of refusals) await expect(attempt).rejects.toBeInstanceOf(WiseReadOnlyError);
    expect(transport).not.toHaveBeenCalled();
    expect(accounts.link).not.toHaveBeenCalled();
    expect(accounts.detach).not.toHaveBeenCalled();
    expect(accounts.listForUser).not.toHaveBeenCalled();
  });

  it("[money] disabled performs no provider I/O even with a token present", async () => {
    const { service, transport } = setup("disabled");
    expect(service.configured()).toBe(false);
    expect(await service.readStatus()).toBeNull();
    expect(await service.listRecipients()).toEqual([]);
    expect(await service.proposeDestinations()).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });
});
