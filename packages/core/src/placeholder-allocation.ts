// Provenance: ezacto-pvt #1191 (parent #1007). Domain decisions and a reference
// store, backed by the native placeholder repository, management API and web
// planning view. Storage repeats current authority and revision fences atomically.
import { timeOffSecondsInWeek } from "./time-off.js";
import { TrackedResourceInputError } from "./tracked-state.js";
import {
  addDays,
  allocationCoversWeek,
  assertAllocationFields,
  weekStartOf,
  type AllocationFields,
  type AllocationWeekStartDay,
} from "./allocation.js";

/** open: unassigned demand. assigned: consumed by one person plan. archived: withdrawn. */
export type PlaceholderAllocationState = "open" | "assigned" | "archived";

/**
 * Unassigned project demand. It names no user, has no capacity, rate or
 * billable/actual time, and its id is never reused after archive or erasure.
 * `revision` starts at 0 and rises by one on every committed change.
 */
export interface PlaceholderAllocation extends AllocationFields {
  readonly id: string;
  readonly placeholderId: string;
  readonly projectId: string;
  readonly state: PlaceholderAllocationState;
  readonly revision: number;
  /** Set exactly when state is `assigned`. */
  readonly assignedAllocationId: string | null;
}

export interface PersonAllocationRow extends AllocationFields {
  readonly id: string;
  readonly userId: string;
  readonly projectId: string;
}

/** The one explicit command. Project and dates come from the placeholder row. */
export interface AssignPlaceholderCommand {
  /** The authenticated caller. Idempotency keys are scoped to this actor. */
  readonly actorId: string;
  /**
   * Replaying the same key from the same actor with the same payload returns
   * the stored result and writes nothing, after authority is re-checked.
   */
  readonly idempotencyKey: string;
  readonly placeholderAllocationId: string;
  readonly expectedRevision: number;
  readonly userId: string;
}

/** Facts the repository reads inside the same transaction as the write. */
export interface AssignmentContext {
  /** The actor currently holds schedule:write over this project. */
  readonly actorCanManageProject: boolean;
  readonly personActive: boolean;
  readonly projectActive: boolean;
  readonly personHasProjectAccess: boolean;
  readonly personWeeklyCapacitySeconds: number;
  /** Minimal scoped leave/holiday facts; no leave kind, note or identity is returned. */
  readonly personUnavailability?: readonly {
    readonly startDate: string;
    readonly endDate: string;
    readonly secondsPerDay: number | null;
  }[];
  readonly weekStartDay: AllocationWeekStartDay;
  /** All of the person's current allocations, on every project. */
  readonly personAllocations: readonly PersonAllocationRow[];
}

export type AssignmentWarning = {
  readonly code: "over_allocated";
  readonly weekStart: string;
  readonly plannedSeconds: number;
  readonly capacitySeconds: number;
};

/** Shown beside the result; the command never creates these. */
export type AssignmentPrerequisite = {
  readonly code: "project_access_missing";
};

export interface AssignmentResult {
  readonly allocation: PersonAllocationRow;
  readonly placeholder: PlaceholderAllocation;
  readonly warnings: readonly AssignmentWarning[];
  readonly prerequisites: readonly AssignmentPrerequisite[];
}

export type PlaceholderAssignmentErrorCode =
  | "placeholder_not_found"
  | "placeholder_forbidden"
  | "placeholder_stale"
  | "placeholder_not_open"
  | "assignment_target_inactive"
  | "allocation_overlap"
  | "idempotency_key_reused";

/** HTTP mapping a route must use: 404, 403, 409, 409, 422, 409, 422. */
export class PlaceholderAssignmentError extends Error {
  constructor(
    readonly code: PlaceholderAssignmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlaceholderAssignmentError";
  }
}

/**
 * The decision, in the order a repository must apply it. Pure: it throws the
 * first refusal or returns the rows to write. A refusal writes nothing, so the
 * placeholder is never consumed by a rejected overlap. Over-allocation and
 * missing project access are reported, never refused.
 *
 * Not found is answered before forbidden on purpose: authority is derived from
 * the placeholder's project, so it cannot be checked for a row that does not
 * exist. A route that must not reveal which ids exist should answer 404 for
 * both, which this order allows without a second lookup.
 */
export const decideAssignment = (
  command: AssignPlaceholderCommand,
  placeholder: PlaceholderAllocation | undefined,
  context: AssignmentContext,
  newAllocationId: string,
): AssignmentResult => {
  if (!placeholder) {
    throw new PlaceholderAssignmentError(
      "placeholder_not_found",
      "The placeholder does not exist.",
    );
  }
  if (!context.actorCanManageProject) {
    throw new PlaceholderAssignmentError(
      "placeholder_forbidden",
      "You cannot manage this project.",
    );
  }
  if (placeholder.revision !== command.expectedRevision) {
    throw new PlaceholderAssignmentError(
      "placeholder_stale",
      "The placeholder changed. Read it again.",
    );
  }
  if (placeholder.state !== "open") {
    throw new PlaceholderAssignmentError(
      "placeholder_not_open",
      "The placeholder is no longer open.",
    );
  }
  if (!context.personActive || !context.projectActive) {
    throw new PlaceholderAssignmentError(
      "assignment_target_inactive",
      "The person and project must be active.",
    );
  }
  const allocation: PersonAllocationRow = {
    id: newAllocationId,
    userId: command.userId,
    projectId: placeholder.projectId,
    startDate: placeholder.startDate,
    endDate: placeholder.endDate,
    plannedSecondsPerWeek: placeholder.plannedSecondsPerWeek,
  };
  assertAllocationFields(allocation);
  const overlaps = context.personAllocations.some(
    (row) =>
      row.projectId === allocation.projectId &&
      row.startDate <= allocation.endDate &&
      row.endDate >= allocation.startDate,
  );
  if (overlaps) {
    throw new PlaceholderAssignmentError(
      "allocation_overlap",
      "This person already has a plan on this project for these dates.",
    );
  }
  const warnings: AssignmentWarning[] = [];
  const last = weekStartOf(allocation.endDate, context.weekStartDay);
  for (
    let week = weekStartOf(allocation.startDate, context.weekStartDay);
    week <= last;
    week = addDays(week, 7)
  ) {
    const planned = context.personAllocations
      .filter((row) => allocationCoversWeek(row, week))
      .reduce(
        (sum, row) => sum + row.plannedSecondsPerWeek,
        allocation.plannedSecondsPerWeek,
      );
    const available = context.personWeeklyCapacitySeconds - timeOffSecondsInWeek(
      context.personUnavailability ?? [], week, context.personWeeklyCapacitySeconds,
    );
    if (planned > available) {
      warnings.push({
        code: "over_allocated",
        weekStart: week,
        plannedSeconds: planned,
        capacitySeconds: available,
      });
    }
  }
  return {
    allocation,
    placeholder: {
      ...placeholder,
      state: "assigned",
      revision: placeholder.revision + 1,
      assignedAllocationId: newAllocationId,
    },
    warnings,
    prerequisites: context.personHasProjectAccess
      ? []
      : [{ code: "project_access_missing" }],
  };
};

/**
 * Reference store with the transaction semantics a real repository must have:
 * replay scoped to actor and key with a payload fingerprint, authority
 * re-checked on replay, all-or-nothing writes, ids never reused.
 */
export class InMemoryPlaceholderPlanning {
  private readonly placeholders = new Map<string, PlaceholderAllocation>();
  private readonly results = new Map<
    string,
    { fingerprint: string; result: AssignmentResult }
  >();
  private readonly usedIds = new Set<string>();
  readonly allocations: PersonAllocationRow[] = [];
  private counter = 0;

  create(
    fields: Omit<
      PlaceholderAllocation,
      "state" | "revision" | "assignedAllocationId"
    >,
  ): PlaceholderAllocation {
    if (this.usedIds.has(fields.id)) {
      throw new TrackedResourceInputError(
        "id",
        "id_reused",
        "identifiers are never reused",
      );
    }
    assertAllocationFields(fields);
    this.usedIds.add(fields.id);
    const row: PlaceholderAllocation = {
      ...fields,
      state: "open",
      revision: 0,
      assignedAllocationId: null,
    };
    this.placeholders.set(row.id, row);
    return row;
  }

  archive(id: string, expectedRevision: number): PlaceholderAllocation {
    const row = this.placeholders.get(id);
    if (!row)
      throw new PlaceholderAssignmentError(
        "placeholder_not_found",
        "The placeholder does not exist.",
      );
    if (row.revision !== expectedRevision)
      throw new PlaceholderAssignmentError(
        "placeholder_stale",
        "The placeholder changed.",
      );
    if (row.state !== "open")
      throw new PlaceholderAssignmentError(
        "placeholder_not_open",
        "The placeholder is no longer open.",
      );
    const next: PlaceholderAllocation = {
      ...row,
      state: "archived",
      revision: row.revision + 1,
    };
    this.placeholders.set(id, next);
    return next;
  }

  get(id: string): PlaceholderAllocation | undefined {
    return this.placeholders.get(id);
  }

  assign(
    command: AssignPlaceholderCommand,
    context: AssignmentContext,
  ): AssignmentResult {
    const replayKey = JSON.stringify([command.actorId, command.idempotencyKey]);
    const fingerprint = JSON.stringify([
      command.placeholderAllocationId,
      command.expectedRevision,
      command.userId,
    ]);
    const replay = this.results.get(replayKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) {
        throw new PlaceholderAssignmentError(
          "idempotency_key_reused",
          "This key was already used for a different request.",
        );
      }
      if (!context.actorCanManageProject) {
        throw new PlaceholderAssignmentError(
          "placeholder_forbidden",
          "You cannot manage this project.",
        );
      }
      return replay.result;
    }
    const id = `allocation-${this.counter + 1}`;
    const result = decideAssignment(
      command,
      this.placeholders.get(command.placeholderAllocationId),
      context,
      id,
    );
    this.counter += 1;
    this.allocations.push(result.allocation);
    this.placeholders.set(result.placeholder.id, result.placeholder);
    this.results.set(replayKey, { fingerprint, result });
    return result;
  }
}
