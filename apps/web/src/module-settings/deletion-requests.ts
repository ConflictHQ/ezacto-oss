import { createRetentionReviewController } from './retention-review.js';
import { createAccountClosureController } from './account-closure.js';
import type { AccountDeletionRecord } from "@ezacto/core";
import { EzactoApiError } from "@conflict-hq/ezacto-client";
import type { SessionPresenter } from "../session.js";
import { apiErrorMessage } from "./model.js";
import { shellFetch } from "../shell/net.js";

type Active = SessionPresenter & {
  signal: AbortSignal;
  identity: { profile: string };
};
const base = "/api/v1/admin/deletion-requests";
export function createDeletionRequestsController(
  root: HTMLElement,
  demo: boolean,
) {
  const section = root.querySelector<HTMLElement>("[data-deletion-requests]")!;
  const list = root.querySelector<HTMLElement>("[data-deletion-list]")!;
  const status = root.querySelector<HTMLElement>("[data-deletion-status]")!;
  const detail = root.querySelector<HTMLElement>("[data-deletion-detail]")!;
  const disclosure = root.querySelector<HTMLElement>(
    "[data-deletion-disclosure]",
  )!;
  const result = root.querySelector<HTMLElement>("[data-deletion-result]")!;
  const notification = root.querySelector<HTMLElement>(
    "[data-deletion-notification]",
  )!;
  const retry = root.querySelector<HTMLButtonElement>("[data-deletion-retry]")!;
  const more = root.querySelector<HTMLButtonElement>("[data-deletion-more]")!;
  const refresh = root.querySelector<HTMLButtonElement>(
    "[data-deletion-refresh]",
  )!;
  const form = root.querySelector<HTMLFormElement>("[data-deletion-form]")!;
  const field = (name: string) =>
    form.elements.namedItem(name) as
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  let session: Active | null = null;
  let selected: AccountDeletionRecord | null = null;
  let next: string | null = null;
  let busy = false;
  const records = new Map<string, AccountDeletionRecord>();
  const retention = createRetentionReviewController(root,demo,(confirmation)=>reload(false,confirmation));
  const closure = createAccountClosureController(root, demo, () => reload(false));
  const writable = () =>
    session?.identity.profile === "administrator" &&
    !demo &&
    !session.signal.aborted;
  const request = async <T>(
    active: Active,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> => {
    const response = await shellFetch(path, {
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
    if (!response.ok)
      throw new EzactoApiError(
        response.status,
        await response.json().catch(() => null),
        response.headers.get("x-request-id"),
      );
    return response.json() as Promise<T>;
  };
  const displayNotification = (record: AccountDeletionRecord) => {
    notification.textContent = `Administrator email: ${record.notification}.${record.notification === "queued" ? " Queued does not mean delivered; check Email activity for the delivery outcome." : ""}`;
    retry.disabled =
      busy ||
      !writable() ||
      record.status === "completed" ||
      record.notification === "queued";
  };
  const display = (record: AccountDeletionRecord) => {
    selected = record;
    closure.select(session, record);
    retention.select(session, record);
    detail.hidden = false;
    root.querySelector<HTMLElement>("[data-deletion-heading]")!.textContent =
      `User ${record.user_id} · ${record.status.replaceAll("_", " ")}`;
    disclosure.replaceChildren();
    const paragraph = (text: string) => {
      const p = document.createElement("p");
      p.textContent = text;
      disclosure.append(p);
    };
    paragraph(
      `Requested ${record.requested_at}. Request ${record.id}, version ${record.version}.`,
    );
    const policy = record.policy_snapshot;
    if (policy === null)
      paragraph(
        "No published policy was captured for this request. Contact the requester with a clear disclosure; this request remains valid.",
      );
    else {
      paragraph(
        `Policy version ${record.policy_version}. ${record.policy_reviewed ? "The client submitted this reviewed version." : "Captured by the server; the client did not confirm reviewing it."}`,
      );
      paragraph(policy.user_notice);
      paragraph(
        `Operator contact: ${policy.operator_contact}. Initial response target: ${record.response_target_at}.`,
      );
      for (const rule of policy.retained_records)
        paragraph(
          `${rule.category.replaceAll("_", " ")}: ${rule.reason} Period: ${rule.period} Review within ${rule.review_after_days} days.`,
        );
      paragraph(`Backups: ${policy.backup_handling}`);
    }
    if (record.completion_confirmation)
      paragraph(record.completion_confirmation);
    displayNotification(record);
    field("status").value = record.status;
    field("message").value = record.message;
    field("completion_date").value =
      record.expected_completion_at?.slice(0, 10) ?? "";
    form.hidden = record.status === "completed";
    for (const input of form.querySelectorAll<
      | HTMLInputElement
      | HTMLButtonElement
      | HTMLTextAreaElement
      | HTMLSelectElement
    >("input,button,textarea,select"))
      input.disabled = busy || !writable();
  };
  const load = async (active: Active, path = base, append = false) => {
    if (active.identity.profile !== "administrator") return;
    const response = await request<{
      data: AccountDeletionRecord[];
      links: { next: string | null };
    }>(active, path);
    active.present(() => {
      section.hidden = false;
      if (!append) { list.replaceChildren(); records.clear(); }
      for (const record of response.data) {
        records.set(record.id, record);
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.deletionRequestId = record.id;
        button.textContent = `User ${record.user_id}: ${record.status.replaceAll("_", " ")} · requested ${record.requested_at.slice(0, 10)}`;
        button.addEventListener("click", () => {
          if (busy || session !== active) return;
          result.textContent = "";
          display(records.get(record.id) ?? record);
        });
        row.append(button);
        list.append(row);
      }
      next = response.links.next;
      more.hidden = next === null;
      status.textContent =
        list.children.length === 0
          ? "No account deletion requests."
          : `${list.children.length} requests loaded.${demo ? " Shared-demo actions are read-only." : ""}`;
    });
  };
  const failure = (active: Active, error: unknown, target: HTMLElement) =>
    active.presentFailure(error, () => {
      target.textContent = apiErrorMessage(
        error,
        "The request could not be completed. Refresh to check its current status.",
      );
    });
  const reload = (append: boolean, confirmation = "") => {
    const active = session;
    if (!active || busy) return;
    busy = true;
    refresh.disabled = more.disabled = true;
    if (!append) {
      selected = null;
      closure.select(null, null);
      retention.select(active, null, confirmation);
      records.clear();
      detail.hidden = true;
    }
    void load(active, append && next !== null ? next : base, append)
      .catch((error: unknown) => failure(active, error, status))
      .finally(() => {
        if (session === active) {
          busy = false;
          refresh.disabled = more.disabled = false;
        }
      });
  };
  refresh.addEventListener("click", () => reload(false));
  more.addEventListener("click", () => reload(true));
  const mutate = (path: string, method: string, body?: unknown) => {
    const active = session;
    if (!active || !selected || busy || !writable()) return;
    const original = selected;
    const notificationOnly = path.endsWith("/notification");
    busy = true;
    retry.disabled = true;
    for (const input of form.querySelectorAll<
      | HTMLInputElement
      | HTMLButtonElement
      | HTMLTextAreaElement
      | HTMLSelectElement
    >("input,button,textarea,select"))
      input.disabled = true;
    result.textContent = "Saving…";
    void request<{ data: AccountDeletionRecord }>(active, path, method, body)
      .then((response) =>
        active.present(() => {
          records.set(response.data.id, response.data);
          for (const button of list.querySelectorAll<HTMLButtonElement>('button')) {
            if (button.dataset.deletionRequestId === response.data.id) button.textContent = `User ${response.data.user_id}: ${response.data.status.replaceAll('_', ' ')} · requested ${response.data.requested_at.slice(0, 10)}`;
          }
          if (notificationOnly) {
            // Mail delivery must not discard a draft or advance its CAS version.
            selected = { ...original, notification: response.data.notification, notification_updated_at: response.data.notification_updated_at, notification_delivery_id: response.data.notification_delivery_id };
            displayNotification(selected);
            result.textContent = `Notification status: ${response.data.notification}. Request edits have not been saved.`;
          } else {
            display(response.data);
            result.textContent = "Request updated. This action has not completed account erasure.";
          }
        }),
      )
      .catch((error: unknown) => failure(active, error, result))
      .finally(() => {
        if (session === active) {
          busy = false;
          // Keep unsaved edits on conflict rather than replacing the form.
          for (const input of form.querySelectorAll<
            | HTMLInputElement
            | HTMLButtonElement
            | HTMLTextAreaElement
            | HTMLSelectElement
          >("input,button,textarea,select"))
            input.disabled = !writable();
          retry.disabled =
            !writable() ||
            selected?.status === "completed" ||
            selected?.notification === "queued";
        }
      });
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selected || !form.reportValidity()) return;
    mutate(`${base}/${selected.id}`, "PATCH", {
      expected_version: selected.version,
      status: field("status").value,
      message: field("message").value,
      expected_completion_at:
        field("completion_date").value === ""
          ? null
          : `${field("completion_date").value}T23:59:59.000Z`,
    });
  });
  retry.addEventListener("click", () => {
    if (selected) mutate(`${base}/${selected.id}/notification`, "POST", {});
  });
  return {
    clear() {
      session = null;
      closure.select(null, null);
      retention.select(null, null);
      selected = null;
      records.clear();
      next = null;
      busy = false;
      list.replaceChildren();
      disclosure.replaceChildren();
      form.reset();
      detail.hidden = section.hidden = true;
      root.querySelector<HTMLElement>("[data-deletion-heading]")!.textContent =
        "";
      more.hidden = true;
      status.textContent = result.textContent = notification.textContent = "";
    },
    async load(active: Active) {
      session = active;
      retention.select(active,null);
      if (active.identity.profile !== "administrator") return;
      active.present(() => {
        section.hidden = false;
        status.textContent = "Loading requests…";
      });
      try {
        await load(active);
      } catch (error) {
        failure(active, error, status);
      }
    },
  };
}
