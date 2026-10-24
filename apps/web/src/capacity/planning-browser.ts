import { createOrganizationHolidayController } from './organization-holidays-browser.js'
import { renderDataTable } from "../components/data-table.js";
import {
  hoursText,
  hoursToSeconds,
  secondsToHoursField,
  shortDate,
  type AllocationRow,
  type PlanningApi,
  type PlanningRange,
  type TimeOffKindName,
  type TimeOffRow,
} from "./model.js";
import { renderPlanningSection } from "./render.js";

/**
 * The administrator's allocation and time off entry on the capacity screen
 * (issue 1007). It writes through the existing endpoints and nothing else; the
 * server decides who may write and refuses a bad range or an overlap, and its
 * message is shown as given.
 */
export interface PlanningEntry {
  /** Draw the entry section into `host` and reveal it. Idempotent. */
  mount(): void;
  /** Remove every control, as for anyone who is not an administrator. */
  unmount(): void;
  /** Reload the rows and the pickers for the weeks now shown. */
  refresh(
    people: readonly { readonly id: number; readonly name: string }[],
    range: PlanningRange,
    signal: AbortSignal,
  ): Promise<void>;
}

const kindLabel: Record<TimeOffKindName, string> = {
  vacation: "Vacation",
  sick: "Sick",
  holiday: "Holiday",
  other: "Other",
};

const messageOf = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

export const createPlanningEntry = (
  host: HTMLElement,
  api: PlanningApi,
  onChanged: () => void,
): PlanningEntry => {
  let mounted = false;
  let holidays: ReturnType<typeof createOrganizationHolidayController> | null = null;
  let people: readonly { id: number; name: string }[] = [];
  let projects: readonly { id: number; name: string }[] = [];
  let allocations: readonly AllocationRow[] = [];
  let timeOff: readonly TimeOffRow[] = [];
  let pendingDelete: string | null = null;

  const query = <ElementType extends Element>(
    selector: string,
  ): ElementType => {
    const element = host.querySelector<ElementType>(selector);
    if (element === null)
      throw new Error(`planning element missing: ${selector}`);
    return element;
  };
  const personName = (id: number): string =>
    people.find((person) => person.id === id)?.name ?? `Person ${id}`;
  const projectName = (id: number): string =>
    projects.find((project) => project.id === id)?.name ?? `Project ${id}`;
  const span = (from: string, to: string): string =>
    `${shortDate(from)} to ${shortDate(to)}`;

  const fillSelect = (
    select: HTMLSelectElement,
    options: readonly { id: number; name: string }[],
  ): void => {
    const chosen = select.value;
    select.replaceChildren(
      ...options.map((option) => {
        const element = document.createElement("option");
        element.value = String(option.id);
        element.textContent = option.name;
        return element;
      }),
    );
    if (chosen !== "") select.value = chosen;
    if (select.value === "" && options.length > 0) select.selectedIndex = 0;
  };

  const actions = (
    label: string,
    edit: () => void,
    remove: () => Promise<void>,
    key: string,
  ) => {
    const wrapper = document.createElement("span");
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.textContent = "Edit";
    editButton.setAttribute("aria-label", `Edit ${label}`);
    editButton.addEventListener("click", edit);
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    // Two steps: a delete is not undone, and there is no dialog to lean on here.
    const confirming = pendingDelete === key;
    removeButton.textContent = confirming ? "Confirm delete" : "Delete";
    removeButton.setAttribute(
      "aria-label",
      `${confirming ? "Confirm delete of" : "Delete"} ${label}`,
    );
    removeButton.addEventListener("click", () => {
      if (pendingDelete !== key) {
        pendingDelete = key;
        drawTables();
        return;
      }
      pendingDelete = null;
      void remove();
    });
    wrapper.append(editButton, " ", removeButton);
    return wrapper;
  };

  const allocationForm = (): HTMLFormElement =>
    query("[data-planning-allocation-form]");
  const timeOffForm = (): HTMLFormElement =>
    query("[data-planning-timeoff-form]");
  const field = (
    form: HTMLFormElement,
    name: string,
  ): HTMLInputElement | HTMLSelectElement =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;

  const resetAllocation = (): void => {
    const form = allocationForm();
    form.reset();
    field(form, "id").value = "";
    field(form, "user_id").removeAttribute("disabled");
    field(form, "project_id").removeAttribute("disabled");
    query<HTMLElement>("[data-planning-allocation-save]").textContent =
      "Add allocation";
    query<HTMLElement>("[data-planning-allocation-cancel]").hidden = true;
  };
  const resetTimeOff = (): void => {
    const form = timeOffForm();
    form.reset();
    field(form, "id").value = "";
    field(form, "user_id").removeAttribute("disabled");
    query<HTMLElement>("[data-planning-timeoff-save]").textContent =
      "Add time off";
    query<HTMLElement>("[data-planning-timeoff-cancel]").hidden = true;
  };

  const editAllocation = (row: AllocationRow): void => {
    const form = allocationForm();
    field(form, "id").value = String(row.id);
    field(form, "user_id").value = String(row.user_id);
    field(form, "project_id").value = String(row.project_id);
    // The endpoint changes dates and hours; moving a plan to someone else is a delete and an add.
    field(form, "user_id").setAttribute("disabled", "");
    field(form, "project_id").setAttribute("disabled", "");
    field(form, "start_date").value = row.start_date;
    field(form, "end_date").value = row.end_date;
    field(form, "hours").value = secondsToHoursField(
      row.planned_seconds_per_week,
    );
    query<HTMLElement>("[data-planning-allocation-save]").textContent =
      "Save allocation";
    query<HTMLElement>("[data-planning-allocation-cancel]").hidden = false;
  };
  const editTimeOff = (row: TimeOffRow): void => {
    const form = timeOffForm();
    field(form, "id").value = String(row.id);
    field(form, "user_id").value = String(row.user_id);
    field(form, "user_id").setAttribute("disabled", "");
    field(form, "kind").value = row.kind;
    field(form, "start_date").value = row.start_date;
    field(form, "end_date").value = row.end_date;
    field(form, "hours").value =
      row.seconds_per_day === null
        ? ""
        : secondsToHoursField(row.seconds_per_day);
    query<HTMLElement>("[data-planning-timeoff-save]").textContent =
      "Save time off";
    query<HTMLElement>("[data-planning-timeoff-cancel]").hidden = false;
  };

  const run = async (
    statusSelector: string,
    work: () => Promise<void>,
    done: string,
  ): Promise<boolean> => {
    const status = query<HTMLElement>(statusSelector);
    status.textContent = "Saving…";
    try {
      await work();
      status.textContent = done;
      onChanged();
      return true;
    } catch (error) {
      status.textContent = messageOf(error, "That could not be saved.");
      return false;
    }
  };

  function drawTables(): void {
    query<HTMLElement>("[data-planning-allocations]").replaceChildren(
      renderDataTable<AllocationRow>({
        caption: "Allocations in these weeks",
        table: "capacity-allocations",
        defaultSort: { column: 'dates', direction: 'ascending' },
        rows: [...allocations],
        rowKey: (row) => String(row.id),
        empty: "No allocations in these weeks.",
        columns: [
          {
            key: "person",
            label: "Person",
            sortValue: (row) => personName(row.user_id),
            render: (row) => personName(row.user_id),
          },
          {
            key: "project",
            label: "Project",
            sortValue: (row) => projectName(row.project_id),
            render: (row) => projectName(row.project_id),
          },
          {
            key: "dates",
            label: "Dates",
            sortValue: (row) => [row.start_date, row.end_date],
            render: (row) => span(row.start_date, row.end_date),
          },
          {
            key: "hours",
            label: "Planned",
            sortValue: (row) => row.planned_seconds_per_week,
            render: (row) =>
              `${hoursText(row.planned_seconds_per_week)} per week`,
          },
          {
            key: "actions",
            label: "",
            render: (row) =>
              actions(
                `allocation of ${personName(row.user_id)} to ${projectName(row.project_id)}`,
                () => editAllocation(row),
                async () => {
                  const status = query<HTMLElement>(
                    "[data-planning-allocation-status]",
                  );
                  status.textContent = "Deleting…";
                  try {
                    await api.deleteAllocation(row.id);
                    status.textContent = "Allocation deleted.";
                    resetAllocation();
                    onChanged();
                  } catch (error) {
                    status.textContent = messageOf(
                      error,
                      "That could not be deleted.",
                    );
                  }
                },
                `allocation-${row.id}`,
              ),
          },
        ],
      }),
    );
    query<HTMLElement>("[data-planning-timeoff]").replaceChildren(
      renderDataTable<TimeOffRow>({
        caption: "Time off in these weeks",
        table: "capacity-time-off",
        defaultSort: { column: 'dates', direction: 'ascending' },
        rows: [...timeOff],
        rowKey: (row) => String(row.id),
        empty: "No time off in these weeks.",
        columns: [
          {
            key: "person",
            label: "Person",
            sortValue: (row) => personName(row.user_id),
            render: (row) => personName(row.user_id),
          },
          { key: "kind", label: "Kind", sortValue: (row) => kindLabel[row.kind], render: (row) => kindLabel[row.kind] },
          {
            key: "dates",
            label: "Dates",
            sortValue: (row) => [row.start_date, row.end_date],
            render: (row) => span(row.start_date, row.end_date),
          },
          {
            key: "hours",
            label: "Away",
            sortValue: (row) => row.seconds_per_day,
            render: (row) =>
              row.seconds_per_day === null
                ? "Whole days"
                : `${hoursText(row.seconds_per_day)} per day`,
          },
          {
            key: "actions",
            label: "",
            render: (row) =>
              actions(
                `${kindLabel[row.kind].toLowerCase()} of ${personName(row.user_id)}`,
                () => editTimeOff(row),
                async () => {
                  const status = query<HTMLElement>(
                    "[data-planning-timeoff-status]",
                  );
                  status.textContent = "Deleting…";
                  try {
                    await api.deleteTimeOff(row.id);
                    status.textContent = "Time off deleted.";
                    resetTimeOff();
                    onChanged();
                  } catch (error) {
                    status.textContent = messageOf(
                      error,
                      "That could not be deleted.",
                    );
                  }
                },
                `timeoff-${row.id}`,
              ),
          },
        ],
      }),
    );
  }

  const wire = (): void => {
    allocationForm().addEventListener("submit", (event) => {
      event.preventDefault();
      const form = allocationForm();
      const status = query<HTMLElement>("[data-planning-allocation-status]");
      const planned = hoursToSeconds(field(form, "hours").value);
      const start = field(form, "start_date").value;
      const end = field(form, "end_date").value;
      const user = Number(field(form, "user_id").value);
      const project = Number(field(form, "project_id").value);
      if (planned === null) {
        status.textContent =
          "Enter the planned hours per week as a number, such as 16 or 7.5.";
        return;
      }
      if (start === "" || end === "" || !(user > 0) || !(project > 0)) {
        status.textContent = "Choose a person, a project and both dates.";
        return;
      }
      const id = field(form, "id").value;
      void run(
        "[data-planning-allocation-status]",
        async () => {
          if (id === "") {
            await api.createAllocation({
              user_id: user,
              project_id: project,
              start_date: start,
              end_date: end,
              planned_seconds_per_week: planned,
            });
          } else {
            await api.updateAllocation(Number(id), {
              start_date: start,
              end_date: end,
              planned_seconds_per_week: planned,
            });
          }
          resetAllocation();
        },
        id === "" ? "Allocation added." : "Allocation saved.",
      );
    });
    timeOffForm().addEventListener("submit", (event) => {
      event.preventDefault();
      const form = timeOffForm();
      const status = query<HTMLElement>("[data-planning-timeoff-status]");
      const typed = field(form, "hours").value.trim();
      const perDay = typed === "" ? null : hoursToSeconds(typed);
      const start = field(form, "start_date").value;
      const end = field(form, "end_date").value;
      const user = Number(field(form, "user_id").value);
      const kind = field(form, "kind").value as TimeOffKindName;
      if (typed !== "" && perDay === null) {
        status.textContent =
          "Enter the hours per day as a number, or leave it blank for whole days.";
        return;
      }
      if (start === "" || end === "" || !(user > 0)) {
        status.textContent = "Choose a person and both dates.";
        return;
      }
      const id = field(form, "id").value;
      void run(
        "[data-planning-timeoff-status]",
        async () => {
          if (id === "") {
            await api.createTimeOff({
              user_id: user,
              start_date: start,
              end_date: end,
              kind,
              seconds_per_day: perDay,
            });
          } else {
            await api.updateTimeOff(Number(id), {
              start_date: start,
              end_date: end,
              kind,
              seconds_per_day: perDay,
            });
          }
          resetTimeOff();
        },
        id === "" ? "Time off added." : "Time off saved.",
      );
    });
    query("[data-planning-allocation-cancel]").addEventListener(
      "click",
      resetAllocation,
    );
    query("[data-planning-timeoff-cancel]").addEventListener(
      "click",
      resetTimeOff,
    );
  };

  return {
    mount() {
      if (mounted) return;
      host.innerHTML = renderPlanningSection();
      host.hidden = false;
      mounted = true;
      wire();
      const holidayHost = host.querySelector<HTMLElement>("[data-organization-holidays]");
      if (holidayHost && api.holidays) holidays = createOrganizationHolidayController(holidayHost, api.holidays, onChanged);
    },
    unmount() {
      mounted = false;
      holidays?.clear(); holidays = null;
      host.replaceChildren();
      host.hidden = true;
    },
    async refresh(nextPeople, range, signal) {
      if (!mounted) return;
      people = nextPeople;
      await holidays?.refresh(range, signal);
      try {
        if (projects.length === 0) projects = await api.listProjects(signal);
        [allocations, timeOff] = await Promise.all([
          api.listAllocations(range, signal),
          api.listTimeOff(range, signal),
        ]);
      } catch (error) {
        if (signal.aborted) return;
        query<HTMLElement>("[data-planning-allocation-status]").textContent =
          messageOf(error, "Allocations and time off could not be loaded.");
        return;
      }
      if (signal.aborted) return;
      fillSelect(
        field(allocationForm(), "user_id") as HTMLSelectElement,
        people,
      );
      fillSelect(
        field(allocationForm(), "project_id") as HTMLSelectElement,
        projects,
      );
      fillSelect(field(timeOffForm(), "user_id") as HTMLSelectElement, people);
      drawTables();
    },
  };
};
