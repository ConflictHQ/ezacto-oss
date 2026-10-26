/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from "vitest";
import { createPlanningEntry } from '../src/capacity/planning-browser.js'
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
  version: 0,
  id: 7,
  user_id: 1,
  project_id: 3,
  start_date: "2026-10-05",
  end_date: "2026-10-30",
  planned_seconds_per_week: hours(16),
};
const away: TimeOffRow = {
  version: 0,
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

describe('precise planning form edits (#1193)',()=>{
  it.each([1,59,60,3601,4442,604799,604800])('round-trips %i stored seconds through an hours field',seconds=>{
    expect(hoursToSeconds(secondsToHoursField(seconds))).toBe(seconds)
  })
  it('preserves exact weekly seconds when only allocation dates change',async()=>{
    const planning=planningApi()
    planning.listAllocations=vi.fn(async()=>[{...allocation,planned_seconds_per_week:4442}])
    await open(true,planning)
    buttonLabelled('Edit allocation of Maya Member to Atlas').click()
    input('[data-planning-allocation-form]','start_date').value='2026-10-06'
    submit('[data-planning-allocation-form]')
    await vi.waitFor(()=>expect(planning.updateAllocation).toHaveBeenCalledWith(7,{
      version:0,start_date:'2026-10-06',end_date:'2026-10-30',planned_seconds_per_week:4442,
    }))
  })
  it('preserves a one-second partial day when only time-off dates change',async()=>{
    const planning=planningApi()
    planning.listTimeOff=vi.fn(async()=>[{...away,seconds_per_day:1}])
    await open(true,planning)
    buttonLabelled('Edit vacation of Maya Member').click()
    input('[data-planning-timeoff-form]','end_date').value='2026-10-14'
    submit('[data-planning-timeoff-form]')
    await vi.waitFor(()=>expect(planning.updateTimeOff).toHaveBeenCalledWith(9,{
      version:0,start_date:'2026-10-12',end_date:'2026-10-14',kind:'vacation',seconds_per_day:1,
    }))
  })
})

describe("capacity entry model (issue 1007)", () => {
  it('locks planning actions during a delayed save and restores them after rejection', async () => {
    const planning = planningApi()
    let reject!: (error: Error) => void
    planning.createAllocation = vi.fn(() => new Promise((_resolve, fail) => { reject = fail }))
    await open(true, planning)
    input('[data-planning-allocation-form]', 'start_date').value = '2026-11-02'
    input('[data-planning-allocation-form]', 'end_date').value = '2026-11-27'
    input('[data-planning-allocation-form]', 'hours').value = '12'
    submit('[data-planning-allocation-form]')
    submit('[data-planning-allocation-form]')
    expect(planning.createAllocation).toHaveBeenCalledTimes(1)
    expect(input('[data-planning-allocation-form]', 'hours').disabled).toBe(true)
    expect(document.querySelector('[data-planning-allocation-status]')?.getAttribute('aria-busy')).toBe('true')
    reject(new Error('Save refused'))
    await vi.waitFor(() => expect(text('[data-planning-allocation-status]')).toContain('Save refused'))
    expect(input('[data-planning-allocation-form]', 'hours').disabled).toBe(false)
    expect(document.querySelector('[data-planning-allocation-status]')?.getAttribute('aria-busy')).toBe('false')
  })
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
        version: 0,
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
      expect(planning.deleteAllocation).toHaveBeenCalledWith(7, 0),
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
        version: 0,
        start_date: "2026-10-12",
        end_date: "2026-10-13",
        kind: "vacation",
        seconds_per_day: 14_400,
      }),
    );
    await vi.waitFor(() => expect(document.querySelector('[data-planning-timeoff-status]')?.getAttribute('aria-busy')).toBe('false'))
    buttonLabelled("Delete vacation of Maya Member").click();
    buttonLabelled("Confirm delete of vacation of Maya Member").click();
    await vi.waitFor(() =>
      expect(planning.deleteTimeOff).toHaveBeenCalledWith(9, 0),
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

it('[browser #852] sorts planning dates and hours without altering an unfinished form', async () => {
  const planning = planningApi()
  planning.listAllocations = vi.fn(async () => [
    { ...allocation, id: 8, planned_seconds_per_week: hours(9), start_date: '2026-10-12' },
    allocation,
  ])
  planning.listTimeOff = vi.fn(async () => [
    away,
    { ...away, id: 10, seconds_per_day: hours(7.5), start_date: '2026-10-20' },
  ])
  await open(true, planning)
  const unfinished = input('[data-planning-allocation-form]', 'hours')
  unfinished.value = '3.75'
  const ids = (table: string) => [...document.querySelectorAll(`${table} tbody tr[data-row-key]`)].map(row => row.getAttribute('data-row-key'))
  const sort = (table: string, column: string) => document.querySelector<HTMLButtonElement>(`${table} button[data-sort-column="${column}"]`)!.click()
  sort('[data-planning-allocations]', 'hours')
  expect(ids('[data-planning-allocations]')).toEqual(['8', '7'])
  sort('[data-planning-allocations]', 'dates')
  expect(ids('[data-planning-allocations]')).toEqual(['7', '8'])
  sort('[data-planning-timeoff]', 'hours')
  expect(ids('[data-planning-timeoff]')).toEqual(['10', '9'])
  sort('[data-planning-timeoff]', 'hours')
  expect(ids('[data-planning-timeoff]')).toEqual(['10', '9'])
  expect(unfinished.value).toBe('3.75')
  expect(planning.createAllocation).not.toHaveBeenCalled()
  expect(planning.updateAllocation).not.toHaveBeenCalled()
})

it('[browser #1190] preserves a stale draft, refreshes capacity and reloads saved values only on request', async () => {
  const planning = planningApi()
  const saved = { ...allocation, version: 1, planned_seconds_per_week: hours(24) }
  planning.updateAllocation = vi.fn(async () => { throw Object.assign(new Error('changed'), {
    status: 409, body: { error: { code: 'allocation_changed', currentVersion: 1, current: saved } },
  }) })
  const { getCapacity } = await open(true, planning)
  buttonLabelled('Edit allocation of Maya Member to Atlas').click()
  input('[data-planning-allocation-form]', 'hours').value = '3.75'
  submit('[data-planning-allocation-form]')
  await vi.waitFor(() => expect(text('[data-planning-allocation-status]')).toContain('Your edits are kept'))
  expect(input('[data-planning-allocation-form]', 'hours').value).toBe('3.75')
  expect(planning.updateAllocation).toHaveBeenCalledWith(7, expect.objectContaining({ version: 0, planned_seconds_per_week: 13500 }))
  await vi.waitFor(() => expect(getCapacity).toHaveBeenCalledTimes(2))
  ;[...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reload saved values (replaces these edits)')!.click()
  expect(input('[data-planning-allocation-form]', 'hours').value).toBe('24')
  planning.updateAllocation = vi.fn(async () => ({}))
  submit('[data-planning-allocation-form]')
  await vi.waitFor(() => expect(planning.updateAllocation).toHaveBeenCalledWith(7, expect.objectContaining({ version: 1 })))
})

it('[browser #1190] a late privileged refresh cannot restore old rows after a session change', async () => {
  document.body.innerHTML = '<div data-planning-test-host></div>'
  const host = document.querySelector<HTMLElement>('[data-planning-test-host]')!
  const planning = planningApi()
  let release!: (rows: readonly AllocationRow[]) => void
  planning.listAllocations = vi.fn().mockImplementationOnce(() => new Promise<readonly AllocationRow[]>(resolve => { release = resolve })).mockResolvedValue([])
  const entry = createPlanningEntry(host, planning, vi.fn())
  entry.mount()
  const old = entry.refresh([{ id: 1, name: 'Old privileged person' }], { from: '2026-10-05', to: '2026-10-11' }, new AbortController().signal)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  entry.unmount()
  planning.listProjects = vi.fn(async () => [{ id: 88, name: 'New session project' }])
  planning.listTimeOff = vi.fn(async () => [])
  entry.mount()
  await entry.refresh([{ id: 2, name: 'New session person' }], { from: '2026-10-05', to: '2026-10-11' }, new AbortController().signal)
  release([allocation])
  await old
  expect(host.textContent).not.toContain('Old privileged person')
  expect(host.querySelectorAll('[data-planning-allocations] tbody tr[data-row-key]')).toHaveLength(0)
  expect([...host.querySelectorAll<HTMLSelectElement>('select[name="project_id"] option')].map(option => option.textContent)).toEqual(['New session project'])
  entry.unmount()
})

it('[browser #1190] clears the actual capacity activation on logout and ignores old refresh/write replies', async () => {
  document.body.innerHTML = renderCapacityPage('capacity')
  const planning = planningApi()
  let finishWrite!: () => void
  planning.updateAllocation = vi.fn(() => new Promise<void>(resolve => { finishWrite = resolve }))
  let finishRefresh!: (value: { data: CapacityData }) => void
  const nextReport = { ...report, people: report.people.map(person => ({ ...person, first_name: 'New' })) }
  const getCapacity = vi.fn().mockResolvedValueOnce({ data: report })
    .mockImplementationOnce(() => new Promise<{ data: CapacityData }>(resolve => { finishRefresh = resolve }))
    .mockResolvedValue({ data: nextReport })
  const controller = createCapacityController({ getCapacity, planning })
  const oldSession = new AbortController()
  await controller.activate(oldSession.signal, { administrator: true })
  buttonLabelled('Edit allocation of Maya Member to Atlas').click()
  input('[data-planning-allocation-form]', 'hours').value = '8'
  submit('[data-planning-allocation-form]')
  document.querySelector<HTMLButtonElement>('[data-capacity-retry]')!.click()
  await vi.waitFor(() => expect(finishRefresh).toBeTypeOf('function'))
  oldSession.abort()
  expect(text('[data-capacity-grid]')).toBe('')
  expect(document.querySelector('[data-planning-allocation-form]')).toBeNull()
  await controller.activate(new AbortController().signal, { administrator: true })
  buttonLabelled('Edit allocation of New Member to Atlas').click()
  input('[data-planning-allocation-form]', 'hours').value = '5'
  finishRefresh({ data: report })
  finishWrite()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(text('[data-capacity-grid]')).toContain('New Member')
  expect(input('[data-planning-allocation-form]', 'hours').value).toBe('5')
  expect(text('[data-planning-allocation-status]')).not.toContain('saved')
  const aborted = new AbortController()
  aborted.abort()
  await controller.activate(aborted.signal, { administrator: true })
  expect(document.querySelector('[data-planning-allocation-form]')).toBeNull()
  expect(getCapacity).toHaveBeenCalledTimes(3)
})
