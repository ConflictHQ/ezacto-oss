import { expect, it } from "vitest";
import {
  matchStaffInvoices,
  staffInvoiceAmount,
  type StaffInvoice,
  type PaymentActualEntry,
} from "../src/index.js";
const entry: PaymentActualEntry = {
  entry_id: 10,
  project_id: 1,
  project_name: "Project",
  spent_date: "2026-09-15",
  rounded_seconds: 3600,
  selected_seconds: 3600,
  cost_rate_cents: 1,
};
const invoice = (id: number, seconds: number, rate = 1): StaffInvoice => ({
  id,
  user_id: 2,
  month: "2026-09",
  currency: "USD",
  reference: `C-${id}`,
  matched_cents: 0,
  flags: [],
  line_flags: [],
  versions: [
    {
      command_id: `v-${id}`,
      version: 1,
      month: "2026-09",
      currency: "USD",
      kind: "received",
      amount_cents: 1,
      review_id: "review",
      document_id: null,
      reason: "Received",
      actor_id: 1,
      recorded_at: "2026-10-01T12:00:00.000Z",
      paid_cents_at_recording: 0,
      has_payment_history: false,
      lines: [
        {
          description: "Work",
          project_id: 1,
          entry_id: 10,
          seconds,
          rate_cents: rate,
        },
      ],
    },
  ],
});
it("flags cent-rounding overclaims as well as overlapping hours, without favoring one invoice", () => {
  const invoices = [invoice(1, 1800), invoice(2, 1800)];
  matchStaffInvoices(invoices, [entry], "USD");
  expect(invoices.map((i) => i.matched_cents)).toEqual([0, 0]);
  expect(
    invoices.every((i) =>
      i.flags.includes("Received invoice lines overlap this earning"),
    ),
  ).toBe(true);
});
it("matches partial quantities when hours, captured rates and cents all fit the earning", () => {
  const invoices = [invoice(1, 1800, 5000), invoice(2, 1800, 5000)];
  matchStaffInvoices(invoices, [{ ...entry, cost_rate_cents: 5000 }], "USD");
  expect(invoices.map((i) => i.matched_cents)).toEqual([2500, 2500]);
  expect(invoices.flatMap((i) => i.flags)).toEqual([]);
});
it("preserves signed correction hours in the invoice total and refuses a negative net payable document", () => {
  expect(
    staffInvoiceAmount([
      {
        description: "Work",
        project_id: 1,
        entry_id: 10,
        seconds: 7200,
        rate_cents: 5000,
      },
      {
        description: "Correction",
        project_id: 1,
        entry_id: 11,
        seconds: -3600,
        rate_cents: 5000,
      },
    ]),
  ).toBe(5000);
  expect(() =>
    staffInvoiceAmount([
      {
        description: "Correction",
        project_id: 1,
        entry_id: 11,
        seconds: -3600,
        rate_cents: 5000,
      },
    ]),
  ).toThrow(/supported range/);
});

it("matches project-only lines at a uniform captured rate and flags mixed project/entry granularity", () => {
  const project = invoice(1, 3600, 5000);
  project.versions[0]!.lines[0]!.entry_id = null;
  matchStaffInvoices([project], [{ ...entry, cost_rate_cents: 5000 }], "USD");
  expect(project.matched_cents).toBe(5000);
  const detailed = invoice(2, 1800, 5000);
  matchStaffInvoices(
    [project, detailed],
    [{ ...entry, cost_rate_cents: 5000 }],
    "USD",
  );
  expect(project.matched_cents).toBe(0);
  expect(detailed.matched_cents).toBe(0);
  expect(project.flags).toContain(
    "Project and entry invoice lines overlap: use one matching granularity",
  );
});
