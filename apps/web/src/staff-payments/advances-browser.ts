import {
  paymentMonthEnd,
  type AdvanceCredit,
  type AdvanceCreditReport,
  type ApplyAdvanceCredit,
  type ReverseAdvanceCredit,
  type ReturnAdvanceCredit,
  type StaffPaymentReport,
  type PaymentRun,
} from "@ezacto/core";
import { renderDataTable } from "../components/data-table.js";
import { moneyText } from "../money-display.js";
import { demoUnavailable, isDemoDeployment } from "../demo.js";
import { staffPaymentAmount, staffPaymentMoney } from "./model.js";
import type { PaymentRunsApi } from "./runs-browser.js";
import type { PaymentAllocationsApi } from "./allocations-browser.js";

export interface AdvanceCreditsApi
  extends PaymentRunsApi, PaymentAllocationsApi {
  getAdvanceCreditReport?(
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<AdvanceCreditReport>;
  applyAdvanceCredit?(
    command: ApplyAdvanceCredit,
    signal?: AbortSignal,
  ): Promise<void>;
  reverseAdvanceCredit?(
    command: ReverseAdvanceCredit,
    signal?: AbortSignal,
  ): Promise<void>;
  returnAdvanceCredit?(
    command: ReturnAdvanceCredit,
    signal?: AbortSignal,
  ): Promise<void>;
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
};
const field = <T extends Node>(
  form: HTMLElement,
  name: string,
  control: T,
): T => {
  const label = node("label", `${name} `);
  label.appendChild(control);
  form.appendChild(label);
  return control;
};
const input = (form: HTMLElement, name: string, value = "", type = "text") => {
  const control = field(form, name, node("input"));
  control.setAttribute("aria-label", name);
  control.type = type;
  control.value = value;
  control.required = true;
  return control;
};
const button = (form: HTMLElement, text: string) => {
  const control = node("button", text);
  control.type = "submit";
  form.appendChild(control);
  return control;
};
const option = (select: HTMLSelectElement, value: string, label: string) => {
  const item = node("option", label);
  item.value = value;
  select.appendChild(item);
};
const money = (amount: number, currency: string) =>
  moneyText(staffPaymentMoney(amount, currency));

export const createAdvanceCreditsController = (
  page: HTMLElement,
  api: AdvanceCreditsApi,
  errorText: (error: unknown) => string,
) => {
  const panel = page.querySelector<HTMLElement>("[data-payment-advances]")!;
  const host = panel.querySelector<HTMLElement>("[data-advance-content]")!;
  const status = panel.querySelector<HTMLElement>("[data-advance-status]")!;
  const dates = panel.querySelector<HTMLFormElement>("[data-advance-period]")!;
  const from = dates.elements.namedItem("from") as HTMLInputElement;
  const to = dates.elements.namedItem("to") as HTMLInputElement;
  let signal: AbortSignal | null = null,
    generation = 0,
    ledger: StaffPaymentReport | null = null,
    busy = false;
  const action = async (work: () => Promise<void>) => {
    const active = signal,
      own = generation;
    if (!active || active.aborted || busy) return;
    busy = true;
    status.textContent = "Working…";
    const controls = [
      ...panel.querySelectorAll<HTMLInputElement>(
        "input,select,button,textarea",
      ),
    ];
    const disabled = controls.map((control) => control.disabled);
    controls.forEach((control) => {
      control.disabled = true;
    });
    try {
      await work();
      if (!active.aborted && own === generation) status.textContent = "";
    } catch (error) {
      if (!active.aborted && own === generation)
        status.textContent = errorText(error);
    } finally {
      if (own === generation) {
        busy = false;
        controls.forEach((control, index) => {
          control.disabled = disabled[index] ?? false;
        });
      }
    }
  };
  const load = async () => {
    if (!api.getAdvanceCreditReport || !signal || signal.aborted) return;
    const active = signal,
      own = generation;
    const report = await api.getAdvanceCreditReport(
      from.value,
      to.value,
      active,
    );
    if (active.aborted || own !== generation) return;
    host.replaceChildren(
      node(
        "p",
        `Credit statement: ${report.from} through ${report.to}. Opening + settled advances − applications (net of reversals) − returned credit = closing credit. Each currency is separate. Pending transfers cannot be applied.`,
      ),
    );
    host.appendChild(
      renderDataTable({
        table: "advance-credit-statement",
        defaultSort: { column: 'name', direction: 'ascending' },
        caption: "Contractor advance credit",
        rows: report.advances,
        rowKey: (r) => r.advance_item_id,
        empty: "No advance deposits have been prepared.",
        columns: [
          {
            key: "name",
            label: "Person",
            sortValue: (r) => r.name,
            render: (r) => r.name,
          },
          {
            key: "intent",
            label: "Intended work month",
            sortValue: (r) => r.month,
            render: (r) => r.month,
          },
          { key: "state", label: "State", sortValue: (r) => r.state, render: (r) => r.state },
          ...(
            [
              "opening_cents",
              "period_settled_cents",
              "period_applied_cents",
              "period_returned_cents",
              "closing_cents",
              "reserved_cents",
              "available_cents",
            ] as const
          ).map((key, index) => ({
            key,
            label: [
              "Opening",
              "Settled in period",
              "Applied in period",
              "Returned in period",
              "Closing",
              "Pending funds",
              "Available now",
            ][index]!,
            numeric: true,
            sortValue: (r: AdvanceCredit) => [r.currency, r[key]] as const,
            render: (r: AdvanceCredit) => money(r[key], r.currency),
          })),
        ],
      }),
    );
    for (const credit of report.advances) {
      const detail = node("details"),
        summary = node(
          "summary",
          `${credit.name} · ${credit.currency} · ${credit.month} advance`,
        );
      detail.appendChild(summary);
      detail.appendChild(
        node(
          "p",
          `${credit.advance_reason} · ${credit.advance_project_id === null ? "No intended project" : `Intended project ${credit.advance_project_id}`}. Settled ${staffPaymentMoney(credit.settled_cents, credit.currency)}; applied ${staffPaymentMoney(credit.applied_cents, credit.currency)}; returned ${staffPaymentMoney(credit.returned_cents, credit.currency)}; unapplied ${staffPaymentMoney(credit.available_cents, credit.currency)}.`,
        ),
      );
      if (credit.available_cents > 0) {
        const select = node("form"),
          month = input(
            select,
            "Apply to reviewed work month",
            ledger?.month ?? credit.month,
            "month",
          );
        button(select, "Load eligible earnings");
        const target = node("div");
        select.addEventListener("submit", (event) => {
          event.preventDefault();
          void action(async () => {
            const own = generation,
              active = signal!;
            const report = await api.getPaymentAllocationReport!(
              month.value,
              active,
            );
            if (active.aborted || own !== generation) return;
            const person = report.people.find(
              (p) =>
                p.user_id === credit.user_id && p.currency === credit.currency,
            );
            target.replaceChildren();
            if (!person) {
              target.textContent =
                "No reviewed earnings in this currency for this person and month.";
              return;
            }
            const form = node("form"),
              scope = field(form, "Earning to pay", node("select"));
            scope.setAttribute("aria-label", "Earning to pay");
            const targets: {
              scope: ApplyAdvanceCredit["scope"];
              project_id: number | null;
              entry_id: number | null;
            }[] = [{ scope: "month", project_id: null, entry_id: null }];
            option(
              scope,
              "0",
              `Whole month · ${staffPaymentMoney(person.remaining_cents, person.currency)} unpaid / unreserved`,
            );
            for (const project of person.projects) {
              targets.push({
                scope: "project",
                project_id: project.project_id,
                entry_id: null,
              });
              option(
                scope,
                String(targets.length - 1),
                `${project.project_name} · ${staffPaymentMoney(project.remaining_cents, person.currency)} unallocated`,
              );
              for (const entry of project.entries) {
                targets.push({
                  scope: "entry",
                  project_id: project.project_id,
                  entry_id: entry.entry_id,
                });
                option(
                  scope,
                  String(targets.length - 1),
                  `${project.project_name} · ${entry.spent_date} · ${(entry.selected_seconds / 3600).toFixed(2)} h · ${staffPaymentMoney(entry.remaining_cents, person.currency)} unallocated${entry.source_changed ? " · Source changed: review actuals first" : ""}`,
                );
              }
            }
            const amount = input(form, "Credit to apply"),
              reason = input(form, "Application reason");
            amount.inputMode = "decimal";
            const acknowledgement = input(
              form,
              "I reviewed the earnings and want to apply credit without sending another payment",
              "",
              "checkbox",
            );
            let id = crypto.randomUUID();
            form.addEventListener("input", () => {
              id = crypto.randomUUID();
            });
            button(form, "Apply advance credit");
            form.addEventListener("submit", (e) => {
              e.preventDefault();
              if (!acknowledgement.checked) return;
              void action(async () => {
                const command: ApplyAdvanceCredit = {
                  id,
                  advance_item_id: credit.advance_item_id,
                  user_id: credit.user_id,
                  currency: credit.currency,
                  month: report.month,
                  amount_cents: staffPaymentAmount(amount.value),
                  ...targets[Number(scope.value)]!,
                  reason: reason.value.trim(),
                };
                await api.applyAdvanceCredit!(command, signal!);
                await load();
              });
            });
            target.appendChild(form);
          });
        });
        detail.appendChild(select);
        detail.appendChild(target);
        const returned = node("form"),
          amount = input(returned, "Confirmed return amount"),
          reference = input(returned, "Bank return reference"),
          reason = input(returned, "Return reason");
        const confirmed = input(
          returned,
          "I confirm these funds were already returned; this only records the return",
          "",
          "checkbox",
        );
        button(returned, "Record returned credit");
        const returnId = crypto.randomUUID();
        returned.addEventListener("submit", (event) => {
          event.preventDefault();
          if (!confirmed.checked) return;
          void action(async () => {
            await api.returnAdvanceCredit!(
              {
                id: returnId,
                advance_item_id: credit.advance_item_id,
                amount_cents: staffPaymentAmount(amount.value),
                reference: reference.value.trim(),
                reason: reason.value.trim(),
              },
              signal!,
            );
            await load();
          });
        });
        detail.appendChild(returned);
      }
      for (const application of credit.applications) {
        detail.appendChild(
          node(
            "p",
            `${application.month} · ${staffPaymentMoney(application.amount_cents, credit.currency)} · ${application.reason} · ${application.reversed_at ? `Reversed: ${application.reversal_reason}` : "Applied"}`,
          ),
        );
        if (application.reversed_at === null) {
          const form = node("form"),
            reason = input(form, "Reason to reverse credit application");
          button(form, "Reverse credit application");
          const reversalId = crypto.randomUUID();
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            void action(async () => {
              await api.reverseAdvanceCredit!(
                {
                  id: reversalId,
                  application_id: application.id,
                  reason: reason.value.trim(),
                },
                signal!,
              );
              await load();
            });
          });
          detail.appendChild(form);
        }
      }
      host.appendChild(detail);
    }
  };
  const prepare = () => {
    const box = panel.querySelector<HTMLElement>("[data-advance-create]")!;
    box.replaceChildren();
    if (!ledger) return;
    if (isDemoDeployment()) {
      box.appendChild(node("p", demoUnavailable("Preparing advance transfers")));
      return;
    }
    if (!api.previewPaymentRun || !api.approvePaymentRun) {
      box.appendChild(node("p", "Advance transfers are unavailable on this instance."));
      return;
    }
    if (!ledger.rows.some((r) => r.active && r.is_contractor !== false && r.wise_ready && r.payout_provider === "wise")) {
      box.appendChild(node("p", "No active contractors have a verified Wise destination with Wise selected. Set these in Team and Payment settings before preparing an advance."));
      return;
    }
    const form = node("form"),
      person = field(form, "Contractor receiving the advance", node("select"));
    person.setAttribute("aria-label", "Contractor receiving the advance");
    for (const row of ledger.rows.filter(
      (r) => r.active && r.is_contractor !== false && r.wise_ready && r.payout_provider === "wise",
    ))
      option(person, String(row.user_id), row.name);
    const month = input(form, "Intended work month", ledger.month, "month"),
      currency = input(form, "Advance currency", "USD"),
      source = input(form, "Source currency", "USD");
    const amount = input(form, "Advance amount"),
      reason = input(form, "Advance reason");
    amount.inputMode = "decimal";
    button(form, "Review advance transfer");
    const review = node("div");
    form.appendChild(review);
    let run: PaymentRun | null = null,
      runId = crypto.randomUUID();
    const invalidate = (event: Event) => {
      if (review.contains(event.target as Node)) return;
      run = null;
      runId = crypto.randomUUID();
      review.replaceChildren();
    };
    form.addEventListener("input", invalidate);
    form.addEventListener("change", invalidate);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void action(async () => {
        const active = signal!,
          own = generation;
        run = await api.previewPaymentRun!(
          {
            id: runId,
            name: `Advance · ${month.value}`,
            source_currency: source.value.trim().toUpperCase(),
            scheduled_at: new Date().toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            items: [
              {
                user_id: Number(person.value),
                month: month.value,
                amount_cents: staffPaymentAmount(amount.value),
                expected_version: 0,
                purpose: "advance",
                currency: currency.value.trim().toUpperCase(),
                advance_reason: reason.value.trim(),
                advance_project_id: null,
              },
            ],
          },
          active,
        );
        if (active.aborted || own !== generation) return;
        review.replaceChildren(
          node(
            "p",
            "Advance deposit, not payment of existing earnings. Pending funds are reserved; credit becomes usable only after confirmed settlement.",
          ),
        );
        const approvedRun = run;
        const limits = approvedRun.items.map((item) => {
          review.appendChild(
            node(
              "p",
              `${item.name} · ${item.month} · ${staffPaymentMoney(item.amount_cents, item.currency)} · ${item.advance_reason} · Verified Wise recipient: ${item.quote.recipient_name} · Estimated source cost including fees: ${staffPaymentMoney(item.quote.source_cents, approvedRun.source_currency)}`,
            ),
          );
          const max = input(
            review,
            "Maximum source cost including fees",
            (item.quote.source_cents / 100).toFixed(2),
          );
          return { item_id: item.id, max };
        });
        const send = node("button", "Confirm advance transfer");
        send.type = "button";
        send.addEventListener("click", () => {
          void action(async () => {
            if (run !== approvedRun) return;
            await api.approvePaymentRun!(
              approvedRun.id,
              {
                limits: limits.map((l) => ({
                  item_id: l.item_id,
                  max_source_cents: staffPaymentAmount(l.max.value),
                })),
              },
              signal!,
            );
            run = null;
            runId = crypto.randomUUID();
            review.replaceChildren(
              node(
                "p",
                "Advance approved. Follow its transfer in History; credit will appear after settlement.",
              ),
            );
            await load();
          });
        });
        review.appendChild(send);
      });
    });
    box.appendChild(form);
  };
  dates.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(load);
  });
  return {
    activate: (active: AbortSignal) => {
      signal = active;
      generation++;
      busy = false;
      ledger = null;
      host.replaceChildren();
      status.textContent = "";
      const today = new Date().toISOString().slice(0, 10);
      from.value = `${today.slice(0, 7)}-01`;
      to.value = paymentMonthEnd(today.slice(0, 7));
      active.addEventListener(
        "abort",
        () => {
          generation++;
          ledger = null;
          host.replaceChildren();
          panel.querySelector("[data-advance-create]")!.replaceChildren();
          status.textContent = "";
        },
        { once: true },
      );
    },
    ledger: (report: StaffPaymentReport) => {
      ledger = report;
      prepare();
    },
  };
};
