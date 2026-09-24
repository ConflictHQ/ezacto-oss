import { describe, expect, it } from "vitest";
import {
  summarizeStaffPayments,
  validateStaffPayment,
  paymentMonthEnd,
  type StaffPaymentCommand,
  type StaffPaymentEvent,
} from "../src/staff-payments.js";
const person = {
  user_id: 2,
  name: "Fixture Person",
  active: true,
  wise_ready: false,
};
const today = "2026-09-24";
const command = (
  overrides: Partial<StaffPaymentCommand> = {},
): StaffPaymentCommand => ({
  id: "entry-1",
  user_id: 2,
  month: "2026-08",
  expected_version: 0,
  kind: "amount",
  amount_cents: 10000,
  currency: "USD",
  paid_on: null,
  due_on: "2026-09-01",
  reference: "",
  note: "Confirmed from monthly statement",
  payment_id: null,
  source: "historical",
  ...overrides,
});
const event = (
  overrides: Partial<StaffPaymentEvent> = {},
): StaffPaymentEvent => ({
  ...command(),
  version: 1,
  actor_id: 1,
  actor_name: "Administrator",
  recorded_at: `${today}T12:00:00Z`,
  request_id: "req-1",
  ...overrides,
});
const row = (events: StaffPaymentEvent[] = [], month = "2026-08") =>
  summarizeStaffPayments(person, month, events, today);

describe("staff payments accounting", () => {
  it("leaves September in progress and August pending without inventing a due date or amount", () => {
    expect(row([], "2026-09")).toMatchObject({
      status: "in_progress",
      overdue: false,
      amount_cents: null,
      balance_cents: null,
    });
    expect(row()).toMatchObject({ status: "pending", overdue: false });
    expect(paymentMonthEnd("2028-02")).toBe("2028-02-29");
  });
  it("keeps a historical Deel cutoff amountless and applies it only through its period", () => {
    const opening = event({
      kind: "opening",
      amount_cents: null,
      currency: null,
      due_on: null,
      note: "Settled in prior provider",
    });
    expect(row([opening], "2026-07")).toMatchObject({
      status: "settled",
      settled_through: "2026-08-31",
      amount_cents: null,
      balance_cents: null,
    });
    expect(row([opening], "2026-09").status).toBe("in_progress");
    expect(
      row([opening, { ...opening, month: "2026-09", id: "later" }])
        .settled_through,
    ).toBe("2026-09-30");
    expect(row([opening, event({ kind: "reopen", version: 2 })]).status).toBe(
      "pending",
    );
  });
  it("preserves exact obligations against a later blanket historical cutoff", () => {
    const opening = event({
      kind: "opening",
      month: "2026-09",
      amount_cents: null,
      currency: null,
    });
    expect(row([event(), opening])).toMatchObject({
      amount_cents: 10000,
      status: "pending",
    });
  });
  it("tracks partial payments, full settlement, and corrections without erasing history", () => {
    const due = event();
    const paid = event({
      id: "pay-1",
      kind: "payment",
      amount_cents: 4000,
      version: 2,
    });
    expect(row([due, paid])).toMatchObject({
      paid_cents: 4000,
      balance_cents: 6000,
      status: "partial",
      overdue: true,
    });
    const final = event({
      id: "pay-2",
      kind: "payment",
      amount_cents: 6000,
      version: 3,
    });
    expect(row([due, paid, final])).toMatchObject({
      paid_cents: 10000,
      balance_cents: 0,
      status: "paid",
      overdue: false,
    });
    const reversed = event({
      id: "void-1",
      kind: "void",
      payment_id: "pay-1",
      version: 4,
    });
    expect(row([due, paid, final, reversed])).toMatchObject({
      paid_cents: 6000,
      balance_cents: 4000,
      status: "partial",
    });
  });
  it("refuses overpayment, wrong currencies, duplicate references and stale versions", () => {
    const due = event();
    const payment = command({
      kind: "payment",
      expected_version: 1,
      due_on: null,
      paid_on: today,
      reference: "wise-123",
      source: "wise",
    });
    expect(() =>
      validateStaffPayment(payment, row([due]), today),
    ).not.toThrow();
    expect(() =>
      validateStaffPayment(
        { ...payment, amount_cents: 10001 },
        row([due]),
        today,
      ),
    ).toThrow(/exceeds/);
    expect(() =>
      validateStaffPayment({ ...payment, currency: "EUR" }, row([due]), today),
    ).toThrow(/currency/);
    expect(() =>
      validateStaffPayment(
        { ...payment, expected_version: 0 },
        row([due]),
        today,
      ),
    ).toThrow(/changed/);
    const partial = event({
      ...payment,
      amount_cents: 1000,
      version: 2,
      id: "paid-1",
    });
    expect(() =>
      validateStaffPayment(
        { ...payment, expected_version: 2, amount_cents: 1000 },
        row([due, partial]),
        today,
      ),
    ).toThrow(/reference/);
  });
  it("requires explicit exact amounts before payments, real dates, and a completed opening period", () => {
    const payment = command({
      kind: "payment",
      due_on: null,
      paid_on: today,
      reference: "wise-123",
    });
    expect(() => validateStaffPayment(payment, row(), today)).toThrow(
      /amount owed/,
    );
    expect(() =>
      validateStaffPayment(
        { ...payment, expected_version: 1, paid_on: "2026-02-30" },
        row([event()]),
        today,
      ),
    ).toThrow(/date/);
    expect(() =>
      validateStaffPayment(
        command({
          month: "2026-09",
          kind: "opening",
          amount_cents: null,
          currency: null,
          due_on: null,
        }),
        row([], "2026-09"),
        today,
      ),
    ).toThrow(/completed/);
  });
});
