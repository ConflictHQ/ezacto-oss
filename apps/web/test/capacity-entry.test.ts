/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from "vitest";
import { createCapacityController } from "../src/capacity/browser.js";
import {
  hoursToSeconds,
  secondsToHoursField,
  type AllocationRow,
  type CapacityData,
  type PlanningApi,
  type TimeOffRow,
} from "../src/capacity/model.js";
import { renderCapacityPage } from "../src/capacity/render.js";

const hours = (count: number) => count * 3_600;

const report: CapacityData = {
  week_start_day: "monday",
  weeks: ["2026-10-05"],
  people: [
    {
      user_id: 1,
      first_name: "Maya",
      last_name: "Member",
      weekly_capacity_seconds: hours(20),
      weeks: [
        {
          week_start: "2026-10-05",
          planned_seconds: hours(16),
          time_off_seconds: 0,
          available_capacity_seconds: hours(20),
          tracked_seconds: 0,
          over_allocated: false,
        },
      ],
    },
  ],
};

const allocation: AllocationRow = {
  id: 7,
  user_id: 1,
  project_id: 3,
  start_date: "2026-10-05",
  end_date: "2026-10-30",
  planned_seconds_per_week: hours(16),
};
const away: TimeOffRow = {
  id: 9,
  user_id: 1,
  start_date: "2026-10-12",
  end_date: "2026-10-13",
  kind: "vacation",
  seconds_per_day: null,
};

const planningApi = (): PlanningApi => ({
  listProjects: vi.fn(async () => [{ id: 3, name: "Atlas" }]),
  listAllocations: vi.fn(async () => [allocation]),
  createAllocation: vi.fn(async () => ({})),
  updateAllocation: vi.fn(async () => ({})),
  deleteAllocation: vi.fn(async () => ({})),
  listTimeOff: vi.fn(async () => [away]),
  createTimeOff: vi.fn(async () => ({})),
  updateTimeOff: vi.fn(async () => ({})),
  deleteTimeOff: vi.fn(async () => ({})),
});

const text = (selector: string): string =>
  document.querySelector<HTMLElement>(selector)?.textContent ?? "";
const input = (form: string, name: string): HTMLInputElement =>
  document
    .querySelector<HTMLFormElement>(form)!
    .elements.namedItem(name) as HTMLInputElement;
const submit = (form: string): void => {
  document
    .querySelector<HTMLFormElement>(form)!
    .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
};
const buttonLabelled = (label: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

const open = async (administrator: boolean, planning = planningApi()) => {
  document.body.innerHTML = renderCapacityPage("capacity");
  const getCapacity = vi.fn(async () => ({ data: report }));
  await createCapacityController({ getCapacity, planning }).activate(
    new AbortController().signal,
    { administrator },
  );
  return { planning, getCapacity };
};

describe("capacity entry model (issue 1007)", () => {
  it("[unit] reads typed hours as whole seconds and refuses anything else", () => {
    expect(hoursToSeconds("16")).toBe(57_600);
    expect(hoursToSeconds(" 7.5 ")).toBe(27_000);
    expect(hoursToSeconds("")).toBeNull();
    expect(hoursToSeconds("-2")).toBeNull();
    expect(hoursToSeconds("0")).toBeNull();
    expect(hoursToSeconds("abc")).toBeNull();
    expect(secondsToHoursField(27_000)).toBe("7.5");
  });
});

describe("capacity entry (issue 1007)", () => {
  it("[browser] gives a non-administrator no control and asks for no rows", async () => {
    const { planning } = await open(false);
    expect(text("[data-capacity-grid]")).toContain("Maya Member");
    expect(
      document.querySelector(
        "[data-capacity-page] input, [data-capacity-page] form, [data-capacity-page] select, [data-capacity-page] textarea",
      ),
    ).toBeNull();
    expect(planning.listAllocations).not.toHaveBeenCalled();
    expect(planning.listTimeOff).not.toHaveBeenCalled();
  });

  it("[browser] shows an administrator the rows in the weeks and the forms", async () => {
    await open(true);
    expect(text("[data-planning-allocations]")).toContain("Maya Member");
    expect(text("[data-planning-allocations]")).toContain("Atlas");
    expect(text("[data-planning-allocations]")).toContain("16h per week");
    expect(text("[data-planning-timeoff]")).toContain("Vacation");
    expect(text("[data-planning-timeoff]")).toContain("Whole days");
  });

  it("[browser] creates an allocation in seconds and reloads the grid", async () => {
    const { planning, getCapacity } = await open(true);
    input("[data-planning-allocation-form]", "start_date").value = "2026-11-02";
    input("[data-planning-allocation-form]", "end_date").value = "2026-11-27";
    input("[data-planning-allocation-form]", "hours").value = "12.5";
    submit("[data-planning-allocation-form]");
    await vi.waitFor(() =>
      expect(planning.createAllocation).toHaveBeenCalledWith({
        user_id: 1,
        project_id: 3,
        start_date: "2026-11-02",
        end_date: "2026-11-27",
        planned_seconds_per_week: 45_000,
      }),
    );
    await vi.waitFor(() => expect(getCapacity).toHaveBeenCalledTimes(2));
    expect(text("[data-planning-allocation-status]")).toBe("Allocation added.");
  });

  it("[browser] refuses bad hours before calling the server", async () => {
    const { planning } = await open(true);
    input("[data-planning-allocation-form]", "start_date").value = "2026-11-02";
    input("[data-planning-allocation-form]", "end_date").value = "2026-11-27";
    input("[data-planning-allocation-form]", "hours").value = "lots";
    submit("[data-planning-allocation-form]");
    expect(text("[data-planning-allocation-status]")).toContain(
      "planned hours per week",
    );
    expect(planning.createAllocation).not.toHaveBeenCalled();
  });

  it("[browser] edits an allocation, sending only dates and hours", async () => {
    const { planning } = await open(true);
    buttonLabelled("Edit allocation of Maya Member to Atlas").click();
    expect(input("[data-planning-allocation-form]", "hours").value).toBe("16");
    input("[data-planning-allocation-form]", "hours").value = "10";
    submit("[data-planning-allocation-form]");
    await vi.waitFor(() =>
      expect(planning.updateAllocation).toHaveBeenCalledWith(7, {
        start_date: "2026-10-05",
        end_date: "2026-10-30",
        planned_seconds_per_week: 36_000,
      }),
    );
  });

  it("[browser] deletes an allocation only on the second press", async () => {
    const { planning } = await open(true);
    buttonLabelled("Delete allocation of Maya Member to Atlas").click();
    expect(planning.deleteAllocation).not.toHaveBeenCalled();
    buttonLabelled(
      "Confirm delete of allocation of Maya Member to Atlas",
    ).click();
    await vi.waitFor(() =>
      expect(planning.deleteAllocation).toHaveBeenCalledWith(7),
    );
    await vi.waitFor(() =>
      expect(text("[data-planning-allocation-status]")).toBe(
        "Allocation deleted.",
      ),
    );
  });

  it("[browser] adds time off, a blank hours field meaning whole days", async () => {
    const { planning } = await open(true);
    input("[data-planning-timeoff-form]", "kind").value = "sick";
    input("[data-planning-timeoff-form]", "start_date").value = "2026-10-20";
    input("[data-planning-timeoff-form]", "end_date").value = "2026-10-21";
    submit("[data-planning-timeoff-form]");
    await vi.waitFor(() =>
      expect(planning.createTimeOff).toHaveBeenCalledWith({
        user_id: 1,
        start_date: "2026-10-20",
        end_date: "2026-10-21",
        kind: "sick",
        seconds_per_day: null,
      }),
    );
  });

  it("[browser] edits and deletes time off", async () => {
    const { planning } = await open(true);
    buttonLabelled("Edit vacation of Maya Member").click();
    input("[data-planning-timeoff-form]", "hours").value = "4";
    submit("[data-planning-timeoff-form]");
    await vi.waitFor(() =>
      expect(planning.updateTimeOff).toHaveBeenCalledWith(9, {
        start_date: "2026-10-12",
        end_date: "2026-10-13",
        kind: "vacation",
        seconds_per_day: 14_400,
      }),
    );
    buttonLabelled("Delete vacation of Maya Member").click();
    buttonLabelled("Confirm delete of vacation of Maya Member").click();
    await vi.waitFor(() =>
      expect(planning.deleteTimeOff).toHaveBeenCalledWith(9),
    );
  });

  it("[browser] shows the server refusal as given", async () => {
    const planning = planningApi();
    planning.createTimeOff = vi.fn(async () => {
      throw new Error(
        "This person already has time off that covers some of these dates.",
      );
    });
    await open(true, planning);
    input("[data-planning-timeoff-form]", "start_date").value = "2026-10-12";
    input("[data-planning-timeoff-form]", "end_date").value = "2026-10-12";
    submit("[data-planning-timeoff-form]");
    await vi.waitFor(() =>
      expect(text("[data-planning-timeoff-status]")).toBe(
        "This person already has time off that covers some of these dates.",
      ),
    );
  });
});
