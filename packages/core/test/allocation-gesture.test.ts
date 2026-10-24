import { describe, expect, it } from "vitest";
import {
  previewAllocationGesture,
  proposeAllocationRange,
  stepAllocationGesture,
  type AllocationGestureEvent,
  type AllocationGestureState,
  type GestureAllocation,
  type PreviewContext,
} from "../src/index.js";

const hours = (n: number) => n * 3_600;
const plan: GestureAllocation = {
  id: 1,
  userId: 7,
  projectId: 3,
  startDate: "2026-10-05",
  endDate: "2026-10-16",
  plannedSecondsPerWeek: hours(20),
  revision: 4,
};
const context = (over: Partial<PreviewContext> = {}): PreviewContext => ({
  weekStartDay: "monday",
  otherAllocations: [],
  availableCapacitySeconds: () => hours(35),
  archived: false,
  ...over,
});

describe("allocation drag contract (issue 1193)", () => {
  it("[unit] move shifts both edges, resize shifts one", () => {
    expect(proposeAllocationRange(plan, "move", 7)).toEqual({
      ok: true,
      range: { startDate: "2026-10-12", endDate: "2026-10-23" },
    });
    expect(proposeAllocationRange(plan, "resize-end", -3)).toEqual({
      ok: true,
      range: { startDate: "2026-10-05", endDate: "2026-10-13" },
    });
    expect(proposeAllocationRange(plan, "resize-start", 2)).toEqual({
      ok: true,
      range: { startDate: "2026-10-07", endDate: "2026-10-16" },
    });
  });

  it("[unit] a resize past the other edge is refused, not flipped", () => {
    expect(proposeAllocationRange(plan, "resize-end", -20)).toEqual({
      ok: false,
      refusal: "empty_range",
    });
  });

  it("[unit] preview counts the full weekly amount for every week touched", () => {
    const preview = previewAllocationGesture(plan, "resize-end", -9, context());
    // 2026-10-05..2026-10-07 touches one week; no proration to three days.
    expect(preview).toMatchObject({ ok: true });
    if (preview.ok) {
      expect(preview.weeks).toEqual([
        {
          weekStart: "2026-10-05",
          plannedSeconds: hours(20),
          availableCapacitySeconds: hours(35),
          overAllocated: false,
        },
      ]);
    }
  });

  it("[unit] over-allocation warns and does not refuse", () => {
    const preview = previewAllocationGesture(
      plan,
      "move",
      0,
      context({
        otherAllocations: [
          {
            id: 2,
            projectId: 9,
            startDate: "2026-10-05",
            endDate: "2026-10-09",
            plannedSecondsPerWeek: hours(25),
          },
        ],
      }),
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.weeks[0]).toMatchObject({
        plannedSeconds: hours(45),
        overAllocated: true,
      });
      expect(preview.weeks[1]).toMatchObject({
        plannedSeconds: hours(20),
        overAllocated: false,
      });
    }
  });

  it("[unit] refuses overlap on the same project, ignores itself and other projects", () => {
    const same = {
      id: 2,
      projectId: 3,
      startDate: "2026-10-19",
      endDate: "2026-10-23",
      plannedSecondsPerWeek: hours(5),
    };
    expect(
      previewAllocationGesture(
        plan,
        "move",
        7,
        context({ otherAllocations: [same] }),
      ),
    ).toEqual({ ok: false, refusal: "overlap" });
    expect(
      previewAllocationGesture(
        plan,
        "move",
        7,
        context({ otherAllocations: [{ ...same, projectId: 4 }] }),
      ).ok,
    ).toBe(true);
    expect(
      previewAllocationGesture(
        plan,
        "move",
        1,
        context({ otherAllocations: [{ ...same, id: 1 }] }),
      ).ok,
    ).toBe(true);
  });

  it("[unit] archived targets are refused", () => {
    expect(
      previewAllocationGesture(plan, "move", 1, context({ archived: true })),
    ).toEqual({
      ok: false,
      refusal: "archived",
    });
  });

  const run = (events: AllocationGestureEvent[]) => {
    let state: AllocationGestureState = { phase: "idle" };
    const commands = [];
    for (const event of events) {
      const step = stepAllocationGesture(state, event);
      state = step.state;
      if (step.command) commands.push(step.command);
    }
    return { state, commands };
  };
  const start: AllocationGestureEvent = {
    type: "start",
    gestureId: "g1",
    allocation: plan,
    kind: "move",
  };

  it("[unit] commit emits exactly one dates-only command with the read revision", () => {
    const { state, commands } = run([
      start,
      { type: "move", deltaDays: 3 },
      { type: "move", deltaDays: 7 },
      { type: "commit" },
      { type: "commit" },
    ]);
    expect(commands).toEqual([
      {
        allocationId: 1,
        expectedRevision: 4,
        patch: { startDate: "2026-10-12", endDate: "2026-10-23" },
        idempotencyKey: "g1",
      },
    ]);
    expect(commands[0]).not.toHaveProperty("patch.plannedSecondsPerWeek");
    expect(state.phase).toBe("saving");
  });

  it("[unit] motion, cancel, Escape, scroll and stale sessions never write", () => {
    expect(run([start, { type: "move", deltaDays: 5 }]).commands).toEqual([]);
    for (const type of [
      "cancel",
      "escape",
      "scroll",
      "stale-session",
    ] as const) {
      const result = run([
        start,
        { type: "move", deltaDays: 5 },
        { type },
        { type: "commit" },
      ]);
      expect(result.commands).toEqual([]);
      expect(result.state.phase).toBe("idle");
    }
  });

  it("[unit] a drop where it started, or into an empty range, writes nothing", () => {
    expect(run([start, { type: "commit" }]).commands).toEqual([]);
    const resize: AllocationGestureEvent = { ...start, kind: "resize-end" };
    expect(
      run([resize, { type: "move", deltaDays: -30 }, { type: "commit" }])
        .commands,
    ).toEqual([]);
  });

  it("[unit] conflict returns to idle so the host can roll back", () => {
    const { state } = run([
      start,
      { type: "move", deltaDays: 7 },
      { type: "commit" },
      { type: "conflict" },
    ]);
    expect(state).toEqual({ phase: "idle" });
  });
});
