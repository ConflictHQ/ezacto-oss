import type { ApiContractOperation } from "./contract.js";
const provider = {
  name: "provider",
  location: "path" as const,
  required: true,
  schema: { type: "string", enum: ["google", "microsoft"] },
};
export const calendarConnectionOperations: readonly ApiContractOperation[] = [
  {
    method: "get",
    path: "/api/v1/calendar-cleanup-status",
    operationId: "getCalendarCleanupStatus",
    summary:
      "Show unresolved calendar cleanup counts across retained incarnations",
    tag: "time-entries",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "CalendarCleanupEnvelope",
  },
  {
    method: "get",
    path: "/api/v1/calendar-connections",
    operationId: "listCalendarConnections",
    summary: "List the acting user’s private calendar connection status",
    tag: "time-entries",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "CalendarConnectionList",
  },
  {
    method: "delete",
    path: "/api/v1/calendar-connections/:provider",
    operationId: "disconnectCalendarConnection",
    summary: "Disconnect the acting user’s calendar and cancel open proposals",
    tag: "time-entries",
    sessionOnly: true,
    responseStatus: 204,
    parameters: [provider],
    requestSchema: "CalendarDisconnectInput",
    requestRequired: true,
  },
  {
    method: "post",
    path: "/api/v1/calendar-connections/:provider/refresh",
    operationId: "refreshCalendarConnection",
    summary: "Refresh proposals from an available calendar provider",
    description:
      "No time entry is created or changed. Returns unavailable until an approved provider adapter is configured. No token may be supplied.",
    tag: "time-entries",
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: "CalendarRefreshResult",
    requestSchema: "CalendarRefreshInput",
    requestRequired: true,
    parameters: [provider],
  },
];
export const calendarConnectionSchemas = {
  CalendarCleanupEnvelope: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: { $ref: "#/components/schemas/CalendarCleanupStatus" },
    },
  },
  CalendarConnectionList: {
    type: "object",
    required: ["data"],
    additionalProperties: false,
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "provider",
            "status",
            "generation",
            "last_synced_at",
            "last_error",
            "syncing",
            "cleanup_pending",
            "available",
          ],
          properties: {
            provider: { type: "string", enum: ["google", "microsoft"] },
            status: {
              type: "string",
              enum: ["connected", "needs_reauth", "disconnected"],
            },
            generation: { type: "integer", minimum: 1 },
            last_synced_at: { type: ["string", "null"], format: "date-time" },
            last_error: {
              type: ["string", "null"],
              enum: [
                "credential_unavailable",
                "authorization",
                "unavailable",
                "invalid_source",
                "limit",
                "changed",
                null,
              ],
            },
            syncing: { type: "boolean" },
            cleanup_pending: { type: "boolean" },
            available: { type: "boolean" },
          },
        },
      },
    },
  },
  CalendarRefreshInput: {
    type: "object",
    additionalProperties: false,
    properties: {
      past_days: { type: "integer", minimum: 0, maximum: 90 },
      future_days: { type: "integer", minimum: 0, maximum: 90 },
    },
  },
  CalendarDisconnectInput: {
    type: "object",
    additionalProperties: false,
    required: ["generation"],
    properties: { generation: { type: "integer", minimum: 1 } },
  },
  CalendarRefreshResult: {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: {
        type: "object",
        additionalProperties: false,
        required: ["state", "applied"],
        properties: {
          state: { type: "string", enum: ["connected", "needs_reauth"] },
          applied: { type: "integer", minimum: 0, maximum: 90 },
        },
      },
    },
  },
};
