# Client version preconditions for allocations and time off

Status: native implementation (issue 1190). Refs issue 1190, parent planning audit 1007, plan in
`docs/resource-planning-plan.md`. The native SQLite/D1 stores, HTTP routes, administrator forms, OpenAPI
and generated client implement the same rules. The pure rules are in
`packages/core/src/revision-precondition.ts`; any real repository must pass the
suite in `packages/core/test/revision-store-suite.ts`.

## Interface

- Allocations and personal time off each gain `version`: integer, zero at
  creation, `+1` in the same atomic write as every successful update. It is read
  in the native read, OpenAPI and generated-client shapes next to `updated_at`.
- PATCH and DELETE send `version` (the value last read) in the JSON body, the
  same place organization holidays send `version`.
- `parseExpectedRevision(body, compatibility)` reads it. A supplied value that
  is not a safe integer >= 0 (including `null`) is a 422 `invalid_version`. It
  is never dropped.
- `decideRevisionedWrite({ current, authorized, expected })` is the decision the
  mutation transaction makes from the freshly read row. Order is fixed:
  `not_found` (404), `forbidden` (403/404 per existing route policy), `stale`
  (409 `allocation_changed` / `time_off_changed`, the existing codes).

## Invariants

1. Revision, schedule/profile/person/project authority and the write are one
   transaction. A pre-read followed by an unconditional write does not satisfy
   the contract.
2. A refused or stale write leaves data unchanged and records no audit event.
   A successful write records actor, before and after version with the data.
3. Authority is decided before version, so a caller who lost access learns
   neither the row nor its current version. The 409 body carries
   `currentVersion` and `current` (see `RevisionConflictBody`) only for a
   caller who still holds read authority.
4. A stale PATCH or DELETE on a row that was deleted is 404, not 409.
5. Existing date-overlap, full-week amounts, archival and warn-only
   over-allocation rules are untouched. No time, rate, invoice or receipt is
   written.
6. Browser: a 409 keeps the person's unsaved field values, offers reload or
   review of the current row, and refreshes capacity from the server.

## Compatibility policy

`RevisionCompatibility` is `required` or `legacy-unconditioned`. Under the
second, an absent `version` falls back to today's same-request `updated_at`
check; a supplied one is always enforced. Owner decision: `version` is
the wire and column name (matching organization holidays), and the route ships
`legacy-unconditioned` for 90 days with a `Deprecation` response header on
unconditioned PATCH and DELETE, then switches to `required`.

## Native enforcement and rollout

Migration `0162_planning_revisions` adds safe-integer, nonnegative `version`
columns to existing allocations and time off, initialized to zero. A database
trigger requires every update to advance exactly one version. The mutation and
its actor-attributed before/after event remain one SQLite transaction or D1
batch; refused writes leave no audit event. The write repeats the current actor
profile, grants, active/closure state, managed-person/project authority and
archival checks together with the client version and same-request snapshot.
Deleting a row for an archived person/project remains possible.

The initial compatibility window ends **2027-01-22 at 00:00 UTC**, ninety days
after the documented 2026-10-24 rollout date. Before that instant, absent versions
are accepted with `Deprecation` and `Sunset` headers. After it, absence is a 422
`version_required`. Supplied invalid versions are always 422 and supplied stale
versions are always 409. A DELETE carries `{ "version": 0 }` in its JSON body;
PATCH carries the same field alongside the changes. The generated client and
CLI accept these bodies. GET and create return the current version.

A 409 includes `error.currentVersion` and the explicitly serialized
`error.current` only after a fresh authorized read. A disappeared or newly
inaccessible row remains 404. The forms keep their draft and original version
on conflict, refresh authoritative capacity, and offer **Reload saved values
(replaces these edits)**; they never silently rebase and overwrite another
editor's changes. Leaving the session clears privileged form/list state and
late responses cannot restore it.

SQLite/D1 tests cover stale updates/deletes and authority/archive changes after
real reads. Native two-page browser tests cover both allocation and time-off
conflicts, preserved input, explicit review and resubmission with the new
version. Planned/availability changes do not alter tracked totals.
