# Client revision preconditions for allocations and time off (contract)

Status: contract only. Refs issue 1190, parent planning audit 1007, plan in
`docs/resource-planning-plan.md`. Nothing here changes a schema, route, form,
OpenAPI document or generated client. The pure rules are in
`packages/core/src/revision-precondition.ts`; any real repository must pass the
suite in `packages/core/test/revision-store-suite.ts`.

## Interface

- Allocations and personal time off each gain `revision`: integer, zero at
  creation, `+1` in the same atomic write as every successful update. It is read
  in the native read, OpenAPI and generated-client shapes next to `updated_at`.
- PATCH and DELETE send `revision` (the value last read) in the JSON body, the
  same place organization holidays send `version`.
- `parseExpectedRevision(body, compatibility)` reads it. A supplied value that
  is not a safe integer >= 0 (including `null`) is a 422 `invalid_revision`. It
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
   A successful write records actor, before and after revision with the data.
3. Authority is decided before revision, so a caller who lost access learns
   neither the row nor its current revision. The 409 body carries
   `currentRevision` and `current` (see `RevisionConflictBody`) only for a
   caller who still holds read authority.
4. A stale PATCH or DELETE on a row that was deleted is 404, not 409.
5. Existing date-overlap, full-week amounts, archival and warn-only
   over-allocation rules are untouched. No time, rate, invoice or receipt is
   written.
6. Browser: a 409 keeps the person's unsaved field values, offers reload or
   review of the current row, and refreshes capacity from the server.

## Compatibility policy

`RevisionCompatibility` is `required` or `legacy-unconditioned`. Under the
second, an absent `revision` falls back to today's same-request `updated_at`
check; a supplied one is always enforced. Which policy ships, and for how long,
is an owner decision recorded in the pull request that closes the plumbing.

## Out of scope here (blocked on plumbing)

Migration adding the column, repository changes, route and OpenAPI/client
updates, administrator form migration, and the real SQLite/D1 race and
two-editor browser tests. The suite is written so those tests can reuse it.
