import { renderDeletionRequests } from './deletion-requests-render.js'
import {
  PRIVACY_FRAMEWORK_CATALOG,
  PRIVACY_REFERENCE_REVIEWED_ON,
} from "@ezacto/core";
import {
  EzactoApiError,
  type AccountRetentionRecord,
} from "@conflict-hq/ezacto-client";
import type { SessionPresenter } from "../session.js";
import { apiErrorMessage } from "./model.js";
import { shellFetch } from "../shell/net.js";

const frameworks = PRIVACY_FRAMEWORK_CATALOG;
const renderFramework = ({
  id,
  label,
  note,
  url,
}: (typeof frameworks)[number]): string =>
  `<div data-privacy-framework><label class="settings-toggle"><input type="checkbox" name="framework" value="${id}" aria-describedby="retention-${id}-note">${label}</label><p class="hint" id="retention-${id}-note">${note}${url === null ? "" : ` <a href="${url}" target="_blank" rel="noopener noreferrer">Reference</a>`}</p></div>`;
const categories = [
  [
    "time_and_worker_attribution",
    "Time records and worker attribution",
    "Who performed which hours, when, and their links to invoices and payments.",
  ],
  [
    "billing_and_payments",
    "Invoices, expenses and payments",
    "Include only necessary billing evidence and attachments.",
  ],
  [
    "audit_and_security",
    "Audit and security records",
    "Limit personal data and access to the documented purpose.",
  ],
  [
    "legal_hold",
    "Records subject to a legal hold",
    "Identify the specific hold, its scope, release condition and review process.",
  ],
] as const;

export const renderRetentionSection = (): string => `
  <section class="settings-section" data-settings-section="erasure" aria-labelledby="settings-erasure-title">
    <header><h2 id="settings-erasure-title">Erasure and retention</h2>
    <p>Publish your instance's account-closure disclosure. The operator determines applicable obligations and completes requests. Saving this policy does not erase accounts, schedule deletion, or establish legal compliance.</p></header>
    <p data-retention-status role="status" aria-live="polite">Loading policy…</p>
    <form class="settings-form" data-retention-form hidden>
      <fieldset data-retention-editable>
        <legend>Operator policy</legend>
        <fieldset><legend>Applicable frameworks</legend>
          <p>Check only frameworks you have assessed. These selections do not waive user rights or authorize blanket retention.</p>
          ${frameworks
            .filter((entry) => entry.state === null)
            .map(renderFramework)
            .join("")}
          <details data-privacy-states><summary>US states and District of Columbia</summary>
            <p>Reviewed ${PRIVACY_REFERENCE_REVIEWED_ON}. Entries distinguish current laws, enacted future laws, sector-specific examples and jurisdictions needing an operator assessment. This is a dated reference, not an exhaustive legal opinion.</p>
            <label>Find a state or privacy law<input type="search" data-privacy-filter autocomplete="off"></label>
            <p data-privacy-filter-status role="status" aria-live="polite"></p>
            ${frameworks
              .filter((entry) => entry.state !== null)
              .map(renderFramework)
              .join("")}
          </details>
        </fieldset>
        <fieldset><legend>Records retained after account closure</legend>
          <p>For each checked category, specify why it is necessary, when retention ends, and when it must be reviewed. Leave unchecked when you have no justified retention need. A review interval is a follow-up target, not automatic erasure.</p>
          ${categories
            .map(
              ([
                id,
                label,
                note,
              ]) => `<fieldset data-retention-category="${id}"><legend>${label}</legend><label class="settings-toggle"><input type="checkbox" name="retain-${id}">Retain necessary records in this category</label><p class="hint">${note}</p><fieldset data-retention-details disabled>
            <legend>Retention justification</legend>
            <label>Specific purpose and legal basis<textarea name="reason-${id}" maxlength="2000" required rows="3"></textarea></label>
            <label>Retention period and starting event, or hold release condition<textarea name="period-${id}" maxlength="1000" required rows="2"></textarea></label>
            <label>Review within (days)<input name="review-${id}" type="number" min="1" max="365" step="1" required></label>
          </fieldset></fieldset>`,
            )
            .join("")}
        </fieldset>
        <label>Operator privacy contact<input type="email" name="operator_contact" maxlength="254" required autocomplete="email"></label>
        <label>Initial response target (days)<input type="number" name="response_target_days" min="1" max="90" step="1" required></label>
        <p class="hint">Choose a target that meets every applicable deadline. This setting cannot extend statutory deadlines or promise completion.</p>
        <label>User disclosure<textarea name="user_notice" maxlength="5000" rows="5" required></textarea></label>
        <p class="hint">Explain what is erased, what remains identified, why, how long, how requests are completed and how users can contact you or appeal where applicable.</p>
        <label>Backup and restore handling<textarea name="backup_handling" maxlength="5000" rows="4" required></textarea></label>
        <p class="hint">State your actual backup expiry and deletion process, including how closures are reapplied before restored data is used. Account closure does not automatically remove backup or third-party copies.</p>
        <label class="settings-toggle"><input name="acknowledged" type="checkbox" required>I have reviewed applicability, necessity, retention periods and this user disclosure. I understand these settings do not certify compliance, waive user rights or perform erasure.</label>
        <button class="primary-action" type="submit">Publish policy</button>
      </fieldset>
    </form>
    <p data-retention-result role="status" aria-live="polite"></p>
    ${renderDeletionRequests()}
  </section>`;

type Active = SessionPresenter & {
  signal: AbortSignal;
  identity: { profile: string };
};
export function createRetentionController(root: HTMLElement, demo: boolean) {
  const form = root.querySelector<HTMLFormElement>("[data-retention-form]")!;
  const editable = form.querySelector<HTMLFieldSetElement>(
    "[data-retention-editable]",
  )!;
  const status = root.querySelector<HTMLElement>("[data-retention-status]")!;
  const result = root.querySelector<HTMLElement>("[data-retention-result]")!;
  let session: Active | null = null;
  let version = 0;
  let busy = false;
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  const check = (name: string) => field(name) as HTMLInputElement;
  const updateCategories = () => {
    for (const [id] of categories) {
      const details = form.querySelector<HTMLFieldSetElement>(
        `[data-retention-category="${id}"] [data-retention-details]`,
      )!;
      details.disabled = !check(`retain-${id}`).checked;
      for (const input of details.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement
      >("input, textarea"))
        input.disabled = details.disabled;
    }
  };
  const filter = form.querySelector<HTMLInputElement>("[data-privacy-filter]")!;
  const filterStatus = form.querySelector<HTMLElement>(
    "[data-privacy-filter-status]",
  )!;
  const filterStates = () => {
    const query = filter.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of form.querySelectorAll<HTMLElement>(
      "[data-privacy-states] [data-privacy-framework]",
    )) {
      row.hidden = !(row.textContent ?? "").toLocaleLowerCase().includes(query);
      if (!row.hidden) visible++;
    }
    filterStatus.textContent =
      query === ""
        ? ""
        : `${visible} matching jurisdictions. Filtering does not change your selections.`;
  };
  filter.addEventListener("input", filterStates);
  form.addEventListener("change", updateCategories);
  const display = (record: AccountRetentionRecord | null) => {
    form.reset();
    filterStates();
    version = record?.version ?? 0;
    if (record !== null) {
      const policy = record.policy;
      for (const checkbox of form.querySelectorAll<HTMLInputElement>(
        '[name="framework"]',
      ))
        checkbox.checked = policy.frameworks.includes(
          checkbox.value as (typeof policy.frameworks)[number],
        );
      for (const rule of policy.retained_records) {
        check(`retain-${rule.category}`).checked = true;
        field(`reason-${rule.category}`).value = rule.reason;
        field(`period-${rule.category}`).value = rule.period;
        field(`review-${rule.category}`).value = String(rule.review_after_days);
      }
      for (const name of [
        "operator_contact",
        "user_notice",
        "backup_handling",
      ] as const)
        field(name).value = policy[name];
      field("response_target_days").value = String(policy.response_target_days);
    }
    form.querySelector<HTMLDetailsElement>("[data-privacy-states]")!.open =
      record?.policy.frameworks.some((id) =>
        frameworks.some((entry) => entry.id === id && entry.state !== null),
      ) ?? false;
    // Every publication needs a fresh acknowledgement, including edits.
    check("acknowledged").checked = false;
    updateCategories();
    editable.disabled = demo || session?.identity.profile !== "administrator";
    form.hidden = false;
    status.textContent = demo
      ? "The shared demo shows this policy but cannot publish changes."
      : record === null
        ? "No operator policy has been published."
        : `Policy version ${record.version}, published ${record.published_at}.`;
    if (!demo && session?.identity.profile !== "administrator")
      status.textContent +=
        " Read-only: an administrator must publish changes.";
  };
  const request = async (
    active: Active,
    body?: unknown,
  ): Promise<AccountRetentionRecord | null> => {
    const response = await shellFetch(
      body === undefined
        ? "/api/v1/profile/retention-policy"
        : "/api/v1/admin/retention-policy",
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        signal: active.signal,
        ...(body === undefined
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    );
    if (!response.ok)
      throw new EzactoApiError(
        response.status,
        await response.json().catch(() => null),
        response.headers.get("x-request-id"),
      );
    return ((await response.json()) as { data: AccountRetentionRecord | null })
      .data;
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const active = session;
    if (
      active === null ||
      active.signal.aborted ||
      busy ||
      demo ||
      active.identity.profile !== "administrator" ||
      !form.reportValidity()
    )
      return;
    const body = {
      expected_version: version,
      policy: {
        frameworks: [
          ...form.querySelectorAll<HTMLInputElement>(
            '[name="framework"]:checked',
          ),
        ].map((item) => item.value),
        retained_records: categories
          .filter(([id]) => check(`retain-${id}`).checked)
          .map(([category]) => ({
            category,
            reason: field(`reason-${category}`).value,
            period: field(`period-${category}`).value,
            review_after_days: Number(field(`review-${category}`).value),
          })),
        operator_contact: field("operator_contact").value,
        response_target_days: Number(field("response_target_days").value),
        user_notice: field("user_notice").value,
        backup_handling: field("backup_handling").value,
        acknowledged: check("acknowledged").checked,
      },
    };
    busy = true;
    editable.disabled = true;
    result.textContent = "Publishing…";
    void request(active, body)
      .then((record) =>
        active.present(() => {
          display(record);
          result.textContent =
            "Policy published. Account requests still require operator action.";
        }),
      )
      .catch((error: unknown) =>
        active.presentFailure(error, () => {
          result.textContent = apiErrorMessage(
            error,
            "The policy could not be published. Your changes are still here.",
          );
        }),
      )
      .finally(() => {
        if (session === active) {
          busy = false;
          editable.disabled =
            demo || active.identity.profile !== "administrator";
        }
      });
  });
  return {
    clear() {
      session = null;
      busy = false;
      version = 0;
      form.reset();
      filterStates();
      form.hidden = true;
      status.textContent = "";
      result.textContent = "";
      updateCategories();
    },
    async load(active: Active) {
      session = active;
      status.textContent = "Loading policy…";
      const record = await request(active);
      active.present(() => display(record));
    },
  };
}
