/** @vitest-environment happy-dom */
import { expect, it, vi } from "vitest";
import { EzactoApiError } from "@conflict-hq/ezacto-client";
import { renderCapacityPage } from "../src/capacity/render.js";
import { createPlaceholderPlanningController } from "../src/capacity/placeholders-browser.js";
import {
  unassignedWeeklySeconds,
  type PlaceholderPlanningApi,
  type PlaceholderPlan,
  type PlanningPlaceholder,
} from "../src/capacity/placeholder-model.js";

const row: PlaceholderPlan = {
  id: 11,
  placeholder_id: 3,
  name: "Designer <unfilled>",
  project_id: 7,
  project_name: "Website & launch",
  start_date: "2026-10-18",
  end_date: "2026-10-19",
  planned_seconds_per_week: 18_000,
  state: "open",
  version: 4,
  assigned_allocation_id: null,
};
const definition: PlanningPlaceholder = {
  id: 3,
  name: row.name,
  is_active: true,
  version: 2,
};
const context = (
  signal = new AbortController().signal,
  administrator = true,
) => ({
  signal,
  administrator,
  range: { from: "2026-10-12", to: "2026-10-25" },
  weeks: ["2026-10-12", "2026-10-19"],
  people: [{ id: 5, name: "Avery Person" }],
  projects: [{ id: 7, name: row.project_name }],
});
const api = (
  overrides: Partial<PlaceholderPlanningApi> = {},
): PlaceholderPlanningApi => ({
  list: vi.fn(async () => [row]),
  listDefinitions: vi.fn(async () => [definition]),
  createDefinition: vi.fn(),
  updateDefinition: vi.fn(),
  archiveDefinition: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  assign: vi.fn<PlaceholderPlanningApi["assign"]>(async () => ({
    allocation: {
      id: 44,
      user_id: 5,
      project_id: 7,
      start_date: row.start_date,
      end_date: row.end_date,
      planned_seconds_per_week: row.planned_seconds_per_week,
      version: 0,
    },
    placeholder: {
      ...row,
      state: "assigned",
      version: 5,
      assigned_allocation_id: 44,
    },
    warnings: [],
    prerequisites: [],
    replayed: false,
  })),
  ...overrides,
});
const setup = (service: PlaceholderPlanningApi) => {
  document.body.innerHTML = renderCapacityPage("capacity");
  const host = document.querySelector<HTMLElement>(
    "[data-capacity-placeholders]",
  );
  expect(
    host,
    "the native Capacity page exposes separate unassigned planning",
  ).not.toBeNull();
  const changed = vi.fn();
  const controller = createPlaceholderPlanningController(
    host!,
    service,
    changed,
  );
  const find = <T extends Element>(selector: string) =>
    host!.querySelector<T>(selector)!;
  const button = (text: string) =>
    [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
      (value) => value.textContent?.trim() === text,
    )!;
  const formField = (selector: string, name: string) =>
    find<HTMLFormElement>(selector).elements.namedItem(name) as
      HTMLInputElement | HTMLSelectElement;
  const submit = (selector: string) =>
    find<HTMLFormElement>(selector).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  return { host: host!, controller, changed, find, button, formField, submit };
};

it("counts full open demand in each touched week without assigned or archived demand or person capacity", () => {
  const records = [
    row,
    { ...row, id: 12, state: "assigned" as const },
    { ...row, id: 13, state: "archived" as const },
  ];
  expect(unassignedWeeklySeconds(records, "2026-10-12")).toBe(18_000);
  expect(unassignedWeeklySeconds(records, "2026-10-19")).toBe(18_000);
  expect(unassignedWeeklySeconds(records, "2026-10-26")).toBe(0);
});
it("renders real project/date/hour labels as text and independent weekly demand for scoped read-only managers", async () => {
  const service = api(),
    screen = setup(service);
  await screen.controller.refresh(context(undefined, false));
  expect(service.listDefinitions).not.toHaveBeenCalled();
  expect(
    screen.find<HTMLElement>("[data-placeholder-administration]").hidden,
  ).toBe(true);
  expect(screen.find("[data-placeholder-rows]").textContent).toContain(
    row.name,
  );
  expect(screen.find("[data-placeholder-rows]").textContent).toContain(
    row.project_name,
  );
  expect(screen.find("[data-placeholder-rows]").textContent).toContain(
    "2026-10-18 to 2026-10-19",
  );
  expect(screen.find("[data-placeholder-rows]").textContent).toContain("5h");
  expect(
    screen.find("[data-placeholder-rows]").querySelector("unfilled"),
  ).toBeNull();
  expect(
    screen.find("[data-placeholder-rows]").querySelectorAll("button"),
  ).toHaveLength(0);
  expect(
    screen.find("[data-placeholder-totals]").textContent?.match(/5h/g),
  ).toHaveLength(2);
});
it("creates a definition and dated demand without pretending the placeholder is a person", async () => {
  const service = api(),
    screen = setup(service),
    ctx = context();
  await screen.controller.refresh(ctx);
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Researcher";
  screen.submit("[data-placeholder-definition-form]");
  await vi.waitFor(() =>
    expect(service.createDefinition).toHaveBeenCalledWith(
      { name: "Researcher" },
      ctx.signal,
    ),
  );
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toBe(
      "Placeholder added.",
    ),
  );
  const values = {
    placeholder_id: "3",
    project_id: "7",
    start_date: "2026-10-20",
    end_date: "2026-10-23",
    hours: "7.5",
  };
  for (const [name, value] of Object.entries(values))
    screen.formField("[data-placeholder-plan-form]", name).value = value;
  screen.submit("[data-placeholder-plan-form]");
  await vi.waitFor(() =>
    expect(service.create).toHaveBeenCalledWith(
      {
        placeholder_id: 3,
        project_id: 7,
        start_date: "2026-10-20",
        end_date: "2026-10-23",
        planned_seconds_per_week: 27_000,
      },
      ctx.signal,
    ),
  );
  expect(service.assign).not.toHaveBeenCalled();
});
it("keeps the edited revision and draft after a conflict until the operator explicitly reloads", async () => {
  const service = api({
    update: vi.fn(async () => {
      throw new EzactoApiError(
        409,
        { error: { message: "The plan changed." } },
        null,
      );
    }),
  });
  const screen = setup(service),
    ctx = context();
  await screen.controller.refresh(ctx);
  screen.button("Edit unassigned work").click();
  screen.formField("[data-placeholder-plan-form]", "hours").value = "9";
  screen.submit("[data-placeholder-plan-form]");
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toContain(
      "The plan changed.",
    ),
  );
  expect(screen.formField("[data-placeholder-plan-form]", "hours").value).toBe(
    "9",
  );
  expect(service.update).toHaveBeenCalledWith(
    11,
    {
      start_date: row.start_date,
      end_date: row.end_date,
      planned_seconds_per_week: 32_400,
      version: 4,
    },
    ctx.signal,
  );
  screen.submit("[data-placeholder-plan-form]");
  expect(service.update).toHaveBeenCalledTimes(1);
  screen.button("Reload saved planning").click();
  await vi.waitFor(() => expect(service.list).toHaveBeenCalledTimes(2));
  expect(screen.formField("[data-placeholder-plan-form]", "hours").value).toBe(
    "",
  );
});
it("assigns once with an explicit revision and command key and displays capacity and access warnings", async () => {
  const service = api(),
    original = service.assign;
  service.assign = vi.fn(
    async (...args: Parameters<PlaceholderPlanningApi["assign"]>) => ({
      ...(await original(...args)),
      warnings: [
        {
          code: "over_allocated" as const,
          week_start: "2026-10-19",
          planned_seconds: 162_000,
          capacity_seconds: 144_000,
        },
      ],
      prerequisites: [{ code: "project_access_missing" as const }],
    }),
  );
  const screen = setup(service),
    ctx = context();
  await screen.controller.refresh(ctx);
  screen.button("Assign to person").click();
  screen.formField("[data-placeholder-assign-form]", "user_id").value = "5";
  screen.submit("[data-placeholder-assign-form]");
  screen.submit("[data-placeholder-assign-form]");
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toContain(
      "45h planned against 40h capacity",
    ),
  );
  expect(service.assign).toHaveBeenCalledTimes(1);
  expect(service.assign).toHaveBeenCalledWith(
    11,
    { version: 4, user_id: 5, idempotency_key: expect.any(String) },
    ctx.signal,
  );
  expect(screen.find("[data-placeholder-status]").textContent).toContain(
    "No access was granted.",
  );
});
it("keeps the unassigned row and target when overlap is refused", async () => {
  const service = api({
    assign: vi.fn(async () => {
      throw new EzactoApiError(
        409,
        { error: { message: "This person already has an overlapping plan." } },
        null,
      );
    }),
  });
  const screen = setup(service);
  await screen.controller.refresh(context());
  screen.button("Assign to person").click();
  screen.formField("[data-placeholder-assign-form]", "user_id").value = "5";
  screen.submit("[data-placeholder-assign-form]");
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toContain(
      "overlapping plan",
    ),
  );
  expect(screen.find("[data-placeholder-rows]").textContent).toContain(
    row.name,
  );
  expect(
    screen.formField("[data-placeholder-assign-form]", "user_id").value,
  ).toBe("5");
  expect(
    screen.find<HTMLFormElement>("[data-placeholder-assign-form]").hidden,
  ).toBe(false);
  expect(screen.changed).not.toHaveBeenCalled();
});
it("discards late reads and all drafts on sign-out, including same-user reauthentication", async () => {
  let resolve!: (rows: readonly PlaceholderPlan[]) => void;
  const service = api({
    list: vi.fn(
      () =>
        new Promise<readonly PlaceholderPlan[]>((done) => {
          resolve = done;
        }),
    ),
  });
  const screen = setup(service),
    ended = new AbortController();
  const reading = screen.controller.refresh(context(ended.signal));
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Private draft";
  ended.abort();
  resolve([row]);
  await reading;
  expect(screen.host.hidden).toBe(true);
  expect(
    screen.formField("[data-placeholder-definition-form]", "name").value,
  ).toBe("");
  expect(screen.find("[data-placeholder-rows]").textContent).toBe("");
  service.list = vi.fn(async () => [row]);
  await screen.controller.refresh(context());
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "New session";
  await screen.controller.refresh(context(ended.signal));
  expect(screen.host.hidden).toBe(false);
  expect(
    screen.formField("[data-placeholder-definition-form]", "name").value,
  ).toBe("New session");
});
it("does not let a late mutation from the old session clear a new session draft", async () => {
  let resolve!: () => void;
  const service = api({
    createDefinition: vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    ),
  });
  const screen = setup(service),
    ended = new AbortController();
  await screen.controller.refresh(context(ended.signal));
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Old session";
  screen.submit("[data-placeholder-definition-form]");
  ended.abort();
  await screen.controller.refresh(context());
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "New session draft";
  resolve();
  await new Promise((done) => setTimeout(done, 0));
  expect(
    screen.formField("[data-placeholder-definition-form]", "name").value,
  ).toBe("New session draft");
  expect(screen.changed).not.toHaveBeenCalled();
});

it("archives only after explicit confirmation with the displayed definition revision", async () => {
  const service = api(),
    screen = setup(service),
    ctx = context();
  await screen.controller.refresh(ctx);
  screen.button("Archive placeholder").click();
  expect(
    screen.find<HTMLDialogElement>("[data-placeholder-archive-dialog]").open,
  ).toBe(true);
  expect(service.archiveDefinition).not.toHaveBeenCalled();
  screen.find<HTMLButtonElement>("[data-placeholder-archive-cancel]").click();
  expect(service.archiveDefinition).not.toHaveBeenCalled();
  screen.button("Archive placeholder").click();
  screen.submit("[data-placeholder-archive-form]");
  await vi.waitFor(() =>
    expect(service.archiveDefinition).toHaveBeenCalledWith(3, 2, ctx.signal),
  );
});

it("clears cached names and drafts when current authority is refused", async () => {
  const service = api(),
    screen = setup(service),
    ctx = context();
  await screen.controller.refresh(ctx);
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Private draft";
  service.list = vi.fn(async () => {
    throw new EzactoApiError(
      403,
      { error: { message: "Not permitted." } },
      null,
    );
  });
  await screen.controller.refresh(ctx);
  expect(screen.host.hidden).toBe(true);
  expect(screen.find("[data-placeholder-rows]").textContent).toBe("");
  expect(
    screen.formField("[data-placeholder-definition-form]", "name").value,
  ).toBe("");
});

it("keeps writes fenced after a conflict until both reload reads succeed", async () => {
  const service = api({
    update: vi.fn(async () => {
      throw new EzactoApiError(
        409,
        { error: { message: "Changed elsewhere." } },
        null,
      );
    }),
  });
  const screen = setup(service);
  await screen.controller.refresh(context());
  screen.button("Edit unassigned work").click();
  screen.formField("[data-placeholder-plan-form]", "hours").value = "9";
  screen.submit("[data-placeholder-plan-form]");
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toContain(
      "Changed elsewhere",
    ),
  );
  service.listDefinitions = vi.fn(async () => {
    throw new Error("Owned network failure");
  });
  screen.button("Reload saved planning").click();
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toContain(
      "could not be confirmed",
    ),
  );
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Must wait";
  screen.submit("[data-placeholder-definition-form]");
  expect(service.createDefinition).not.toHaveBeenCalled();
  service.listDefinitions = vi.fn(async () => [definition]);
  screen.button("Reload saved planning").click();
  await vi.waitFor(() =>
    expect(screen.find("[data-placeholder-status]").textContent).toBe(""),
  );
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Reconciled";
  screen.submit("[data-placeholder-definition-form]");
  await vi.waitFor(() =>
    expect(service.createDefinition).toHaveBeenCalledWith(
      { name: "Reconciled" },
      expect.any(AbortSignal),
    ),
  );
});

it.each([4442, 1])(
  "preserves %i exact weekly seconds when only dates change",
  async (seconds) => {
    const service = api({
      list: vi.fn(async () => [{ ...row, planned_seconds_per_week: seconds }]),
    });
    const screen = setup(service),
      ctx = context();
    await screen.controller.refresh(ctx);
    screen.button("Edit unassigned work").click();
    expect(
      Number(screen.formField("[data-placeholder-plan-form]", "hours").value),
    ).toBeGreaterThan(0);
    screen.formField("[data-placeholder-plan-form]", "end_date").value =
      "2026-10-20";
    screen.submit("[data-placeholder-plan-form]");
    await vi.waitFor(() =>
      expect(service.update).toHaveBeenCalledWith(
        11,
        {
          start_date: row.start_date,
          end_date: "2026-10-20",
          planned_seconds_per_week: seconds,
          version: 4,
        },
        ctx.signal,
      ),
    );
    expect(screen.find("[data-placeholder-rows]").textContent).toContain(
      `${seconds.toLocaleString("en-US")}s`,
    );
  },
);

it("erases private option labels and dialog descriptions when the administrator session ends", async () => {
  const screen = setup(api()),
    ended = new AbortController();
  await screen.controller.refresh(context(ended.signal));
  screen.button("Assign to person").click();
  screen.button("Archive placeholder").click();
  expect(screen.host.textContent).toContain(row.name);
  expect(screen.host.textContent).toContain(row.project_name);
  expect(screen.host.textContent).toContain("Avery Person");
  ended.abort();
  expect(screen.host.textContent).not.toContain(row.name);
  expect(screen.host.textContent).not.toContain(row.project_name);
  expect(screen.host.textContent).not.toContain("Avery Person");
  expect(screen.host.querySelectorAll("option")).toHaveLength(0);
  expect(screen.find("[data-placeholder-assign-description]").textContent).toBe(
    "",
  );
  expect(
    screen.find("[data-placeholder-archive-description]").textContent,
  ).toBe("");
});

it("ignores a late administrator reply after a clear and read-only activation on the same signal", async () => {
  let finish!: () => void;
  const service = api({
    createDefinition: vi.fn(
      () =>
        new Promise<void>((done) => {
          finish = done;
        }),
    ),
  });
  const screen = setup(service),
    ctx = context();
  await screen.controller.refresh(ctx);
  screen.formField("[data-placeholder-definition-form]", "name").value =
    "Old administrator input";
  screen.submit("[data-placeholder-definition-form]");
  screen.controller.clear();
  await screen.controller.refresh({ ...ctx, administrator: false });
  finish();
  await new Promise((done) => setTimeout(done, 0));
  expect(screen.changed).not.toHaveBeenCalled();
  expect(screen.find("[data-placeholder-status]").textContent).toBe("");
  expect(
    screen.find<HTMLElement>("[data-placeholder-administration]").hidden,
  ).toBe(true);
  expect(screen.host.querySelectorAll("option")).toHaveLength(0);
});
