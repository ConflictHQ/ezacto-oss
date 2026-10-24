import { TrackedResourceInputError } from "./tracked-state.js";

/**
 * Contract for client-read revision preconditions on allocation and personal
 * time-off edits (issue 1190). Types and pure rules only: no schema, route or
 * repository changes live here. A real repository must pass the reusable suite
 * in `test/revision-store-suite.ts`.
 *
 * Invariants:
 * - A row's revision is an integer, zero at creation, incremented by exactly
 *   one in the same atomic write as each successful update.
 * - PATCH and DELETE carry the revision the caller last read as `revision` in
 *   the JSON body (the shape organization holidays use for `version`).
 * - A supplied precondition is never ignored: wrong type, negative or null is
 *   a 422, a mismatch is a 409.
 * - Authority (schedule/profile/person/project) and the revision are compared
 *   in the mutation transaction. Authority is decided first, so a caller who
 *   lost access learns nothing about the row's current revision.
 * - A refused or stale write changes no data and records no audit event.
 */

export const revisionField = "revision";

/**
 * `required`: a missing precondition is a 422. `legacy-unconditioned`: a missing
 * one falls back to the pre-1190 same-request `updated_at` check, for callers
 * that predate the field. Either way a supplied value is enforced.
 */
export type RevisionCompatibility = "required" | "legacy-unconditioned";

export interface Revisioned {
  readonly revision: number;
}

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Reads the expected revision from a request body. Returns null only when the
 * field is absent under `legacy-unconditioned`.
 */
export const parseExpectedRevision = (
  body: Readonly<Record<string, unknown>>,
  compatibility: RevisionCompatibility,
): number | null => {
  if (!Object.hasOwn(body, revisionField)) {
    if (compatibility === "required")
      throw new TrackedResourceInputError(
        revisionField,
        "revision_required",
        "Send the revision you last read so a newer change is not overwritten.",
      );
    return null;
  }
  const value = body[revisionField];
  if (!isRevision(value))
    throw new TrackedResourceInputError(
      revisionField,
      "invalid_revision",
      "revision must be a whole number, zero or greater.",
    );
  return value;
};

export type RevisionedWriteRefusal = "not_found" | "forbidden" | "stale";

export type RevisionedWriteDecision =
  | { readonly ok: true; readonly nextRevision: number }
  | { readonly ok: false; readonly refusal: RevisionedWriteRefusal };

/**
 * The decision a mutation transaction makes from the freshly read row. Order is
 * fixed: missing row, then authority, then revision. Deleting does not use
 * `nextRevision`.
 */
export const decideRevisionedWrite = (input: {
  readonly current: Readonly<Revisioned> | null;
  readonly authorized: boolean;
  readonly expected: number | null;
}): RevisionedWriteDecision => {
  if (input.current === null) return { ok: false, refusal: "not_found" };
  if (!input.authorized) return { ok: false, refusal: "forbidden" };
  if (input.expected !== null && input.expected !== input.current.revision)
    return { ok: false, refusal: "stale" };
  return { ok: true, nextRevision: input.current.revision + 1 };
};

/**
 * Body of a 409 for a stale edit. `current` is present only when the caller
 * still holds read authority, so the form can offer review while keeping the
 * person's unsaved fields client-side.
 */
export interface RevisionConflictBody<Row extends Revisioned> {
  readonly code: "allocation_changed" | "time_off_changed";
  readonly currentRevision: number;
  readonly current: Row | null;
}
