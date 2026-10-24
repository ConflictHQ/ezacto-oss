# Resource calendar projection contract (contract-only)

Refs [#1192](https://github.com/ConflictHQ/ezacto-pvt/issues/1192); plan in
[resource-planning-plan.md](resource-planning-plan.md). This settles the shape and
invariants of the scoped project/team calendar read so the database composition,
API operation and views can be built against one reference. It adds no endpoint,
migration or UI.

Source: [`packages/core/src/resource-calendar.ts`](../packages/core/src/resource-calendar.ts).
Executable contract: [`packages/core/test/resource-calendar.test.ts`](../packages/core/test/resource-calendar.test.ts).
Any real implementation must return what `composeResourceCalendar` returns for the
same rows.

## Interface

`composeResourceCalendar(context, query, rows) -> ResourceCalendarProjection`

- `context` is server-made: organization time zone, week start, organization-local
  `today` and `currentWeekStart` (`resourceCalendarContext`). Device dates are
  never used.
- `query`: `view` (`project` | `team`), inclusive `from`/`to` dates, `projectId`
  (required for `project`), optional `personId`, `limit` (1-100, default 50),
  `cursor` (last person id).
- `rows` are the already scope-filtered rows from the existing allocation,
  time-off, organization-holiday and tracked-time repositories. No second
  aggregate store.

## Invariants

1. The range snaps to whole weeks and spans at most 53 weeks (`capacityWeeks`).
2. The full `plannedSecondsPerWeek` counts for every week a range touches; no
   daily proration; disjoint ranges in one week add.
3. `plannedSeconds`, `availableSeconds` (current capacity minus leave and
   holidays, once per day, never negative) and `trackedSeconds` (stored rounded
   seconds by `spent_date`) are separate fields. `overAllocated` is
   `planned > available`, including zero capacity.
4. Placeholder demand is returned only in `unassigned`, never in a person total
   or capacity denominator.
5. Archived people are omitted; plans and placeholders on archived projects are
   omitted; tracked time for included people is unchanged.
6. Hidden scope: planned hours on projects the caller cannot see are included in
   `plannedSeconds` and reported as `otherScopePlannedSeconds` with
   `hasOtherScope`; no hidden project id or name, and no hidden placeholder, is
   ever emitted. Leave appears only as availability seconds, never kind or note.
7. `revision` changes whenever a contributing allocation or placeholder revision
   changes. People are paged by ascending id; `nextCursor` is null on the last
   page.
8. The projection never writes actual time, rates, invoices or staffing.

## Not settled here

- The placeholder row shape is provisional until #1191 lands; only
  `CalendarPlaceholder` changes if it differs.
- The `revision` digest is a reference; the real read may use a database
  watermark if it changes exactly when a contributing row changes.
- The public API path, scope, OpenAPI entry and generated client are left to the
  implementation slice.
