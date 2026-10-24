/** @vitest-environment happy-dom */
import { setSortPreferenceOwner } from "../src/components/table-sort.js";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { renderStaffPayments } from "../src/staff-payments/render.js";
import { createPaymentRunsController } from "../src/staff-payments/runs-browser.js";
import {
  filteredPaymentReport,
  paymentRunCsv,
  paymentReportTotals,
  paymentAllocationRows,
} from "../src/staff-payments/runs-model.js";
import {
  summarizeStaffPayments,
  type PaymentRun,
  type PaymentRunReport,
  type PaymentAllocationReport,
  type StaffPaymentReport,
} from "@ezacto/core";
const row = {
  ...summarizeStaffPayments(
    { user_id: 2, name: "Person Two", active: true, wise_ready: true },
    "2026-09",
    [],
    "2026-10-01",
  ),
  amount_cents: 10000,
  currency: "USD",
  balance_cents: 10000,
  reserved_cents: 2000,
  available_cents: 8000,
  version: 1,
};
const ledger: StaffPaymentReport = {
  month: "2026-09",
  as_of: "2026-10-01",
  provider_settings: { default_provider: "wise", version: 0, events: [] },
  rows: [row],
};
const run: PaymentRun = {
  id: "run",
  name: "September",
  source_currency: "USD",
  scheduled_at: "2026-10-01T12:00:00Z",
  timezone: "UTC",
  state: "draft",
  actor_id: 1,
  approved_by: null,
  created_at: "2026-10-01T11:00:00Z",
  approved_at: null,
  request_id: "request",
  items: [
    {
      id: "item",
      run_id: "run",
      name: row.name,
      user_id: 2,
      month: "2026-09",
      expected_version: 1,
      currency: "USD",
      amount_cents: 5000,
      destination: { id: 1, kind: "account", external_id: "456" },
      quote: {
        id: "q",
        profile_id: "123",
        recipient_id: "456",
        recipient_name: "Verified Recipient",
        source_currency: "USD",
        target_currency: "USD",
        target_cents: 5000,
        source_cents: 5050,
        fee_cents: 50,
        rate: 1,
        expires_at: "2026-10-01T12:00:00Z",
        estimated_arrival: null,
      },
      execution_quote: null,
      max_source_cents: 5050,
      state: "draft",
      transfer_id: null,
      provider_status: null,
      failure: null,
      attempts: 0,
      next_attempt_at: "2026-10-01T12:00:00Z",
      updated_at: "2026-10-01T11:00:00Z",
      version: 0,
      lease_token: null,
      lease_until: null,
    },
  ],
};
const report: PaymentRunReport = {
  from: "2026-09",
  to: "2026-09",
  ledgers: [ledger],
  runs: [run],
};
beforeEach(() => {
  history.replaceState({}, "", "/payments");
  document.body.innerHTML = renderStaffPayments("staff-payments");
});
describe("payment run review", () => {
  it("discards an old month's in-flight preview after the selection is reset", async () => {
    let finish!: (value: PaymentRun) => void;
    const api = {
      getPaymentRunReport: async () => report,
      previewPaymentRun: vi.fn(
        () =>
          new Promise<PaymentRun>((resolve) => {
            finish = resolve;
          }),
      ),
      approvePaymentRun: vi.fn(async () => run),
    };
    const controller = createPaymentRunsController(api, async () => {});
    await controller.activate(new AbortController().signal);
    controller.ledger(ledger);
    const form = document.querySelector<HTMLFormElement>("[data-run-form]")!;
    (form.elements.namedItem("select-2") as HTMLInputElement).checked = true;
    form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(api.previewPaymentRun).toHaveBeenCalledTimes(1);
    controller.resetSelection();
    finish(run);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-run-status]")!.textContent).toBe(""),
    );
    expect(
      document.querySelector<HTMLElement>("[data-run-review]")!.hidden,
    ).toBe(true);
    expect(api.approvePaymentRun).not.toHaveBeenCalled();
  });
  it("tells the person what a status check did instead of staying silent", async () => {
    const stuck: PaymentRun = {
      ...run,
      state: "approved",
      items: [{ ...run.items[0]!, state: "attention", execution_quote: run.items[0]!.quote }],
    };
    const reconcile = vi.fn(async () => stuck);
    const controller = createPaymentRunsController(
      {
        getPaymentRunReport: async () => ({ ...report, runs: [stuck] }),
        reconcilePaymentRunItem: reconcile,
      },
      async () => {},
    );
    await controller.activate(new AbortController().signal);
    controller.ledger(ledger);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-run-history] button")).not.toBeNull(),
    );
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-run-history] button"),
    ].find((b) => b.textContent === "Check status")!;
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-run-status]")!.textContent).toContain(
        "Status check requested for Person Two",
      ),
    );
    expect(document.querySelector("[data-run-status]")!.textContent).toContain(
      "no Wise transfer created yet",
    );
  });
  it("shows the request ID when the payment API fails", async () => {
    const controller = createPaymentRunsController(
      {
        getPaymentRunReport: async () => report,
        previewPaymentRun: async () => {
          throw {
            body: {
              error: { message: "The request could not be completed." },
              request_id: "payment-request-123",
            },
            requestId: "payment-request-123",
          };
        },
      },
      async () => {},
    );
    await controller.activate(new AbortController().signal);
    controller.ledger(ledger);
    const form = document.querySelector<HTMLFormElement>("[data-run-form]")!;
    (form.elements.namedItem("select-2") as HTMLInputElement).checked = true;
    form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-run-status]")!.textContent,
      ).toContain("Reference: payment-request-123"),
    );
  });
  it("requires a separate confirmation showing recipient, fees and cost before approval", async () => {
    const api = {
      previewPaymentRun: vi.fn(async () => run),
      approvePaymentRun: vi.fn(async () => ({
        ...run,
        state: "approved" as const,
      })),
      getPaymentRunReport: vi.fn(async () => report),
    };
    const reload = vi.fn(async () => {});
    const controller = createPaymentRunsController(api, reload);
    await controller.activate(new AbortController().signal);
    controller.ledger(ledger);
    expect(document.querySelector<HTMLElement>("[data-run-demo]")!.hidden).toBe(true);
    const form = document.querySelector<HTMLFormElement>("[data-run-form]")!;
    const input = (name: string) =>
      form.elements.namedItem(name) as HTMLInputElement;
    input("run_name").value = "September";
    input("select-2").checked = true;
    input("amount-2").value = "50.00";
    form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>("[data-run-review]")!.hidden,
      ).toBe(false),
    );
    expect(api.approvePaymentRun).not.toHaveBeenCalled();
    expect(document.querySelector("[data-run-review]")!.textContent).toContain(
      "Verified Recipient",
    );
    expect(document.querySelector("[data-run-review]")!.textContent).toContain(
      "50.50",
    );
    document
      .querySelector<HTMLFormElement>("[data-run-approval]")!
      .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(api.approvePaymentRun).toHaveBeenCalledWith(
        "run",
        { limits: [{ item_id: "item", max_source_cents: 5050 }] },
        expect.any(AbortSignal),
      ),
    );
    expect(api.previewPaymentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ amount_cents: 5000, expected_version: 1 }),
        ],
      }),
      expect.any(AbortSignal),
    );
  });
  it("on the public demo, withholds quoting and sending, and says why", async () => {
    // Issue 931: the Worker refuses every payout step on the demo.
    document.documentElement.setAttribute("data-demo-deployment", "");
    try {
      const api = {
        getPaymentRunReport: vi.fn(async () => report),
        previewPaymentRun: vi.fn(async () => run),
        approvePaymentRun: vi.fn(async () => run),
      };
      const controller = createPaymentRunsController(api, async () => {});
      await controller.activate(new AbortController().signal);
      controller.ledger(ledger);
      expect(
        document.querySelector<HTMLButtonElement>("[data-run-submit]")!.hidden,
      ).toBe(true);
      const note = document.querySelector<HTMLElement>("[data-run-demo]")!;
      expect(note.hidden).toBe(false);
      expect(note.textContent).toBe(
        "Sending payments: not available on the public demo.",
      );
      // Enter still submits a form whose button is hidden.
      const form = document.querySelector<HTMLFormElement>("[data-run-form]")!;
      (form.elements.namedItem("select-2") as HTMLInputElement).checked = true;
      form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
      expect(api.previewPaymentRun).not.toHaveBeenCalled();
    } finally {
      document.documentElement.removeAttribute("data-demo-deployment");
    }
  });
  it("keeps report totals separate by currency and exports the applied filters", () => {
    const data = {
      ...report,
      ledgers: [
        {
          ...ledger,
          rows: [
            row,
            { ...row, user_id: 3, name: "Euro Person", currency: "EUR" },
          ],
        },
      ],
    };
    expect(paymentReportTotals(data.ledgers[0]!.rows).size).toBe(2);
    const filters = { person: "Person Two", currency: "USD", status: "all" };
    expect(filteredPaymentReport(data, filters).rows).toHaveLength(1);
    const csv = paymentRunCsv(data, filters);
    expect(csv).toContain("Person Two");
    expect(csv).not.toContain("Euro Person");
    expect(csv).toContain("Review estimate");
  });
  it("does not load transfer history after authentication is aborted", async () => {
    let resolve!: (r: PaymentRunReport) => void;
    const api = {
      getPaymentRunReport: vi.fn(
        () =>
          new Promise<PaymentRunReport>((r) => {
            resolve = r;
          }),
      ),
    };
    const controller = createPaymentRunsController(api, async () => {});
    const active = new AbortController();
    await controller.activate(active.signal);
    controller.ledger(ledger);
    active.abort();
    resolve(report);
    await Promise.resolve();
    expect(document.querySelector("[data-run-history]")!.textContent).toBe("");
  });
});

it("reports historical costs separately and includes settlements in the paid filter", async () => {
  history.replaceState({}, "", "/payments/report");
  const historical = {
    ...row,
    amount_cents: 529870,
    amount_basis: "contractor_cost" as const,
    status: "settled" as const,
    paid_cents: 0,
    balance_cents: null,
    reserved_cents: 0,
    available_cents: null,
  };
  const data = {
    ...report,
    runs: [],
    ledgers: [{ ...ledger, rows: [historical] }],
  };
  expect(paymentReportTotals([historical]).get("USD")).toEqual({
    owed: 0n,
    paid: 0n,
    reserved: 0n,
    available: 0n,
    historical: 529870n,
  });
  const filters = { person: "", currency: "USD", status: "paid" };
  expect(filteredPaymentReport(data, filters).rows).toHaveLength(1);
  expect(filteredPaymentReport(data, filters).receipts).toHaveLength(0);
  const csv = paymentRunCsv(data, filters).split("\r\n");
  expect(csv[0]).toContain('"Amount basis"');
  expect(csv[1]).toContain('"529870","","0","","settled"');
  expect(csv[1]?.split(",")).toHaveLength(csv[0]!.split(",").length);
  expect(csv[1]).toContain('"contractor_cost"');
  const controller = createPaymentRunsController(
    { getPaymentRunReport: async () => data },
    async () => {},
  );
  await controller.activate(new AbortController().signal);
  expect(
    document.querySelector("[data-run-report-totals]")!.textContent,
  ).toContain("historically settled contractor cost");
  expect(
    document.querySelector("[data-run-report-balances]")!.textContent,
  ).toContain("5,298.70 · contractor cost");
});

it("hides empty report rows and exports by default, with an explicit opt-in", () => {
  const empty = { ...row, name: "Empty Person", amount_cents: null, balance_cents: null, reserved_cents: 0, available_cents: null };
  const hours = { ...empty, user_id: 3, name: "Hours Only", has_hours: true };
  const reserved = { ...empty, user_id: 4, name: "Reserved Person", reserved_cents: 100 };
  const data = { ...report, runs: [], ledgers: [{ ...ledger, rows: [empty, hours, reserved] }] };
  const filters = { person: "", currency: "", status: "all" };
  expect(filteredPaymentReport(data, filters).rows.map(r => r.name)).toEqual(["Hours Only", "Reserved Person"]);
  expect(paymentRunCsv(data, filters)).not.toContain("Empty Person");
  expect(filteredPaymentReport(data, { ...filters, show_empty: true }).rows).toHaveLength(3);
  expect(paymentRunCsv(data, { ...filters, show_empty: true })).toContain("Empty Person");
});

const allocationReport = (month: string): PaymentAllocationReport => ({ month, people: [{
  user_id: 2, name: "Person Two", currency: "USD", earned_cents: 10000,
  paid_cents: 5000, reserved_cents: 2000, allocated_applied_cents: 3000,
  allocated_reserved_cents: 1000, remaining_cents: 3000,
  unallocated_payments: [{ payment_kind: "event", payment_id: "old-payment", amount_cents: 2000, allocated_cents: 0, unallocated_cents: 2000, state: "applied" }],
  allocations: [], projects: [{ project_id: 7, project_name: '=Atlas,"North"', earned_cents: 10000,
    applied_cents: 3000, reserved_cents: 1000, remaining_cents: 6000, entries: [{
      entry_id: 31, spent_date: `${month}-04`, selected_seconds: 7200, rate_cents: 5000,
      reviewed_rounded_seconds: 7200, current_rounded_seconds: 3600, current_rate_cents: 5000,
      earned_cents: 10000, applied_cents: 1000, reserved_cents: 500,
      applied_seconds: 720, reserved_seconds: 360, remaining_cents: 8500, remaining_seconds: 6120,
      source_changed: true, over_allocated: false,
    }] }],
}] });

it("exports explicit project and entry allocations without assigning monthly or project money to entries", () => {
  const allocations = allocationReport("2026-09");
  const filters = { person: "Two", currency: "USD", status: "all" };
  const balances = filteredPaymentReport(report, filters).rows;
  const rows = paymentAllocationRows([allocations], balances);
  expect(rows).toMatchObject([
    { level: "Project", earned: 10000, paid: 3000, reserved: 1000, remaining: 6000, entry_id: null },
    { level: "Entry", earned: 10000, paid: 1000, reserved: 500, remaining: 8500, entry_id: 31, flags: "Source time changed" },
  ]);
  const csv = paymentRunCsv(report, filters, [allocations]);
  expect(csv).toContain('"Allocation Project","Person Two","2026-09","USD","10000","3000","1000","6000"');
  expect(csv).toContain('"Allocation Entry","Person Two","2026-09","USD","10000","1000","500","8500"');
  expect(csv).toContain(`"'=Atlas,""North"""`);
  expect(csv).toContain('"31","7200","6120","Source time changed"');
  const csvRows = csv.trim().split("\r\n").map((line) => line.match(/"(?:[^"]|"")*"/gu));
  expect(csvRows.every((cells) => cells?.length === csvRows[0]?.length)).toBe(true);
  for (const hidden of [ { ...filters, person: "Nobody" }, { ...filters, currency: "EUR" }, { ...filters, status: "paid" } ])
    expect(paymentRunCsv(report, hidden, [allocations])).not.toContain("Allocation Entry");
  expect(paymentRunCsv(report, filters, [allocationReport("2026-08")])).not.toContain("Allocation Entry");
});

it("loads allocation reconciliation for every reported month and clears it on navigation", async () => {
  history.replaceState({}, "", "/payments/report");
  const data = { ...report, from: "2026-08", ledgers: [{ ...ledger, month: "2026-08", rows: [{ ...row, month: "2026-08" }] }, ledger] };
  const getPaymentAllocationReport = vi.fn(async (month: string) => allocationReport(month));
  const controller = createPaymentRunsController({ getPaymentRunReport: async () => data, getPaymentAllocationReport }, async () => {});
  const active = new AbortController();
  await controller.activate(active.signal);
  expect(getPaymentAllocationReport.mock.calls.map(([month]) => month)).toEqual(["2026-08", "2026-09"]);
  const host = document.querySelector<HTMLElement>("[data-run-report-allocations]")!;
  expect(host.textContent).toContain("entry 31");
  expect(host.textContent).toContain("Source time changed");
  expect(host.textContent).toContain("Monthly payments stay unassigned");
  const person = document.querySelector<HTMLInputElement>('[data-run-report-form] [name="person"]')!;
  person.value = "Nobody";
  person.dispatchEvent(new Event("input"));
  expect(host.textContent).not.toContain("entry 31");
  active.abort();
  expect(host.textContent).toBe("");
});


it('[browser #852] sorts read-only payment reports by currency, exact cents and receipt date without changing totals or paying', async () => {
  const values = [
    { user_id: 2, currency: 'USD', amount_cents: 900, paid_on: '2026-10-12' },
    { user_id: 3, currency: 'USD', amount_cents: 10000, paid_on: '2026-10-02' },
    { user_id: 4, currency: 'EUR', amount_cents: 99999, paid_on: '2026-10-09' },
  ]
  const rows = values.map(value => ({ ...row, ...value, name: `Person ${value.user_id}`, events: [{
    ...value, id: `receipt-${value.user_id}`, month: row.month, expected_version: 0,
    kind: 'payment' as const, due_on: null, reference: 'Fixture', note: '', payment_id: null,
    source: 'wise' as const, version: 1, actor_id: 1, actor_name: 'Admin',
    recorded_at: '2026-10-20T00:00:00.000Z', request_id: 'fixture',
  }] }))
  const data: PaymentRunReport = { ...report,
    ledgers: [{ ...ledger, rows: [...rows, { ...row, user_id: 5, name: 'Unspecified amount', amount_cents: null }] }],
    runs: [{ ...run, items: values.map(value => ({ ...run.items[0]!, ...value, id: `item-${value.user_id}`, name: `Person ${value.user_id}` })) }],
  }
  const api = { getPaymentRunReport: async () => data, approvePaymentRun: vi.fn(), previewPaymentRun: vi.fn() }
  const mount = async () => {
    document.body.innerHTML = renderStaffPayments('staff-payments')
    history.replaceState({}, '', '/payments/report')
    await createPaymentRunsController(api, async () => {}).activate(new AbortController().signal)
  }
  const keys = (table: string) => [...document.querySelectorAll(`${table} tbody tr[data-row-key]`)].map(tr => tr.getAttribute('data-row-key'))
  const click = (table: string, column: string) => document.querySelector<HTMLButtonElement>(`${table} button[data-sort-column="${column}"]`)!.click()
  setSortPreferenceOwner(1)
  try {
    await mount()
    const totals = document.querySelector('[data-run-report-totals]')!.textContent
    click('[data-run-report-balances]', 'owed')
    expect(keys('[data-run-report-balances]')).toEqual(['4/2026-09', '2/2026-09', '3/2026-09', '5/2026-09'])
    click('[data-run-report-balances]', 'owed')
    expect(keys('[data-run-report-balances]')).toEqual(['3/2026-09', '2/2026-09', '4/2026-09', '5/2026-09'])
    click('[data-run-report-transfers]', 'amount')
    expect(keys('[data-run-report-transfers]')).toEqual(['item-4', 'item-2', 'item-3'])
    click('[data-run-report-receipts]', 'date')
    expect(keys('[data-run-report-receipts]')).toEqual(['receipt-3', 'receipt-4', 'receipt-2'])
    expect(document.querySelector('[data-run-report-totals]')!.textContent).toBe(totals)
    await mount()
    expect(keys('[data-run-report-balances]')).toEqual(['3/2026-09', '2/2026-09', '4/2026-09', '5/2026-09'])
    expect(keys('[data-run-report-transfers]')).toEqual(['item-4', 'item-2', 'item-3'])
    expect(keys('[data-run-report-receipts]')).toEqual(['receipt-3', 'receipt-4', 'receipt-2'])
    expect(api.approvePaymentRun).not.toHaveBeenCalled()
    expect(api.previewPaymentRun).not.toHaveBeenCalled()
  } finally { setSortPreferenceOwner(null); localStorage.clear() }
})
