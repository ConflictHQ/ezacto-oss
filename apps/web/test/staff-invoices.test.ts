/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from "vitest";
import {
  summarizeStaffPayments,
  type StaffInvoice,
  type StaffInvoiceReport,
  type StaffPaymentReport,
} from "@ezacto/core";
import { renderStaffPayments } from "../src/staff-payments/render.js";
import {
  createStaffInvoicesController,
  renderStaffInvoiceDocuments,
  type StaffInvoicesApi,
} from "../src/staff-payments/invoices-browser.js";
const invoice: StaffInvoice = {
  id: 7,
  user_id: 2,
  month: "2026-09",
  currency: "USD",
  reference: "C-001",
  matched_cents: 10000,
  flags: [],
  line_flags: [[]],
  versions: [
    {
      command_id: "v1",
      version: 1,
      month: "2026-09",
      currency: "USD",
      kind: "received",
      lines: [
        {
          description: "Project work",
          project_id: 1,
          entry_id: 10,
          seconds: 7200,
          rate_cents: 5000,
        },
      ],
      amount_cents: 10000,
      review_id: "review",
      document_id: null,
      reason: "Received from contractor",
      actor_id: 1,
      recorded_at: "2026-10-01T12:00:00.000Z",
      paid_cents_at_recording: 4000,
      has_payment_history: true,
    },
  ],
};
const report = (invoices: StaffInvoice[] = []): StaffInvoiceReport => ({
  month: "2026-09",
  people: [
    {
      user_id: 2,
      name: "Person Two",
      currency: "USD",
      earned_cents: 10000,
      paid_cents: 4000,
      invoiced_cents: invoices.length ? 10000 : 0,
      matched_invoice_cents: invoices.length ? 10000 : 0,
      uninvoiced_cents: invoices.length ? 0 : 10000,
      invoices,
    },
  ],
});
const ledger: StaffPaymentReport = {
  month: "2026-09",
  as_of: "2026-10-01",
  provider_settings: { default_provider: "wise", version: 0, events: [] },
  rows: [
    {
      ...summarizeStaffPayments(
        { user_id: 2, name: "Person Two", active: true, wise_ready: true },
        "2026-09",
        [],
        "2026-10-01",
      ),
      is_contractor: true,
      currency: "USD",
    },
  ],
};
const byLabel = (label: string) =>
  document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
const set = (label: string, value: string) => {
  const input = byLabel(label);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const click = (text: string) =>
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent === text)!
    .click();
const submit = (input: HTMLElement) =>
  input
    .closest("form")!
    .dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
const mount = async (api: StaffInvoicesApi) => {
  document.body.innerHTML = renderStaffPayments("staff-payments");
  const controller = createStaffInvoicesController(
    document.querySelector("[data-staff-payments-page]")!,
    api,
    (e) => (e as Error).message,
  );
  const active = new AbortController();
  controller.activate(active.signal);
  controller.ledger(ledger);
  click("Load contractor invoices for work month");
  await vi.waitFor(() =>
    expect(
      document.querySelector("[data-staff-invoice-editor]"),
    ).not.toBeNull(),
  );
  return active;
};
beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-demo-deployment");
});
it("announces a delayed invoice refresh and releases its indicator after rejection", async () => {
  const read = vi.fn(async () => report());
  const active = await mount({ getStaffInvoiceReport: read });
  let reject!: (error: Error) => void;
  read.mockImplementationOnce(() => new Promise<StaffInvoiceReport>((_, fail) => { reject = fail; }));
  click("Load contractor invoices for work month");
  const status = document.querySelector<HTMLElement>("[data-staff-invoice-status]")!;
  expect(status.textContent).toBe("Loading contractor invoices…");
  expect(status.getAttribute("aria-busy")).toBe("true");
  reject(new Error("Invoices unavailable"));
  await vi.waitFor(() => expect(status.textContent).toBe("Invoices unavailable"));
  expect(status.getAttribute("aria-busy")).toBe("false");
  active.abort();
  expect(status.getAttribute("aria-busy")).toBe("false");
});
it("drafts from a reviewed earning with an explicit contractor reference and does not use a payment mutation", async () => {
  const api = {
    getStaffInvoiceReport: vi.fn(async () => report()),
    saveStaffInvoice: vi.fn(async () => invoice),
  };
  await mount(api);
  click("Draft or record contractor invoice");
  expect(byLabel("Use reviewed hours and captured rates").required).toBe(false);
  set("Contractor invoice reference", "C-002");
  set("Reason shared with contractor", "Prepare invoice from reviewed hours");
  submit(byLabel("Contractor invoice reference"));
  await vi.waitFor(() => expect(api.saveStaffInvoice).toHaveBeenCalledTimes(1));
  expect(api.saveStaffInvoice).toHaveBeenCalledWith(
    expect.objectContaining({
      invoice_id: null,
      expected_version: 0,
      user_id: 2,
      month: "2026-09",
      reference: "C-002",
      kind: "draft",
      from_review: true,
      lines: [],
    }),
    expect.any(AbortSignal),
  );
});
it("records a received document against a selected project summary without inventing entry splits", async () => {
  const api: StaffInvoicesApi = {
    getStaffInvoiceReport: vi.fn(async () => report()),
    saveStaffInvoice: vi.fn(async () => invoice),
    getPaymentAllocationReport: vi.fn(async () => ({
      month: "2026-09",
      people: [
        {
          user_id: 2,
          name: "Person Two",
          currency: "USD",
          earned_cents: 10000,
          paid_cents: 0,
          reserved_cents: 0,
          allocated_applied_cents: 0,
          allocated_reserved_cents: 0,
          remaining_cents: 10000,
          allocations: [],
          unallocated_payments: [],
          projects: [
            {
              project_id: 1,
              project_name: "Project",
              earned_cents: 10000,
              applied_cents: 0,
              reserved_cents: 0,
              remaining_cents: 10000,
              entries: [
                {
                  entry_id: 10,
                  spent_date: "2026-09-15",
                  selected_seconds: 7200,
                  rate_cents: 5000,
                  reviewed_rounded_seconds: 7200,
                  current_rounded_seconds: 7200,
                  current_rate_cents: 5000,
                  earned_cents: 10000,
                  applied_cents: 0,
                  reserved_cents: 0,
                  applied_seconds: 0,
                  reserved_seconds: 0,
                  remaining_cents: 10000,
                  remaining_seconds: 7200,
                  source_changed: false,
                  over_allocated: false,
                },
              ],
            },
          ],
        },
      ],
    })),
  };
  await mount(api);
  click("Draft or record contractor invoice");
  set("Contractor invoice reference", "C-002");
  byLabel("Contractor invoice state").value = "received";
  byLabel("Use reviewed hours and captured rates").checked = false;
  byLabel("Use reviewed hours and captured rates").dispatchEvent(
    new Event("change"),
  );
  set("Line description", "Project services");
  click("Load reviewed earning choices");
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("project summary"),
  );
  byLabel("Reviewed earning").value = "project:1";
  byLabel("Reviewed earning").dispatchEvent(new Event("change"));
  set("Reason shared with contractor", "Received contractor invoice");
  submit(byLabel("Contractor invoice reference"));
  await vi.waitFor(() =>
    expect(api.saveStaffInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "received",
        from_review: false,
        lines: [
          {
            description: "Project services",
            project_id: 1,
            entry_id: null,
            seconds: 7200,
            rate_cents: 5000,
          },
        ],
      }),
      expect.any(AbortSignal),
    ),
  );
});
it("preserves the invoice identity/version on a payment-aware correction and clears money on navigation", async () => {
  const api = {
    getStaffInvoiceReport: vi.fn(async () => report([invoice])),
    saveStaffInvoice: vi.fn(async () => invoice),
  };
  const active = await mount(api);
  click("Record corrected version");
  expect(
    byLabel("I reviewed existing payments; this document will not change them")
      .required,
  ).toBe(true);
  set("Reason shared with contractor", "Corrected received document");
  byLabel(
    "I reviewed existing payments; this document will not change them",
  ).checked = true;
  set("Invoice work month", "2026-08");
  submit(byLabel("Contractor invoice reference"));
  await vi.waitFor(() =>
    expect(api.saveStaffInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice_id: 7,
        expected_version: 1,
        month: "2026-08",
        reference: "C-001",
        acknowledge_paid_history: true,
      }),
      expect.any(AbortSignal),
    ),
  );
  active.abort();
  expect(
    document.querySelector("[data-staff-invoice-content]")!.textContent,
  ).toBe("");
});
it("stages a file then attaches it in a version, while the own-person document view stays read-only", async () => {
  const api = {
    getStaffInvoiceReport: vi.fn(async () => report([invoice])),
    saveStaffInvoice: vi.fn(async () => invoice),
    uploadStaffInvoiceDocument: vi.fn(async () => ({ id: "document" })),
  };
  await mount(api);
  const file = new File(["pdf bytes"], "invoice.pdf", {
    type: "application/pdf",
  });
  Object.defineProperty(byLabel("Contractor invoice document"), "files", {
    value: [file],
  });
  set("Attachment reason shared with contractor", "Attach received PDF");
  byLabel("I reviewed payments before attaching this document").checked = true;
  submit(byLabel("Contractor invoice document"));
  await vi.waitFor(() =>
    expect(api.saveStaffInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice_id: 7,
        expected_version: 1,
        document_id: "document",
        acknowledge_paid_history: true,
      }),
      expect.any(AbortSignal),
    ),
  );
  expect(api.uploadStaffInvoiceDocument).toHaveBeenCalledWith(
    7,
    "2026-09",
    expect.any(String),
    file,
    expect.any(AbortSignal),
  );
  const own = renderStaffInvoiceDocuments(
    report([
      {
        ...invoice,
        versions: [{ ...invoice.versions[0]!, document_id: "document" }],
      },
    ]),
  );
  expect(own.querySelector("form,input,button")).toBeNull();
  expect(own.querySelector("a")!.getAttribute("href")).toBe(
    "/api/v1/staff-invoices/7/documents/document/content",
  );
});
