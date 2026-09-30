/** @vitest-environment happy-dom */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { renderStaffPayments } from "../src/staff-payments/render.js";
import { createPaymentRunsController } from "../src/staff-payments/runs-browser.js";
import {
  filteredPaymentReport,
  paymentRunCsv,
  paymentReportTotals,
} from "../src/staff-payments/runs-model.js";
import {
  summarizeStaffPayments,
  type PaymentRun,
  type PaymentRunReport,
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
