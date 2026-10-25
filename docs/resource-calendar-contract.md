# Resource calendar read contract

Refs [#1192](https://github.com/ConflictHQ/ezacto-pvt/issues/1192); plan in
[resource-planning-plan.md](resource-planning-plan.md). This settles the shape and
invariants of the scoped project/team calendar read. The native SQLite/D1
composition, HTTP operations and Capacity week/timeline views use this reference.
There is no second planning store or aggregate table.

Source: [`packages/core/src/resource-calendar.ts`](../packages/core/src/resource-calendar.ts).
Executable contract: [`packages/core/test/resource-calendar.test.ts`](../packages/core/test/resource-calendar.test.ts).
Any real implementation must return what `composeResourceCalendar` returns for the
same rows.

Native composition: [`resource-calendar.ts`](../packages/db/src/resource-calendar.ts).
HTTP and public DTOs: [routes](../packages/api/src/resources/resource-calendar.ts),
[OpenAPI source](../packages/api/src/resource-calendar-contract.ts).
Web: [controller](../apps/web/src/capacity/resource-calendar-browser.ts).

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
   seconds by `spent_date`) are separate fields. `plannedSeconds` and
   `trackedSeconds` share one project scope: the requested project in the
   project view, all of the person's work in the team view. `availableSeconds`
   and `personPlannedSeconds` are always whole-person, and `overAllocated` is
   `personPlannedSeconds > availableSeconds` in both views, including zero
   capacity, so a small project is never called over-allocated by comparing it
   with whole-person availability.
4. Placeholder demand is returned only in `unassigned`, never in a person total
   or capacity denominator.
5. Archived people are omitted; plans and placeholders on archived projects are
   omitted; tracked time for included people is unchanged.
6. Hidden scope: planned hours on projects the caller cannot see are included in
   `plannedSeconds` and reported as `otherScopePlannedSeconds` with
   `hasOtherScope`; tracked time on hidden projects is likewise included in
   `trackedSeconds` and reported as `otherScopeTrackedSeconds`. The hidden
   part of whole-person `personPlannedSeconds` is reported in both views as
   `personOtherScopePlannedSeconds` and sets `hasOtherScope`, so in the project
   view `overAllocated` never turns on hidden work without a label; a hidden
   placeholder sets `hasOtherScope` but no hidden project id, name or
   placeholder is ever emitted. Leave appears only as availability seconds, never kind or note.
7. `revision` is a SHA-256 of the canonical projection (everything but
   `context`). It changes exactly when the returned data changes, whatever input
   caused it (allocations, placeholders, leave, holidays, capacity, tracked
   time), and not when rows outside the caller's scope or page change. People
   are paged by ascending id; `nextCursor` is null on the last page.
   `unassigned` is returned on the first page only (no `cursor`), never with a
   `personId` filter, holds at most `maximumResourceCalendarPlaceholders`
   placeholders (lowest ids first, `unassignedTruncated` says more matched),
   and so at most 100 x 53 rows.
8. The projection never writes actual time, rates, invoices or staffing.

## Native reads and HTTP pagination

- `GET /api/v1/resource-calendar/context` supplies organization-local initial
  navigation dates. The browser uses this before choosing its window; a device
  date or a person's timezone does not choose the calendar week. An invalid
  imported organization timezone falls back to UTC.
- `GET /api/v1/resource-calendar` returns the projection. `view`, `from` and `to`
  are required; project view also requires `project_id`. Optional `person_id`
  restricts people without broadening project visibility.
- `GET /api/v1/resource-calendar/allocations` separately pages saved, authorized
  allocation ranges, exact weekly seconds and mutation versions. A timeline
  never invents dates from weekly aggregates. Hidden project identities are
  withheld even when their hours contribute to the summary's labelled scope.
- `GET /api/v1/resource-calendar/projects` pages the current scoped project
  labels, including historical archived identities; optional `is_active`
  narrows that list. A renamed label is refreshed independently of the weekly
  projection digest.
- Every read requires `schedule:read`, including its token ceiling, and checks
  current native actor profile/grants/closure and row authority. All responses
  are `no-store`. The API uses signed query-bound opaque cursors, at most 100
  rows/people per page, in ascending native ID order. Pagination is a live
  read, not a frozen multi-request snapshot. An old cursor never confers access.
- One SQL statement reads each coherent native projection. The whole-week
  range is limited to 53 weeks before fact reads. Each fact category is limited
  to 20,000 rows; exceeding that budget returns a `range_too_large` field error
  rather than partial totals. Narrow the date range or person filter.
- Open demand uses #1191's actual placeholder-allocation ID and integer
  revision. A native read may pass hidden demand to the composer as an existence
  boolean, preserving `hasOtherScope` without fetching private demand names or
  IDs. The first visible page contains at most 100 placeholders.

## Web entry and follow-on boundaries

Capacity offers team/project scope, a person filter, week and dated-allocation
timeline displays, explicit people pagination, and organization-week navigation.
Planned, available and rounded tracked seconds remain separate. Unassigned
demand stays outside person totals. Broader aggregate scope is labelled.

The existing administrator allocation, time-off, holiday and placeholder forms
remain the mutation path with their saved versions and conflict drafts. Other
web profiles are explicitly read-only. Request aborts, scope changes and lost
authority clear private rows/options and invalidate late replies. Planning never
creates actual time, staffing grants or accounting entries.

Drag editing, revocable feeds and native application parity remain #1193, #1194
and #1195 respectively; these read operations do not establish those features.
