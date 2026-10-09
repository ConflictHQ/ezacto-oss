import type { AccountDeletionRecord, RetentionObligation } from "@ezacto/core";
import type { SessionPresenter } from "../session.js";
import { EzactoApiError } from "@conflict-hq/ezacto-client";
import { apiErrorMessage } from "./model.js";
type Active = SessionPresenter & {
  signal: AbortSignal;
  identity: { profile: string };
};
export function createRetentionReviewController(
  root: HTMLElement,
  demo: boolean,
  onCompleted: () => void,
) {
  const section = root.querySelector<HTMLElement>("[data-retention-review]")!;
  const content = section.querySelector<HTMLElement>(
    "[data-retention-content]",
  )!;
  const status = section.querySelector<HTMLElement>("[data-retention-status]")!;
  const reference = section.querySelector<HTMLElement>(
    "[data-retention-reference]",
  )!;
  const load = section.querySelector<HTMLButtonElement>(
    "[data-retention-load]",
  )!;
  const due = section.querySelector<HTMLButtonElement>("[data-retention-due]")!;
  const queue = section.querySelector<HTMLElement>(
    "[data-retention-due-list]",
  )!;
  let queueAfter: string | null = null;
  let session: Active | null = null,
    request: AccountDeletionRecord | null = null,
    revision = 0,
    busy = false;
  const paragraph = (parent: HTMLElement, text: string) => {
    const p = document.createElement("p");
    p.textContent = text;
    parent.append(p);
  };
  const call = async <T>(
    active: Active,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> => {
    const result = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: active.signal,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!result.ok)
      throw new EzactoApiError(
        result.status,
        await result.json().catch(() => null),
        result.headers.get("x-request-id"),
      );
    return result.json() as Promise<T>;
  };
  const display = (rows: RetentionObligation[], savedArea?: string) => {
    const drafts = new Map<
      string,
      { name: string; value: string; checked: boolean }[]
    >();
    if (savedArea)
      for (const form of content.querySelectorAll<HTMLFormElement>(
        "form[data-area]",
      )) {
        if (form.dataset.area === savedArea) continue;
        drafts.set(
          form.dataset.area!,
          Array.from(
            form.querySelectorAll<
              HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
            >("[name]"),
          ).map((field) => ({
            name: field.name,
            value: field.value,
            checked: field instanceof HTMLInputElement && field.checked,
          })),
        );
      }
    content.replaceChildren();
    for (const row of rows) {
      const details = document.createElement("details"),
        summary = document.createElement("summary");
      summary.textContent = `${row.area.replaceAll("_", " ")} — ${row.decision.replaceAll("_", " ")}${row.next_review_at ? ` · review ${row.next_review_at.slice(0, 10)}` : ""}`;
      details.append(summary);
      paragraph(
        details,
        `Original purpose: ${row.original_reason} Release condition: ${row.original_period}`,
      );
      if (row.hold_active)
        paragraph(
          details,
          "An active hold must be explicitly released before removal can be recorded.",
        );
      const form = document.createElement("form");
      form.dataset.area = row.area;
      const label = document.createElement("label");
      label.textContent = "Decision";
      const decision = document.createElement("select");
      decision.name = "decision";
      for (const [value, text] of [
        ["retain", "Retain under a current basis"],
        ["removed", "Removal verified by operator"],
        ["not_applicable", "Verified not applicable"],
        ["failed", "Cleanup failed; retry required"],
        ["release_hold", "Record authorized hold release"],
      ]) {
        const option = document.createElement("option");
        option.value = value!;
        option.textContent = text!;
        decision.append(option);
      }
      decision.value = row.decision === "pending" ? "failed" : row.decision;
      label.append(decision);
      form.append(label);
      const fields: Record<string, HTMLTextAreaElement | HTMLInputElement> = {};
      for (const [name, text, value] of [
        ["basis", "Current documented basis", row.basis],
        [
          "release_condition",
          "Period or release condition",
          row.release_condition,
        ],
        ["evidence", "Actual evidence or protected reference", row.evidence],
      ]) {
        const label = document.createElement("label");
        label.textContent = text!;
        const field = document.createElement("textarea");
        field.name = name!;
        field.value = value!;
        field.maxLength = 2000;
        field.rows = 2;
        label.append(field);
        form.append(label);
        fields[name!] = field;
      }
      const dateLabel = document.createElement("label");
      dateLabel.textContent = "Next review date (UTC; required when retaining)";
      const date = document.createElement("input");
      date.type = "date";
      date.name = "next_review_date";
      date.value = row.next_review_at?.slice(0, 10) ?? "";
      dateLabel.append(date);
      form.append(dateLabel);
      paragraph(
        form,
        "Use a protected evidence reference, not copied personal records or credentials. Saving this decision does not perform deletion. Verify removal in the relevant system first; shared documents and justified work/payment records must remain protected.",
      );
      const ackLabel = document.createElement("label"),
        ack = document.createElement("input");
      ack.type = "checkbox";
      ack.name = "acknowledged";
      ack.required = true;
      ackLabel.append(
        ack,
        document.createTextNode(
          " I reviewed the actual result and remaining retention. This entry is an operator attestation, not automated erasure or a compliance certificate.",
        ),
      );
      form.append(ackLabel);
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "Record review";
      save.disabled = demo;
      form.append(save);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        run(async (active, selected) => {
          const response = await call<{ data: RetentionObligation }>(
            active,
            `/api/v1/admin/deletion-requests/${selected.id}/retention-reviews/${row.area}`,
            "PATCH",
            {
              expected_version: row.version,
              decision: decision.value,
              basis: fields.basis!.value,
              release_condition: fields.release_condition!.value,
              evidence: fields.evidence!.value,
              next_review_at:
                decision.value === "retain" && date.value
                  ? `${date.value}T23:59:59.000Z`
                  : null,
              acknowledged: true,
            },
          );
          return () => {
            display(
              rows.map((item) =>
                item.area === response.data.area ? response.data : item,
              ),
              row.area,
            );
            status.textContent =
              "Review recorded. No automatic deletion was performed.";
          };
        }, true);
      });
      for (const draft of drafts.get(row.area) ?? []) {
        const field = form.elements.namedItem(draft.name) as
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
        if (field) {
          field.value = draft.value;
          if (field instanceof HTMLInputElement) field.checked = draft.checked;
        }
      }
      details.append(form);
      content.append(details);
    }
    if (request?.status !== "completed") {
      const complete = document.createElement("form"),
        label = document.createElement("label"),
        ack = document.createElement("input");
      ack.type = "checkbox";
      ack.required = true;
      label.append(
        ack,
        document.createTextNode(
          " I verified each cleanup outcome and current retention justification. Confirm the request outcome while clearly disclosing remaining retained records.",
        ),
      );
      const button = document.createElement("button");
      button.type = "submit";
      button.textContent = "Confirm reviewed request outcome";
      button.disabled = demo;
      const manualLabel = document.createElement("label"),
        manual = document.createElement("input");
      manual.type = "checkbox";
      manualLabel.append(
        manual,
        document.createTextNode(
          " Historical Apple accounts only: I verified manual disconnect and recorded its protected evidence in the Apple authorization removal review. This does not replace proof for any current known grant.",
        ),
      );
      complete.append(manualLabel, label, button);
      complete.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!complete.reportValidity()) return;
        run(async (active, selected) => {
          const result = await call<{ data: { confirmation: string } }>(
            active,
            `/api/v1/admin/deletion-requests/${selected.id}/completion`,
            "POST",
            {
              expected_request_version: selected.version,
              apple_historical_manual_verified: manual.checked,
              expected_reviews: Object.fromEntries(
                rows.map((row) => [row.area, row.version]),
              ),
              acknowledged: true,
            },
          );
          return () => {
            status.textContent = result.data.confirmation;
            onCompleted();
          };
        }, true);
      });
      content.append(complete);
    }
  };
  const run = (
    action: (
      active: Active,
      selected: AccountDeletionRecord,
    ) => Promise<() => void>,
    mutation = false,
  ) => {
    const active = session,
      selected = request,
      current = revision;
    if (
      !active ||
      !selected ||
      busy ||
      active.signal.aborted ||
      (mutation && demo)
    )
      return;
    busy = true;
    status.textContent = "Working…";
    for (const button of content.querySelectorAll<HTMLButtonElement>("button"))
      button.disabled = true;
    void action(active, selected)
      .then((show) =>
        active.present(() => {
          if (current === revision) show();
        }),
      )
      .catch((error) =>
        active.presentFailure(error, () => {
          if (current === revision)
            status.textContent = apiErrorMessage(
              error,
              "Review could not be saved. Your draft remains available; refresh before retrying a changed record.",
            );
        }),
      )
      .finally(() => {
        if (current === revision) {
          busy = false;
          for (const button of content.querySelectorAll<HTMLButtonElement>(
            "button",
          ))
            button.disabled = demo;
        }
      });
  };
  const select = (
    active: Active | null,
    selected: AccountDeletionRecord | null,
  ) => {
    revision++;
    session = active;
    request = selected;
    busy = false;
    content.replaceChildren();
    queue.replaceChildren();
    queueAfter = null;
    due.textContent = "Show due and overdue reviews";
    status.textContent = "";
    reference.textContent = selected
      ? `Request ${selected.id} · ${selected.status.replaceAll("_", " ")}`
      : "Select a request to review its remaining obligations.";
    load.disabled = !active || !selected;
    due.disabled = !active;
  };
  load.addEventListener("click", () =>
    run(async (active, selected) => {
      const result = await call<{ data: RetentionObligation[] }>(
        active,
        `/api/v1/admin/deletion-requests/${selected.id}/retention-reviews`,
      );
      return () => {
        display(result.data);
        status.textContent =
          "Review each applicable system and retained category.";
      };
    }),
  );
  due.addEventListener("click", () => {
    const active = session,
      current = revision;
    if (!active || busy || active.signal.aborted) return;
    due.disabled = true;
    status.textContent = "Loading due reviews…";
    void call<{ data: RetentionObligation[] }>(
      active,
      `/api/v1/admin/retention-reviews${queueAfter ? `?after=${encodeURIComponent(queueAfter)}` : ""}`,
    )
      .then((result) =>
        active.present(() => {
          if (current !== revision) return;
          queue.replaceChildren();
          for (const row of result.data) {
            const item = document.createElement("li"),
              button = document.createElement("button");
            button.type = "button";
            button.textContent = `${row.request_id}: ${row.area.replaceAll("_", " ")} · ${row.decision.replaceAll("_", " ")}${row.next_review_at ? ` · ${row.next_review_at.slice(0, 10)}` : ""}`;
            button.addEventListener("click", () => {
              void call<{ data: AccountDeletionRecord }>(
                active,
                `/api/v1/admin/deletion-requests/${row.request_id}`,
              )
                .then((response) =>
                  active.present(() => {
                    if (current !== revision) return;
                    select(active, response.data);
                    load.click();
                  }),
                )
                .catch((error) =>
                  active.presentFailure(error, () => {
                    status.textContent = apiErrorMessage(
                      error,
                      "Could not load the selected request.",
                    );
                  }),
                );
            });
            item.append(button);
            queue.append(item);
          }
          const last = result.data.at(-1);
          queueAfter =
            result.data.length === 100 && last
              ? `${last.request_id}/${last.area}`
              : null;
          due.textContent = queueAfter
            ? "Show next due reviews"
            : "Refresh due reviews";
          status.textContent = result.data.length
            ? "Due and overdue obligations remain actionable, including after request completion."
            : "No due reviews were found.";
        }),
      )
      .catch((error) =>
        active.presentFailure(error, () => {
          if (current === revision)
            status.textContent = apiErrorMessage(
              error,
              "Could not load due reviews.",
            );
        }),
      )
      .finally(() => {
        if (current === revision) due.disabled = false;
      });
  });
  return { select };
}
