import { describe, expect, it } from "vitest";
import {
  isNeutralDeposit,
  matchDeposit,
  type BankFeed,
  type MatchCandidate,
  type NeutralDeposit,
} from "../src/bank-deposit-matching.js";

const deposit = (patch: Partial<NeutralDeposit> = {}): NeutralDeposit => ({
  provider_transaction_id: "tx-1",
  currency: "USD",
  posted_at: "2026-10-10T12:00:00Z",
  amount_cents: 100_000,
  memo: null,
  counterparty: null,
  ...patch,
});
const invoice = (
  id: number,
  patch: Partial<MatchCandidate> = {},
): MatchCandidate => ({
  invoice_id: id,
  reference_token: `EZ-${String(id).padStart(12, "0")}`,
  currency: "USD",
  due_cents: 100_000,
  issue_date: "2026-10-01",
  ...patch,
});

describe("matchDeposit", () => {
  it("suggests on token plus exact amount", () => {
    expect(
      matchDeposit(deposit({ memo: "Pay ez-000000000001 thanks" }), [
        invoice(1),
        invoice(2),
      ]),
    ).toEqual({ state: "suggested", invoice_id: 1, basis: "token_and_amount" });
  });
  it("suggests on token alone, ranked below token and amount", () => {
    const d = deposit({ memo: "EZ-000000000001", amount_cents: 5 });
    expect(matchDeposit(d, [invoice(1)])).toEqual({
      state: "suggested",
      invoice_id: 1,
      basis: "token",
    });
    const both = deposit({ memo: "EZ-000000000001 EZ-000000000002" });
    expect(
      matchDeposit(both, [invoice(1, { due_cents: 7 }), invoice(2)]),
    ).toMatchObject({
      invoice_id: 2,
      basis: "token_and_amount",
    });
  });
  it("suggests on amount inside the date window only", () => {
    expect(
      matchDeposit(deposit(), [invoice(1, { reference_token: null })]),
    ).toEqual({
      state: "suggested",
      invoice_id: 1,
      basis: "amount_in_window",
    });
    expect(
      matchDeposit(deposit(), [invoice(1, { issue_date: "2026-01-01" })]),
    ).toEqual({
      state: "unmatched",
      reason: "no_candidate",
    });
    expect(
      matchDeposit(deposit(), [invoice(1, { issue_date: "2026-10-11" })]),
    ).toEqual({
      state: "unmatched",
      reason: "no_candidate",
    });
  });
  it("leaves two equal candidates unmatched", () => {
    expect(matchDeposit(deposit(), [invoice(1), invoice(2)])).toEqual({
      state: "unmatched",
      reason: "ambiguous",
    });
  });
  it("leaves no candidate unmatched", () => {
    expect(matchDeposit(deposit(), [])).toEqual({
      state: "unmatched",
      reason: "no_candidate",
    });
  });
  it("never considers an invoice of another currency", () => {
    const d = deposit({ currency: "EUR", memo: "EZ-000000000001" });
    expect(matchDeposit(d, [invoice(1)])).toEqual({
      state: "unmatched",
      reason: "no_candidate",
    });
  });
});

describe("isNeutralDeposit", () => {
  it("accepts the canonical shape and rejects debits, bad currency and bad timestamps", () => {
    expect(isNeutralDeposit(deposit())).toBe(true);
    expect(isNeutralDeposit(deposit({ amount_cents: -5 }))).toBe(false);
    expect(isNeutralDeposit(deposit({ amount_cents: 0 }))).toBe(false);
    expect(isNeutralDeposit(deposit({ amount_cents: 1.5 }))).toBe(false);
    expect(isNeutralDeposit(deposit({ currency: "usd" }))).toBe(false);
    expect(isNeutralDeposit(deposit({ posted_at: "2026-10-10" }))).toBe(false);
    expect(isNeutralDeposit(deposit({ provider_transaction_id: "" }))).toBe(
      false,
    );
  });
});

/** Any real adapter (Mercury, Wise) must pass this against its recorded fixtures. */
export const bankFeedContract = (name: string, make: () => BankFeed) =>
  describe(`BankFeed contract: ${name}`, () => {
    it("returns only well-formed credits with unique ids", async () => {
      const { deposits } = await make().poll(null);
      expect(deposits.length).toBeGreaterThan(0);
      expect(deposits.every(isNeutralDeposit)).toBe(true);
      expect(new Set(deposits.map((d) => d.provider_transaction_id)).size).toBe(
        deposits.length,
      );
    });
    it("is replay-safe: the same cursor returns the same deposits", async () => {
      const feed = make();
      expect(await feed.poll(null)).toEqual(await feed.poll(null));
    });
    it("resumes after its cursor without repeating earlier deposits", async () => {
      const feed = make();
      const first = await feed.poll(null);
      const next = await feed.poll(first.cursor);
      const seen = new Set(
        first.deposits.map((d) => d.provider_transaction_id),
      );
      expect(
        next.deposits.some((d) => seen.has(d.provider_transaction_id)),
      ).toBe(false);
    });
  });

/** Fixture feed: the neutral shape a recorded provider payload must map to. */
const fakeFeed = (): BankFeed => {
  const all = [
    deposit({ provider_transaction_id: "a" }),
    deposit({ provider_transaction_id: "b", amount_cents: 2500 }),
  ];
  return {
    poll: async (cursor) =>
      cursor === null
        ? { deposits: all.slice(0, 1), cursor: "a" }
        : { deposits: all.slice(1), cursor: null },
  };
};
bankFeedContract("fake", fakeFeed);
