import { EzactoApiError } from "@conflict-hq/ezacto-client";
import type {
  EzactoClient,
  DeelStageCommand,
  DeelStagePreview,
} from "@conflict-hq/ezacto-client";
import type { StaffPaymentReport } from "@ezacto/core";
import { isDemoDeployment } from "../demo.js";

export type DeelStageApi = Partial<
  Pick<
    EzactoClient,
    | "getDeelStaging"
    | "previewDeelStaging"
    | "stageDeelHours"
    | "getDeelStageStatus"
  >
>;
export const createDeelStageController = (
  page: HTMLElement,
  api: DeelStageApi,
  changed: () => void,
  progressChanged: () => Promise<void> = async () => {},
) => {
  const root = page.querySelector<HTMLElement>("[data-deel-stage]")!;
  const form = root.querySelector<HTMLFormElement>("form")!;
  const people = root.querySelector<HTMLElement>("[data-deel-stage-people]")!;
  const output = root.querySelector<HTMLElement>("[data-deel-stage-preview]")!;
  const message = root.querySelector<HTMLElement>("[data-deel-stage-message]")!;
  const reviewed = root.querySelector<HTMLInputElement>(
    "[data-deel-stage-reviewed]",
  )!;
  const send = root.querySelector<HTMLButtonElement>("[data-deel-stage-send]")!;
  const check = root.querySelector<HTMLButtonElement>(
    "[data-deel-stage-check]",
  )!;
  const retry = root.querySelector<HTMLButtonElement>(
    "[data-deel-stage-retry]",
  )!;
  const handoff = root.querySelector<HTMLAnchorElement>(
    "[data-deel-stage-handoff]",
  )!;
  const warnBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!busy) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const warnBeforeNavigation = (event: MouseEvent) => {
    if (!busy || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
    if (!globalThis.confirm("Deel is still processing this request. Leave this screen?")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  let navigationGuard = false;
  let active: AbortSignal | null = null,
    generation = 0,
    enabled = false,
    busy = false,
    parentBusy = false;
  let dateBounds: { from: string; to: string } | null = null;
  let preview: DeelStagePreview | null = null,
    pending: DeelStageCommand | null = null;
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement;
  const current = (signal: AbortSignal, revision: number) =>
    active === signal && !signal.aborted && generation === revision;
  const controls = () => {
    message.setAttribute("aria-busy", String(busy));
    message.dataset.busy = String(busy);
    if (busy !== navigationGuard) {
      navigationGuard = busy;
      if (busy) {
        globalThis.window.addEventListener("beforeunload", warnBeforeUnload);
        globalThis.document.addEventListener("click", warnBeforeNavigation, true);
      } else {
        globalThis.window.removeEventListener("beforeunload", warnBeforeUnload);
        globalThis.document.removeEventListener("click", warnBeforeNavigation, true);
      }
    }
    for (const node of form.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input,button"))
      node.disabled = busy || parentBusy || pending !== null;
    reviewed.disabled =
      busy ||
      parentBusy ||
      pending !== null ||
      preview === null ||
      preview.entry_ids.length === 0 ||
      preview.unmatched.length > 0 ||
      preview.conflict_entry_ids.length > 0 ||
      preview.unsyncable_entry_ids.length > 0 ||
      preview.unresolved_entry_ids.length > 0;
    send.disabled = reviewed.disabled || !reviewed.checked;
    check.hidden = pending === null;
    check.disabled = busy || parentBusy;
    retry.hidden = pending === null;
    retry.disabled = busy || parentBusy;
  };
  const clearPreview = () => {
    preview = null;
    reviewed.checked = false;
    output.replaceChildren();
    handoff.hidden = true;
    controls();
  };
  const clear = () => {
    generation++;
    enabled = false;
    dateBounds = null;
    busy = false;
    pending = null;
    clearPreview();
    people.replaceChildren();
    form.reset();
    message.textContent = "";
    root.hidden = true;
    changed();
  };
  form.addEventListener("change", () => {
    if (!busy && pending === null) clearPreview();
  });
  reviewed.addEventListener("change", controls);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (
      !enabled ||
      busy ||
      parentBusy ||
      pending !== null ||
      !active ||
      active.aborted
    )
      return;
    const user_ids = [
      ...people.querySelectorAll<HTMLInputElement>("input:checked"),
    ].map((x) => Number(x.value));
    if (!user_ids.length) {
      message.textContent = "Select at least one person.";
      return;
    }
    const signal = active,
      revision = generation;
    clearPreview();
    busy = true;
    controls();
    message.textContent = "Reviewing hours and Deel contracts…";
    try {
      const result = await api.previewDeelStaging!({
        body: { from: field("from").value, to: field("to").value, user_ids },
        signal,
      });
      if (!current(signal, revision)) return;
      preview = result.data;
      const list = document.createElement("ul");
      for (const person of preview.people) {
        const li = document.createElement("li");
        const name =
          people.querySelector<HTMLInputElement>(
            `input[value="${person.user_id}"]`,
          )?.parentElement?.textContent ?? `Person ${person.user_id}`;
        li.textContent = `${name}: ${person.seconds} seconds (${(person.seconds / 3600).toFixed(4)} hours), ${person.entries} entries, Deel contract ${person.contract_id ?? "not matched"}.`;
        list.appendChild(li);
      }
      const summary = document.createElement("p");
      summary.textContent = `${preview.from} to ${preview.to}: ${preview.seconds} seconds in ${preview.entry_ids.length} new entries; ${preview.already_staged} already staged. ${preview.zero_duration_entry_ids.length} zero-duration entries skipped, ${preview.conflict_entry_ids.length} changed entries, ${preview.unsyncable_entry_ids.length} entries that cannot be staged, ${preview.unmatched.length} unmatched people, ${preview.unresolved_entry_ids.length} awaiting reconciliation.`;
      output.replaceChildren(summary, list);
      for (const [label, ids] of [
        ["Already staged in Deel (will not be sent again)", preview.already_staged_entry_ids],
        ["Changed entries", preview.conflict_entry_ids],
        ["Entries that cannot be staged", preview.unsyncable_entry_ids],
        ["Entries awaiting Deel reconciliation", preview.unresolved_entry_ids],
      ] as const) {
        if (!ids.length) continue;
        const diagnostic = document.createElement("p");
        diagnostic.textContent = ids === preview.already_staged_entry_ids
          ? `${label}: ${ids.join(", ")}. Other new eligible entries remain stageable.`
          : `${label}: ${ids.join(", ")}. Review these entries before staging a new selection.`;
        output.appendChild(diagnostic);
      }
      if (preview.zero_duration_entry_ids.length) {
        const diagnostic = document.createElement("p");
        diagnostic.textContent =
          `Zero-duration entries skipped (not sent to Deel): ${preview.zero_duration_entry_ids.join(", ")}. ` +
          "They are excluded from hours and do not block staging the remaining positive time.";
        output.appendChild(diagnostic);
      }
      for (const unmatched of preview.unmatched) {
        const diagnostic = document.createElement("p");
        const name =
          people.querySelector<HTMLInputElement>(
            `input[value="${unmatched.user_id}"]`,
          )?.parentElement?.textContent ?? `Person ${unmatched.user_id}`;
        diagnostic.textContent = `${name}: ${unmatched.reason.replaceAll("_", " ")}. Check the verified payroll email and active Deel contract.`;
        output.appendChild(diagnostic);
      }
      handoff.hidden =
        preview.unresolved_entry_ids.length === 0 && preview.already_staged === 0;
      message.textContent =
        "Review before staging. Rates and invoice totals are determined in Deel.";
    } catch (error) {
      if (
        current(signal, revision) &&
        error instanceof EzactoApiError &&
        [401, 403].includes(error.status)
      ) {
        clear();
        return;
      }
      if (current(signal, revision)) {
        const note =
          error instanceof EzactoApiError && error.status === 503
            ? "Deel could not be reached for review. Nothing was staged. Try again."
            : "The preview could not be loaded. Check the selection and try again.";
        const reference =
          error instanceof EzactoApiError && error.requestId
            ? ` Reference: ${error.requestId}`
            : "";
        message.textContent = note + reference;
      }
    } finally {
      if (current(signal, revision)) {
        busy = false;
        controls();
      }
    }
  });
  const execute = async (statusOnly: boolean) => {
    if (!active || active.aborted || busy || parentBusy || !pending) return;
    const signal = active,
      revision = generation,
      command = pending;
    let refreshProgress = false;
    busy = true;
    controls();
    message.textContent = "Checking or staging the exact reviewed selection…";
    try {
      const response = statusOnly
        ? await api.getDeelStageStatus!({ body: command, signal })
        : await api.stageDeelHours!({
            "Idempotency-Key": command.command_id,
            body: command,
            signal,
          });
      if (!current(signal, revision)) return;
      const result = response.data;
      if (result === null) {
        message.textContent =
          "No accepted command was found. Retry this exact reviewed command.";
        return;
      }
      refreshProgress = true;
      if (result.status === "running") {
        handoff.hidden = false;
        message.textContent =
          "Staging is still running. Check status without sending again.";
        return;
      }
      message.textContent =
        result.status === "staged"
          ? `${result.entries_staged} entries staged in Deel (${result.already_staged} already staged). Complete invoice and payment in Deel; these entries are not marked paid here.`
          : `Staging needs attention (${result.code ?? result.status}). ${result.entries_staged} entries staged. Uncertain entries will not be sent again automatically.`;
      handoff.hidden =
        result.status !== "staged" &&
        result.status !== "attention" &&
        result.entries_staged === 0;
      pending = null;
      preview = null;
      reviewed.checked = false;
    } catch (error) {
      if (current(signal, revision)) {
        if (
          error instanceof EzactoApiError &&
          [401, 403].includes(error.status)
        ) {
          clear();
          return;
        }
        if (
          error instanceof EzactoApiError &&
          (error.status === 401 ||
            error.status === 403 ||
            [
              "deel_stage_stale",
              "deel_stage_invalid",
              "deel_stage_command_reused",
              "deel_stage_unconfigured",
              "deel_stage_provider_unavailable",
            ].includes(
              String(
                (error.body as { error?: { code?: string } })?.error?.code,
              ),
            ))
        ) {
          pending = null;
          clearPreview();
          message.textContent =
            "The command was refused. Review a fresh selection before trying again.";
        } else {
          refreshProgress = true;
          handoff.hidden = false;
          message.textContent =
            "The outcome is unknown. Check status or retry the same command; do not create another selection.";
        }
      }
    } finally {
      if (current(signal, revision)) {
        busy = false;
        controls();
        if (refreshProgress) await progressChanged();
      }
    }
  };
  send.addEventListener("click", () => {
    if (
      !pending &&
      preview &&
      reviewed.checked &&
      !busy &&
      !parentBusy &&
      !reviewed.disabled &&
      !send.disabled
    )
      pending = {
        command_id: crypto.randomUUID(),
        preview_fingerprint: preview.preview_fingerprint,
        from: preview.from,
        to: preview.to,
        user_ids: [...preview.user_ids],
      };
    void execute(false);
  });
  check.addEventListener("click", () => void execute(true));
  retry.addEventListener("click", () => void execute(false));
  return {
    clear,
    available: () => enabled,
    setParentBusy(value: boolean) {
      parentBusy = value;
      controls();
    },
    update(report: StaffPaymentReport) {
      if (pending || busy) return;
      clearPreview();
      people.replaceChildren();
      const seen = new Set<number>();
      for (const row of report.rows.filter(
        (x) => x.active && x.payout_provider === "deel",
      )) {
        if (seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        const label = document.createElement("label"),
          checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = String(row.user_id);
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(row.name));
        people.appendChild(label);
      }
      field("from").value = `${report.month}-01`;
      const last = new Date(`${report.month}-01T00:00:00Z`);
      last.setUTCMonth(last.getUTCMonth() + 1);
      last.setUTCDate(0);
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      field("to").value = [
        last.toISOString().slice(0, 10),
        yesterday.toISOString().slice(0, 10),
      ].sort()[0]!;
      if (dateBounds) {
        field("from").min = dateBounds.from;
        field("to").min = dateBounds.from;
        field("from").max = dateBounds.to;
        field("to").max = dateBounds.to;
        if (field("from").value < dateBounds.from)
          field("from").value = dateBounds.from;
        if (field("to").value > dateBounds.to)
          field("to").value = dateBounds.to;
        if (field("to").value < field("from").value)
          field("to").value = dateBounds.to;
      }
    },
    open(userId?: number) {
      if (!enabled || pending || busy) return;
      root.hidden = false;
      for (const box of people.querySelectorAll<HTMLInputElement>("input"))
        box.checked = userId !== undefined && Number(box.value) === userId;
      clearPreview();
      root.scrollIntoView({ block: "nearest" });
      field("from").focus();
    },
    async activate(signal: AbortSignal) {
      clear();
      active = signal;
      const revision = generation;
      signal.addEventListener(
        "abort",
        () => {
          if (active === signal) clear();
        },
        { once: true },
      );
      if (
        signal.aborted ||
        isDemoDeployment() ||
        !api.getDeelStaging ||
        !api.previewDeelStaging ||
        !api.stageDeelHours ||
        !api.getDeelStageStatus
      )
        return;
      try {
        const response = await api.getDeelStaging({ signal });
        if (current(signal, revision)) {
          const { start_date, last_complete_date } = response.data;
          dateBounds =
            start_date && last_complete_date
              ? { from: start_date, to: last_complete_date }
              : null;
          enabled =
            response.data.configured &&
            dateBounds !== null &&
            dateBounds.from <= dateBounds.to;
          changed();
        }
      } catch {
        /* unavailable until authoritative discovery succeeds */
      }
    },
  };
};
