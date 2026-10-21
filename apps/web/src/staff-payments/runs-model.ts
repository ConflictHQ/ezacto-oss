import { paymentFinancialSections, type PaymentFinancialSources } from './report-financials.js';
import { hasPaymentActivity } from './model.js';
import type {
  PaymentRunReport,
  PaymentAllocationReport,
  PaymentItem,
  StaffPaymentRow,
} from "@ezacto/core";
export const canPayNow = (row: StaffPaymentRow): boolean =>
  row.active &&
  row.payout_provider === "wise" &&
  row.wise_ready &&
  row.currency !== null &&
  row.status !== "settled" &&
  (row.available_cents ?? row.balance_cents ?? 0) > 0;

export const paymentStateLabel = (state: PaymentItem["state"]): string =>
  ({
    draft: "Awaiting approval",
    queued: "Scheduled / queued",
    creating: "Preparing transfer",
    funding: "Funding",
    processing: "Processing",
    paid: "Paid (Wise sent)",
    failed: "Failed / refunded",
    attention: "Needs attention",
    cancelled: "Cancelled",
  })[state];
export interface PaymentReportFilters {
  person: string;
  currency: string;
  status: string;
  show_empty?: boolean;
}
export const filteredPaymentReport = (
  report: PaymentRunReport,
  filters: PaymentReportFilters,
) => {
  const matches = (name: string, currency: string | null) =>
    name.toLowerCase().includes(filters.person.trim().toLowerCase()) &&
    (!filters.currency.trim() ||
      currency === filters.currency.trim().toUpperCase());
  const items = report.runs
    .flatMap((run) =>
      run.items
        .filter((item) => item.month >= report.from && item.month <= report.to)
        .map((item) => ({
          ...item,
          run_name: run.name,
          scheduled_at: run.scheduled_at,
          timezone: run.timezone,
        })),
    )
    .filter(
      (item) =>
        matches(item.name, item.currency) &&
        (filters.status === "all" ||
          (filters.status === "outstanding" &&
            !["paid", "cancelled", "failed", "draft"].includes(item.state)) ||
          (filters.status === "processing" &&
            ["creating", "funding", "processing"].includes(item.state)) ||
          item.state === filters.status),
    );
  const rows = report.ledgers
    .flatMap((ledger) => ledger.rows)
    .filter(
      (row) =>
        (filters.show_empty || hasPaymentActivity(row) || items.some(
          (item) => item.user_id === row.user_id && item.month === row.month,
        )) &&
        matches(row.name, row.currency) &&
        (filters.status === "all" ||
          (filters.status === "outstanding" &&
            row.status !== "paid" &&
            row.status !== "settled") ||
          (filters.status === "paid" &&
            (row.status === "paid" || row.status === "settled")) ||
          items.some(
            (item) => item.user_id === row.user_id && item.month === row.month,
          )),
    );
  const receipts = rows.flatMap((row) => {
    const voided = new Set(
      row.events.filter((e) => e.kind === "void").map((e) => e.payment_id),
    );
    return row.events
      .filter((e) => e.kind === "payment" && !voided.has(e.id))
      .map((e) => ({ ...e, name: row.name }));
  });
  return { rows, items, receipts };
};
/** Parent and child rows are separate levels, not additive totals. Payments assigned
 * only to a month/project stay there; no entry split is inferred. */
export const paymentAllocationRows = (
  reports: PaymentAllocationReport[],
  balances: StaffPaymentRow[],
) => reports.flatMap((report) => report.people.flatMap((person) => {
  if (!balances.some((row) => row.user_id === person.user_id && row.month === report.month && row.currency === person.currency)) return [];
  const base = { name: person.name, user_id: person.user_id, month: report.month, currency: person.currency };
  return person.projects.flatMap((project) => [
    { ...base, level: 'Project', project_id: project.project_id, project: project.project_name,
      entry_id: null as number | null, earned: project.earned_cents, paid: project.applied_cents,
      reserved: project.reserved_cents, remaining: project.remaining_cents, selected_seconds: null as number | null,
      remaining_seconds: null as number | null, flags: '' },
    ...project.entries.map((entry) => ({ ...base, level: 'Entry', project_id: project.project_id,
      project: project.project_name, entry_id: entry.entry_id, earned: entry.earned_cents,
      paid: entry.applied_cents, reserved: entry.reserved_cents, remaining: entry.remaining_cents,
      selected_seconds: entry.selected_seconds, remaining_seconds: entry.remaining_seconds,
      flags: [entry.source_changed ? 'Source time changed' : '', entry.over_allocated ? 'Over-allocated' : ''].filter(Boolean).join('; ') })),
  ]);
}));

export const paymentReportTotals = (rows: StaffPaymentRow[]) => {
  const totals = new Map<
    string,
    {
      owed: bigint;
      paid: bigint;
      reserved: bigint;
      available: bigint;
      historical: bigint;
    }
  >();
  for (const row of rows) {
    if (row.currency === null || row.amount_cents === null) continue;
    const t = totals.get(row.currency) ?? {
      owed: 0n,
      paid: 0n,
      reserved: 0n,
      available: 0n,
      historical: 0n,
    };
    if (row.status === "settled") {
      t.historical += BigInt(row.amount_cents);
      totals.set(row.currency, t);
      continue;
    }
    t.owed += BigInt(row.amount_cents);
    t.paid += BigInt(row.paid_cents);
    t.reserved += BigInt(row.reserved_cents ?? 0);
    t.available += BigInt(row.available_cents ?? row.balance_cents ?? 0);
    totals.set(row.currency, t);
  }
  return totals;
};
const cell = (value: unknown): string => {
  let text = value === null || value === undefined ? "" : String(value);
  if (typeof value === "string" && /^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export const paymentRunCsv = (
  report: PaymentRunReport,
  filters: PaymentReportFilters,
  allocations: PaymentAllocationReport[] = [],
  financials?: PaymentFinancialSources,
): string => {
  const { rows, items, receipts } = filteredPaymentReport(report, filters);
  const lines: unknown[][] = [
    [
      "Record",
      "Person",
      "Work month",
      "Currency",
      "Amount cents",
      "Paid cents",
      "Reserved cents",
      "Available cents",
      "Status",
      "Run",
      "Scheduled at",
      "Paid on",
      "Provider",
      "Transfer reference",
      "Source currency",
      "Source cost cents",
      "Fee cents",
      "Cost basis",
      "Maximum source cents",
      "Failure",
      "Amount basis",
      "User ID", "Project ID", "Project", "Entry ID", "Selected seconds", "Remaining seconds", "Flags",
    ],
  ];
  for (const r of rows)
    lines.push([
      "Balance",
      r.name,
      r.month,
      r.currency,
      r.amount_cents,
      r.status === "settled" ? null : r.paid_cents,
      r.reserved_cents ?? 0,
      r.available_cents ?? r.balance_cents,
      r.status,
      ...Array.from({ length: 11 }, () => ""),
      r.amount_basis,
    ]);
  for (const i of items) {
    const q = i.execution_quote ?? i.quote;
    lines.push([
      "Transfer",
      i.name,
      i.month,
      i.currency,
      i.amount_cents,
      "",
      "",
      "",
      i.state,
      i.run_name,
      i.scheduled_at,
      "",
      "wise",
      i.transfer_id,
      q.source_currency,
      q.source_cents,
      q.fee_cents,
      i.execution_quote ? "Execution quote" : "Review estimate",
      i.max_source_cents,
      i.failure,
    ]);
  }
  for (const r of receipts)
    lines.push([
      "Receipt",
      r.name,
      r.month,
      r.currency,
      r.amount_cents,
      "",
      "",
      "",
      "Recorded",
      "",
      "",
      r.paid_on,
      r.source,
      r.reference,
    ]);
  // Preserve the existing columns; allocation amounts occupy the same money
  // columns, with explicit record levels so readers never sum parent + child.
  for (const row of lines.slice(1)) while (row.length < lines[0]!.length) row.push("");
  for (const r of paymentAllocationRows(allocations, rows))
    lines.push([
      `Allocation ${r.level}`, r.name, r.month, r.currency,
      r.earned, r.paid, r.reserved, r.remaining, "", ...Array.from({ length: 11 }, () => ""),
      "allocated_earnings", r.user_id, r.project_id, r.project, r.entry_id,
      r.selected_seconds, r.remaining_seconds, r.flags,
    ]);
  if (financials) {
    const eligible = filteredPaymentReport(report, {...filters, currency: '', show_empty: true}).rows;
    const sections = paymentFinancialSections(financials, filters, eligible);
    const header = lines[0]!;
    for (const key of sections.flatMap(section => section.columns)) if (!header.includes(key)) header.push(key);
    for (const section of sections) for (const record of section.rows)
      lines.push(header.map(key => key === 'Record' ? section.title : record[String(key)] ?? ''));
    for (const record of lines.slice(1)) while (record.length < header.length) record.push('');
  }
  return (
    "\uFEFF" + lines.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
};
