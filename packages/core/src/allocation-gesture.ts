import {
  addDays,
  allocationCoversWeek,
  assertAllocationFields,
  capacityWeeks,
  isOverAllocated,
  type AllocationWeekStartDay,
} from "./allocation.js";

/**
 * Drag editing of allocation ranges (issue 1193), contract only.
 *
 * These are the pure rules a calendar gesture must follow, so a pointer drag, a
 * keyboard nudge and a phone form all produce the same planning command. The
 * browser host, the revisioned update endpoint (issue 1190) and the scoped
 * calendar (issue 1192) are separate work; nothing here touches them.
 *
 * Invariants:
 * - Only the date range moves. Planned seconds per week are copied unchanged;
 *   there is no daily proration (docs/resource-planning-plan.md).
 * - A gesture emits at most one command, and only on commit. Motion, cancel,
 *   Escape, scroll and a stale session emit none.
 * - The command carries the revision the editor last read. A conflict returns
 *   the gesture to idle with the server's revision, never overwriting a form.
 * - Over-allocation is a warning in the preview, never a refusal. Overlap is a
 *   refusal, matching the server rule (same person and project).
 */

export type AllocationGestureKind = "move" | "resize-start" | "resize-end";

export interface GestureAllocation {
  readonly id: number;
  readonly userId: number;
  readonly projectId: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly plannedSecondsPerWeek: number;
  /** The revision the editor last read (issue 1190). */
  readonly revision: number;
}

export interface AllocationRange {
  readonly startDate: string;
  readonly endDate: string;
}

export type AllocationRangeRefusal = "empty_range";

/**
 * The range a gesture proposes. A resize past the opposite edge is refused
 * rather than flipped, so the preview never silently swaps start and end.
 */
export const proposeAllocationRange = (
  allocation: Readonly<AllocationRange>,
  kind: AllocationGestureKind,
  deltaDays: number,
):
  | { readonly ok: true; readonly range: AllocationRange }
  | { readonly ok: false; readonly refusal: AllocationRangeRefusal } => {
  if (!Number.isInteger(deltaDays))
    return { ok: false, refusal: "empty_range" };
  const startDate =
    kind === "resize-end"
      ? allocation.startDate
      : addDays(allocation.startDate, deltaDays);
  const endDate =
    kind === "resize-start"
      ? allocation.endDate
      : addDays(allocation.endDate, deltaDays);
  if (endDate < startDate) return { ok: false, refusal: "empty_range" };
  return { ok: true, range: { startDate, endDate } };
};

export interface PreviewWeek {
  readonly weekStart: string;
  /** Full weekly amounts of every plan touching the week, the candidate included. */
  readonly plannedSeconds: number;
  readonly availableCapacitySeconds: number;
  readonly overAllocated: boolean;
}

export type AllocationPreview =
  | {
      readonly ok: true;
      readonly range: AllocationRange;
      readonly weeks: PreviewWeek[];
    }
  | {
      readonly ok: false;
      readonly refusal: "empty_range" | "overlap" | "archived";
    };

export interface PreviewContext {
  readonly weekStartDay: AllocationWeekStartDay;
  /** The person's other allocations, from the same read as the capacity view. */
  readonly otherAllocations: readonly Readonly<
    Pick<
      GestureAllocation,
      "id" | "projectId" | "startDate" | "endDate" | "plannedSecondsPerWeek"
    >
  >[];
  /** Available capacity for a week start, as the capacity view reports it. */
  readonly availableCapacitySeconds: (weekStart: string) => number;
  readonly archived: boolean;
}

/** The weeks and totals the person would have if the gesture were saved. */
export const previewAllocationGesture = (
  allocation: Readonly<GestureAllocation>,
  kind: AllocationGestureKind,
  deltaDays: number,
  context: Readonly<PreviewContext>,
): AllocationPreview => {
  if (context.archived) return { ok: false, refusal: "archived" };
  const proposed = proposeAllocationRange(allocation, kind, deltaDays);
  if (!proposed.ok) return { ok: false, refusal: proposed.refusal };
  const { range } = proposed;
  assertAllocationFields({
    ...range,
    plannedSecondsPerWeek: allocation.plannedSecondsPerWeek,
  });
  const others = context.otherAllocations.filter(
    (other) => other.id !== allocation.id,
  );
  const overlaps = others.some(
    (other) =>
      other.projectId === allocation.projectId &&
      other.startDate <= range.endDate &&
      other.endDate >= range.startDate,
  );
  if (overlaps) return { ok: false, refusal: "overlap" };
  const weeks = capacityWeeks(
    range.startDate,
    range.endDate,
    context.weekStartDay,
  ).map((weekStart) => {
    const plannedSeconds =
      allocation.plannedSecondsPerWeek +
      others
        .filter((other) => allocationCoversWeek(other, weekStart))
        .reduce((sum, other) => sum + other.plannedSecondsPerWeek, 0);
    const availableCapacitySeconds =
      context.availableCapacitySeconds(weekStart);
    return {
      weekStart,
      plannedSeconds,
      availableCapacitySeconds,
      overAllocated: isOverAllocated(plannedSeconds, availableCapacitySeconds),
    };
  });
  return { ok: true, range, weeks };
};

/** The one planning command a completed gesture sends. */
export interface AllocationUpdateCommand {
  readonly allocationId: number;
  readonly expectedRevision: number;
  /** Dates only; weekly seconds are deliberately absent. */
  readonly patch: AllocationRange;
  /** Stable for the gesture, so a retried commit replays instead of repeating. */
  readonly idempotencyKey: string;
}

export type AllocationGestureState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "dragging";
      readonly gestureId: string;
      readonly allocation: GestureAllocation;
      readonly kind: AllocationGestureKind;
      readonly deltaDays: number;
    }
  | { readonly phase: "saving"; readonly command: AllocationUpdateCommand };

export type AllocationGestureEvent =
  | {
      readonly type: "start";
      readonly gestureId: string;
      readonly allocation: GestureAllocation;
      readonly kind: AllocationGestureKind;
    }
  | { readonly type: "move"; readonly deltaDays: number }
  | { readonly type: "commit" }
  | { readonly type: "cancel" | "escape" | "scroll" | "stale-session" }
  | { readonly type: "saved" }
  | { readonly type: "conflict" | "failed" };

export interface AllocationGestureStep {
  readonly state: AllocationGestureState;
  /** Present on exactly one transition per gesture: commit with a changed range. */
  readonly command?: AllocationUpdateCommand;
}

const idle: AllocationGestureStep = { state: { phase: "idle" } };

/**
 * The gesture state machine. `conflict` and `failed` return to idle: the host
 * rolls back its optimistic display and reloads the current revision.
 */
export const stepAllocationGesture = (
  state: Readonly<AllocationGestureState>,
  event: Readonly<AllocationGestureEvent>,
): AllocationGestureStep => {
  switch (state.phase) {
    case "idle":
      return event.type === "start"
        ? {
            state: {
              phase: "dragging",
              gestureId: event.gestureId,
              allocation: event.allocation,
              kind: event.kind,
              deltaDays: 0,
            },
          }
        : idle;
    case "dragging":
      switch (event.type) {
        case "move":
          return Number.isInteger(event.deltaDays)
            ? { state: { ...state, deltaDays: event.deltaDays } }
            : { state };
        case "commit": {
          const proposed = proposeAllocationRange(
            state.allocation,
            state.kind,
            state.deltaDays,
          );
          const unchanged =
            !proposed.ok ||
            (proposed.range.startDate === state.allocation.startDate &&
              proposed.range.endDate === state.allocation.endDate);
          if (unchanged) return idle;
          const command: AllocationUpdateCommand = {
            allocationId: state.allocation.id,
            expectedRevision: state.allocation.revision,
            patch: proposed.range,
            idempotencyKey: state.gestureId,
          };
          return { state: { phase: "saving", command }, command };
        }
        case "cancel":
        case "escape":
        case "scroll":
        case "stale-session":
          return idle;
        default:
          return { state };
      }
    case "saving":
      return event.type === "saved" ||
        event.type === "conflict" ||
        event.type === "failed"
        ? idle
        : { state };
  }
};
