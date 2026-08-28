export const approvalStatuses = [
  "unsubmitted",
  "submitted",
  "approved",
] as const;

export const trackedLockReasonCodes = [
  "invoiced",
  "approved",
  "policy_locked",
  "client_archived",
  "project_archived",
  "task_archived",
] as const;

export type ApprovalStatus = (typeof approvalStatuses)[number];
export type TrackedLockReasonCode = (typeof trackedLockReasonCodes)[number];

export interface TrackedStateFacts {
  approvalStatus: ApprovalStatus;
  invoiceId: number | null;
  /** Already-computed by the policy subsystem; this derivation does not recalculate policy. */
  policyLocked: boolean;
  clientArchived: boolean;
  projectArchived: boolean;
  /** Expenses have no task and supply false. */
  taskArchived: boolean;
}

export interface TrackedState {
  approvalStatus: ApprovalStatus;
  invoiceId: number | null;
  isBilled: boolean;
  isLocked: boolean;
  lockedReasonCode: TrackedLockReasonCode | null;
  lockedReason: string | null;
}

export const trackedLockReasons: Readonly<
  Record<TrackedLockReasonCode, string>
> = {
  invoiced: "Invoiced",
  approved: "Approved",
  policy_locked: "Locked by policy",
  client_archived: "Client is archived",
  project_archived: "Project is archived",
  task_archived: "Task is archived",
};

export class TrackedMutationLockedError extends Error {
  readonly code = "tracked_mutation_locked" as const;
  readonly reasonCode: TrackedLockReasonCode;
  readonly reason: string;

  constructor(reasonCode: TrackedLockReasonCode) {
    const reason = trackedLockReasons[reasonCode];
    super(reason);
    this.name = "TrackedMutationLockedError";
    this.reasonCode = reasonCode;
    this.reason = reason;
  }
}

/** API-neutral failures emitted by a tracked-resource persistence adapter. */
export class TrackedResourceNotFoundError extends Error {
  readonly code = "tracked_resource_not_found" as const;

  constructor(readonly resource: "time entry" | "expense") {
    super(`The requested ${resource} does not exist.`);
    this.name = "TrackedResourceNotFoundError";
  }
}

export class TrackedResourceAssignmentError extends Error {
  readonly code = "project_assignment_required" as const;

  constructor() {
    super("The acting user is not assigned to the active project and task.");
    this.name = "TrackedResourceAssignmentError";
  }
}

export class TrackedResourceConflictError extends Error {
  readonly code = "version_conflict" as const;

  constructor(readonly resource: "time entry" | "expense") {
    super(`The ${resource} changed before this request completed.`);
    this.name = "TrackedResourceConflictError";
  }
}

export class TrackedResourceInputError extends Error {
  readonly code = "tracked_resource_input_invalid" as const;

  constructor(
    readonly field: string,
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "TrackedResourceInputError";
  }
}

const deriveLockReasonCode = (
  facts: TrackedStateFacts,
): TrackedLockReasonCode | null => {
  if (facts.invoiceId !== null) return "invoiced";
  if (facts.approvalStatus === "approved") return "approved";
  if (facts.policyLocked) return "policy_locked";
  if (facts.clientArchived) return "client_archived";
  if (facts.projectArchived) return "project_archived";
  if (facts.taskArchived) return "task_archived";
  return null;
};

export const deriveTrackedState = (facts: TrackedStateFacts): TrackedState => {
  const lockedReasonCode = deriveLockReasonCode(facts);
  return {
    approvalStatus: facts.approvalStatus,
    invoiceId: facts.invoiceId,
    isBilled: facts.invoiceId !== null,
    isLocked: lockedReasonCode !== null,
    lockedReasonCode,
    lockedReason:
      lockedReasonCode === null ? null : trackedLockReasons[lockedReasonCode],
  };
};

/**
 * Shared native mutation boundary for time entries and expenses. The caller supplies
 * current persisted/parent facts plus the policy subsystem's already-computed fact.
 */
export const assertTrackedMutationAllowed = (
  facts: TrackedStateFacts,
): TrackedState => {
  const state = deriveTrackedState(facts);
  if (state.lockedReasonCode !== null) {
    throw new TrackedMutationLockedError(state.lockedReasonCode);
  }
  return state;
};
