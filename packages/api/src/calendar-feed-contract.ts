import type { ApiContractOperation } from "./contract.js";
const s = { type: "string" },
  n = { type: "integer", minimum: 1 },
  nullable = (x: object) => ({ anyOf: [x, { type: "null" }] }),
  object = (properties: Record<string, unknown>, optional: string[] = []) => ({
    type: "object",
    properties,
    required: Object.keys(properties).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  });
const input = {
  scope: { type: "string", enum: ["self", "project", "team"] },
  project_id: nullable(n),
  from_date: s,
  through_date: s,
  include_names: { type: "boolean" },
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
export const calendarFeedSchemas = {
  CalendarFeedInput: object({ ...input, expires_at: s }, ["expires_at"]),
  CalendarFeed: object({
    ...input,
    id: s,
    issued_at: s,
    expires_at: s,
    revoked_at: nullable(s),
    credential_generation: n,
  }),
  CalendarFeedList: object({
    data: { type: "array", items: ref("CalendarFeed") },
  }),
  CalendarFeedIssued: object({
    data: object({ feed: ref("CalendarFeed"), username: s, password: s }),
  }),
};
const parameter = {
  name: "id",
  location: "path",
  required: true,
  schema: s,
} as const;
export const calendarFeedOperations: ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/calendar-feeds",
    operationId: "listCalendarFeeds",
    tag: "capacity",
    summary: "List owned advisory calendar subscriptions",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "CalendarFeedList",
  },
  {
    method: "post",
    path: "/api/v1/calendar-feeds",
    operationId: "createCalendarFeed",
    tag: "capacity",
    summary: "Issue a scoped expiring calendar subscription password",
    sessionOnly: true,
    requestRequired: true,
    requestSchema: "CalendarFeedInput",
    responseStatus: 201,
    responseSchema: "CalendarFeedIssued",
  },
  {
    method: "post",
    path: "/api/v1/calendar-feeds/:id/rotate",
    operationId: "rotateCalendarFeed",
    tag: "capacity",
    summary: "Replace a subscription password while retaining stable event IDs",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "CalendarFeedIssued",
    parameters: [parameter],
  },
  {
    method: "delete",
    path: "/api/v1/calendar-feeds/:id",
    operationId: "revokeCalendarFeed",
    tag: "capacity",
    summary: "Revoke a calendar subscription immediately",
    sessionOnly: true,
    responseStatus: 204,
    parameters: [parameter],
  },
  {
    method: "get",
    path: "/api/v1/calendar-feeds/:id/download",
    operationId: "downloadCalendarFeed",
    tag: "capacity",
    summary: "Download the current authorized advisory calendar",
    sessionOnly: true,
    responseStatus: 200,
    binaryResponse: true,
    parameters: [parameter],
  },
];
