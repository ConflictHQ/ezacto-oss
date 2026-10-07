import { previousPaymentMonth } from "@ezacto/core";
import type {
  PaymentRun,
  PaymentRunCommand,
  PaymentRunApproval,
  PaymentRunReport,
  StaffPaymentReport,
} from "@ezacto/core";
import { moneyText } from "../money-display.js";
import { renderDataTable } from "../components/data-table.js";
import { isDemoDeployment } from "../demo.js";
import { staffPaymentAmount, staffPaymentMoney } from "./model.js";
import {
  canPayNow,
  filteredPaymentReport,
  paymentReportTotals,
  paymentRunCsv,
  paymentStateLabel,
} from "./runs-model.js";
export interface PaymentRunsApi {
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
    busy = false,
    generation = 0;
  let pendingCommand: PaymentRunCommand | null = null;
  const action = async (work: () => Promise<void>, target = status) => {
    if (busy || !signal || signal.aborted) return;
    busy = true;
    target.textContent = "Working…";
    const controls = [
      ...(reportMode
        ? reportSection
        : section
      ).querySelectorAll<HTMLInputElement>("input,select,button"),
    ];
    const prior = controls.map((control) => control.disabled);
    controls.forEach((control) => {
      control.disabled = true;
    });
    try {
      await work();
      if (!signal.aborted) target.textContent = "";
    } catch (error) {
      if (!signal.aborted) target.textContent = errorText(error);
    } finally {
      busy = false;
      controls.forEach((control, index) => {
        control.disabled = prior[index] ?? false;
      });
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
          rows: run.items,
          rowKey: (i) => i.id,
          empty: "No payments.",
          columns: [
            {
              key: "name",
              label: "Person",
              render: (i) => `${i.name} · ${i.month}`,
            },
            {
              key: "amount",
              label: "Recipient receives",
              render: (i) => money(i.amount_cents, i.currency),
            },
            {
              key: "state",
              label: "Status",
              render: (i) => paymentStateLabel(i.state),
            },
            {
              key: "reference",
              label: "Wise transfer",
              render: (i) => i.transfer_id ?? "Not created",
            },
            {
              key: "failure",
              label: "Details",
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
                    void action(async () => {
                      await api.reconcilePaymentRunItem!(run.id, i.id, signal);
                      await refresh();
                    }),
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
            void action(async () => {
              await api.cancelPaymentRun!(run.id, signal);
              await reload();
              await refresh();
            }),
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
            render: (r) =>
              money(r.status === "settled" ? null : r.paid_cents, r.currency),
          },
          {
            key: "reserved",
            label: "Reserved",
            render: (r) => money(r.reserved_cents ?? 0, r.currency),
          },
          {
            key: "available",
            label: "Available to pay",
            render: (r) =>
              money(r.available_cents ?? r.balance_cents, r.currency),
          },
          { key: "status", label: "Status", render: (r) => r.status },
        ],
      }),
    );
    el(reportSection, "[data-run-report-transfers]").replaceChildren(
      renderDataTable({
        caption: "Transfer progress",
        rows: items,
        rowKey: (i) => i.id,
        empty: "No matching transfers.",
        columns: [
          { key: "run", label: "Run", render: (i) => i.run_name },
          { key: "name", label: "Person", render: (i) => i.name },
          { key: "month", label: "Work month", render: (i) => i.month },
          {
            key: "amount",
            label: "Recipient amount",
            render: (i) => money(i.amount_cents, i.currency),
          },
          {
            key: "schedule",
            label: "Scheduled start",
            render: (i) => new Date(i.scheduled_at).toLocaleString(),
          },
          {
            key: "state",
            label: "Status",
            render: (i) => paymentStateLabel(i.state),
          },
          {
            key: "cost",
            label: "Source cost (quote)",
            render: (i) =>
              money(
                (i.execution_quote ?? i.quote).source_cents,
                i.quote.source_currency,
              ),
          },
          {
            key: "fee",
            label: "Fee (quote)",
            render: (i) =>
              money(
                (i.execution_quote ?? i.quote).fee_cents,
                i.quote.source_currency,
              ),
          },
          {
            key: "ref",
            label: "Wise transfer",
            render: (i) => i.transfer_id ?? "",
          },
          { key: "failure", label: "Details", render: (i) => i.failure ?? "" },
        ],
      }),
    );
    el(reportSection, "[data-run-report-receipts]").replaceChildren(
      renderDataTable({
        caption: "Recorded payments (excluding voided receipts)",
        rows: receipts,
        rowKey: (r) => r.id,
        empty: "No matching recorded payments.",
        columns: [
          { key: "name", label: "Person", render: (r) => r.name },
          { key: "month", label: "Work month", render: (r) => r.month },
          {
            key: "date",
            label: "Payment / confirmation date",
            render: (r) => r.paid_on ?? "",
          },
          {
            key: "amount",
            label: "Amount",
            render: (r) => money(r.amount_cents, r.currency),
          },
          { key: "provider", label: "Provider", render: (r) => r.source },
          { key: "reference", label: "Reference", render: (r) => r.reference },
        ],
      }),
    );
  };
  const refresh = async () => {
    if (!api.getPaymentRunReport || !signal || signal.aborted) return;
    const own = ++generation;
    const from = reportMode ? input(reportForm, "from").value : snapshot?.month;
    const to = reportMode ? input(reportForm, "to").value : from;
    if (!from || !to) return;
    const result = await api.getPaymentRunReport(from, to, signal);
    if (signal.aborted || own !== generation) return;
    data = result;
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
            render: (i) => `${i.name} (${i.month}) → ${i.quote.recipient_name}`,
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
    void action(async () => {
      if (!snapshot || !api.previewPaymentRun) return;
      const selectedLedger = snapshot;
      pendingCommand ??= {
        id: crypto.randomUUID(),
        name: input(form, "run_name").value.trim(),
        source_currency: input(form, "source_currency")
          .value.trim()
          .toUpperCase(),
        scheduled_at:
          input(form, "timing").value === "now"
            ? new Date().toISOString()
            : new Date(input(form, "scheduled_at").value).toISOString(),
        timezone,
        items: snapshot.rows
          .filter(
            (row) =>
              (
                form.elements.namedItem(
                  `select-${row.user_id}`,
                ) as HTMLInputElement | null
              )?.checked,
          )
          .map((row) => ({
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
      const run = await api.previewPaymentRun(pendingCommand, signal);
      if (!signal?.aborted && snapshot === selectedLedger) paintReview(run);
    });
  });
  approvalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(async () => {
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
        signal,
      );
      if (signal?.aborted) return;
      draft = null;
      pendingCommand = null;
      review.hidden = true;
      form.hidden = false;
      await reload();
      await refresh();
      if (!signal?.aborted) onApproved();
    });
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
    void action(refresh, reportStatus);
  });
  for (const name of ["person", "currency", "status"])
    input(reportForm, name).addEventListener("input", paintReport);
  el(reportSection, "[data-run-report-export]").addEventListener(
    "click",
    () => {
      if (!data) return;
      const url = URL.createObjectURL(
        new Blob([paymentRunCsv(data, filters())], {
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
      if (!input(form, "run_name").value.trim() && snapshot) {
        const name =
          snapshot.rows.find((row) => row.user_id === userId)?.name ??
          "Payments";
        input(form, "run_name").value = `${name} · ${snapshot.month}`.slice(
          0,
          100,
        );
      }
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
      signal = active;
      section.hidden = reportMode || !api.previewPaymentRun;
      reportSection.hidden = !reportMode;
      active.addEventListener(
        "abort",
        () => {
          generation++;
          snapshot = null;
          draft = null;
          data = null;
          pendingCommand = null;
          section.hidden = true;
          reportSection.hidden = true;
          el(section, "[data-run-history]").replaceChildren();
          el(section, "[data-run-review-items]").replaceChildren();
          for (const selector of [
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
        await action(refresh, reportStatus);
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
