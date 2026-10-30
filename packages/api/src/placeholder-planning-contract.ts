import type { ApiContractOperation } from "./contract.js";

const string = { type: "string" };
const id = { type: "integer", minimum: 1 };
const version = { type: "integer", minimum: 0 };
const date = { type: "string", format: "date" };
const name = { type: "string", minLength: 1, maxLength: 120 };
const seconds = { type: "integer", minimum: 1 };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const page = (item: string) =>
  object({
    data: { type: "array", items: ref(item) },
    links: object({
      self: string,
      next: { anyOf: [string, { type: "null" }] },
    }),
    page: object({
      per_page: id,
      next_cursor: { anyOf: [string, { type: "null" }] },
    }),
  });
const pathId = {
  name: "id",
  location: "path" as const,
  required: true,
  schema: id,
};
const pagination = [
  { name: "cursor", location: "query" as const, schema: string },
  {
    name: "per_page",
    location: "query" as const,
    schema: { type: "integer", minimum: 1, maximum: 200 },
  },
];
const base = {
  tag: "capacity",
  description:
    "Named unassigned project demand, separate from people, capacity, actual time and money. Reads require schedule:read; mutations require schedule:write. Current management authority and project access are rechecked, including within native writes. Ordinary members cannot list organization-wide unassigned demand. Project managers are confined to managed work. Every edit or archive requires its saved version; a conflict preserves the saved state. Archiving a placeholder archives its remaining open demand without removing assigned person allocations.",
};
export const placeholderPlanningOperations: ApiContractOperation[] = [
  {
    ...base,
    method: "get",
    path: "/api/v1/planning-placeholders",
    operationId: "listPlanningPlaceholders",
    summary: "List permitted planning placeholders",
    responseStatus: 200,
    responseSchema: "PlanningPlaceholderPage",
    parameters: [
      ...pagination,
      { name: "is_active", location: "query", schema: { type: "boolean" } },
    ],
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/planning-placeholders",
    operationId: "createPlanningPlaceholder",
    summary: "Create a named planning placeholder",
    requestSchema: "PlanningPlaceholderInput",
    requestRequired: true,
    responseStatus: 201,
    responseSchema: "PlanningPlaceholderEnvelope",
  },
  {
    ...base,
    method: "patch",
    path: "/api/v1/planning-placeholders/:id",
    operationId: "updatePlanningPlaceholder",
    summary: "Rename a planning placeholder at its current version",
    parameters: [pathId],
    requestSchema: "PlanningPlaceholderUpdateInput",
    requestRequired: true,
    responseStatus: 200,
    responseSchema: "PlanningPlaceholderEnvelope",
  },
  {
    ...base,
    method: "delete",
    path: "/api/v1/planning-placeholders/:id",
    operationId: "deletePlanningPlaceholder",
    summary: "Archive a placeholder and its open unassigned demand",
    parameters: [pathId],
    requestSchema: "PlanningVersionInput",
    requestRequired: true,
    responseStatus: 200,
    responseSchema: "PlanningPlaceholderEnvelope",
  },
  {
    ...base,
    method: "get",
    path: "/api/v1/placeholder-allocations",
    operationId: "listPlaceholderAllocations",
    summary: "List scoped unassigned allocation records",
    responseStatus: 200,
    responseSchema: "PlaceholderAllocationPage",
    parameters: [
      ...pagination,
      { name: "project_id", location: "query", schema: id },
      {
        name: "state",
        location: "query",
        schema: { type: "string", enum: ["open", "assigned", "archived"] },
      },
      { name: "from", location: "query", schema: date },
      { name: "to", location: "query", schema: date },
    ],
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/placeholder-allocations",
    operationId: "createPlaceholderAllocation",
    summary: "Plan unassigned project work",
    requestSchema: "PlaceholderAllocationInput",
    requestRequired: true,
    responseStatus: 201,
    responseSchema: "PlaceholderAllocationEnvelope",
  },
  {
    ...base,
    method: "patch",
    path: "/api/v1/placeholder-allocations/:id",
    operationId: "updatePlaceholderAllocation",
    summary: "Edit open unassigned work at its current version",
    parameters: [pathId],
    requestSchema: "PlaceholderAllocationUpdateInput",
    requestRequired: true,
    responseStatus: 200,
    responseSchema: "PlaceholderAllocationEnvelope",
  },
  {
    ...base,
    method: "delete",
    path: "/api/v1/placeholder-allocations/:id",
    operationId: "deletePlaceholderAllocation",
    summary: "Archive open unassigned work at its current version",
    parameters: [pathId],
    requestSchema: "PlanningVersionInput",
    requestRequired: true,
    responseStatus: 200,
    responseSchema: "PlaceholderAllocationEnvelope",
  },
  {
    ...base,
    method: "post",
    path: "/api/v1/placeholder-allocations/:id/assign",
    operationId: "assignPlaceholderAllocation",
    summary: "Atomically assign unassigned demand to a person",
    description:
      base.description +
      " One explicit command creates one person allocation and marks the open placeholder allocation assigned, with an audit event and actor-scoped idempotency receipt in the same transaction. Repeat the same key and exact payload to recover its prior result; reusing the key for different input is refused. The expected version, active target and project, current authority and same-person/project overlap are checked. An overlap consumes no demand. Over-allocation produces warnings. Project access and staffing are never granted implicitly; a missing-access prerequisite is returned separately.",
    parameters: [pathId],
    requestSchema: "PlaceholderAssignmentInput",
    requestRequired: true,
    responseStatus: 200,
    responseSchema: "PlaceholderAssignmentEnvelope",
  },
];

export const placeholderPlanningSchemas = {
  PlanningPlaceholder: object({
    id,
    name,
    is_active: { type: "boolean" },
    version,
  }),
  PlanningPlaceholderInput: object({ name }),
  PlanningPlaceholderUpdateInput: object({ name, version }),
  PlanningVersionInput: object({ version }),
  PlanningPlaceholderEnvelope: object({ data: ref("PlanningPlaceholder") }),
  PlanningPlaceholderPage: page("PlanningPlaceholder"),
  PlaceholderAllocation: object({
    id,
    placeholder_id: id,
    name,
    project_id: id,
    project_name: string,
    start_date: date,
    end_date: date,
    planned_seconds_per_week: seconds,
    state: { type: "string", enum: ["open", "assigned", "archived"] },
    version,
    assigned_allocation_id: { anyOf: [id, { type: "null" }] },
  }),
  PlaceholderAllocationInput: object({
    placeholder_id: id,
    project_id: id,
    start_date: date,
    end_date: date,
    planned_seconds_per_week: seconds,
  }),
  PlaceholderAllocationUpdateInput: {
    ...object(
      {
        version,
        start_date: date,
        end_date: date,
        planned_seconds_per_week: seconds,
      },
      ["version"],
    ),
    minProperties: 2,
  },
  PlaceholderAllocationEnvelope: object({ data: ref("PlaceholderAllocation") }),
  PlaceholderAllocationPage: page("PlaceholderAllocation"),
  PlaceholderAssignmentInput: object({
    version,
    user_id: id,
    idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
  }),
  PlaceholderAssignment: object({
    allocation: object({
      id,
      version,
      user_id: id,
      project_id: id,
      start_date: date,
      end_date: date,
      planned_seconds_per_week: seconds,
    }),
    placeholder: ref("PlaceholderAllocation"),
    warnings: {
      type: "array",
      items: object({
        code: { type: "string", enum: ["over_allocated"] },
        week_start: date,
        planned_seconds: { type: "integer", minimum: 0 },
        capacity_seconds: { type: "integer", minimum: 0, description: "Available weekly capacity after current personal leave and organization holidays." },
      }),
    },
    prerequisites: {
      type: "array",
      items: object({
        code: { type: "string", enum: ["project_access_missing"] },
      }),
    },
  }),
  PlaceholderAssignmentEnvelope: object({ data: ref("PlaceholderAssignment") }),
};
