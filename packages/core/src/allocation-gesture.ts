import {
  addDays,
  allocationCoversWeek,
  assertAllocationFields,
  capacityWeeks,
  isAllocationDate,
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

export type AllocationRangeRefusal =
  "empty_range" | "invalid_delta" | "invalid_range";

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
  if (!Number.isSafeInteger(deltaDays))
    return { ok: false, refusal: "invalid_delta" };
  if (
    !isAllocationDate(allocation.startDate) ||
    !isAllocationDate(allocation.endDate)
  )
    return { ok: false, refusal: "invalid_range" };
  let startDate: string;
  let endDate: string;
  try {
    startDate =
      kind === "resize-end"
        ? allocation.startDate
        : addDays(allocation.startDate, deltaDays);
    endDate =
      kind === "resize-start"
        ? allocation.endDate
        : addDays(allocation.endDate, deltaDays);
  } catch {
    // A huge delta leaves the representable calendar; refuse, never throw.
    return { ok: false, refusal: "invalid_range" };
  }
  if (!isAllocationDate(startDate) || !isAllocationDate(endDate))
    return { ok: false, refusal: "invalid_range" };
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

export type AllocationPreviewRefusal =
  AllocationRangeRefusal | "overlap" | "archived" | "range_too_wide";

export type AllocationPreview =
  | {
      readonly ok: true;
      readonly range: AllocationRange;
      readonly weeks: PreviewWeek[];
    }
  | {
      readonly ok: false;
      readonly refusal: AllocationPreviewRefusal;
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
  try {
    assertAllocationFields({
      ...range,
      plannedSecondsPerWeek: allocation.plannedSecondsPerWeek,
    });
  } catch {
    return { ok: false, refusal: "invalid_range" };
  }
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
  let weekStarts: string[];
  try {
    weekStarts = capacityWeeks(
      range.startDate,
      range.endDate,
      context.weekStartDay,
    );
  } catch {
    return { ok: false, refusal: "range_too_wide" };
  }
  const weeks = weekStarts.map((weekStart) => {
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
      /** Read at start, so commit applies the same refusals as the preview. */
      readonly context: PreviewContext;
    }
  | { readonly phase: "saving"; readonly command: AllocationUpdateCommand };

export type AllocationGestureEvent =
  | {
      readonly type: "start";
      readonly gestureId: string;
      readonly allocation: GestureAllocation;
      readonly kind: AllocationGestureKind;
      readonly context: PreviewContext;
    }
  | { readonly type: "move"; readonly deltaDays: number }
  | { readonly type: "commit" }
  | {
      readonly type:
        "cancel" | "escape" | "scroll" | "stale-session" | "authority-revoked";
    }
  | { readonly type: "saved" }
  | {
      readonly type: "conflict";
      /** The server's current revision, for the host to reload. */
      readonly currentRevision?: number;
    }
  | { readonly type: "failed" };

export interface AllocationGestureStep {
  readonly state: AllocationGestureState;
  /** Present on exactly one transition per gesture: commit with a changed range. */
  readonly command?: AllocationUpdateCommand;
  /** Why a commit produced no command, when it was refused. */
  readonly refusal?: AllocationPreviewRefusal;
  /** How a save ended. `conflict` and `failed` are distinct for the host. */
  readonly outcome?: "saved" | "conflict" | "failed";
  /** On conflict: the revision to reload. Form fields stay the host's. */
  readonly currentRevision?: number;
}

const idle: AllocationGestureStep = { state: { phase: "idle" } };

/**
 * The gesture state machine. `conflict` and `failed` return to idle with a
 * distinct outcome: the host rolls back its optimistic display, keeps any
 * unsaved form fields, and reloads the current revision.
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
              context: event.context,
            },
          }
        : idle;
    case "dragging":
      switch (event.type) {
        case "move":
          // Stored as given; a non-integer delta is refused at commit.
          return { state: { ...state, deltaDays: event.deltaDays } };
        case "commit": {
          const preview = previewAllocationGesture(
            state.allocation,
            state.kind,
            state.deltaDays,
            state.context,
          );
          if (!preview.ok) return { ...idle, refusal: preview.refusal };
          const proposed = { range: preview.range };
          const unchanged =
            proposed.range.startDate === state.allocation.startDate &&
            proposed.range.endDate === state.allocation.endDate;
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
        case "authority-revoked":
          return idle;
        default:
          return { state };
      }
    case "saving":
      switch (event.type) {
        case "saved":
          return { ...idle, outcome: "saved" };
        case "conflict":
          return {
            ...idle,
            outcome: "conflict",
            ...(event.currentRevision === undefined
              ? {}
              : { currentRevision: event.currentRevision }),
          };
        case "failed":
          return { ...idle, outcome: "failed" };
        case "authority-revoked":
          return idle;
        default:
          return { state };
      }
  }
};
