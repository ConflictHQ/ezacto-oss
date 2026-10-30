import { describe, expect, it } from "vitest";
import {
  buildContractorReview,
  type ContractorReviewSources,
} from "../src/contractor-review.js";
import { summarizeStaffPayments } from "../src/staff-payments.js";
import type { AdvanceCredit } from "../src/contractor-advances.js";
import type { StaffInvoice } from "../src/staff-invoices.js";

const month = "2026-09",
  now = "2026-10-01T12:00:00.000Z";
const credit = (overrides: Partial<AdvanceCredit> = {}): AdvanceCredit => ({
  advance_item_id: "advance-1",
  user_id: 2,
  name: "Contractor Two",
  currency: "USD",
  month,
  advance_project_id: null,
  advance_reason: "Explicit deposit",
  state: "paid",
  amount_cents: 5000,
  settled_cents: 5000,
  settled_at: "2026-09-01T12:00:00.000Z",
  applied_cents: 0,
  returned_cents: 0,
  reserved_cents: 0,
  available_cents: 5000,
  opening_cents: 0,
  period_settled_cents: 5000,
  period_applied_cents: 0,
  period_returned_cents: 0,
  closing_cents: 5000,
  applications: [],
  returns: [],
  ...overrides,
});
const invoice = (): StaffInvoice => ({
  id: 7,
  user_id: 2,
  month,
  currency: "USD",
  reference: "C-9",
  matched_cents: 10000,
  flags: [],
  line_flags: [[]],
  versions: [
    {
      command_id: "invoice-1",
      version: 1,
      month,
      currency: "USD",
      kind: "received",
      lines: [
        {
          description: "Work",
          project_id: 1,
          entry_id: 10,
          seconds: 7200,
          rate_cents: 5000,
        },
      ],
      amount_cents: 10000,
      review_id: "review-1",
      document_id: null,
      reason: "Received",
      actor_id: 1,
      recorded_at: now,
      paid_cents_at_recording: 0,
      has_payment_history: false,
    },
  ],
});
const fixture = (): ContractorReviewSources => {
  const entries = [
    {
      entry_id: 10,
      project_id: 1,
      project_name: "Project",
      spent_date: "2026-09-15",
      rounded_seconds: 7200,
      cost_rate_cents: 5000,
      selected_seconds: 7200,
    },
  ];
  return {
    actuals: {
      month,
      currency: "USD",
      completed: true,
      people: [{ user_id: 2, name: "Contractor Two", entries }],
    },
    earnings: {
      month,
      currency: "USD",
      completed: true,
      people: [
        {
          user_id: 2,
          name: "Contractor Two",
          proposed_cents: 10000,
          confirmed_cents: 10000,
          status: "converged",
          exceptions: [],
        },
      ],
    },
    ledger: {
      month,
      as_of: "2026-10-01",
      provider_settings: { default_provider: "wise", version: 0, events: [] },
      rows: [
        {
          ...summarizeStaffPayments(
            {
              user_id: 2,
              name: "Contractor Two",
              active: true,
              wise_ready: true,
            },
            month,
            [],
            "2026-10-01",
          ),
          is_contractor: true,
          amount_cents: 10000,
          currency: "USD",
          amount_basis: "ledger",
          paid_cents: 2000,
          reserved_cents: 1000,
          available_cents: 7000,
          balance_cents: 8000,
          status: "partial",
          version: 3,
        },
      ],
    },
    reviews: [
      {
        id: "review-1",
        user_id: 2,
        currency: "USD",
        amount_cents: 10000,
        expected_version: 0,
        actor_id: 1,
        note: "Reviewed actuals",
        recorded_at: now,
      },
    ],
    invoices: {
      month,
      people: [
        {
          user_id: 2,
          name: "Contractor Two",
          currency: "USD",
          earned_cents: 10000,
          paid_cents: 2000,
          invoiced_cents: 10000,
          matched_invoice_cents: 10000,
          uninvoiced_cents: 0,
          invoices: [invoice()],
        },
      ],
    },
    allocations: {
      month,
      people: [
        {
          user_id: 2,
          name: "Contractor Two",
          currency: "USD",
          earned_cents: 10000,
          paid_cents: 2000,
          reserved_cents: 1000,
          allocated_applied_cents: 0,
          allocated_reserved_cents: 0,
          remaining_cents: 7000,
          projects: [],
          allocations: [],
          unallocated_payments: [
            {
              payment_kind: "event",
              payment_id: "partial",
              amount_cents: 2000,
              allocated_cents: 0,
              unallocated_cents: 2000,
              state: "applied",
            },
            {
              payment_kind: "run_item",
              payment_id: "reserved",
              amount_cents: 1000,
              allocated_cents: 0,
              unallocated_cents: 1000,
              state: "reserved",
            },
          ],
        },
      ],
    },
    advances: { from: "2026-09-01", to: "2026-10-01", advances: [credit()] },
    runs: { from: month, to: month, ledgers: [], runs: [] },
  };
};
const reviewRow = (input: ContractorReviewSources) =>
  buildContractorReview(input).people[0]!.currencies.find(
    (row) => row.currency === "USD",
  )!;

describe("combined contractor review (#902)", () => {
  it("proposes monthly links and settled credit against remaining reviewed capacity, preserving actor/reason and invoices", () => {
    const source = fixture(),
      before = structuredClone(source);
    const review = buildContractorReview(source),
      person = review.people[0]!,
      row = person.currencies[0]!;
    expect(person.phase).toBe("review");
    expect(person.latest_review).toMatchObject({
      id: "review-1",
      actor_id: 1,
      note: "Reviewed actuals",
    });
    expect(row).toMatchObject({
      recorded_earnings_cents: 10000,
      paid_cents: 2000,
      reserved_cents: 1000,
      available_to_pay_cents: 7000,
      available_credit_cents: 5000,
      proposed_credit_cents: 5000,
      remaining_after_credit_cents: 2000,
      proposal_blocked: false,
    });
    expect(row.invoices[0]!.reference).toBe("C-9");
    expect(row.allocation_proposals).toEqual([
      {
        payment_kind: "event",
        payment_id: "partial",
        amount_cents: 2000,
        scope: "month",
      },
      {
        payment_kind: "run_item",
        payment_id: "reserved",
        amount_cents: 1000,
        scope: "month",
      },
    ]);
    expect(row.credit_proposals).toEqual([
      { advance_item_id: "advance-1", amount_cents: 5000, scope: "month" },
    ]);
    expect(review.version).toMatch(/^[a-f0-9]{64}$/u);
    expect(buildContractorReview(source)).toEqual(review);
    expect(source).toEqual(before);
  });
  it("does not count foreign or unconfirmed transfers as spendable credit", () => {
    const source = fixture();
    source.advances.advances.push(
      credit({
        advance_item_id: "eur",
        currency: "EUR",
        available_cents: 90000,
      }),
      credit({
        advance_item_id: "pending",
        state: "processing",
        available_cents: 20000,
      }),
    );
    const review = buildContractorReview(source),
      usd = review.people[0]!.currencies.find((row) => row.currency === "USD")!,
      eur = review.people[0]!.currencies.find((row) => row.currency === "EUR")!;
    expect(usd.available_credit_cents).toBe(5000);
    expect(usd.proposed_credit_cents).toBe(5000);
    expect(eur.available_credit_cents).toBe(90000);
    expect(eur.available_to_pay_cents).toBeNull();
    expect(eur.credit_proposals).toEqual([]);
    expect(review.people[0]!.phase).toBe("review");
  });
  it.each(["missing_rate", "changed_source"] as const)(
    "blocks proposals when current captured hours have %s",
    (code) => {
      const source = fixture();
      source.earnings.people[0]!.exceptions.push({ code, entry_ids: [10] });
      const review = buildContractorReview(source),
        row = review.people[0]!.currencies[0]!;
      expect(row.flags).toContain(code);
      expect(row.proposal_blocked).toBe(true);
      expect(row.credit_proposals).toEqual([]);
      expect(row.allocation_proposals).toEqual([]);
      expect(review.people[0]!.phase).toBe("attention");
    },
  );
  it.each([
    "incomplete",
    "unreviewed",
    "archived",
    "unavailable",
    "foreign_earnings",
  ] as const)("blocks monetary proposals for %s sources", (state) => {
    const source = fixture();
    if (state === "incomplete")
      source.actuals.completed = source.earnings.completed = false;
    if (state === "unreviewed") source.reviews = [];
    if (state === "archived") source.ledger.rows[0]!.active = false;
    if (state === "unavailable") source.ledger.rows[0]!.available_cents = null;
    if (state === "foreign_earnings") source.ledger.rows[0]!.currency = "EUR";
    const row = reviewRow(source);
    expect(row.proposal_blocked).toBe(true);
    expect(row.credit_proposals).toEqual([]);
    expect(row.allocation_proposals).toEqual([]);
  });
  it("preserves historical settlements and manual overrides without inventing earnings or reopening a month", () => {
    const source = fixture();
    source.ledger.rows[0]!.status = "settled";
    source.ledger.rows[0]!.settled_through = month;
    source.ledger.rows[0]!.amount_basis = "contractor_cost";
    let review = buildContractorReview(source);
    expect(review.people[0]!.phase).toBe("settled");
    expect(reviewRow(source)).toMatchObject({
      recorded_earnings_cents: null,
      available_to_pay_cents: null,
      proposed_credit_cents: 0,
    });
    source.ledger.rows[0]!.status = "partial";
    source.ledger.rows[0]!.amount_basis = "ledger";
    source.ledger.rows[0]!.amount_cents = 15000;
    source.ledger.rows[0]!.available_cents = 12000;
    source.advances.advances[0]!.available_cents = 15000;
    review = buildContractorReview(source);
    const row = review.people[0]!.currencies[0]!;
    expect(row.flags).toContain("earnings_override");
    expect(row.proposed_credit_cents).toBe(7000);
    expect(row.remaining_after_credit_cents).toBe(5000);
    expect(row.recorded_earnings_cents).toBe(15000);
  });
  it("respects advance month/project intent and retains amounts requiring explicit target review", () => {
    const source = fixture();
    source.advances.advances = [
      credit({ month: "2026-10" }),
      credit({ advance_item_id: "project-specific", advance_project_id: 1 }),
    ];
    const row = reviewRow(source);
    expect(row.available_credit_cents).toBe(10000);
    expect(row.credit_proposals).toEqual([]);
    expect(row.flags).toContain("advance_requires_target_review");
  });
  it("is independent of collection query order but changes its version when financial sources change", () => {
    const source = fixture();
    source.advances.advances.push(
      credit({
        advance_item_id: "older",
        settled_at: "2026-08-01T00:00:00.000Z",
      }),
    );
    const first = buildContractorReview(source);
    source.advances.advances.reverse();
    source.allocations.people[0]!.unallocated_payments.reverse();
    expect(buildContractorReview(source)).toEqual(first);
    source.ledger.rows[0]!.paid_cents++;
    expect(buildContractorReview(source).version).not.toBe(first.version);
  });
  it("fails closed on mismatched work-month sources or inexact financial totals", () => {
    const source = fixture();
    source.invoices.month = "2026-08";
    expect(() => buildContractorReview(source)).toThrow(/sources disagree/u);
    source.invoices.month = month;
    source.advances.advances = [
      credit({ available_cents: Number.MAX_SAFE_INTEGER }),
      credit({
        advance_item_id: "too-much",
        available_cents: Number.MAX_SAFE_INTEGER,
      }),
    ];
    expect(() => buildContractorReview(source)).toThrow(
      /exact supported range/u,
    );
  });
});

it("rejects an inexact ledger amount instead of returning a rounded financial review", () => {
  const source = fixture();
  source.ledger.rows[0]!.paid_cents = Number.MAX_SAFE_INTEGER + 1;
  expect(() => buildContractorReview(source)).toThrow(/exact supported range/u);
});
