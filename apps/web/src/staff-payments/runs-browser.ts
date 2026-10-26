import { paymentFinancialSections, type PaymentFinancialSources } from './report-financials.js';
import { previousPaymentMonth, paymentMonthEnd } from "@ezacto/core";
import type {
  StaffInvoiceReport,
  AdvanceCreditReport,
  PaymentRun,
  PaymentRunCommand,
  PaymentRunApproval,
  PaymentRunReport,
  PaymentAllocationReport,
  StaffPaymentReport,
} from "@ezacto/core";
import { moneyText } from "../money-display.js";
import { renderDataTable, type DataSortValue } from "../components/data-table.js";
import { isDemoDeployment } from "../demo.js";
import { staffPaymentAmount, staffPaymentMoney } from "./model.js";
import { setRequestBusy } from '../request-feedback.js'
import {
  canPayNow,
  filteredPaymentReport,
  paymentReportTotals,
  paymentAllocationRows,
  paymentRunCsv,
  paymentStateLabel,
} from "./runs-model.js";
export interface PaymentRunsApi {
  getStaffInvoiceReport?(month: string, signal?: AbortSignal): Promise<StaffInvoiceReport>;
  getAdvanceCreditReport?(from: string, to: string, signal?: AbortSignal): Promise<AdvanceCreditReport>;
  getPaymentAllocationReport?(month: string, signal?: AbortSignal): Promise<PaymentAllocationReport>;
  getPaymentRunReport?(
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<PaymentRunReport>;
  previewPaymentRun?(
    body: PaymentRunCommand,
    signal?: AbortSignal,
  ): Promise<PaymentRun>;
  approvePaymentRun?(
    id: string,
    body: PaymentRunApproval,
    signal?: AbortSignal,
  ): Promise<PaymentRun>;
  cancelPaymentRun?(id: string, signal?: AbortSignal): Promise<PaymentRun>;
  reconcilePaymentRunItem?(
    id: string,
    itemId: string,
    signal?: AbortSignal,
  ): Promise<PaymentRun>;
}
const money = (...args: Parameters<typeof staffPaymentMoney>) =>
  moneyText(staffPaymentMoney(...args));
const moneySort = (amount: number | null, currency: string | null): DataSortValue =>
  amount === null || currency === null ? null : [currency, amount];
const node = (tag: string, value: string): HTMLElement => {
  const e = document.createElement(tag);
  e.textContent = value;
  return e;
};
const el = <T extends HTMLElement>(root: HTMLElement, selector: string): T => {
  const e = root.querySelector<T>(selector);
  if (!e) throw new Error(`Missing payment control ${selector}`);
  return e;
};
const errorText = (error: unknown): string => {
  const failure = error as {
    requestId?: string;
    body?: {
      request_id?: string;
      error?: { message?: string; fields?: { message?: string }[] };
    };
  } | null;
  const body = failure?.body;
  const message =
    body?.error?.fields?.[0]?.message ??
    body?.error?.message ??
    (error instanceof Error
      ? error.message
      : "Unable to complete the payment request.");
  const requestId = failure?.requestId ?? body?.request_id;
  return requestId ? `${message} Reference: ${requestId}` : message;
};
export const createPaymentRunsController = (
  api: PaymentRunsApi,
  reload: () => Promise<void>,
  onApproved: () => void = () => {},
) => {
  const page = document.querySelector<HTMLElement>(
    "[data-staff-payments-page]",
  );
  const section = page?.querySelector<HTMLElement>("[data-payment-runs]");
  if (!page || !section)
    return {
      activate: async () => {},
      resetSelection: () => {},
      payNow: (_userId?: number) => {
        void _userId;
      },
      ledger: (report: StaffPaymentReport) => {
        void report;
      },
    };
  const reportSection = el<HTMLElement>(page, "[data-payments-report]");
  const reportMode = location.pathname === "/payments/report";
  const form = el<HTMLFormElement>(section, "[data-run-form]");
  // The public demo sends no money (issue 931). Choosing amounts still works,
  // so the form stays; only the step that would quote and send is withheld,
  // with the note in its place. Hidden rather than disabled, because every
  // busy state in this page re-enables its buttons when it ends.
  const demo = isDemoDeployment();
  el<HTMLButtonElement>(section, "[data-run-submit]").hidden = demo;
  el<HTMLElement>(section, "[data-run-demo]").hidden = !demo;
  const approvalForm = el<HTMLFormElement>(section, "[data-run-approval]");
  const review = el<HTMLElement>(section, "[data-run-review]");
  const status = el<HTMLElement>(section, "[data-run-status]");
  const reportStatus = el<HTMLElement>(
    reportSection,
    "[data-run-report-status]",
  );
  const reportForm = el<HTMLFormElement>(
    reportSection,
    "[data-run-report-form]",
  );
  const input = (root: HTMLFormElement, name: string) =>
    root.elements.namedItem(name) as HTMLInputElement;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  el(section, "[data-run-timezone]").textContent = `Times shown in ${timezone}`;
  let signal: AbortSignal | undefined,
    snapshot: StaffPaymentReport | null = null,
    draft: PaymentRun | null = null,
    data: PaymentRunReport | null = null,
    allocationReports: PaymentAllocationReport[] = [],
    financialSources: PaymentFinancialSources = {invoices: [], advances: null},
    busy = false,
    generation = 0;
  let pendingCommand: PaymentRunCommand | null = null;
  let sessionGeneration = 0
  let pendingControls: { control: HTMLInputElement; disabled: boolean }[] = []
  const restoreControls = () => {
    pendingControls.forEach(({ control, disabled }) => { control.disabled = disabled })
    pendingControls = []
  }
  const action = async (work: (active: AbortSignal, current: () => boolean) => Promise<string | void>, target = status, phase = 'Working…') => {
    if (busy || !signal || signal.aborted) return;
    const active = signal, revision = sessionGeneration
    const current = () => signal === active && !active.aborted && sessionGeneration === revision
    busy = true;
    target.textContent = phase;
    setRequestBusy(target, true)
    const controls = [
      ...(reportMode
        ? reportSection
        : section
      ).querySelectorAll<HTMLInputElement>("input,select,button"),
    ];
    pendingControls = controls.map(control => ({ control, disabled: control.disabled }))
    controls.forEach((control) => {
      control.disabled = true;
    });
    try {
      const note = await work(active, current);
      if (current()) target.textContent = note ?? "";
    } catch (error) {
      if (current()) target.textContent = errorText(error);
    } finally {
      if (current()) {
        busy = false;
        restoreControls()
        setRequestBusy(target, false)
      }
    }
  };
  const paintHistory = () => {
    const host = el(section, "[data-run-history]");
    host.replaceChildren();
    if (!data?.runs.length)
      host.appendChild(node("p", "No payment runs for this month yet."));
    for (const run of data?.runs ?? []) {
      const block = document.createElement("section");
      block.appendChild(node("h4", `${run.name} · ${run.state}`));
      block.appendChild(
        node(
          "p",
          `Starts ${new Date(run.scheduled_at).toLocaleString()} (${timezone})`,
        ),
      );
      block.appendChild(
        renderDataTable({
          caption: run.name,
          table: `payment-run-items:${run.id}`,
          defaultSort: { column: "name", direction: "ascending" },
          rows: run.items,
          rowKey: (i) => i.id,
          empty: "No payments.",
          columns: [
            {
              key: "name",
              label: "Person",
              sortValue: (i) => i.name,
              render: (i) => `${i.name} · ${i.month}${i.purpose === "advance" ? " · Advance deposit" : ""}`,
            },
            {
              key: "amount",
              label: "Recipient receives",
              sortValue: (i) => moneySort(i.amount_cents, i.currency),
              render: (i) => money(i.amount_cents, i.currency),
            },
            {
              key: "state",
              label: "Status",
              sortValue: (i) => paymentStateLabel(i.state),
              render: (i) => paymentStateLabel(i.state),
            },
            {
              key: "reference",
              label: "Wise transfer",
              sortValue: (i) => i.transfer_id,
              render: (i) => i.transfer_id ?? "Not created",
            },
            {
              key: "failure",
              label: "Details",
              sortValue: (i) => i.failure || null,
              render: (i) => i.failure ?? "",
            },
            {
              key: "check",
              label: "Status check",
              render: (i) => {
                const b = node("button", "Check status") as HTMLButtonElement;
                b.type = "button";
                b.disabled =
                  i.transfer_id === null && i.execution_quote === null;
                b.addEventListener(
                  "click",
                  () =>
                    void action(async (active, current) => {
                      const checked = await api.reconcilePaymentRunItem!(
                        run.id,
                        i.id,
                        active,
                      );
                      if (!current()) return
                      await refresh();
                      // The check only asks the sender to look again; Wise is
                      // queried by the next minute's run, so say what happened
                      // instead of leaving a silent button.
                      const now = checked.items.find((x) => x.id === i.id);
                      return `Status check requested for ${i.name}. Now: ${paymentStateLabel((now ?? i).state)}${
                        (now ?? i).transfer_id === null
                          ? ", with no Wise transfer created yet"
                          : ""
                      }. Wise is checked within the next minute; press Check status again then to see the result.`;
                    }, status, 'Checking payment status…'),
                );
                return b;
              },
            },
          ],
        }),
      );
      if (
        run.items.some(
          (i) =>
            ["draft", "queued"].includes(i.state) ||
            (i.state === "attention" && i.execution_quote === null),
        )
      ) {
        const b = node("button", "Cancel unsent payments") as HTMLButtonElement;
        b.type = "button";
        b.addEventListener(
          "click",
          () =>
            void action(async (active, current) => {
              await api.cancelPaymentRun!(run.id, active);
              if (!current()) return
              await reload();
              if (!current()) return
              await refresh();
            }, status, 'Cancelling unsent payments…'),
        );
        block.appendChild(b);
      }
      host.appendChild(block);
    }
  };
  const filters = () => ({
    person: input(reportForm, "person").value,
    currency: input(reportForm, "currency").value,
    status: input(reportForm, "status").value,
    show_empty: input(reportForm, "show_empty").checked,
  });
  const paintReport = () => {
    if (!data) return;
    const { rows, items, receipts } = filteredPaymentReport(data, filters());
    const financialHost = el(reportSection, "[data-run-report-financials]");
    financialHost.replaceChildren();
    if (api.getStaffInvoiceReport || api.getAdvanceCreditReport)
      financialHost.appendChild(node("p", "The status filter follows the earnings ledger for invoices and applications, and the transfer status for credit deposits and returns. Invoice and credit evidence stays visible even when its currency differs from the earnings ledger."));
    const eligible = filteredPaymentReport(data, { ...filters(), currency: "", show_empty: true }).rows;
    for (const section of paymentFinancialSections(financialSources, filters(), eligible)) {
      if (
        (section.id.startsWith("invoice") && !api.getStaffInvoiceReport) ||
        (section.id.startsWith("credit") && !api.getAdvanceCreditReport)
      )
        continue;
      financialHost.appendChild(node("h3", section.title));
      financialHost.appendChild(node("p", section.note));
      financialHost.appendChild(
        renderDataTable<Record<string, string | number | null>>({
          caption: section.title,
          table: `payment-report-${section.id}`,
          defaultSort: { column: "Person", direction: "ascending" },
          rows: section.rows,
          rowKey: (row) =>
            JSON.stringify([
              row["User ID"],
              row["Work month"],
              row["Invoice ID"],
              row["Invoice line"],
              row["Advance item ID"],
              row["Application ID"],
              row["Return ID"],
            ]),
          empty: "No records match these filters.",
          columns: section.columns.map((key) => ({
            key,
            label: key.endsWith(" cents") ? key.slice(0, -6) : key,
            numeric: key.endsWith(" cents"),
            sortValue: (row) =>
              key.endsWith(" cents")
                ? moneySort(row[key] as number | null, row.Currency as string)
                : (row[key] ?? null),
            render: (row) =>
              key.endsWith(" cents")
                ? money(row[key] as number | null, row.Currency as string)
                : String(row[key] ?? ""),
          })),
        }),
      );
    }
    const allocationHost = el(reportSection, "[data-run-report-allocations]");
    allocationHost.replaceChildren();
    if (api.getPaymentAllocationReport) {
      allocationHost.appendChild(node("h3", "Earnings allocated by project and entry"));
      allocationHost.appendChild(node("p", "Paid and reserved here include only explicitly allocated payments. Monthly payments stay unassigned until reconciled in Allocations. Project rows include their entries: do not add the two levels. A project allocation is not split across entries."));
      allocationHost.appendChild(renderDataTable({
        caption: "Allocation reconciliation",
        table: "payment-allocation-report",
        defaultSort: { column: 'name', direction: 'ascending' },
        rows: paymentAllocationRows(allocationReports, rows),
        rowKey: (r) => `${r.user_id}/${r.month}/${r.project_id}/${r.entry_id ?? 'project'}`,
        empty: "No reviewed project or entry earnings match these filters.",
        columns: [
          { key: "name", sortValue: (r) => r.name, label: "Person", render: (r) => r.name },
          { key: "month", sortValue: (r) => r.month, label: "Work month", render: (r) => r.month },
          { key: "level", sortValue: (r) => r.level, label: "Level", render: (r) => r.level },
          { key: "project", sortValue: (r) => `${r.project} ${r.entry_id ?? ""}`, label: "Project / entry", render: (r) => r.entry_id === null ? r.project : `${r.project} · entry ${r.entry_id}` },
          { key: "earned", numeric: true, sortValue: (r) => moneySort(r.earned, r.currency), label: "Earned", render: (r) => money(r.earned, r.currency) },
          { key: "paid", numeric: true, sortValue: (r) => moneySort(r.paid, r.currency), label: "Allocated paid", render: (r) => money(r.paid, r.currency) },
          { key: "reserved", numeric: true, sortValue: (r) => moneySort(r.reserved, r.currency), label: "Allocated reserved", render: (r) => money(r.reserved, r.currency) },
          { key: "remaining", numeric: true, sortValue: (r) => moneySort(r.remaining, r.currency), label: "Remaining to allocate", render: (r) => money(r.remaining, r.currency) },
          { key: "flags", sortValue: (r) => r.flags, label: "Review flags", render: (r) => r.flags },
        ],
      }));
    }
    const totals = el(reportSection, "[data-run-report-totals]");
    totals.replaceChildren();
    for (const [currency, t] of paymentReportTotals(rows)) {
      const line = node("p", `${currency} · owed `);
      for (const part of [
        money(t.owed, currency),
        " · recorded paid ",
        money(t.paid, currency),
        " · reserved ",
        money(t.reserved, currency),
        " · available to pay ",
        money(t.available, currency),
        " · historically settled contractor cost ",
        money(t.historical, currency),
      ])
        line.appendChild(
          typeof part === "string" ? document.createTextNode(part) : part,
        );
      totals.appendChild(line);
    }
    totals.appendChild(
      node(
        "p",
        `${rows.filter((r) => r.amount_cents === null).length} unspecified amounts excluded from monetary totals. ${items.filter((i) => i.state === "failed").length} failed/refunded transfers. Historical amounts reflect current contractor costs, separate from recorded payments. Figures reflect current records for the selected work months.`,
      ),
    );
    el(reportSection, "[data-run-report-balances]").replaceChildren(
      renderDataTable({
        caption: "Balances by person and work month",
        table: "payment-report-balances",
        defaultSort: { column: 'name', direction: 'ascending' },
        rows,
        rowKey: (r) => `${r.user_id}/${r.month}`,
        empty: "No matching balances.",
        columns: [
          {
            key: "name",
            label: "Person",
            sortValue: (r) => r.name,
            render: (r) => r.name,
          },
          {
            key: "month",
            label: "Work month",
            sortValue: (r) => r.month,
            render: (r) => r.month,
          },
          {
            key: "owed",
            label: "Owed",
            sortValue: (r) => moneySort(r.amount_cents, r.currency),
            render: (r) => {
              const value = money(r.amount_cents, r.currency);
              if (r.amount_basis === "contractor_cost")
                value.appendChild(
                  document.createTextNode(" · contractor cost"),
                );
              return value;
            },
          },
          {
            key: "paid",
            label: "Recorded paid",
            sortValue: (r) => moneySort(r.status === "settled" ? null : r.paid_cents, r.currency),
            render: (r) =>
              money(r.status === "settled" ? null : r.paid_cents, r.currency),
          },
          {
            key: "reserved",
            label: "Reserved",
            sortValue: (r) => moneySort(r.reserved_cents ?? 0, r.currency),
            render: (r) => money(r.reserved_cents ?? 0, r.currency),
          },
          {
            key: "available",
            label: "Available to pay",
            sortValue: (r) => moneySort(r.available_cents ?? r.balance_cents, r.currency),
            render: (r) =>
              money(r.available_cents ?? r.balance_cents, r.currency),
          },
          { key: "status", label: "Status", sortValue: (r) => r.status, render: (r) => r.status },
        ],
      }),
    );
    el(reportSection, "[data-run-report-transfers]").replaceChildren(
      renderDataTable({
        caption: "Transfer progress",
        table: "payment-report-transfers",
        defaultSort: { column: 'schedule', direction: 'ascending' },
        rows: items,
        rowKey: (i) => i.id,
        empty: "No matching transfers.",
        columns: [
          { key: "run", label: "Run", sortValue: (i) => i.run_name, render: (i) => i.run_name },
          { key: "name", label: "Person", sortValue: (i) => i.name, render: (i) => `${i.name}${i.purpose === "advance" ? " · Advance deposit" : ""}` },
          { key: "month", label: "Work month", sortValue: (i) => i.month, render: (i) => i.month },
          {
            key: "amount",
            label: "Recipient amount",
            sortValue: (i) => moneySort(i.amount_cents, i.currency),
            render: (i) => money(i.amount_cents, i.currency),
          },
          {
            key: "schedule",
            label: "Scheduled start",
            sortValue: (i) => Date.parse(i.scheduled_at),
            render: (i) => new Date(i.scheduled_at).toLocaleString(),
          },
          {
            key: "state",
            label: "Status",
            sortValue: (i) => paymentStateLabel(i.state),
            render: (i) => paymentStateLabel(i.state),
          },
          {
            key: "cost",
            label: "Source cost (quote)",
            sortValue: (i) => moneySort((i.execution_quote ?? i.quote).source_cents, i.quote.source_currency),
            render: (i) =>
              money(
                (i.execution_quote ?? i.quote).source_cents,
                i.quote.source_currency,
              ),
          },
          {
            key: "fee",
            label: "Fee (quote)",
            sortValue: (i) => moneySort((i.execution_quote ?? i.quote).fee_cents, i.quote.source_currency),
            render: (i) =>
              money(
                (i.execution_quote ?? i.quote).fee_cents,
                i.quote.source_currency,
              ),
          },
          {
            key: "ref",
            label: "Wise transfer",
            sortValue: (i) => i.transfer_id,
            render: (i) => i.transfer_id ?? "",
          },
          { key: "failure", label: "Details", sortValue: (i) => i.failure || null, render: (i) => i.failure ?? "" },
        ],
      }),
    );
    el(reportSection, "[data-run-report-receipts]").replaceChildren(
      renderDataTable({
        caption: "Recorded payments (excluding voided receipts)",
        table: "payment-report-receipts",
        defaultSort: { column: 'date', direction: 'descending' },
        rows: receipts,
        rowKey: (r) => r.id,
        empty: "No matching recorded payments.",
        columns: [
          { key: "name", label: "Person", sortValue: (r) => r.name, render: (r) => r.name },
          { key: "month", label: "Work month", sortValue: (r) => r.month, render: (r) => r.month },
          {
            key: "date",
            label: "Payment / confirmation date",
            sortValue: (r) => r.paid_on,
            render: (r) => r.paid_on ?? "",
          },
          {
            key: "amount",
            label: "Amount",
            sortValue: (r) => moneySort(r.amount_cents, r.currency),
            render: (r) => money(r.amount_cents, r.currency),
          },
          { key: "provider", label: "Provider", sortValue: (r) => r.source, render: (r) => r.source },
          { key: "reference", label: "Reference", sortValue: (r) => r.reference || null, render: (r) => r.reference },
        ],
      }),
    );
  };
  const refresh = async () => {
    if (!api.getPaymentRunReport || !signal || signal.aborted) return;
    const active = signal, sessionRevision = sessionGeneration
    const own = ++generation;
    const current = () => signal === active && !active.aborted && own === generation && sessionRevision === sessionGeneration
    const from = reportMode ? input(reportForm, "from").value : snapshot?.month;
    const to = reportMode ? input(reportForm, "to").value : from;
    if (!from || !to) return;
    const result = await api.getPaymentRunReport(from, to, active);
    if (!current()) return;
    const allocations: PaymentAllocationReport[] = [];
    if (reportMode && api.getPaymentAllocationReport) {
      // One read per month (not per person); sequential reads bound API pressure.
      for (const ledger of result.ledgers) {
        allocations.push(await api.getPaymentAllocationReport(ledger.month, active));
        if (!current()) return;
      }
    }
    const financials: PaymentFinancialSources = {invoices: [], advances: null};
    if (reportMode && api.getStaffInvoiceReport) {
      for (const ledger of result.ledgers) {
        financials.invoices.push(await api.getStaffInvoiceReport(ledger.month, active));
        if (!current()) return;
      }
    }
    if (reportMode && api.getAdvanceCreditReport) {
      financials.advances = await api.getAdvanceCreditReport(`${from}-01`, paymentMonthEnd(to), active);
      if (!current()) return;
    }
    data = result;
    financialSources = financials;
    allocationReports = allocations;
    if (reportMode) paintReport();
    else paintHistory();
  };
  const confirmLabel = (run: PaymentRun, total: bigint, basis: string) => {
    el(section, "[data-run-confirm]").replaceChildren(
      document.createTextNode(
        `${input(form, "timing").value === "now" ? "Send" : "Schedule"} ${run.items.length} ${run.items.length === 1 ? "payment" : "payments"} · ${basis} `,
      ),
      money(total, run.source_currency),
    );
  };
  const paintReview = (run: PaymentRun) => {
    draft = run;
    review.hidden = false;
    form.hidden = true;
    el(section, "[data-run-review-summary]").textContent =
      `${run.name}: ${run.items.length} ${run.items.length === 1 ? "payment" : "payments"} from the Wise ${run.source_currency} balance. ${input(form, "timing").value === "now" ? "Starts after approval" : `Starts ${new Date(run.scheduled_at).toLocaleString()} (${timezone})`}. Review expires in 30 minutes.`;
    el(section, "[data-run-review-items]").replaceChildren(
      renderDataTable({
        caption: "Payment confirmation",
        rows: run.items,
        rowKey: (i) => i.id,
        empty: "No payments.",
        columns: [
          {
            key: "person",
            label: "Person / Wise recipient",
            render: (i) => `${i.name} (${i.month})${i.purpose === "advance" ? " · Advance deposit" : ""} → ${i.quote.recipient_name}`,
          },
          {
            key: "destination",
            label: "Destination",
            render: (i) => `Wise recipient ${i.quote.recipient_id}`,
          },
          {
            key: "amount",
            label: "Recipient receives",
            render: (i) => money(i.amount_cents, i.currency),
          },
          {
            key: "fee",
            label: "Fee estimate",
            render: (i) => money(i.quote.fee_cents, run.source_currency),
          },
          {
            key: "source",
            label: "Total cost estimate",
            render: (i) => money(i.quote.source_cents, run.source_currency),
          },
          {
            key: "arrival",
            label: "Estimated arrival",
            render: (i) =>
              i.quote.estimated_arrival ?? "Available when processing",
          },
          {
            key: "limit",
            label: `Maximum cost (${run.source_currency})`,
            render: (i) => {
              const control = document.createElement("input");
              control.name = i.id;
              control.inputMode = "decimal";
              control.required = true;
              control.value = (i.quote.source_cents / 100).toFixed(2);
              control.setAttribute("aria-label", `Maximum cost for ${i.name}`);
              return control;
            },
          },
        ],
      }),
    );
    const total = run.items.reduce(
      (sum, i) => sum + BigInt(i.quote.source_cents),
      0n,
    );
    confirmLabel(run, total, "estimated");
  };
  approvalForm.addEventListener("input", () => {
    if (!draft) return;
    try {
      const total = draft.items.reduce(
        (sum, item) =>
          sum + BigInt(staffPaymentAmount(input(approvalForm, item.id).value)),
        0n,
      );
      confirmLabel(draft, total, "up to");
    } catch {
      el(section, "[data-run-confirm]").textContent =
        "Confirm approved amounts";
    }
  });
  form.addEventListener("input", () => {
    pendingCommand = null;
  });
  input(form, "timing").addEventListener("change", () => {
    const scheduled = input(form, "timing").value === "scheduled";
    el(section, "[data-run-schedule]").hidden = !scheduled;
    input(form, "scheduled_at").required = scheduled;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // An Enter key still submits a form whose button is hidden.
    if (demo) return;
    void action(async (active, current) => {
      if (!snapshot || !api.previewPaymentRun) return;
      const selectedLedger = snapshot;
      const selected = snapshot.rows.filter(
        (row) =>
          (
            form.elements.namedItem(
              `select-${row.user_id}`,
            ) as HTMLInputElement | null
          )?.checked,
      );
      // The label only helps a person find the run later, so a blank one is
      // named from what was selected rather than asked for.
      const label =
        input(form, "run_name").value.trim() ||
        (selected.length === 1
          ? `${selected[0]!.name} · ${selected[0]!.month}`
          : `${selected.length} payments · ${snapshot.month}`);
      pendingCommand ??= {
        id: crypto.randomUUID(),
        name: label.slice(0, 100),
        source_currency: input(form, "source_currency")
          .value.trim()
          .toUpperCase(),
        scheduled_at:
          input(form, "timing").value === "now"
            ? new Date().toISOString()
            : new Date(input(form, "scheduled_at").value).toISOString(),
        timezone,
        items: selected.map((row) => ({
            user_id: row.user_id,
            month: row.month,
            expected_version: row.version,
            amount_cents: staffPaymentAmount(
              input(form, `amount-${row.user_id}`).value,
            ),
          })),
      };
      if (!pendingCommand.items.length)
        throw new Error("Select at least one person to pay.");
      const run = await api.previewPaymentRun(pendingCommand, active);
      if (current() && snapshot === selectedLedger) paintReview(run);
    }, status, 'Reviewing payments…');
  });
  approvalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async (active, current) => {
      if (!draft || !api.approvePaymentRun) return;
      await api.approvePaymentRun(
        draft.id,
        {
          limits: draft.items.map((i) => ({
            item_id: i.id,
            max_source_cents: staffPaymentAmount(
              input(approvalForm, i.id).value,
            ),
          })),
        },
        active,
      );
      if (!current()) return;
      draft = null;
      pendingCommand = null;
      review.hidden = true;
      form.hidden = false;
      await reload();
      if (!current()) return
      await refresh();
      if (current()) onApproved();
    }, status, 'Confirming payment run…');
  });
  el(section, "[data-run-back]").addEventListener("click", () => {
    draft = null;
    pendingCommand = null;
    review.hidden = true;
    form.hidden = false;
  });
  input(reportForm, "show_empty").addEventListener("change", paintReport);
  reportForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(refresh, reportStatus, 'Loading payment report…');
  });
  for (const name of ["person", "currency", "status"])
    input(reportForm, name).addEventListener("input", paintReport);
  el(reportSection, "[data-run-report-export]").addEventListener(
    "click",
    () => {
      if (!data) return;
      const url = URL.createObjectURL(
        new Blob([paymentRunCsv(data, filters(), allocationReports, financialSources)], {
          type: "text/csv;charset=utf-8",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `payments-${data.from}-${data.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  );
  return {
    resetSelection: () => {
      snapshot = null;
      draft = null;
      pendingCommand = null;
      review.hidden = true;
      form.hidden = false;
      el(section, "[data-run-selection]").replaceChildren();
    },
    payNow: (userId?: number) => {
      if (busy || !signal || signal.aborted) return;
      if (userId !== undefined) {
        if (
          !snapshot?.rows.some(
            (row) => row.user_id === userId && canPayNow(row),
          )
        )
          return;
        draft = null;
        pendingCommand = null;
        review.hidden = true;
        form.hidden = false;
        for (const checkbox of form.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        )) {
          checkbox.checked = checkbox.name === `select-${userId}`;
        }
        input(form, "timing").value = "now";
        input(form, "timing").dispatchEvent(new Event("change"));
        const row = snapshot.rows.find((row) => row.user_id === userId)!;
        input(form, `amount-${userId}`).value = (
          (row.available_cents ?? row.balance_cents ?? 0) / 100
        ).toFixed(2);
        input(form, `amount-${userId}`).focus();
        input(form, `amount-${userId}`).select();
      } else {
        (draft
          ? el<HTMLButtonElement>(section, "[data-run-confirm]")
          : input(form, "run_name")
        ).focus();
      }
    },
    activate: async (active: AbortSignal) => {
      sessionGeneration++
      generation++
      restoreControls()
      busy = false
      setRequestBusy(status, false)
      setRequestBusy(reportStatus, false)
      signal = active;
      section.hidden = reportMode || !api.previewPaymentRun;
      reportSection.hidden = !reportMode;
      active.addEventListener(
        "abort",
        () => {
          if (signal !== active) return
          sessionGeneration++
          generation++;
          restoreControls()
          busy = false
          status.textContent = ''
          reportStatus.textContent = ''
          setRequestBusy(status, false)
          setRequestBusy(reportStatus, false)
          snapshot = null;
          draft = null;
          data = null;
          allocationReports = [];
          financialSources = {invoices: [], advances: null};
          pendingCommand = null;
          section.hidden = true;
          reportSection.hidden = true;
          el(section, "[data-run-history]").replaceChildren();
          el(section, "[data-run-review-items]").replaceChildren();
          for (const selector of [
            "financials",
            "allocations",
            "totals",
            "balances",
            "transfers",
            "receipts",
          ])
            el(
              reportSection,
              `[data-run-report-${selector}]`,
            ).replaceChildren();
        },
        { once: true },
      );
      if (reportMode) {
        const month = previousPaymentMonth(
          new Intl.DateTimeFormat("en-CA", {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date()),
        );
        input(reportForm, "from").value = month;
        input(reportForm, "to").value = month;
        await action(refresh, reportStatus, 'Loading payment report…');
      }
    },
    ledger: (report: StaffPaymentReport) => {
      if (snapshot && snapshot.month !== report.month) {
        draft = null;
        pendingCommand = null;
        review.hidden = true;
        form.hidden = false;
      }
      snapshot = report;
      if (reportMode) return;
      const eligible = report.rows.filter(canPayNow);
      el(section, "[data-run-selection]").replaceChildren(
        renderDataTable({
          caption: "Choose payments from the selected month",
          rows: eligible,
          rowKey: (r) => String(r.user_id),
          empty:
            "No available Wise balances. Set amounts owed and verified destinations in the ledger.",
          columns: [
            {
              key: "selected",
              label: "Pay",
              render: (r) => {
                const c = document.createElement("input");
                c.type = "checkbox";
                c.name = `select-${r.user_id}`;
                c.setAttribute("aria-label", `Pay ${r.name}`);
                return c;
              },
            },
            { key: "name", label: "Person", render: (r) => r.name },
            {
              key: "available",
              label: "Available",
              render: (r) =>
                money(r.available_cents ?? r.balance_cents, r.currency),
            },
            {
              key: "amount",
              label: "Amount to send",
              render: (r) => {
                const c = document.createElement("input");
                c.name = `amount-${r.user_id}`;
                c.inputMode = "decimal";
                c.value = (
                  (r.available_cents ?? r.balance_cents ?? 0) / 100
                ).toFixed(2);
                c.setAttribute("aria-label", `Amount for ${r.name}`);
                return c;
              },
            },
          ],
        }),
      );
      void refresh().catch((error) => {
        if (!signal?.aborted) status.textContent = errorText(error);
      });
    },
  };
};
