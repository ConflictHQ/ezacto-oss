import { isDemoDeployment, demoUnavailable } from "../demo.js";
import type {
  SaveStaffInvoice,
  StaffInvoice,
  StaffInvoiceLine,
  StaffInvoiceReport,
  StaffPaymentReport,
} from "@ezacto/core";
import { renderDataTable } from "../components/data-table.js";
import { moneyText } from "../money-display.js";
import { staffPaymentAmount, staffPaymentMoney } from "./model.js";
import type { PaymentAllocationsApi } from "./allocations-browser.js";
export interface StaffInvoicesApi extends PaymentAllocationsApi {
  getStaffInvoiceReport?(
    month: string,
    signal?: AbortSignal,
  ): Promise<StaffInvoiceReport>;
  saveStaffInvoice?(
    command: SaveStaffInvoice,
    signal?: AbortSignal,
  ): Promise<StaffInvoice>;
  uploadStaffInvoiceDocument?(
    invoiceId: number,
    month: string,
    id: string,
    file: File,
    signal?: AbortSignal,
  ): Promise<{ id: string }>;
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
};
const field = <T extends Node>(
  form: HTMLElement,
  label: string,
  control: T,
) => {
  const wrap = node("label", `${label} `);
  wrap.appendChild(control);
  form.appendChild(wrap);
  return control;
};
const input = (form: HTMLElement, label: string, value = "", type = "text") => {
  const n = field(form, label, node("input"));
  n.type = type;
  n.value = value;
  n.required = true;
  n.setAttribute("aria-label", label);
  return n;
};
const button = (
  form: HTMLElement,
  label: string,
  type: "button" | "submit" = "submit",
) => {
  const n = node("button", label);
  n.type = type;
  form.appendChild(n);
  return n;
};
const option = (select: HTMLSelectElement, value: string, text: string) => {
  const n = node("option", text);
  n.value = value;
  select.appendChild(n);
};
const money = (amount: number | null, currency: string | null) =>
  moneyText(staffPaymentMoney(amount, currency));
const fileLink = (invoice: StaffInvoice, documentId: string) => {
  const link = node("a", "Download invoice document");
  link.href = `/api/v1/staff-invoices/${invoice.id}/documents/${encodeURIComponent(documentId)}/content`;
  return link;
};
/** Shared read-only view; the own-person API decides which versions/documents
 * are visible. No identity or file-storage key can be entered through this UI. */
export const renderStaffInvoiceDocuments = (
  report: StaffInvoiceReport,
): HTMLElement => {
  const host = node("section");
  host.appendChild(node("h3", "Contractor invoice documents"));
  const invoices = report.people.flatMap((p) => p.invoices);
  if (!invoices.length)
    host.appendChild(
      node(
        "p",
        "No received contractor invoices are recorded for this work month.",
      ),
    );
  for (const invoice of invoices) {
    const detail = node("details");
    detail.appendChild(
      node(
        "summary",
        `${invoice.reference} · ${invoice.month} · ${invoice.versions.at(-1)!.kind}`,
      ),
    );
    for (const version of invoice.versions) {
      const line = node(
        "p",
        `Version ${version.version} · ${version.month} · ${version.currency} · ${version.kind} · ${version.recorded_at.slice(0, 10)} · `,
      );
      line.appendChild(money(version.amount_cents, version.currency));
      line.appendChild(document.createTextNode(` · ${version.reason}`));
      detail.appendChild(line);
      if (version.document_id)
        detail.appendChild(fileLink(invoice, version.document_id));
    }
    for (const flag of invoice.flags) detail.appendChild(node("p", flag));
    host.appendChild(detail);
  }
  return host;
};
export const createStaffInvoicesController = (
  page: HTMLElement,
  api: StaffInvoicesApi,
  errorText: (error: unknown) => string,
) => {
  const panel = page.querySelector<HTMLElement>("[data-staff-invoices]")!,
    host = panel.querySelector<HTMLElement>("[data-staff-invoice-content]")!,
    status = panel.querySelector<HTMLElement>("[data-staff-invoice-status]")!,
    refresh = panel.querySelector<HTMLButtonElement>(
      "[data-staff-invoice-load]",
    )!;
  let signal: AbortSignal | null = null,
    ledger: StaffPaymentReport | null = null,
    generation = 0,
    busy = false;
  const action = async (work: () => Promise<void>) => {
    const active = signal,
      own = generation;
    if (!active || active.aborted || busy) return;
    busy = true;
    status.textContent = "Working…";
    const controls = [
        ...panel.querySelectorAll<HTMLInputElement>(
          "input,select,textarea,button",
        ),
      ],
      disabled = controls.map((c) => c.disabled);
    controls.forEach((c) => {
      c.disabled = true;
    });
    try {
      await work();
      if (
        !active.aborted &&
        own === generation &&
        status.textContent === "Working…"
      )
        status.textContent = "";
    } catch (error) {
      if (!active.aborted && own === generation)
        status.textContent = errorText(error);
    } finally {
      if (own === generation) {
        busy = false;
        controls.forEach((c, i) => {
          c.disabled = disabled[i] ?? false;
        });
      }
    }
  };
  const load = async () => {
    if (!ledger || !signal || signal.aborted || !api.getStaffInvoiceReport)
      return;
    const own = generation,
      active = signal,
      report = await api.getStaffInvoiceReport(ledger.month, active);
    if (active.aborted || own !== generation) return;
    host.replaceChildren(
      node(
        "p",
        "These payable invoices document existing earnings. Receiving or correcting an invoice does not change amounts owed, allocate payments, or create a customer invoice. Earnings without a matched invoice exclude unmatched or conflicting document lines.",
      ),
    );
    host.appendChild(
      renderDataTable({
        table: "staff-invoice-reconciliation",
        caption: "Earned, invoiced and paid by contractor and currency",
        rows: report.people,
        rowKey: (p) => `${p.user_id}/${p.currency}`,
        columns: [
          {
            key: "name",
            label: "Person",
            sortValue: (p) => p.name,
            render: (p) => p.name,
          },
          {
            key: "earned",
            sortValue: (p) =>
              p.earned_cents === null
                ? null
                : [p.currency ?? "", p.earned_cents],
            label: "Earned",
            numeric: true,
            render: (p) => money(p.earned_cents, p.currency),
          },
          {
            key: "invoiced",
            sortValue: (p) =>
              p.invoiced_cents === null
                ? null
                : [p.currency ?? "", p.invoiced_cents],
            label: "Received invoice total",
            numeric: true,
            render: (p) => money(p.invoiced_cents, p.currency),
          },
          {
            key: "matched",
            sortValue: (p) =>
              p.matched_invoice_cents === null
                ? null
                : [p.currency ?? "", p.matched_invoice_cents],
            label: "Matched to earnings",
            numeric: true,
            render: (p) => money(p.matched_invoice_cents, p.currency),
          },
          {
            key: "paid",
            sortValue: (p) =>
              p.paid_cents === null ? null : [p.currency ?? "", p.paid_cents],
            label: "Paid for work month",
            numeric: true,
            render: (p) => money(p.paid_cents, p.currency),
          },
          {
            key: "uninvoiced",
            sortValue: (p) =>
              p.uninvoiced_cents === null
                ? null
                : [p.currency ?? "", p.uninvoiced_cents],
            label: "Earnings without matched invoice",
            numeric: true,
            render: (p) => money(p.uninvoiced_cents, p.currency),
          },
        ],
      }),
    );
    const editor = node("section");
    editor.dataset.staffInvoiceEditor = "";
    host.appendChild(editor);
    const start = button(host, "Draft or record contractor invoice", "button");
    start.addEventListener("click", () => edit(editor, report));
    host.appendChild(renderStaffInvoiceDocuments(report));
    for (const person of report.people)
      for (const invoice of person.invoices) {
        const detail = node("details"),
          version = invoice.versions.at(-1)!;
        detail.appendChild(
          node("summary", `Review ${person.name} · ${invoice.reference}`),
        );
        detail.appendChild(
          renderDataTable({
            caption: `Lines on ${invoice.reference}`,
            rows: version.lines.map((line, index) => ({ ...line, index })),
            rowKey: (l) => String(l.index),
            columns: [
              {
                key: "description",
                sortValue: (l) => l.description,
                label: "Line",
                render: (l) => l.description,
              },
              {
                key: "hours",
                sortValue: (l) => l.seconds,
                label: "Hours",
                numeric: true,
                render: (l) => (l.seconds / 3600).toFixed(4),
              },
              {
                key: "rate",
                sortValue: (l) => l.rate_cents,
                label: "Rate",
                numeric: true,
                render: (l) => money(l.rate_cents, invoice.currency),
              },
              {
                key: "flags",
                sortValue: (l) => invoice.line_flags[l.index]?.join("; ") ?? "",
                label: "Match review",
                render: (l) =>
                  invoice.line_flags[l.index]?.join("; ") ||
                  "Matches reviewed earning",
              },
            ],
          }),
        );
        const correct = button(detail, "Record corrected version", "button");
        correct.addEventListener("click", () => edit(editor, report, invoice));
        documentForm(
          detail,
          invoice,
          person.paid_cents > 0 ||
            invoice.versions.some((v) => v.has_payment_history),
        );
        host.appendChild(detail);
      }
  };
  const edit = (
    target: HTMLElement,
    report: StaffInvoiceReport,
    existing?: StaffInvoice,
  ) => {
    if (!ledger) return;
    target.replaceChildren(
      node(
        "h3",
        existing
          ? `Correct ${existing.reference}`
          : "Draft or record a contractor invoice",
      ),
    );
    const form = node("form"),
      person = field(form, "Contractor", node("select"));
    person.setAttribute("aria-label", "Invoice contractor");
    for (const p of ledger.rows.filter((p) => p.is_contractor !== false))
      option(person, String(p.user_id), p.name);
    if (existing) {
      person.value = String(existing.user_id);
      person.disabled = true;
    }
    const workMonth = input(
      form,
      "Invoice work month",
      existing?.month ?? report.month,
      "month",
    );
    const reference = input(
        form,
        "Contractor invoice reference",
        existing?.reference ?? "",
      ),
      currency = input(
        form,
        "Invoice currency",
        existing?.currency ??
          ledger.rows.find((p) => String(p.user_id) === person.value)
            ?.currency ??
          "USD",
      ),
      kind = field(form, "Document state", node("select"));
    kind.setAttribute("aria-label", "Contractor invoice state");
    for (const value of ["draft", "received", "void"] as const)
      if (existing || value !== "void")
        if (
          value !== "draft" ||
          !existing ||
          existing.versions.at(-1)!.kind === "draft"
        )
          option(
            kind,
            value,
            value === "draft"
              ? "Draft from earnings"
              : value === "received"
                ? "Received from contractor"
                : "Void document",
          );
    person.addEventListener("change", () => {
      if (!existing)
        currency.value =
          ledger!.rows.find((p) => String(p.user_id) === person.value)
            ?.currency ?? "USD";
    });
    if (existing) {
      reference.readOnly = true;
      kind.value = existing.versions.at(-1)!.kind;
    }
    const fromReview = input(
      form,
      "Use reviewed hours and captured rates",
      "",
      "checkbox",
    );
    fromReview.checked = !existing;
    fromReview.required = false;
    const manual = node("div");
    form.appendChild(manual);
    const entries: {
      project_id: number;
      entry_id: number | null;
      key: string;
      name: string;
      seconds: number;
      rate_cents: number | null;
    }[] = [];
    const choices: HTMLSelectElement[] = [];
    const lineControls: {
      description: HTMLInputElement;
      hours: HTMLInputElement;
      rate: HTMLInputElement;
      earning: HTMLSelectElement;
      original: StaffInvoiceLine | null;
      removed: boolean;
    }[] = [];
    const addLine = (line?: StaffInvoiceLine) => {
      const row = node("fieldset");
      row.appendChild(node("legend", "Invoice line"));
      const description = input(
          row,
          "Line description",
          line?.description ?? "",
        ),
        hours = input(
          row,
          "Line hours",
          line ? String(line.seconds / 3600) : "",
          "number",
        ),
        rate = input(
          row,
          "Line hourly rate",
          line ? (line.rate_cents / 100).toFixed(2) : "",
        ),
        earning = field(row, "Reviewed earning", node("select"));
      hours.step = "any";
      rate.inputMode = "decimal";
      earning.setAttribute("aria-label", "Reviewed earning");
      option(earning, "unmatched", "Unmatched line (review required)");
      if (line?.project_id != null) {
        option(
          earning,
          `saved:${line.entry_id ?? "project-" + line.project_id}`,
          `Captured project ${line.project_id} · entry ${line.entry_id}`,
        );
        earning.value = `saved:${line.entry_id ?? "project-" + line.project_id}`;
      }
      for (const e of entries) option(earning, e.key, e.name);
      choices.push(earning);
      earning.addEventListener("change", () => {
        const entry = entries.find((e) => e.key === earning.value);
        if (entry) {
          hours.value = String(entry.seconds / 3600);
          rate.value =
            entry.rate_cents === null
              ? ""
              : (entry.rate_cents / 100).toFixed(2);
        }
      });
      const record = {
        description,
        hours,
        rate,
        earning,
        original: line ?? null,
        removed: false,
      };
      lineControls.push(record);
      button(row, "Remove line", "button").addEventListener("click", () => {
        record.removed = true;
        row.remove();
      });
      manual.appendChild(row);
    };
    if (existing) existing.versions.at(-1)!.lines.forEach(addLine);
    else addLine();
    button(manual, "Add invoice line", "button").addEventListener("click", () =>
      addLine(),
    );
    button(manual, "Load reviewed earning choices", "button").addEventListener(
      "click",
      () => {
        void action(async () => {
          const own = generation,
            active = signal!,
            data = await api.getPaymentAllocationReport!(
              workMonth.value,
              active,
            );
          if (active.aborted || own !== generation) return;
          entries.splice(0);
          const personData = data.people.find(
            (p) => String(p.user_id) === person.value,
          );
          for (const project of personData?.projects ?? [])
            for (const entry of project.entries)
              entries.push({
                project_id: project.project_id,
                entry_id: entry.entry_id,
                key: String(entry.entry_id),
                name: `${project.project_name} · ${entry.spent_date} · ${(entry.selected_seconds / 3600).toFixed(2)} h`,
                seconds: entry.selected_seconds,
                rate_cents: entry.rate_cents,
              });
          for (const project of personData?.projects ?? []) {
            const selected = project.entries.filter(
                (e) => e.selected_seconds !== 0,
              ),
              rates = new Set(selected.map((e) => e.rate_cents)),
              seconds = selected.reduce((n, e) => n + e.selected_seconds, 0);
            if (seconds !== 0 && rates.size === 1 && !rates.has(null))
              entries.push({
                project_id: project.project_id,
                entry_id: null,
                key: `project:${project.project_id}`,
                name: `${project.project_name} · project summary · ${(seconds / 3600).toFixed(2)} h`,
                seconds,
                rate_cents: selected[0]!.rate_cents,
              });
          }
          for (const select of choices) {
            for (const old of [...select.options])
              if (
                !["unmatched"].includes(old.value) &&
                !old.value.startsWith("saved:")
              )
                old.remove();
            for (const entry of entries) option(select, entry.key, entry.name);
          }
        });
      },
    );
    const layout = () => {
      manual.hidden = fromReview.checked;
      for (const control of manual.querySelectorAll<HTMLInputElement>(
        "input,select,button",
      ))
        control.disabled = fromReview.checked;
    };
    layout();
    fromReview.addEventListener("change", layout);
    const reason = input(form, "Reason shared with contractor"),
      ack = input(
        form,
        "I reviewed existing payments; this document will not change them",
        "",
        "checkbox",
      );
    ack.required =
      !!existing &&
      (existing.versions.some((v) => v.has_payment_history) ||
        report.people.some(
          (p) => p.user_id === existing.user_id && p.paid_cents > 0,
        ));
    workMonth.addEventListener("change", () => {
      if (existing && workMonth.value !== existing.month) ack.required = true;
    });
    let id = crypto.randomUUID();
    form.addEventListener("input", () => {
      id = crypto.randomUUID();
    });
    button(
      form,
      existing ? "Record invoice correction" : "Record contractor invoice",
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void action(async () => {
        const lines: StaffInvoiceLine[] = fromReview.checked
          ? []
          : lineControls
              .filter((l) => !l.removed)
              .map((l) => {
                const selected = entries.find((e) => e.key === l.earning.value);
                const saved = l.earning.value.startsWith("saved:")
                  ? l.original
                  : null;
                return {
                  description: l.description.value.trim(),
                  project_id: selected?.project_id ?? saved?.project_id ?? null,
                  entry_id: selected?.entry_id ?? saved?.entry_id ?? null,
                  seconds: Math.round(Number(l.hours.value) * 3600),
                  rate_cents: staffPaymentAmount(l.rate.value.trim()),
                };
              });
        await api.saveStaffInvoice!(
          {
            id,
            invoice_id: existing?.id ?? null,
            expected_version: existing?.versions.at(-1)!.version ?? 0,
            user_id: existing?.user_id ?? Number(person.value),
            month: workMonth.value,
            currency: currency.value.trim().toUpperCase(),
            reference: reference.value.trim(),
            kind: kind.value as SaveStaffInvoice["kind"],
            from_review: fromReview.checked,
            lines,
            document_id: existing?.versions.at(-1)!.document_id ?? null,
            reason: reason.value.trim(),
            acknowledge_paid_history: ack.checked,
          },
          signal!,
        );
        await load();
        status.textContent =
          "Invoice version recorded. Earnings and payments are unchanged.";
      });
    });
    target.appendChild(form);
  };
  const documentForm = (
    host: HTMLElement,
    invoice: StaffInvoice,
    paid: boolean,
  ) => {
    if (isDemoDeployment()) {
      host.appendChild(
        node("p", demoUnavailable("Uploading contractor invoice documents")),
      );
      return;
    }
    if (!api.uploadStaffInvoiceDocument) return;
    const form = node("form"),
      file = input(form, "Contractor invoice document", "", "file"),
      reason = input(form, "Attachment reason shared with contractor"),
      ack = input(
        form,
        "I reviewed payments before attaching this document",
        "",
        "checkbox",
      );
    ack.required = paid;
    let uploadId = crypto.randomUUID(),
      saveId = crypto.randomUUID(),
      documentId: string | null = null;
    file.addEventListener("change", () => {
      uploadId = crypto.randomUUID();
      saveId = crypto.randomUUID();
      documentId = null;
    });
    button(form, "Attach invoice document");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void action(async () => {
        const selected = file.files?.[0];
        if (!selected) throw new Error("Choose an invoice document.");
        if (documentId === null)
          documentId = (
            await api.uploadStaffInvoiceDocument!(
              invoice.id,
              invoice.month,
              uploadId,
              selected,
              signal!,
            )
          ).id;
        const version = invoice.versions.at(-1)!;
        await api.saveStaffInvoice!(
          {
            id: saveId,
            invoice_id: invoice.id,
            expected_version: version.version,
            user_id: invoice.user_id,
            month: invoice.month,
            currency: invoice.currency,
            reference: invoice.reference,
            kind: version.kind,
            from_review: false,
            lines: version.lines,
            document_id: documentId,
            reason: reason.value.trim(),
            acknowledge_paid_history: ack.checked,
          },
          signal!,
        );
        await load();
        status.textContent =
          "Document attached in a new immutable invoice version.";
      });
    });
    host.appendChild(form);
  };
  refresh.addEventListener("click", () => {
    void action(load);
  });
  return {
    activate: (active: AbortSignal) => {
      signal = active;
      generation++;
      ledger = null;
      busy = false;
      host.replaceChildren();
      refresh.disabled = true;
      active.addEventListener(
        "abort",
        () => {
          generation++;
          ledger = null;
          host.replaceChildren();
          status.textContent = "";
          refresh.disabled = true;
        },
        { once: true },
      );
    },
    ledger: (report: StaffPaymentReport) => {
      if (ledger?.month !== report.month) {
        generation++;
        host.replaceChildren();
        status.textContent = "";
        busy = false;
      }
      ledger = report;
      refresh.disabled = !api.getStaffInvoiceReport;
    },
  };
};
