import { EzactoApiError } from "@conflict-hq/ezacto-client";
import { renderDataTable } from "../components/data-table.js";
import {
  hoursText,
  hoursToSeconds,
  weekHeading,
  type PlanningRange,
} from "./model.js";
import {
  unassignedWeeklySeconds,
  type PlaceholderPlan,
  type PlaceholderPlanningApi,
  type PlanningPlaceholder,
} from "./placeholder-model.js";
import { renderPlaceholderPlanning } from "./placeholder-render.js";

interface Choice {
  readonly id: number;
  readonly name: string;
}
const demandText = (seconds: number) =>
  seconds % 360 === 0
    ? hoursText(seconds)
    : `${hoursText(seconds)} (${seconds.toLocaleString("en-US")}s)`;
interface Context {
  readonly signal: AbortSignal;
  readonly range: PlanningRange;
  readonly weeks: readonly string[];
  readonly people: readonly Choice[];
  readonly projects: readonly Choice[];
  readonly administrator: boolean;
}

const failure = (error: unknown): { message: string; conflict: boolean } => {
  if (
    error instanceof EzactoApiError &&
    error.body &&
    typeof error.body === "object"
  ) {
    const detail = (
      error.body as {
        error?: { message?: unknown; fields?: { message?: unknown }[] };
      }
    ).error;
    const message =
      typeof detail?.fields?.[0]?.message === "string"
        ? detail.fields[0].message
        : typeof detail?.message === "string"
          ? detail.message
          : "Planning could not be saved.";
    return { message, conflict: error.status === 409 };
  }
  return {
    message:
      "The result could not be confirmed. Reload saved planning before making another change.",
    conflict: true,
  };
};

/** Separate demand rows never participate in the person's capacity grid. */
export const createPlaceholderPlanningController = (
  host: HTMLElement,
  api: PlaceholderPlanningApi,
  onChanged: () => void,
) => {
  host.innerHTML = renderPlaceholderPlanning();
  const find = <T extends Element>(selector: string): T => {
    const element = host.querySelector<T>(selector);
    if (!element)
      throw new Error(`placeholder planning element missing: ${selector}`);
    return element;
  };
  const definitionForm = find<HTMLFormElement>(
    "[data-placeholder-definition-form]",
  );
  const planForm = find<HTMLFormElement>("[data-placeholder-plan-form]");
  const assignForm = find<HTMLFormElement>("[data-placeholder-assign-form]");
  const status = find<HTMLElement>("[data-placeholder-status]");
  const reload = find<HTMLButtonElement>("[data-placeholder-reload]");
  const dialog = find<HTMLDialogElement>("[data-placeholder-archive-dialog]");
  const field = (form: HTMLFormElement, name: string) =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
  let active: Context | null = null;
  let revision = 0;
  let generation = 0;
  let pending = false;
  let stale = false;
  let recovering = false;
  let editingDefinition: PlanningPlaceholder | null = null;
  let editingPlan: PlaceholderPlan | null = null;
  let originalHours: string | null = null;
  let assigning: PlaceholderPlan | null = null;
  let assignmentCommand: { fingerprint: string; key: string } | null = null;
  let archiving:
    | { kind: "definition"; row: PlanningPlaceholder }
    | { kind: "plan"; row: PlaceholderPlan }
    | null = null;
  let definitions: readonly PlanningPlaceholder[] = [];
  let rows: readonly PlaceholderPlan[] = [];
  const current = (context: Context) =>
    active?.signal === context.signal && !context.signal.aborted;
  const choice = (select: HTMLSelectElement, choices: readonly Choice[]) => {
    const value = select.value;
    const option = (label: string, id: string) => {
      const element = document.createElement("option");
      element.textContent = label;
      element.value = id;
      return element;
    };
    select.replaceChildren(
      option("Choose…", ""),
      ...choices.map((row) => option(row.name, String(row.id))),
    );
    select.value = value;
  };
  const setBusy = () => {
    const blocked = pending || recovering;
    for (const control of host.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input,select,button"))
      control.disabled = blocked;
    field(planForm, "placeholder_id").disabled =
      blocked || editingPlan !== null;
    field(planForm, "project_id").disabled = blocked || editingPlan !== null;
    reload.disabled = pending;
  };
  const resetDefinition = () => {
    editingDefinition = null;
    definitionForm.reset();
    find<HTMLElement>("[data-placeholder-definition-save]").textContent =
      "Add placeholder";
    find<HTMLElement>("[data-placeholder-definition-cancel]").hidden = true;
  };
  const resetPlan = () => {
    editingPlan = null;
    originalHours = null;
    planForm.reset();
    find<HTMLElement>("[data-placeholder-plan-save]").textContent =
      "Add unassigned work";
    find<HTMLElement>("[data-placeholder-plan-cancel]").hidden = true;
    setBusy();
  };
  const cancelAssignment = () => {
    assigning = null;
    assignmentCommand = null;
    assignForm.reset();
    assignForm.hidden = true;
    find<HTMLElement>("[data-placeholder-assign-description]").textContent = "";
  };
  const reset = () => {
    resetDefinition();
    resetPlan();
    cancelAssignment();
    archiving = null;
    dialog.close();
  };
  const showArchive = (value: NonNullable<typeof archiving>) => {
    if (pending || stale || !active?.administrator) return;
    archiving = value;
    find<HTMLElement>("[data-placeholder-archive-description]").textContent =
      value.kind === "definition"
        ? `Archive ${value.row.name} and its remaining unassigned work?`
        : `${value.row.name}: ${value.row.start_date} to ${value.row.end_date}, ${hoursText(value.row.planned_seconds_per_week)} per week.`;
    dialog.showModal();
  };
  const run = async (
    work: (context: Context) => Promise<string>,
    after: () => void,
  ) => {
    const context = active;
    if (
      !context ||
      !context.administrator ||
      context.signal.aborted ||
      pending ||
      stale
    )
      return;
    const epoch = generation;
    const stillCurrent = () => current(context) && epoch === generation;
    pending = true;
    setBusy();
    status.textContent = "Saving planning…";
    try {
      const message = await work(context);
      if (!stillCurrent()) return;
      after();
      status.textContent = message;
      onChanged();
    } catch (error) {
      if (!stillCurrent()) return;
      if (
        error instanceof EzactoApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        clear();
        return;
      }
      const detail = failure(error);
      stale = detail.conflict;
      reload.hidden = !stale;
      status.textContent =
        detail.message +
        (stale
          ? " Your inputs are kept. Reload saved planning to use its current versions."
          : "");
    } finally {
      if (stillCurrent()) {
        pending = false;
        setBusy();
      }
    }
  };
  const render = (context: Context) => {
    const open = rows.filter((row) => row.state === "open");
    find<HTMLElement>("[data-placeholder-totals]").replaceChildren(
      renderDataTable<string>({
        caption: "Unassigned weekly demand, separate from person capacity",
        table: "unassigned-totals",
        rows: context.weeks,
        rowKey: (week) => week,
        empty: "No weeks to show.",
        columns: [
          { key: "week", label: "Week", fit: true, render: weekHeading },
          {
            key: "hours",
            label: "Unassigned demand",
            render: (week) => demandText(unassignedWeeklySeconds(open, week)),
          },
        ],
      }),
    );
    find<HTMLElement>("[data-placeholder-rows]").replaceChildren(
      renderDataTable<PlaceholderPlan>({
        caption: "Unassigned project plans",
        table: "unassigned-plans",
        rows: open,
        rowKey: (row) => String(row.id),
        empty: "No unassigned work in these weeks.",
        columns: [
          {
            key: "placeholder",
            label: "Placeholder",
            wrap: true,
            render: (row) => row.name,
          },
          {
            key: "project",
            label: "Project",
            wrap: true,
            render: (row) => row.project_name,
          },
          {
            key: "dates",
            label: "Dates",
            wrap: true,
            render: (row) => `${row.start_date} to ${row.end_date}`,
          },
          {
            key: "hours",
            label: "Hours per week",
            render: (row) => demandText(row.planned_seconds_per_week),
          },
        ],
        ...(context.administrator
          ? {
              actions: (row: PlaceholderPlan) => [
                {
                  label: "Edit unassigned work",
                  primary: true,
                  onSelect: () => {
                    if (pending || stale) return;
                    editingPlan = row;
                    field(planForm, "placeholder_id").value = String(
                      row.placeholder_id,
                    );
                    field(planForm, "project_id").value = String(
                      row.project_id,
                    );
                    field(planForm, "start_date").value = row.start_date;
                    field(planForm, "end_date").value = row.end_date;
                    originalHours = String(row.planned_seconds_per_week / 3600);
                    field(planForm, "hours").value = originalHours;
                    find<HTMLElement>(
                      "[data-placeholder-plan-save]",
                    ).textContent = "Save unassigned work";
                    find<HTMLElement>("[data-placeholder-plan-cancel]").hidden =
                      false;
                    setBusy();
                    field(planForm, "hours").focus();
                  },
                },
                {
                  label: "Assign to person",
                  onSelect: () => {
                    if (pending || stale) return;
                    assigning = row;
                    assignmentCommand = null;
                    assignForm.hidden = false;
                    find<HTMLElement>(
                      "[data-placeholder-assign-description]",
                    ).textContent =
                      `${row.name}, ${row.project_name}: ${row.start_date} to ${row.end_date}, ${hoursText(row.planned_seconds_per_week)} per week.`;
                    field(assignForm, "user_id").focus();
                  },
                },
                {
                  label: "Archive unassigned work",
                  onSelect: () => showArchive({ kind: "plan", row }),
                },
              ],
            }
          : {}),
      }),
    );
    find<HTMLElement>("[data-placeholder-administration]").hidden =
      !context.administrator;
    if (!context.administrator) return;
    choice(
      field(planForm, "placeholder_id") as HTMLSelectElement,
      definitions.filter((row) => row.is_active),
    );
    choice(
      field(planForm, "project_id") as HTMLSelectElement,
      context.projects,
    );
    choice(field(assignForm, "user_id") as HTMLSelectElement, context.people);
    find<HTMLElement>("[data-placeholder-definitions]").replaceChildren(
      renderDataTable<PlanningPlaceholder>({
        caption: "Active planning placeholders",
        table: "planning-placeholders",
        rows: definitions.filter((row) => row.is_active),
        rowKey: (row) => String(row.id),
        empty: "No planning placeholders yet.",
        columns: [
          { key: "name", label: "Name", wrap: true, render: (row) => row.name },
        ],
        actions: (row) => [
          {
            label: "Rename placeholder",
            primary: true,
            onSelect: () => {
              if (pending || stale) return;
              editingDefinition = row;
              field(definitionForm, "name").value = row.name;
              find<HTMLElement>(
                "[data-placeholder-definition-save]",
              ).textContent = "Save placeholder name";
              find<HTMLElement>("[data-placeholder-definition-cancel]").hidden =
                false;
              field(definitionForm, "name").focus();
            },
          },
          {
            label: "Archive placeholder",
            onSelect: () => showArchive({ kind: "definition", row }),
          },
        ],
      }),
    );
    setBusy();
  };
  definitionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!definitionForm.reportValidity()) return;
    const row = editingDefinition,
      name = field(definitionForm, "name").value.trim();
    if (!name) return;
    void run(async (context) => {
      if (row)
        await api.updateDefinition(
          row.id,
          { name, version: row.version },
          context.signal,
        );
      else await api.createDefinition({ name }, context.signal);
      return row ? "Placeholder renamed." : "Placeholder added.";
    }, resetDefinition);
  });
  planForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!planForm.reportValidity()) return;
    const hours = field(planForm, "hours").value;
    const seconds =
      editingPlan !== null && hours === originalHours
        ? editingPlan.planned_seconds_per_week
        : hoursToSeconds(hours);
    if (seconds === null || !Number.isSafeInteger(seconds)) {
      status.textContent = "Enter positive hours per week.";
      return;
    }
    const row = editingPlan;
    const dates = {
      start_date: field(planForm, "start_date").value,
      end_date: field(planForm, "end_date").value,
      planned_seconds_per_week: seconds,
    };
    if (dates.end_date < dates.start_date) {
      status.textContent = "The end date must be on or after the start date.";
      return;
    }
    const placeholder_id = Number(field(planForm, "placeholder_id").value),
      project_id = Number(field(planForm, "project_id").value);
    void run(async (context) => {
      if (row)
        await api.update(
          row.id,
          { ...dates, version: row.version },
          context.signal,
        );
      else
        await api.create(
          { ...dates, placeholder_id, project_id },
          context.signal,
        );
      return row ? "Unassigned work saved." : "Unassigned work added.";
    }, resetPlan);
  });
  assignForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const row = assigning;
    if (!row || !assignForm.reportValidity()) return;
    const user_id = Number(field(assignForm, "user_id").value);
    const fingerprint = JSON.stringify([row.id, row.version, user_id]);
    if (assignmentCommand?.fingerprint !== fingerprint)
      assignmentCommand = { fingerprint, key: crypto.randomUUID() };
    const key = assignmentCommand.key;
    void run(async (context) => {
      const result = await api.assign(
        row.id,
        { version: row.version, user_id, idempotency_key: key },
        context.signal,
      );
      const warnings = result.warnings.map(
        (warning) =>
          `${weekHeading(warning.week_start)}: ${hoursText(warning.planned_seconds)} planned against ${hoursText(warning.capacity_seconds)} capacity.`,
      );
      if (result.prerequisites.length)
        warnings.push(
          "This person still needs project access; manage staffing separately. No access was granted.",
        );
      return ["Assigned to person.", ...warnings].join(" ");
    }, cancelAssignment);
  });
  find<HTMLButtonElement>(
    "[data-placeholder-definition-cancel]",
  ).addEventListener("click", resetDefinition);
  find<HTMLButtonElement>("[data-placeholder-plan-cancel]").addEventListener(
    "click",
    resetPlan,
  );
  find<HTMLButtonElement>("[data-placeholder-assign-cancel]").addEventListener(
    "click",
    cancelAssignment,
  );
  find<HTMLButtonElement>("[data-placeholder-archive-cancel]").addEventListener(
    "click",
    () => dialog.close(),
  );
  dialog.addEventListener("close", () => {
    archiving = null;
    find<HTMLElement>("[data-placeholder-archive-description]").textContent =
      "";
  });
  find<HTMLFormElement>("[data-placeholder-archive-form]").addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      const target = archiving;
      if (!target) return;
      dialog.close();
      void run(async (context) => {
        if (target.kind === "definition")
          await api.archiveDefinition(
            target.row.id,
            target.row.version,
            context.signal,
          );
        else
          await api.archive(target.row.id, target.row.version, context.signal);
        return "Unassigned planning archived.";
      }, reset);
    },
  );
  const clear = () => {
    active = null;
    generation++;
    revision++;
    pending = false;
    stale = false;
    recovering = false;
    definitions = [];
    rows = [];
    reset();
    for (const select of host.querySelectorAll("select"))
      select.replaceChildren();
    find<HTMLElement>("[data-placeholder-archive-description]").textContent =
      "";
    status.textContent = "";
    reload.hidden = true;
    for (const name of ["rows", "totals", "definitions"])
      find<HTMLElement>(`[data-placeholder-${name}]`).replaceChildren();
    host.hidden = true;
  };
  const refresh = async (context: Context) => {
    if (context.signal.aborted) return;
    const changingView =
      active === null ||
      active.signal !== context.signal ||
      active.range.from !== context.range.from ||
      active.range.to !== context.range.to;
    if (active?.signal !== context.signal) {
      clear();
      context.signal.addEventListener(
        "abort",
        () => {
          if (active?.signal === context.signal) clear();
        },
        { once: true },
      );
    }
    active = context;
    const request = ++revision;
    host.hidden = false;
    if (changingView) status.textContent = "Loading unassigned work…";
    try {
      const [nextRows, nextDefinitions] = await Promise.all([
        api.list(context.range, context.signal),
        context.administrator
          ? api.listDefinitions(context.signal)
          : Promise.resolve([]),
      ]);
      if (!current(context) || request !== revision) return;
      rows = nextRows;
      definitions = nextDefinitions;
      if (recovering) {
        stale = false;
        recovering = false;
        reload.hidden = true;
      }
      render(context);
      if (
        status.textContent === "Loading unassigned work…" ||
        status.textContent === "Reloading saved planning…"
      )
        status.textContent = "";
    } catch (error) {
      if (!current(context) || request !== revision) return;
      if (
        error instanceof EzactoApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        clear();
        return;
      }
      status.textContent = failure(error).message;
      reload.hidden = false;
    }
  };
  reload.addEventListener("click", () => {
    const context = active;
    if (!context || pending) return;
    stale = true;
    recovering = true;
    reset();
    status.textContent = "Reloading saved planning…";
    reload.hidden = true;
    void refresh(context);
  });
  return { clear, refresh };
};
