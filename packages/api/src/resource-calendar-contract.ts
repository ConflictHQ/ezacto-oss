import type { ApiContractOperation } from "./contract.js";
const text = { type: "string" },
  date = { type: "string", format: "date" },
  id = { type: "integer", minimum: 1 },
  seconds = { type: "integer", minimum: 0 },
  bool = { type: "boolean" };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (name: string, maxItems: number) => ({
  type: "array",
  items: ref(name),
  maxItems,
});
const rangeParameters: NonNullable<ApiContractOperation["parameters"]> = [
  {
    name: "view",
    location: "query",
    required: true,
    schema: { type: "string", enum: ["project", "team"] },
  },
  { name: "from", location: "query", required: true, schema: date },
  { name: "to", location: "query", required: true, schema: date },
  { name: "project_id", location: "query", schema: id },
  { name: "person_id", location: "query", schema: id },
  {
    name: "per_page",
    location: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  },
  { name: "cursor", location: "query", schema: text },
];
export const resourceCalendarOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/resource-calendar/context",
    operationId: "getResourceCalendarContext",
    tag: "capacity",
    summary: "Read current organization-local calendar context",
    responseStatus: 200,
    responseSchema: "ResourceCalendarContextEnvelope",
    description:
      "Requires schedule:read and current native actor authority. Supplies organization-local today, current week, timezone and week start for initial calendar navigation without using the device date. Always no-store; invalid imported organization zones fall back to UTC.",
  },
  {
    method: "get",
    path: "/api/v1/resource-calendar",
    operationId: "getResourceCalendar",
    tag: "capacity",
    summary: "Read the scoped project or team resource calendar",
    responseStatus: 200,
    responseSchema: "ResourceCalendarEnvelope",
    description:
      "Requires schedule:read. A bounded live projection of planned, available and rounded tracked seconds, with separate unassigned demand. Uses current self/managed-person/project authority on every page. Hidden project work is labelled only by aggregate scope; private leave details are never returned. Availability uses full touched organization weeks and current person capacity. Context always contains organization-local today/week and refreshes even if revision is unchanged. No actual time, staffing or accounting mutations. More than the native fact budget is refused with a range_too_large field error; narrow the date range or person filter. Other web profiles remain read-only.",
    parameters: rangeParameters,
  },
  {
    method: "get",
    path: "/api/v1/resource-calendar/allocations",
    operationId: "getResourceCalendarAllocations",
    tag: "capacity",
    summary: "Read scoped dated allocation ranges",
    responseStatus: 200,
    responseSchema: "ResourceCalendarAllocationPage",
    parameters: rangeParameters,
    description:
      "Requires schedule:read and current self/managed-person/project access. Returns actual saved allocation dates, exact weekly seconds and mutation versions; no ranges are inferred from weekly aggregates. Snaps the query to full organization weeks, at most 53. Archived people and plans on archived projects are omitted. Project view requires project_id. The live signed cursor is independently scoped to this query. No hidden project identities, time-off detail, rates or actual-time writes.",
  },
  {
    method: "get",
    path: "/api/v1/resource-calendar/projects",
    operationId: "listResourceCalendarProjects",
    tag: "capacity",
    summary: "List project identities visible to the resource calendar",
    responseStatus: 200,
    responseSchema: "ResourceCalendarProjectPage",
    description:
      "Requires schedule:read. Current administrators/executive managers see all projects; project managers see managed projects; members see assigned historical/current project identities. Optional is_active narrows the catalog; archived identities remain available to label retained actuals. Pagination is bounded at 100; current authority is rechecked for every page.",
    parameters: [
      { name: "is_active", location: "query", schema: bool },
      {
        name: "per_page",
        location: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      { name: "cursor", location: "query", schema: text },
    ],
  },
];
const collectionPage = (name: string) =>
  object({
    data: array(name, 100),
    links: object({ self: text, next: { anyOf: [text, { type: "null" }] } }),
    page: object({
      per_page: { type: "integer", minimum: 1, maximum: 100 },
      next_cursor: { anyOf: [text, { type: "null" }] },
    }),
  });
export const resourceCalendarSchemas = {
  ResourceCalendarAllocation: object({
    id,
    version: { type: "integer", minimum: 0 },
    user_id: id,
    project_id: id,
    project_name: text,
    start_date: date,
    end_date: date,
    planned_seconds_per_week: { type: "integer", minimum: 1, maximum: 604800 },
  }),
  ResourceCalendarProject: object({ id, name: text, is_active: bool }),
  ResourceCalendarAllocationPage: collectionPage("ResourceCalendarAllocation"),
  ResourceCalendarProjectPage: collectionPage("ResourceCalendarProject"),
  ResourceCalendarContextEnvelope: object({
    data: ref("ResourceCalendarContext"),
    links: object({ self: text }),
  }),
  ResourceCalendarContext: object({
    time_zone: text,
    week_start_day: { type: "string", enum: ["saturday", "sunday", "monday"] },
    today: date,
    current_week_start: date,
  }),
  ResourceCalendarProjectHours: object({
    project_id: id,
    planned_seconds: seconds,
  }),
  ResourceCalendarWeek: object({
    week_start: date,
    planned_seconds: seconds,
    available_seconds: seconds,
    tracked_seconds: seconds,
    person_planned_seconds: seconds,
    person_other_scope_planned_seconds: seconds,
    over_allocated: bool,
    projects: array("ResourceCalendarProjectHours", 20000),
    other_scope_planned_seconds: seconds,
    other_scope_tracked_seconds: seconds,
  }),
  ResourceCalendarPerson: object({
    person_id: id,
    name: text,
    weeks: array("ResourceCalendarWeek", 53),
  }),
  ResourceCalendarUnassigned: object({
    week_start: date,
    placeholder_id: id,
    name: text,
    project_id: id,
    planned_seconds: seconds,
  }),
  ResourceCalendar: object({
    context: ref("ResourceCalendarContext"),
    view: { type: "string", enum: ["project", "team"] },
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    week_starts: { type: "array", items: date, maxItems: 53 },
    people: array("ResourceCalendarPerson", 100),
    unassigned: array("ResourceCalendarUnassigned", 5300),
    unassigned_truncated: bool,
    has_other_scope: bool,
  }),
  ResourceCalendarEnvelope: object({
    data: ref("ResourceCalendar"),
    links: object({ self: text, next: { anyOf: [text, { type: "null" }] } }),
    page: object({
      per_page: { type: "integer", minimum: 1, maximum: 100 },
      next_cursor: { anyOf: [text, { type: "null" }] },
    }),
  }),
};
