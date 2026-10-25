# Resource planning: implementation inventory and next slices

Planning contract for [#1007](https://github.com/ConflictHQ/ezacto-pvt/issues/1007),
audited 2026-10-23 against product source
`39cef276ab61b28e4ad30db683a625a77705ae28`. The first slice is already implemented:
dated person/project allocations, administrator-entered personal time off, a
weekly Capacity view and administrator entry forms. PRs #1045 and #1061 are the
allocation/time-off delivery lineage. Closing #1007 accepts this inventory and
buildable follow-on plan; implementation delivery belongs to the child issues.

## Current implementation

| Surface | Actual behavior and source | Evidence already present |
| --- | --- | --- |
| Project staffing | `user_assignments` links people/projects, access, manager flags, rates and budgets. It has no planning date range. Reuse the project and person staffing screens. [Schema](../packages/db/src/schema.ts), [project UI](../apps/web/src/projects/render.ts), [team UI](../apps/web/src/team/render.ts). | [Project browser tests](../apps/web/test/project-browser.test.ts); staffing/person APIs remain the authority for project access. |
| Dated plans | Separate `allocations` rows contain person, project, inclusive date range and integer seconds/week. Mutations publish atomic before/after allocation events. [Migration 0119](../packages/db/src/migrations/0119_allocations.ts), [repository](../packages/db/src/allocations.ts), [API](../packages/api/src/resources/allocations.ts). | [SQLite/D1 allocation tests](../packages/db/test/allocations.test.ts), [API tests](../packages/api/test/allocations.test.ts). |
| Personal availability | `time_off` stores one person's inclusive date range, kind and optional seconds/day. `kind=holiday` is personal time off; it does not create an organization calendar. Mutations publish before/after time-off events. [Migration 0126](../packages/db/src/migrations/0126_time_off.ts), [rules](../packages/core/src/time-off.ts), [repository](../packages/db/src/time-off.ts), [API](../packages/api/src/resources/time-off.ts). | [Core tests](../packages/core/test/time-off.test.ts), [SQLite/D1 tests](../packages/db/test/time-off.test.ts), [API tests](../packages/api/test/time-off.test.ts). |
| Weekly capacity | `GET /api/v1/capacity` returns person/week planned, current weekly capacity, time off, available capacity, rounded tracked seconds and an over-allocation flag. It lists permitted active people, including those with zero plans. [Composition](../packages/db/src/allocations.ts), [OpenAPI source](../packages/api/src/contract.ts). | Allocation/time-off DB/API tests cover week starts, part-time, zero/over allocation, archive and reader scope. |
| Web planning entry | `/capacity` shows an eight-week window, previous/current/next controls and a read-only aggregate grid. An administrator also gets create/edit/delete allocation and time-off forms, delete confirmation and grid refresh. [Renderer](../apps/web/src/capacity/render.ts), [controller](../apps/web/src/capacity/browser.ts), [entry controller](../apps/web/src/capacity/planning-browser.ts), [API wiring](../apps/web/src/shell/model.ts). | [Entry tests](../apps/web/test/capacity-entry.test.ts), [time-off presentation tests](../apps/web/test/capacity-time-off.test.ts), [native browser case](../apps/web/e2e/capacity.browser.ts). The browser case proves the grid and form presence; it does not establish every future calendar workflow. |
| Existing Time calendar | The draggable calendar consumes actual entries and creates/moves their start/end times. Calendar proposals are suggestions that become actual entries only after acceptance. These are distinct from resource allocations. [Calendar host](../apps/web/src/calendar/browser.ts), [proposal rules](../packages/core/src/calendar-proposal.ts), [proposal API](../packages/api/src/resources/calendar-proposals.ts). | [Actual-time drag acceptance](../apps/web/e2e/calendar-drag.browser.ts), [proposal tests](../packages/api/test/calendar-proposals.test.ts). |
| Runtime/client surfaces | Worker and container compose the same allocation repository/API. The generated client publishes allocation, time-off and capacity operations. [Worker](../entries/worker/src/runtime.ts), [container](../entries/container/src/runtime.ts), [client](../packages/client/src/generated.ts). | Current API/runtime tests and generated-contract checks; native application UI acceptance remains a separate slice. |

Organization holidays are being implemented under [#1188](https://github.com/ConflictHQ/ezacto-pvt/issues/1188).
[PR #1196](https://github.com/ConflictHQ/ezacto-pvt/pull/1196), source
`79fc0b0a`, is the proposed delivery. Its merge, deployment and read-back remain
pending at this audit baseline; holidays are not counted as delivered here.

## First slice: exact operating rules

A plan records intended weekly hours; actual time remains the ledger of work.
The capacity code reads actuals for comparison and never creates time entries,
approvals, rates, invoice lines or receipts. A plan also does not grant project
access or create task/person staffing assignments.

| Concern | Current contract to preserve |
| --- | --- |
| Dates and zones | Allocation/time-off dates are floating `YYYY-MM-DD` calendar dates, both endpoints included. They do not convert through a person's timezone. Actuals are grouped by stored `spent_date`; their own time-entry filing policy remains authoritative. |
| Week boundary | The organization selects Saturday, Sunday or Monday. The API snaps `from`/`to` to their containing weeks and caps a request at 53 weeks. See [allocation rules](../packages/core/src/allocation.ts). |
| Partial weeks | The full `planned_seconds_per_week` counts for **each week touched by the range**, including a single day or weekend. There is no daily proration. Two non-overlapping date ranges in one week can both contribute their full weekly amounts. |
| Capacity and part-time | `users.weekly_capacity` is a nonnegative integer in seconds, default 126000 (35h). Team forms edit it in hours. Capacity reads use this person's current value, including zero; they do not substitute an organization default or reconstruct historical capacity. The organization also stores `weekly_capacity_default`. See [schema](../packages/db/src/schema.ts) and [person editor](../apps/web/src/team/browser.ts). |
| Working days | Capacity availability is spread over Monday–Friday, regardless of the configured week-start day. There are no custom per-person workday patterns in this slice. Whole-day time off removes `round(weekly_capacity / 5)` per working day; weekends remove zero. |
| Partial-day time off | Explicit seconds/day are subtracted as entered for each weekday; the value may exceed the nominal one-fifth daily share. The weekly total is capped at weekly capacity, leaving available capacity at least zero. Changing a person's current capacity changes historical availability calculations. |
| Overlaps | DB triggers reject intersecting **dates** for the same person/project allocation; different projects may overlap. Personal time-off date ranges for one person cannot intersect, even across kinds. These constraints prevent duplicate personal leave subtraction; they do not prohibit two disjoint allocation ranges in the same week. |
| Over-allocation | A positive plan may exceed current available capacity, including zero capacity. It is flagged as `planned > available`, never blocked or converted to billable work. Per-allocation weekly hours remain bounded at 168h. |
| Archived resources | Creation/update requires an active person and project; time off requires an active person. Authorized deletion of old plans/leave remains possible after archive. Capacity excludes archived people and plans on archived projects, while tracked totals for active people still include their stored actuals on archived projects. Existing list/history APIs retain their own scoped rows. |
| Actual comparison | `tracked_seconds` is the sum of stored `rounded_seconds` by person and `spent_date`; it is separate from planned seconds and the live elapsed-timer badge. Capacity figures are not a financial forecast or an invoice input. |
| Current web date context | The current Capacity controller chooses its initial 56-day window using the device-local date, then the API applies the organization's week boundaries. The resource-calendar slice will publish organization-local today/week context and test device/organization/DST boundaries explicitly. |
| Mutation concurrency | Repositories compare the `updated_at` read inside an update/delete request and audit the write atomically. Existing browser rows/PATCH/DELETE requests do not bind the client's earlier read revision. [#1190](https://github.com/ConflictHQ/ezacto-pvt/issues/1190) owns that real stale-editor gap before richer concurrent editing. |

### Permissions are deliberately different between API and web entry

[The scope ceiling](../packages/core/src/api-authorization.ts) gives every profile
`schedule:read`; `schedule:write` is limited to administrators, executive managers
and project managers. Tokens also require the corresponding issued scopes.
Repository predicates remain essential:

- Administrators and executive managers read all planning rows and people.
- Project managers read their own allocations plus allocations for people **and**
  projects they manage, and write inside their managed scope. Personal time-off
  access is restricted by managed-person access.
- Other profiles read their own allocations, time off and capacity and cannot
  write. The capacity aggregate lists only the people permitted by its person
  scope; it does not expose a project-by-project allocation breakdown.
- Web entry forms are currently shown only to administrators. API write
  capability for a manager does not establish a manager web editor.

Future project/calendar projections must preserve those boundaries. A scoped
aggregate can include hours whose project details are not in the visible list;
label the aggregation scope without exposing hidden project identities. New
revisioned mutations must check current authority in the atomic write as well as
requiring the caller's expected revision.

## Dependency-ordered implementation stories

Every row is an implementation issue with concrete acceptance and runtime/UI
verification. Existing staffing, the weekly grid, personal time off and its entry
forms need no replacement stories.

| Slice | Dependency | Bounded delivery and state |
| --- | --- | --- |
| [#1188 Organization holidays](https://github.com/ConflictHQ/ezacto-pvt/issues/1188) | Delivered allocation/time-off baseline | **In progress, delivery pending.** Explicit organization dates/names, administrator CRUD and atomic audit, weekday availability subtraction with daily max against personal leave. Holiday/weekend overlap never double-subtracts and availability stays nonnegative. No country feeds, recurrence or leave approvals. |
| [#1190 Client revision preconditions](https://github.com/ConflictHQ/ezacto-pvt/issues/1190) | Delivered allocation/time-off APIs/forms | Add integer revisions and public stale-write preconditions, migrate existing forms and retain input after a conflict. Fresh authority and before/after audit commit with the mutation. This hardens the existing editor; it does not replace the allocation model. |
| [#1191 Placeholders and atomic assignment](https://github.com/ConflictHQ/ezacto-pvt/issues/1191) | #1190 | Named unassigned project demand in separate planning records/rows. One revisioned, idempotent assignment creates the person plan and consumes the placeholder allocation atomically. No fake users, capacity denominators, staffing grants or actual-time writes. |
| [#1192 Project/team resource calendars](https://github.com/ConflictHQ/ezacto-pvt/issues/1192) | #1188 and #1191 | A shared scoped projection plus week/timeline views for allocations, availability and unassigned work, separate from the Time calendar. Organization-local today/week context, bounded reads and explicit aggregate/detail scope. The selected release includes holidays and placeholder rows. |
| [#1193 Drag editing](https://github.com/ConflictHQ/ezacto-pvt/issues/1193) | #1192 and #1190 | Administrator move/resize with a visible full-week-hours preview, revision checks, cancel/rollback and equivalent keyboard/phone forms. Each completed gesture calls a planning command; moving a plan never moves actual time. |
| [#1194 Read-only ICS feeds](https://github.com/ConflictHQ/ezacto-pvt/issues/1194) | #1192 | Scoped advisory export/subscription with revocable credentials, field minimization, stable IDs/revisions and calendar-parser/owned-client acceptance. Floating/all-day planning dates do not become invented timed appointments or remote calendar writes. |
| [#1195 Native parity](https://github.com/ConflictHQ/ezacto-pvt/issues/1195) | #1192 and its published contracts | Implement in the private native application, linking its own story/PR. Shared fixtures and owned iOS/Android acceptance must prove scoped views, administrator entry, revision conflicts, offline/sign-out behavior and exact backend/native versions. Responsive web is already present. |

Holidays and revision preconditions can proceed independently. Placeholder work
follows revisions; the full resource-calendar release then composes holidays and
placeholders. Drag editing, feeds and native parity can proceed independently
once that shared calendar contract is verified. A delay in any of those final
three does not block the others or change the delivered first slice.

## Verification and availability boundary

This audit reads source and existing test evidence. It introduces no runtime
behavior; it does not turn the pending holiday branch or future child issues into
a released capability. Child PRs must retain exact code/runtime evidence:

- Core cases: all week starts, inclusive/partial/weekend boundaries, part-time and
  zero capacity, overlap, archival and over-allocation rules.
- Native SQLite/D1: current actor/scope fences, atomic plan/audit writes,
  revision conflict, duplicate/out-of-order assignment and unchanged actual and
  financial fingerprints.
- Native browser: existing entry reuse, project/team scopes, stale input,
  keyboard/phone/reduced-motion behavior and session isolation.
- Feed/native children: owned disposable client/device acceptance with exact
  versions; API presence alone does not prove an application workflow.

The website source at `b5d1fe8b99cfa034b05dd39ae10ed2df55f810a4` was searched
for resource planning, capacity, scheduling and Forecast claims. Its capacity
reference describes financial bands in `site/releases.html`; its Forecast
reference warns that closing Harvest does not close a separate Forecast account.
No resource-planning claim was found in that source pass. This is a source
review, not a new live-site deployment receipt. Future marketing should name the
specific released web/API/native features and keep pending holidays, placeholders,
resource calendars, feeds and native parity out of current-availability claims.

The private native source at `c148488f356b3e36bf1b9260e0d1d6a0738824db` has
no resource-capacity/allocation/time-off screen found in the `src` inventory.
Native implementation and device evidence remain with #1195 and that repository.

## Placeholder assignment contract (#1191, contract only)

[`packages/core/src/placeholder-allocation.ts`](../packages/core/src/placeholder-allocation.ts)
fixes the interface before the tables exist; its reference store and
[tests](../packages/core/test/placeholder-allocation.test.ts) are what a real
repository must pass. No schema, route or migration is added by it.

- A placeholder allocation names unassigned project demand: project, inclusive
  dates, weekly seconds, `state` (`open`, `assigned`, `archived`), integer
  `revision` from 0. It has no user, capacity, rate or time. Identifiers are
  never reused after archive or erasure.
- One command assigns: `{actorId, idempotencyKey, placeholderAllocationId,
  expectedRevision, userId}`. In a single transaction it re-reads authority,
  creates the person allocation from the placeholder's project/dates/hours and
  marks the placeholder `assigned` with a revision bump and audit event.
- Refusal order, each writing nothing: not found (404), no management of the
  project (403), stale revision (409), not open (409), inactive person/project
  (422), same person/project date overlap (409). Not found precedes forbidden
  because authority comes from the placeholder's project; a route that must
  hide which ids exist answers 404 for both.
- Idempotency: a key is scoped to actor and key, and stores a fingerprint of
  placeholder, revision and user. A replay with the same fingerprint re-checks
  authority (403 if lost), then returns the stored result and writes nothing.
  The same key with a different fingerprint is refused with 422
  `idempotency_key_reused`.
- Warnings, never refusals: `over_allocated` per week (existing policy).
  Missing project access is returned as a `project_access_missing`
  prerequisite; the command creates no staffing assignment or access.
- Unassigned rows are listed separately and never enter a person's capacity or
  utilization. Organization-wide lists need `schedule:write` over the project.

## Placeholder storage and repository (#1191, slice 2)

Migration `0158_placeholder_allocations` adds new tables and leaves
`allocations` (and its `user_id` foreign key) untouched:

- `placeholders`: a name and an active flag. No user, capacity or rate.
- `placeholder_allocations`: project, inclusive dates, weekly seconds, `state`,
  `revision` from 0 and a plain `assigned_allocation_id` (not a foreign key, so
  erasing a person's plan keeps the record that the demand was met). Rows are
  AUTOINCREMENT and never deleted; triggers refuse deletes and any change to a
  row that is not `open`, so ids are never reused and a stale conversion cannot
  re-open a row.
- `placeholder_assignment_keys`: one row per actor and idempotency key with the
  request fingerprint and the stored result.

`createPlaceholderAllocationRepository` (`packages/db/src/placeholder-allocations.ts`)
supplies `decideAssignment` its facts and commits the result as one batch:
person allocation, placeholder `assigned` with revision + 1, key result and
audit event (aggregate `placeholder_allocation`). Each write is also guarded in
SQL by the live actor and project scope, and a date overlap is refused by the
existing allocations trigger, which rolls the whole batch back. Reads and writes
require `schedule:write`: administrators and executive managers see all, project
managers only projects they manage, everyone else is refused.

Still open: the HTTP routes and revision wire shape (waits for #1190), the
planning-view lines and administrator forms, edit of an open placeholder
allocation, and the shared capacity projection (#1192).

Open: the revision wire shape depends on #1190.
