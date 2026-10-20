/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  summarizeStaffPayments,
  type AllocatePayment,
  type ConfirmPaymentActuals,
  type PaymentActuals,
  type PaymentAllocation,
  type PaymentAllocationReport,
  type ReversePaymentAllocation,
  type StaffPaymentReport,
} from "@ezacto/core";
import { renderStaffPayments } from "../src/staff-payments/render.js";
import { createAllocationsController } from "../src/staff-payments/allocations-browser.js";

const ledger: StaffPaymentReport = {
  month: "2026-09",
  as_of: "2026-10-01",
  provider_settings: { default_provider: "wise", version: 0, events: [] },
  rows: [
    summarizeStaffPayments(
      { user_id: 2, name: "Person Two", active: true, wise_ready: true },
      "2026-09",
      [],
      "2026-10-01",
    ),
  ],
};
const allocation: PaymentAllocation = {
  id: "a1",
  payment_kind: "event",
  payment_id: "pay-1",
  user_id: 2,
  month: "2026-09",
  currency: "USD",
  scope: "entry",
  project_id: 7,
  project_name: "Atlas",
  entry_id: 31,
  seconds: 7200,
  rate_cents: 5000,
  amount_cents: 10000,
  state: "applied",
  reason: "Two hours",
  actor_id: 1,
  recorded_at: "2026-10-01T00:00:00.000Z",
};
const report: PaymentAllocationReport = {
  month: "2026-09",
  people: [
    {
      user_id: 2,
      name: "Person Two",
      currency: "USD",
      earned_cents: 20000,
      paid_cents: 10000,
      reserved_cents: 0,
      allocated_applied_cents: 10000,
      allocated_reserved_cents: 0,
      remaining_cents: 10000,
      projects: [
        {
          project_id: 7,
          project_name: "Atlas",
          earned_cents: 20000,
          applied_cents: 10000,
          reserved_cents: 0,
          remaining_cents: 10000,
          entries: [
            {
              entry_id: 31,
              spent_date: "2026-09-04",
              selected_seconds: 14400,
              rate_cents: 5000,
              reviewed_rounded_seconds: 14400,
              current_rounded_seconds: 3600,
              current_rate_cents: 6000,
              earned_cents: 20000,
              applied_cents: 10000,
              reserved_cents: 0,
              applied_seconds: 7200,
              reserved_seconds: 0,
              remaining_cents: 10000,
              remaining_seconds: 7200,
              source_changed: true,
              over_allocated: false,
            },
          ],
        },
      ],
      unallocated_payments: [],
      allocations: [allocation],
    },
  ],
};
// What getPaymentActuals proposes: the selection never exceeds the current hours.
const actuals: PaymentActuals = {
  month: "2026-09",
  currency: "USD",
  completed: true,
  people: [
    {
      user_id: 2,
      name: "Person Two",
      entries: [
        {
          entry_id: 31,
          project_id: 7,
          project_name: "Atlas",
          spent_date: "2026-09-04",
          rounded_seconds: 3600,
          cost_rate_cents: 6000,
          selected_seconds: 3600,
        },
      ],
    },
  ],
};
const text = () => document.body.textContent ?? "";
const buttons = () => [...document.querySelectorAll("button")];
const type = (selector: string, value: string): void => {
  const control = document.querySelector<HTMLTextAreaElement>(selector)!;
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
};
const mount = async (
  api: Parameters<typeof createAllocationsController>[1],
) => {
  document.body.innerHTML = renderStaffPayments("staff-payments");
  const page = document.querySelector<HTMLElement>(
    "[data-staff-payments-page]",
  )!;
  const controller = createAllocationsController(
    page,
    api,
    (error) => (error as Error).message,
  );
  const active = new AbortController().signal;
  controller.activate(active);
  controller.ledger(ledger, active);
  document.querySelector<HTMLButtonElement>("[data-allocations-load]")!.click();
  await vi.waitFor(() =>
    expect(
      document.querySelector(
        '[aria-label="Review source change for entry 31"]',
      ),
    ).not.toBeNull(),
  );
};
const calls: string[] = [];
const fakes = () => ({
  getPaymentAllocationReport: vi.fn(async () => report),
  reversePaymentAllocation: vi.fn<
    (c: ReversePaymentAllocation) => Promise<void>
  >(async (c) => void calls.push(`reverse ${c.allocation_id}`)),
  getPaymentActuals: vi.fn(async () => actuals),
  confirmPaymentActuals: vi.fn<(c: ConfirmPaymentActuals) => Promise<void>>(
    async () => void calls.push("confirm"),
  ),
  allocatePayment: vi.fn<(c: AllocatePayment) => Promise<void>>(
    async (c) => void calls.push(`allocate ${c.payment_id}`),
  ),
});
beforeEach(() => {
  document.body.innerHTML = "";
  calls.length = 0;
});

describe("adjusting an allocation whose source time changed", () => {
  it("shows reviewed against current, then reverses, re-confirms and re-allocates in order within the current hours", async () => {
    const api = fakes();
    await mount(api);
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Review source change for entry 31"]',
      )!
      .click();
    for (const expected of [
      "Hours worked4.00001.0000",
      "RateUSD 50.00USD 60.00",
      "Hours selected for pay4.0000",
      "AllocatedUSD 100.00",
    ])
      expect(text()).toContain(expected);
    const go = buttons().find(
      (b) => b.textContent === "Reverse and re-allocate",
    )!;
    go.click();
    expect(text()).toContain("Explain the adjustment.");
    expect(api.reversePaymentAllocation).not.toHaveBeenCalled();
    type(
      '[aria-label="Adjustment reason for entry 31"]',
      "  Entry edited down  ",
    );
    go.click();
    await vi.waitFor(() =>
      expect(api.allocatePayment).toHaveBeenCalledTimes(1),
    );
    expect(calls).toEqual(["reverse a1", "confirm", "allocate pay-1"]);
    expect(api.reversePaymentAllocation.mock.calls[0]![0]).toMatchObject({
      allocation_id: "a1",
      reason: "Entry edited down",
    });
    expect(api.confirmPaymentActuals.mock.calls[0]![0]).toMatchObject({
      user_id: 2,
      month: "2026-09",
      expected_version: 0,
      currency: "USD",
      note: "Entry edited down",
      entries: actuals.people[0]!.entries,
    });
    // 7200 s were allocated; the entry now has 3600 s selected, so no more than that is re-allocated.
    expect(api.allocatePayment.mock.calls[0]![0]).toMatchObject({
      payment_kind: "event",
      payment_id: "pay-1",
      scope: "entry",
      project_id: 7,
      entry_id: 31,
      seconds: 3600,
      amount_cents: null,
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-allocations-status]")!.textContent,
      ).toContain("adjusted"),
    );
    expect(api.getPaymentAllocationReport).toHaveBeenCalledTimes(2);
  });

  it("retries with the same identifiers and the same commands after a failed step", async () => {
    const api = fakes();
    api.confirmPaymentActuals.mockRejectedValueOnce(
      new Error("The balance changed. Reload actuals before confirming."),
    );
    await mount(api);
    document
      .querySelector<HTMLButtonElement>(
        '[aria-label="Review source change for entry 31"]',
      )!
      .click();
    type('[aria-label="Adjustment reason for entry 31"]', "Entry edited down");
    const go = buttons().find(
      (b) => b.textContent === "Reverse and re-allocate",
    )!;
    go.click();
    await vi.waitFor(() => expect(text()).toContain("The balance changed."));
    expect(text()).toContain("steps already recorded are not repeated");
    expect(api.allocatePayment).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(go.disabled).toBe(false));
    go.click();
    await vi.waitFor(() =>
      expect(api.allocatePayment).toHaveBeenCalledTimes(1),
    );
    expect(api.reversePaymentAllocation).toHaveBeenCalledTimes(2);
    expect(api.reversePaymentAllocation.mock.calls[1]![0]).toEqual(
      api.reversePaymentAllocation.mock.calls[0]![0],
    );
    expect(api.confirmPaymentActuals).toHaveBeenCalledTimes(2);
    expect(api.confirmPaymentActuals.mock.calls[1]![0]).toEqual(
      api.confirmPaymentActuals.mock.calls[0]![0],
    );
  });

  it("offers no adjustment when a command it needs is unavailable", async () => {
    document.body.innerHTML = "";
    const api = fakes();
    // @ts-expect-error the adjustment needs every command; leave one out
    delete api.confirmPaymentActuals;
    document.body.innerHTML = renderStaffPayments("staff-payments");
    const page = document.querySelector<HTMLElement>(
      "[data-staff-payments-page]",
    )!;
    const controller = createAllocationsController(
      page,
      api,
      (error) => (error as Error).message,
    );
    const active = new AbortController().signal;
    controller.activate(active);
    controller.ledger(ledger, active);
    document
      .querySelector<HTMLButtonElement>("[data-allocations-load]")!
      .click();
    await vi.waitFor(() => expect(text()).toContain("Source time changed"));
    expect(
      document.querySelector(
        '[aria-label="Review source change for entry 31"]',
      ),
    ).toBeNull();
  });
});
