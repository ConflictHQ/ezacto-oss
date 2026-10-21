/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from "vitest";
import {
  summarizeStaffPayments,
  type AdvanceCreditReport,
  type PaymentRun,
  type StaffPaymentReport,
} from "@ezacto/core";
import { renderStaffPayments } from "../src/staff-payments/render.js";
import {
  createAdvanceCreditsController,
  type AdvanceCreditsApi,
} from "../src/staff-payments/advances-browser.js";
const report: AdvanceCreditReport = {
  from: "2026-10-01",
  to: "2026-10-31",
  advances: [
    {
      advance_item_id: "item",
      user_id: 2,
      name: "Person Two",
      currency: "USD",
      month: "2026-09",
      advance_project_id: null,
      advance_reason: "Deposit before work",
      state: "paid",
      amount_cents: 15000,
      settled_cents: 15000,
      settled_at: "2026-08-01T12:00:00.000Z",
      applied_cents: 4000,
      returned_cents: 0,
      reserved_cents: 0,
      available_cents: 11000,
      opening_cents: 15000,
      period_settled_cents: 0,
      period_applied_cents: 4000,
      period_returned_cents: 0,
      closing_cents: 11000,
      applications: [
        {
          id: "application",
          advance_item_id: "item",
          user_id: 2,
          currency: "USD",
          month: "2026-09",
          amount_cents: 4000,
          scope: "month",
          project_id: null,
          entry_id: null,
          reason: "Reviewed work",
          actor_id: 1,
          recorded_at: "2026-10-01T12:00:00.000Z",
          reversed_at: null,
          reversal_reason: null,
        },
      ],
      returns: [],
    },
  ],
};
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
const run: PaymentRun = {
  id: "run",
  name: "Deposit",
  source_currency: "USD",
  scheduled_at: "2026-10-21T00:00:00.000Z",
  timezone: "UTC",
  state: "draft",
  actor_id: 1,
  approved_by: null,
  created_at: "2026-10-21T00:00:00.000Z",
  approved_at: null,
  request_id: "request",
  items: [
    {
      id: "item",
      run_id: "run",
      name: "Person Two",
      user_id: 2,
      month: "2026-09",
      expected_version: 0,
      purpose: "advance",
      advance_reason: "Deposit",
      advance_project_id: null,
      amount_cents: 15000,
      currency: "USD",
      destination: { id: 1, external_id: "456", kind: "account" },
      quote: {
        id: "quote",
        profile_id: "123",
        recipient_id: "456",
        recipient_name: "Person Two",
        source_currency: "USD",
        target_currency: "USD",
        source_cents: 15050,
        target_cents: 15000,
        fee_cents: 50,
        rate: 1,
        expires_at: "2026-10-21T01:00:00.000Z",
        estimated_arrival: null,
      },
      execution_quote: null,
      max_source_cents: 15050,
      state: "draft",
      transfer_id: null,
      provider_status: null,
      failure: null,
      attempts: 0,
      next_attempt_at: "2026-10-21T00:00:00.000Z",
      updated_at: "2026-10-21T00:00:00.000Z",
      version: 0,
      lease_token: null,
      lease_until: null,
    },
  ],
};
const byLabel = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const set = (label: string, value: string) => {
  const control = byLabel(label);
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
};
const submit = (control: HTMLElement) =>
  control
    .closest("form")!
    .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
const click = (text: string) =>
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent === text)!
    .click();
const mount = (api: AdvanceCreditsApi) => {
  document.body.innerHTML = renderStaffPayments("staff-payments");
  const active = new AbortController();
  const controller = createAdvanceCreditsController(
    document.querySelector("[data-staff-payments-page]")!,
    api,
    (error) => (error as Error).message,
  );
  controller.activate(active.signal);
  controller.ledger(ledger);
  return active;
};
beforeEach(() => {
  document.body.innerHTML = "";
});
it("requires transfer review and explicit approval of an advance, retaining review when its fee limit changes", async () => {
  const api = {
    previewPaymentRun: vi.fn(async () => run),
    approvePaymentRun: vi.fn(async () => run),
    getAdvanceCreditReport: vi.fn(async () => report),
  };
  mount(api);
  set("Advance amount", "150");
  set("Advance reason", "Deposit before work");
  submit(byLabel("Advance amount"));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Confirm advance transfer"),
  );
  expect(api.previewPaymentRun).toHaveBeenCalledWith(
    expect.objectContaining({
      items: [
        expect.objectContaining({
          purpose: "advance",
          currency: "USD",
          amount_cents: 15000,
          advance_reason: "Deposit before work",
        }),
      ],
    }),
    expect.any(AbortSignal),
  );
  expect(api.approvePaymentRun).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain(
    "credit becomes usable only after confirmed settlement",
  );
  set("Maximum source cost including fees", "151");
  click("Confirm advance transfer");
  await vi.waitFor(() =>
    expect(api.approvePaymentRun).toHaveBeenCalledWith(
      "run",
      { limits: [{ item_id: "item", max_source_cents: 15100 }] },
      expect.any(AbortSignal),
    ),
  );
});
it("shows carry-forward and applies only after choosing reviewed earnings and confirming the amount and reason", async () => {
  const applyAdvanceCredit = vi.fn(async () => {});
  const getPaymentAllocationReport = vi.fn(async () => ({
    month: "2026-09",
    people: [
      {
        user_id: 2,
        name: "Person Two",
        currency: "USD",
        earned_cents: 20000,
        paid_cents: 4000,
        reserved_cents: 0,
        remaining_cents: 16000,
        allocated_applied_cents: 4000,
        allocated_reserved_cents: 0,
        projects: [],
        allocations: [],
        unallocated_payments: [],
      },
    ],
  }));
  const api = {
    getAdvanceCreditReport: vi.fn(async () => report),
    getPaymentAllocationReport,
    applyAdvanceCredit,
  };
  const active = mount(api);
  submit(document.querySelector("[data-advance-period] button")!);
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Closing"),
  );
  expect(applyAdvanceCredit).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Opening + settled advances");
  submit(byLabel("Apply to reviewed work month"));
  await vi.waitFor(() => expect(byLabel("Credit to apply")).not.toBeNull());
  expect(getPaymentAllocationReport).toHaveBeenCalledWith(
    "2026-09",
    expect.any(AbortSignal),
  );
  set("Credit to apply", "40");
  set("Application reason", "Apply agreed deposit");
  byLabel(
    "I reviewed the earnings and want to apply credit without sending another payment",
  ).checked = true;
  submit(byLabel("Credit to apply"));
  await vi.waitFor(() => expect(applyAdvanceCredit).toHaveBeenCalledTimes(1));
  expect(applyAdvanceCredit).toHaveBeenCalledWith(
    expect.objectContaining({
      advance_item_id: "item",
      user_id: 2,
      currency: "USD",
      month: "2026-09",
      amount_cents: 4000,
      scope: "month",
      project_id: null,
      entry_id: null,
      reason: "Apply agreed deposit",
    }),
    expect.any(AbortSignal),
  );
  active.abort();
  expect(document.querySelector("[data-advance-content]")!.textContent).toBe(
    "",
  );
});
it("reverses credit applications with a reason and records only a confirmed return, without approving another transfer", async () => {
  const api = {
    getAdvanceCreditReport: vi.fn(async () => report),
    reverseAdvanceCredit: vi.fn(async () => {}),
    returnAdvanceCredit: vi.fn(async () => {}),
  };
  mount(api);
  submit(document.querySelector("[data-advance-period] button")!);
  await vi.waitFor(() =>
    expect(byLabel("Reason to reverse credit application")).not.toBeNull(),
  );
  set("Reason to reverse credit application", "Wrong period");
  submit(byLabel("Reason to reverse credit application"));
  await vi.waitFor(() =>
    expect(api.reverseAdvanceCredit).toHaveBeenCalledTimes(1),
  );
  await vi.waitFor(() =>
    expect(document.querySelector("[data-advance-status]")!.textContent).toBe(
      "",
    ),
  );
  await vi.waitFor(() =>
    expect(byLabel("Confirmed return amount")).not.toBeNull(),
  );
  set("Confirmed return amount", "10");
  set("Bank return reference", "bank-return");
  set("Return reason", "Unused deposit returned");
  byLabel(
    "I confirm these funds were already returned; this only records the return",
  ).checked = true;
  submit(byLabel("Confirmed return amount"));
  await vi.waitFor(() =>
    expect(api.returnAdvanceCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        advance_item_id: "item",
        amount_cents: 1000,
        reference: "bank-return",
        reason: "Unused deposit returned",
      }),
      expect.any(AbortSignal),
    ),
  );
});

it("explains why live advance transfers are withheld on the public demo", () => {
  document.documentElement.setAttribute("data-demo-deployment", "true");
  try {
    const api = { previewPaymentRun: vi.fn(async () => run), approvePaymentRun: vi.fn(async () => run) };
    mount(api);
    expect(document.querySelector("[data-advance-create]")!.textContent).toContain("not available on the public demo");
    expect(byLabel("Advance amount")).toBeNull();
    expect(api.previewPaymentRun).not.toHaveBeenCalled();
  } finally {
    document.documentElement.removeAttribute("data-demo-deployment");
  }
});
