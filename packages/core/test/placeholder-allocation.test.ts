import { describe, expect, it } from "vitest";
import type { PlaceholderAssignmentError } from "../src/index.js";
import {
  InMemoryPlaceholderPlanning,
  type AssignmentContext,
} from "../src/index.js";

const week = 126_000;
const context = (over: Partial<AssignmentContext> = {}): AssignmentContext => ({
  actorCanManageProject: true,
  personActive: true,
  projectActive: true,
  personHasProjectAccess: true,
  personWeeklyCapacitySeconds: week,
  weekStartDay: "monday",
  personAllocations: [],
  ...over,
});
const fields = {
  id: "ph-1",
  placeholderId: "role-designer",
  projectId: "p1",
  startDate: "2026-11-02",
  endDate: "2026-11-13",
  plannedSecondsPerWeek: 72_000,
};
const command = (over = {}) => ({
  idempotencyKey: "k1",
  placeholderAllocationId: "ph-1",
  expectedRevision: 0,
  userId: "u1",
  ...over,
});
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as PlaceholderAssignmentError).code;
  }
  return undefined;
};
const seeded = () => {
  const store = new InMemoryPlaceholderPlanning();
  store.create(fields);
  return store;
};

describe("placeholder assignment contract (issue 1191)", () => {
  it("[unit] creates the person plan and consumes the placeholder together", () => {
    const store = seeded();
    const result = store.assign(command(), context());
    expect(result.allocation).toMatchObject({
      userId: "u1",
      projectId: "p1",
      startDate: "2026-11-02",
      plannedSecondsPerWeek: 72_000,
    });
    expect(result.placeholder).toMatchObject({
      state: "assigned",
      revision: 1,
      assignedAllocationId: result.allocation.id,
    });
    expect(store.allocations).toHaveLength(1);
    expect(result.warnings).toEqual([]);
    expect(result.prerequisites).toEqual([]);
  });

  it("[unit] replaying a key returns the prior result and writes nothing", () => {
    const store = seeded();
    const first = store.assign(command(), context());
    expect(
      store.assign(command(), context({ actorCanManageProject: false })),
    ).toBe(first);
    expect(store.allocations).toHaveLength(1);
  });

  it("[unit] a second key for a consumed placeholder cannot duplicate the plan", () => {
    const store = seeded();
    store.assign(command(), context());
    expect(
      code(() =>
        store.assign(
          command({ idempotencyKey: "k2", expectedRevision: 1 }),
          context(),
        ),
      ),
    ).toBe("placeholder_not_open");
    expect(store.allocations).toHaveLength(1);
  });

  it("[unit] refuses stale revision, missing placeholder and lost authority without writing", () => {
    const store = seeded();
    expect(
      code(() => store.assign(command({ expectedRevision: 3 }), context())),
    ).toBe("placeholder_stale");
    expect(
      code(() =>
        store.assign(command({ placeholderAllocationId: "nope" }), context()),
      ),
    ).toBe("placeholder_not_found");
    expect(
      code(() =>
        store.assign(command(), context({ actorCanManageProject: false })),
      ),
    ).toBe("placeholder_forbidden");
    expect(store.allocations).toHaveLength(0);
    expect(store.get("ph-1")?.state).toBe("open");
  });

  it("[unit] refuses an inactive person or project", () => {
    const store = seeded();
    expect(
      code(() => store.assign(command(), context({ personActive: false }))),
    ).toBe("assignment_target_inactive");
    expect(
      code(() => store.assign(command(), context({ projectActive: false }))),
    ).toBe("assignment_target_inactive");
  });

  it("[unit] same person/project date overlap is refused and the placeholder stays open", () => {
    const store = seeded();
    const personAllocations = [
      {
        id: "a0",
        userId: "u1",
        projectId: "p1",
        startDate: "2026-11-13",
        endDate: "2026-12-01",
        plannedSecondsPerWeek: 36_000,
      },
    ];
    expect(
      code(() => store.assign(command(), context({ personAllocations }))),
    ).toBe("allocation_overlap");
    expect(store.get("ph-1")).toMatchObject({ state: "open", revision: 0 });
    // A different project on the same dates is allowed.
    const other = [{ ...personAllocations[0]!, projectId: "p2" }];
    expect(
      store.assign(command(), context({ personAllocations: other })).allocation
        .id,
    ).toBeDefined();
  });

  it("[unit] over-allocation is a per-week warning, never a refusal", () => {
    const store = seeded();
    const personAllocations = [
      {
        id: "a0",
        userId: "u1",
        projectId: "p2",
        startDate: "2026-11-09",
        endDate: "2026-11-20",
        plannedSecondsPerWeek: 90_000,
      },
    ];
    const result = store.assign(command(), context({ personAllocations }));
    expect(result.warnings).toEqual([
      {
        code: "over_allocated",
        weekStart: "2026-11-09",
        plannedSeconds: 162_000,
        capacitySeconds: week,
      },
    ]);
    expect(store.allocations).toHaveLength(1);
  });

  it("[unit] zero capacity warns; missing project access is a prerequisite, not a grant", () => {
    const result = seeded().assign(
      command(),
      context({
        personWeeklyCapacitySeconds: 0,
        personHasProjectAccess: false,
      }),
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.prerequisites).toEqual([{ code: "project_access_missing" }]);
  });

  it("[unit] archived placeholders cannot be assigned and identifiers are never reused", () => {
    const store = seeded();
    expect(store.archive("ph-1", 0).revision).toBe(1);
    expect(
      code(() => store.assign(command({ expectedRevision: 1 }), context())),
    ).toBe("placeholder_not_open");
    expect(() => store.create(fields)).toThrow();
  });
});
