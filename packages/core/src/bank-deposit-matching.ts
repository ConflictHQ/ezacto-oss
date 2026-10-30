/**
 * Issue 101, contract slice: the provider-neutral shape of an inbound bank
 * deposit, the feed seam a Mercury or Wise adapter must satisfy, and the pure
 * matcher that turns a deposit into a suggestion. Nothing here reads or writes
 * storage, calls a provider, or confirms anything: a suggestion creates no
 * payment (docs/domain-model.md 2.16), and confirmation stays an explicit act.
 */
export interface NeutralDeposit {
  /** Unique within one provider account; the idempotency key for ingest. */
  provider_transaction_id: string;
  /** Upper-case ISO 4217 code of the credited balance. */
  currency: string;
  /** Canonical UTC timestamp, YYYY-MM-DDTHH:MM:SS(.f)Z. */
  posted_at: string;
  /** Positive: the feed carries credits only. */
  amount_cents: number;
  memo: string | null;
  counterparty: string | null;
}

/** Provider observations never grant confirmation by omission. */
export interface BankDepositObservation {
  status: 'final' | 'pending' | 'reversed' | 'ineligible' | 'unknown';
  classification: 'external_credit' | 'internal_transfer' | 'ambiguous_credit';
  reason?: string;
}
export interface BankFeedPage {
  deposits: NeutralDeposit[];
  /** May include previously seen IDs omitted from deposits to revoke eligibility. */
  observations?: Record<string, BankDepositObservation>;
  /** Opaque resume point; null when the feed has nothing newer. */
  cursor: string | null;
}

/**
 * Poll-first feed. Polling from the same cursor again must return the same
 * deposits with the same ids (replay-safe); the store, not the feed, dedupes.
 * Own outbound transfers on the same balance are never returned.
 */
export interface BankFeed {
  poll(cursor: string | null): Promise<BankFeedPage>;
}

export interface MatchCandidate {
  invoice_id: number;
  reference_token: string | null;
  currency: string;
  /** Amount still owed. */
  due_cents: number;
  /** YYYY-MM-DD the invoice was issued. */
  issue_date: string;
}

export type MatchBasis = "token_and_amount" | "token" | "amount_in_window";
export type MatchResult =
  | { state: "suggested"; invoice_id: number; basis: MatchBasis }
  | { state: "unmatched"; reason: "no_candidate" | "ambiguous" };

/** Days after issue within which an amount-only match is still plausible. */
export const AMOUNT_MATCH_WINDOW_DAYS = 90;

const TOKEN = /\bEZ-[0-9A-F]{12}\b/gi;
const MS_PER_DAY = 86_400_000;

export const isNeutralDeposit = (d: NeutralDeposit): boolean =>
  d.provider_transaction_id.length > 0 &&
  /^[A-Z]{3}$/.test(d.currency) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(d.posted_at) &&
  !Number.isNaN(Date.parse(d.posted_at)) &&
  Number.isSafeInteger(d.amount_cents) &&
  d.amount_cents >= 1 &&
  d.amount_cents <= 9_000_000_000_000;

const inWindow = (postedAt: string, issueDate: string): boolean => {
  const days =
    (Date.parse(postedAt) - Date.parse(`${issueDate}T00:00:00Z`)) / MS_PER_DAY;
  return days >= 0 && days <= AMOUNT_MATCH_WINDOW_DAYS;
};

/**
 * Rank 1 token plus exact amount, 2 token alone, 3 exact amount inside the
 * window. The best rank wins; two candidates tied at it leave the deposit
 * unmatched. A candidate of another currency is never considered.
 */
export const matchDeposit = (
  deposit: NeutralDeposit,
  candidates: readonly MatchCandidate[],
): MatchResult => {
  const tokens = new Set(
    (deposit.memo?.match(TOKEN) ?? []).map((t) => t.toUpperCase()),
  );
  const ranked: { rank: 1 | 2 | 3; invoice_id: number }[] = [];
  for (const c of candidates) {
    if (c.currency !== deposit.currency) continue;
    const token =
      c.reference_token !== null && tokens.has(c.reference_token.toUpperCase());
    const amount = c.due_cents === deposit.amount_cents;
    if (token && amount) ranked.push({ rank: 1, invoice_id: c.invoice_id });
    else if (token) ranked.push({ rank: 2, invoice_id: c.invoice_id });
    else if (amount && inWindow(deposit.posted_at, c.issue_date))
      ranked.push({ rank: 3, invoice_id: c.invoice_id });
  }
  if (ranked.length === 0)
    return { state: "unmatched", reason: "no_candidate" };
  const best = Math.min(...ranked.map((r) => r.rank));
  const top = ranked.filter((r) => r.rank === best);
  if (top.length > 1) return { state: "unmatched", reason: "ambiguous" };
  const basis: MatchBasis = (
    ["token_and_amount", "token", "amount_in_window"] as const
  )[best - 1]!;
  return { state: "suggested", invoice_id: top[0]!.invoice_id, basis };
};
