import type {
  PaymentRunReport,
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
        matches(row.name, row.currency) &&
        (filters.status === "all" ||
          (filters.status === "outstanding" &&
            row.status !== "paid" &&
            row.status !== "settled") ||
          (filters.status === "paid" && row.status === "paid") ||
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
export const paymentReportTotals = (rows: StaffPaymentRow[]) => {
  const totals = new Map<
    string,
    { owed: bigint; paid: bigint; reserved: bigint; available: bigint }
  >();
  for (const row of rows) {
    if (
      row.currency === null ||
      row.amount_cents === null ||
      row.status === "settled"
    )
      continue;
    const t = totals.get(row.currency) ?? {
      owed: 0n,
      paid: 0n,
      reserved: 0n,
      available: 0n,
    };
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
  if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export const paymentRunCsv = (
  report: PaymentRunReport,
  filters: PaymentReportFilters,
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
    ],
  ];
  for (const r of rows)
    lines.push([
      "Balance",
      r.name,
      r.month,
      r.currency,
      r.amount_cents,
      r.paid_cents,
      r.reserved_cents ?? 0,
      r.available_cents ?? r.balance_cents,
      r.status,
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
  return (
    "\uFEFF" + lines.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
};
