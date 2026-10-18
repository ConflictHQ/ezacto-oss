import type {
  AccountClosurePreview,
  AccountClosureRecord,
  AccountDeletionRecord,
  AppleCleanupStatus,
} from "@ezacto/core";
import { EzactoApiError } from "@conflict-hq/ezacto-client";
import type { SessionPresenter } from "../session.js";
import { apiErrorMessage } from "./model.js";
import { shellFetch } from "../shell/net.js";
type Active = SessionPresenter & {
  signal: AbortSignal;
  identity: { profile: string };
};
export function createAccountClosureController(
  root: HTMLElement,
  demo: boolean,
  onClosed: () => void,
) {
  const section = root.querySelector<HTMLElement>("[data-account-closure]")!;
  const review = section.querySelector<HTMLButtonElement>(
    "[data-closure-review]",
  )!;
  const inventory = section.querySelector<HTMLElement>(
    "[data-closure-inventory]",
  )!;
  const form = section.querySelector<HTMLFormElement>("[data-closure-form]")!;
  const result = section.querySelector<HTMLElement>("[data-closure-result]")!;
  let session: Active | null = null;
  let selected: AccountDeletionRecord | null = null;
  let preview: AccountClosurePreview | null = null;
  let busy = false;
  let revision = 0;
  const request = async <T>(
    active: Active,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    const response = await shellFetch(path, {
      method: body === undefined ? "GET" : "POST",
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
  const paragraph = (text: string) => {
    const element = document.createElement("p");
    element.textContent = text;
    inventory.append(element);
  };
  const render = (data: AccountClosurePreview) => {
    preview = data;
    inventory.replaceChildren();
    form.reset();
    form.hidden = true;
    if (data.closure) {
      paragraph(
        `Access closed ${data.closure.closed_at}. Local credentials were erased. This request still requires review of retained records and external cleanup.`,
      );
      paragraph(
        `Apple authorization: ${{ pending: "provider cleanup pending", not_linked: "no Apple identity was linked", revoked: "provider invalidation confirmed; retained records still need review", manual_required: "historical or unsupported Apple authorization needs manual review" }[data.closure.apple_cleanup]}.`,
      );
      if (
        data.apple_cleanup_retry_available &&
        !demo &&
        ["pending", "manual_required"].includes(data.closure.apple_cleanup)
      ) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "editor-secondary";
        retry.textContent = "Retry server-managed Apple cleanup";
        retry.addEventListener("click", () => {
          const active = session,
            record = selected,
            current = revision;
          if (!active || !record || busy || active.signal.aborted) return;
          busy = true;
          retry.disabled = true;
          result.textContent = "Retrying Apple cleanup…";
          void request<{ data: { apple_cleanup: AppleCleanupStatus } }>(
            active,
            `/api/v1/admin/deletion-requests/${record.id}/apple-cleanup`,
            {},
          )
            .then((response) =>
              active.present(() => {
                if (current !== revision) return;
                render({
                  ...data,
                  closure: {
                    ...data.closure!,
                    apple_cleanup: response.data.apple_cleanup,
                  },
                });
                result.textContent =
                  response.data.apple_cleanup === "revoked"
                    ? "Apple cleanup confirmed. Retained records still require review."
                    : "Apple cleanup remains unresolved. Local account access stays closed.";
              }),
            )
            .catch((error) =>
              active.presentFailure(error, () => {
                if (current === revision)
                  result.textContent = apiErrorMessage(
                    error,
                    "Apple cleanup could not be confirmed. Local account access stays closed.",
                  );
              }),
            )
            .finally(() => {
              if (current === revision) {
                busy = false;
                retry.disabled = false;
              }
            });
        });
        inventory.append(retry);
      }
      for (const rule of data.closure.policy_snapshot.retained_records)
        paragraph(
          `${rule.category.replaceAll("_", " ")}: ${rule.reason} Period: ${rule.period} Review by ${new Date(Date.parse(data.closure.closed_at) + rule.review_after_days * 86400000).toISOString().slice(0, 10)}.`,
        );
      return;
    }
    paragraph(
      `Current policy version: ${data.policy_version ?? "unpublished"}. Request version: ${data.request_version}.`,
    );
    if (data.policy_snapshot) {
      paragraph(data.policy_snapshot.user_notice);
      for (const rule of data.policy_snapshot.retained_records)
        paragraph(
          `${rule.category.replaceAll("_", " ")}: ${rule.reason} Period: ${rule.period} Review within ${rule.review_after_days} days after closure.`,
        );
      paragraph(`Backups: ${data.policy_snapshot.backup_handling}`);
    }
    for (const item of data.inventory)
      paragraph(
        `${item.location}: ${item.count} record${item.count === 1 ? "" : "s"} (${item.category.replaceAll("_", " ")}).`,
      );
    paragraph(
      "These counts cover linked database records. Review free text, document contents, exported copies and external systems separately.",
    );
    if (data.owner_transfer_required)
      paragraph(
        "The current owner must transfer ownership to another active administrator first.",
      );
    if (data.running_timer)
      paragraph("Stop this person’s running timer before closing access.");
    if (data.uncovered_categories.length)
      paragraph(
        `Review and document the actual basis for: ${data.uncovered_categories.map((category) => category.replaceAll("_", " ")).join(", ")}. Do not select a category merely to dismiss this requirement.`,
      );
    form.hidden =
      demo ||
      data.policy_version === null ||
      data.owner_transfer_required ||
      data.running_timer ||
      data.uncovered_categories.length > 0;
  };
  const run = (body?: unknown) => {
    const active = session,
      record = selected,
      current = revision;
    if (
      !active ||
      !record ||
      busy ||
      active.signal.aborted ||
      (body !== undefined && demo)
    )
      return;
    busy = true;
    review.disabled = true;
    for (const input of form.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input,button"))
      input.disabled = true;
    result.textContent =
      body === undefined
        ? "Reviewing account data…"
        : "Closing account access…";
    void request<{ data: AccountClosurePreview | AccountClosureRecord }>(
      active,
      `/api/v1/admin/deletion-requests/${record.id}/closure`,
      body,
    )
      .then((response) =>
        active.present(() => {
          if (current !== revision) return;
          if (body === undefined) {
            render(response.data as AccountClosurePreview);
            result.textContent =
              "Review complete. No account data has been erased.";
          } else {
            form.hidden = true;
            result.textContent =
              "Access closed and local credentials erased. Retained records and external cleanup remain under review.";
            onClosed();
          }
        }),
      )
      .catch((error: unknown) =>
        active.presentFailure(error, () => {
          if (current === revision)
            result.textContent = apiErrorMessage(
              error,
              "Account closure could not be confirmed. Refresh its status before retrying.",
            );
        }),
      )
      .finally(() => {
        if (current !== revision) return;
        busy = false;
        review.disabled = false;
        for (const input of form.querySelectorAll<
          HTMLInputElement | HTMLButtonElement
        >("input,button"))
          input.disabled = demo;
      });
  };
  review.addEventListener("click", () => run());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!preview || !form.reportValidity() || preview.policy_version === null)
      return;
    run({
      expected_version: preview.request_version,
      review_token: preview.review_token,
      expected_policy_version: preview.policy_version,
      acknowledged: true,
    });
  });
  return {
    select(active: Active | null, record: AccountDeletionRecord | null) {
      revision += 1;
      session = active;
      selected = record;
      preview = null;
      busy = false;
      inventory.replaceChildren();
      form.reset();
      form.hidden = true;
      result.textContent = "";
      review.disabled =
        !active || !record || demo || record.status === "completed";
    },
  };
}
