/** #902: one deterministic review over the existing immutable contractor ledgers.
 * This model proposes monthly allocations/credit applications. It authorizes no
 * write or transfer; the existing review/confirm/payment-run commands execute them. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  StaffPaymentError,
  validPaymentMonth,
  type StaffPaymentReport,
} from "./staff-payments.js";
import type { PaymentActuals } from "./payment-actuals.js";
import type {
  PaymentReconciliation,
  ProposedEarnings,
} from "./payment-reconciliation.js";
import type {
  PaymentAllocation,
  PaymentAllocationReport,
  UnallocatedPayment,
} from "./payment-allocations.js";
import type {
  AdvanceCredit,
  AdvanceCreditReport,
} from "./contractor-advances.js";
import type { StaffInvoice, StaffInvoiceReport } from "./staff-invoices.js";
import type { PaymentItemState, PaymentRunReport } from "./payment-runs.js";

export interface ContractorEarningsReview {
  id: string;
  user_id: number;
  currency: string;
  amount_cents: number;
  expected_version: number;
  actor_id: number;
  note: string;
  recorded_at: string;
}
export interface ContractorReviewSources {
  actuals: PaymentActuals;
  earnings: PaymentReconciliation;
  ledger: StaffPaymentReport;
  invoices: StaffInvoiceReport;
  allocations: PaymentAllocationReport;
  advances: AdvanceCreditReport;
  runs: PaymentRunReport;
  reviews: ContractorEarningsReview[];
}
export interface ContractorAllocationProposal {
  payment_kind: UnallocatedPayment["payment_kind"];
  payment_id: string;
  amount_cents: number;
  scope: "month";
}
export interface ContractorCreditProposal {
  advance_item_id: string;
  amount_cents: number;
  scope: "month";
}
export interface ContractorReviewItem {
  id: string;
  run_id: string;
  run_name: string;
  purpose: "earnings" | "advance";
  amount_cents: number;
  state: PaymentItemState;
  phase:
    | "draft"
    | "queued"
    | "processing"
    | "settled"
    | "failed"
    | "attention"
    | "cancelled";
  failure: string | null;
  attempts: number;
}
export interface ContractorCurrencyReview {
  currency: string;
  recorded_earnings_cents: number | null;
  proposed_earnings_cents: number | null;
  paid_cents: number;
  reserved_cents: number;
  available_to_pay_cents: number | null;
  available_credit_cents: number;
  proposed_credit_cents: number;
  remaining_after_credit_cents: number | null;
  invoices: StaffInvoice[];
  advances: AdvanceCredit[];
  allocations: PaymentAllocation[];
  allocation_proposals: ContractorAllocationProposal[];
  credit_proposals: ContractorCreditProposal[];
  items: ContractorReviewItem[];
  proposal_blocked: boolean;
  flags: string[];
}
export interface ContractorReviewPerson {
  user_id: number;
  name: string;
  active: boolean;
  ledger_version: number | null;
  settled_through: string | null;
  ledger_events: StaffPaymentReport["rows"][number]["events"];
  phase:
    "review" | "queued" | "processing" | "settled" | "failed" | "attention";
  latest_review: ContractorEarningsReview | null;
  earnings: ProposedEarnings | null;
  entries: PaymentActuals["people"][number]["entries"];
  currencies: ContractorCurrencyReview[];
}
export interface ContractorReview {
  month: string;
  completed: boolean;
  /** Exact financial/source state; clocks and query ordering do not change it. */
  version: string;
  credit_period: { from: string; to: string };
  people: ContractorReviewPerson[];
}
export interface ContractorReviewStore {
  review(month: string, now: string): Promise<ContractorReview>;
}
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const safeCents = (value: number): number => {
  if (!Number.isSafeInteger(value))
    throw new StaffPaymentError(
      "conflict",
      "A financial source exceeds the exact supported range. Review its records.",
    );
  return value;
};
const sumCents = (values: readonly number[]): number =>
  values.reduce((sum, value) => safeCents(sum + safeCents(value)), 0);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => textOrder(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};
const phase = (state: PaymentItemState): ContractorReviewItem["phase"] =>
  ["creating", "funding", "processing"].includes(state)
    ? "processing"
    : state === "paid"
      ? "settled"
      : (state as ContractorReviewItem["phase"]);

export const buildContractorReview = (
  source: Readonly<ContractorReviewSources>,
): ContractorReview => {
  const month = source.ledger.month;
  if (!validPaymentMonth(month))
    throw new StaffPaymentError("invalid", "Choose a valid work month.");
  if (
    [
      source.actuals.month,
      source.earnings.month,
      source.invoices.month,
      source.allocations.month,
      source.runs.from,
      source.runs.to,
    ].some((value) => value !== month) ||
    source.actuals.currency !== source.earnings.currency ||
    source.actuals.completed !== source.earnings.completed
  )
    throw new StaffPaymentError(
      "conflict",
      "The work-month sources disagree. Reload the contractor review.",
    );
  const ids = new Set<number>([
    ...source.ledger.rows
      .filter((row) => row.is_contractor === true)
      .map((row) => row.user_id),
    ...source.earnings.people.map((row) => row.user_id),
    ...source.reviews.map((row) => row.user_id),
    ...source.invoices.people
      .filter((row) => row.invoices.length > 0)
      .map((row) => row.user_id),
    ...source.advances.advances.map((row) => row.user_id),
  ]);
  const people = [...ids]
    .sort((a, b) => a - b)
    .map((user_id): ContractorReviewPerson => {
      const ledger = source.ledger.rows.find((row) => row.user_id === user_id);
      const earnings =
        source.earnings.people.find((row) => row.user_id === user_id) ?? null;
      const latest =
        source.reviews.find((row) => row.user_id === user_id) ?? null;
      const invoicePeople = source.invoices.people.filter(
        (row) => row.user_id === user_id,
      );
      const credits = source.advances.advances.filter(
        (row) => row.user_id === user_id,
      );
      const allocation = source.allocations.people.find(
        (row) => row.user_id === user_id,
      );
      const items = source.runs.runs.flatMap((run) =>
        run.items
          .filter((item) => item.user_id === user_id && item.month === month)
          .map((item) => ({ ...item, run_name: run.name })),
      );
      const active = ledger?.active === true && ledger.is_contractor === true;
      const currencies = new Set<string>([
        ...(earnings === null ? [] : [source.earnings.currency]),
        ...(ledger?.currency ? [ledger.currency] : []),
        ...invoicePeople.flatMap((row) =>
          row.currency === null ? [] : [row.currency],
        ),
        ...credits.map((row) => row.currency),
        ...(allocation?.allocations.map((row) => row.currency) ?? []),
        ...items.map((item) => item.currency),
      ]);
      const rows = [...currencies]
        .sort(textOrder)
        .map((currency): ContractorCurrencyReview => {
          const ownLedger = ledger?.currency === currency ? ledger : null;
          const ownAllocation =
            allocation?.currency === currency ? allocation : null;
          const ownCredits = credits
            .filter((row) => row.currency === currency)
            .sort(
              (a, b) =>
                textOrder(a.settled_at ?? "", b.settled_at ?? "") ||
                textOrder(a.advance_item_id, b.advance_item_id),
            );
          const invoices = invoicePeople
            .filter((row) => row.currency === currency)
            .flatMap((row) => row.invoices)
            .map((invoice) => ({
              ...invoice,
              versions: [...invoice.versions].sort(
                (a, b) => a.version - b.version,
              ),
            }))
            .sort((a, b) => a.id - b.id);
          const allocations = [...(allocation?.allocations ?? [])]
            .filter((row) => row.currency === currency)
            .sort((a, b) => textOrder(a.id, b.id));
          for (const amount of [
            ownLedger?.amount_cents,
            ownLedger?.paid_cents,
            ownLedger?.reserved_cents,
            ownLedger?.balance_cents,
            ownLedger?.available_cents,
            ownAllocation?.earned_cents,
            ownAllocation?.allocated_applied_cents,
            ownAllocation?.allocated_reserved_cents,
          ])
            if (amount !== null && amount !== undefined) safeCents(amount);
          const flags = new Set<string>();
          if (!source.actuals.completed) flags.add("incomplete_month");
          if (!active) flags.add("inactive_contractor");
          for (const exception of earnings?.exceptions ?? [])
            flags.add(exception.code);
          if (
            ledger?.currency &&
            earnings &&
            ledger.currency !== source.earnings.currency
          )
            flags.add("currency_mismatch");
          if (ownLedger?.status === "settled")
            flags.add("historical_settlement");
          if (
            !ownLedger ||
            ownLedger.amount_cents === null ||
            ownLedger.amount_basis !== "ledger"
          )
            flags.add("unconfirmed_earnings");
          if (!latest || latest.currency !== currency)
            flags.add("unreviewed_earnings");
          if (
            ownCredits.some(
              (credit) =>
                credit.state === "attention" ||
                credit.available_cents < 0 ||
                (["failed", "cancelled"].includes(credit.state) &&
                  credit.applications.some(
                    (application) => application.reversed_at === null,
                  )),
            )
          )
            flags.add("advance_attention");
          if (
            ownLedger &&
            latest &&
            ownLedger.currency === latest.currency &&
            ownLedger.amount_cents !== latest.amount_cents
          )
            flags.add("earnings_override");
          if (earnings?.status === "differs")
            flags.add("review_selection_override");
          if (
            ownAllocation?.projects.some((project) =>
              project.entries.some(
                (entry) => entry.source_changed || entry.over_allocated,
              ),
            )
          )
            flags.add("allocation_attention");
          for (const invoice of invoices)
            for (const flag of invoice.flags) flags.add(`invoice_${flag}`);
          if (
            ((ownLedger?.amount_cents ?? 0) > 0 ||
              (currency === source.earnings.currency &&
                (earnings?.proposed_cents ?? 0) > 0)) &&
            !invoices.some(
              (invoice) => invoice.versions.at(-1)?.kind === "received",
            )
          )
            flags.add("missing_received_invoice");
          if (
            ownCredits.some(
              (credit) =>
                credit.state === "paid" &&
                credit.available_cents > 0 &&
                (credit.month !== month || credit.advance_project_id !== null),
            )
          )
            flags.add("advance_requires_target_review");
          const available =
            ownLedger?.status === "settled" ||
            ownLedger?.amount_basis !== "ledger"
              ? null
              : ownLedger.available_cents !== undefined
                ? ownLedger.available_cents
                : ownLedger.balance_cents === null
                  ? null
                  : ownLedger.balance_cents - (ownLedger.reserved_cents ?? 0);
          if (available === null) flags.add("unavailable_balance");
          if (available !== null && available < 0)
            flags.add("overpaid_or_reserved");
          const availableCredit = sumCents(
            ownCredits.map((credit) =>
              credit.state === "paid" ? Math.max(0, credit.available_cents) : 0,
            ),
          );
          const blocked = [
            "incomplete_month",
            "inactive_contractor",
            "missing_rate",
            "changed_source",
            "currency_mismatch",
            "historical_settlement",
            "unconfirmed_earnings",
            "unreviewed_earnings",
            "allocation_attention",
            "advance_attention",
            "unavailable_balance",
            "overpaid_or_reserved",
          ].some((flag) => flags.has(flag));
          // Existing payments take their reviewed monthly capacity first. A credit
          // application consumes the same allocation capacity, never a second copy.
          let allocatable = blocked
            ? 0
            : Math.max(
                0,
                (ownAllocation?.earned_cents ?? 0) -
                  (ownAllocation?.allocated_applied_cents ?? 0) -
                  (ownAllocation?.allocated_reserved_cents ?? 0),
              );
          const allocationProposals: ContractorAllocationProposal[] = [];
          for (const payment of [
            ...(ownAllocation?.unallocated_payments ?? []),
          ].sort(
            (a, b) =>
              textOrder(a.payment_kind, b.payment_kind) ||
              textOrder(a.payment_id, b.payment_id),
          )) {
            const amount = Math.min(allocatable, payment.unallocated_cents);
            if (amount > 0)
              allocationProposals.push({
                payment_kind: payment.payment_kind,
                payment_id: payment.payment_id,
                amount_cents: amount,
                scope: "month",
              });
            allocatable -= amount;
          }
          let unpaid = blocked
            ? 0
            : Math.min(allocatable, Math.max(0, available ?? 0));
          const creditProposals: ContractorCreditProposal[] = [];
          for (const credit of ownCredits) {
            const compatible =
              credit.month === month && credit.advance_project_id === null;
            const amount = Math.min(
              unpaid,
              compatible && credit.state === "paid"
                ? Math.max(0, credit.available_cents)
                : 0,
            );
            if (amount > 0)
              creditProposals.push({
                advance_item_id: credit.advance_item_id,
                amount_cents: amount,
                scope: "month",
              });
            unpaid -= amount;
          }
          const proposedCredit = sumCents(
            creditProposals.map((proposal) => proposal.amount_cents),
          );
          if (available !== null) safeCents(available);
          if (
            ownLedger?.amount_cents !== null &&
            ownLedger?.amount_cents !== undefined
          )
            safeCents(ownLedger.amount_cents);
          if (earnings) safeCents(earnings.proposed_cents);
          return {
            currency,
            recorded_earnings_cents:
              ownLedger?.amount_basis === "ledger"
                ? ownLedger.amount_cents
                : null,
            proposed_earnings_cents:
              currency === source.earnings.currency
                ? (earnings?.proposed_cents ?? null)
                : null,
            paid_cents: ownLedger?.paid_cents ?? 0,
            reserved_cents: ownLedger?.reserved_cents ?? 0,
            available_to_pay_cents: available,
            available_credit_cents: availableCredit,
            proposed_credit_cents: proposedCredit,
            remaining_after_credit_cents:
              available === null
                ? null
                : Math.max(0, available) - proposedCredit,
            invoices,
            advances: ownCredits.map((credit) => ({
              ...credit,
              applications: [...credit.applications].sort((a, b) =>
                textOrder(a.id, b.id),
              ),
              returns: [...credit.returns].sort((a, b) =>
                textOrder(a.id, b.id),
              ),
            })),
            allocations,
            allocation_proposals: allocationProposals,
            credit_proposals: creditProposals,
            items: items
              .filter((item) => item.currency === currency)
              .map((item) => ({
                id: item.id,
                run_id: item.run_id,
                run_name: item.run_name,
                purpose: item.purpose ?? "earnings",
                amount_cents: item.amount_cents,
                state: item.state,
                phase: phase(item.state),
                failure: item.failure,
                attempts: item.attempts,
              }))
              .sort((a, b) => textOrder(a.id, b.id)),
            proposal_blocked: blocked,
            flags: [...flags].sort(textOrder),
          };
        });
      const relevant = rows.filter(
        (row) =>
          row.recorded_earnings_cents !== null ||
          row.proposed_earnings_cents !== null ||
          row.items.some((item) => item.purpose === "earnings"),
      );
      const itemPhases = relevant.flatMap((row) =>
        row.items
          .filter((item) => item.purpose === "earnings")
          .map((item) => item.phase),
      );
      const personPhase: ContractorReviewPerson["phase"] =
        ledger?.status === "settled"
          ? "settled"
          : relevant.some((row) => row.proposal_blocked) ||
              itemPhases.includes("attention")
            ? "attention"
            : itemPhases.includes("processing")
              ? "processing"
              : itemPhases.includes("queued")
                ? "queued"
                : itemPhases.includes("failed") &&
                    relevant.some(
                      (row) => (row.available_to_pay_cents ?? 0) > 0,
                    )
                  ? "failed"
                  : relevant.length > 0 &&
                      relevant.every(
                        (row) =>
                          row.available_to_pay_cents !== null &&
                          row.available_to_pay_cents <= 0,
                      )
                    ? "settled"
                    : "review";
      return {
        user_id,
        name:
          ledger?.name ??
          earnings?.name ??
          invoicePeople[0]?.name ??
          credits[0]?.name ??
          `Person ${user_id}`,
        active,
        phase: personPhase,
        ledger_version: ledger?.version ?? null,
        settled_through: ledger?.settled_through ?? null,
        ledger_events: [...(ledger?.events ?? [])].sort(
          (a, b) => a.version - b.version || textOrder(a.id, b.id),
        ),
        latest_review: latest,
        earnings:
          earnings === null
            ? null
            : {
                ...earnings,
                exceptions: earnings.exceptions
                  .map((exception) => ({
                    ...exception,
                    entry_ids: [...exception.entry_ids].sort((a, b) => a - b),
                  }))
                  .sort((a, b) => textOrder(a.code, b.code)),
              },
        entries: [
          ...(source.actuals.people.find((row) => row.user_id === user_id)
            ?.entries ?? []),
        ].sort((a, b) => a.entry_id - b.entry_id),
        currencies: rows,
      };
    });
  const result = { month, completed: source.actuals.completed, people };
  const version = bytesToHex(
    sha256(new TextEncoder().encode(JSON.stringify(canonical(result)))),
  );
  return {
    ...result,
    credit_period: { from: source.advances.from, to: source.advances.to },
    version,
  };
};
