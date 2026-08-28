import { describe, expect, it } from "vitest";
import {
  assertTrackedMutationAllowed,
  deriveTrackedState,
  TrackedMutationLockedError,
  trackedLockReasonCodes,
  trackedLockReasons,
  type TrackedStateFacts,
} from "../src/tracked-state.js";

const unlockedFacts = (): TrackedStateFacts => ({
  approvalStatus: "unsubmitted",
  invoiceId: null,
  policyLocked: false,
  clientArchived: false,
  projectArchived: false,
  taskArchived: false,
});

describe("shared three-axis state", () => {
  it("[unit] derives independent approval, invoicing, and editability axes", () => {
    expect(deriveTrackedState(unlockedFacts())).toEqual({
      approvalStatus: "unsubmitted",
      invoiceId: null,
      isBilled: false,
      isLocked: false,
      lockedReasonCode: null,
      lockedReason: null,
    });
    expect(
      deriveTrackedState({
        ...unlockedFacts(),
        approvalStatus: "submitted",
      }),
    ).toMatchObject({
      approvalStatus: "submitted",
      isBilled: false,
      isLocked: false,
    });
  });

  it("[unit] applies the documented lock reason precedence and rendered text", () => {
    const allCauses: TrackedStateFacts = {
      approvalStatus: "approved",
      invoiceId: 7,
      policyLocked: true,
      clientArchived: true,
      projectArchived: true,
      taskArchived: true,
    };
    const clearCause = (
      facts: TrackedStateFacts,
      code: (typeof trackedLockReasonCodes)[number],
    ) => {
      switch (code) {
        case "invoiced":
          return { ...facts, invoiceId: null };
        case "approved":
          return { ...facts, approvalStatus: "submitted" as const };
        case "policy_locked":
          return { ...facts, policyLocked: false };
        case "client_archived":
          return { ...facts, clientArchived: false };
        case "project_archived":
          return { ...facts, projectArchived: false };
        case "task_archived":
          return { ...facts, taskArchived: false };
      }
    };

    let remaining = allCauses;
    for (const reasonCode of trackedLockReasonCodes) {
      expect(deriveTrackedState(remaining)).toMatchObject({
        isLocked: true,
        lockedReasonCode: reasonCode,
        lockedReason: trackedLockReasons[reasonCode],
      });
      remaining = clearCause(remaining, reasonCode);
    }
    expect(deriveTrackedState(remaining)).toMatchObject({
      isLocked: false,
      lockedReasonCode: null,
      lockedReason: null,
    });
  });

  it("[unit] rejects before a locked mutation can change an entity", () => {
    const entity = { notes: "before" };
    const mutate = (facts: TrackedStateFacts) => {
      assertTrackedMutationAllowed(facts);
      entity.notes = "after";
    };

    expect(() => mutate({ ...unlockedFacts(), projectArchived: true })).toThrow(
      TrackedMutationLockedError,
    );
    try {
      mutate({ ...unlockedFacts(), projectArchived: true });
    } catch (error) {
      expect(error).toMatchObject({
        name: "TrackedMutationLockedError",
        code: "tracked_mutation_locked",
        reasonCode: "project_archived",
        reason: "Project is archived",
      });
    }
    expect(entity).toEqual({ notes: "before" });
  });
});
