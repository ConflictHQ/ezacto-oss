import {
  maximumResourceCalendarPeople,
  ResourceCalendarReadError,
  type ResourceCalendarRepository,
  type ResourceCalendarProjection,
  type ResourceCalendarContext,
  type ResourceCalendarQuery,
} from "@ezacto/core";
import type { Hono } from "hono";
import { requireApiScope } from "../auth.js";
import type { ApiContext } from "../context.js";
import { ApiError, validationError, type FieldError } from "../errors.js";
import { projectionPage } from "../pagination.js";
import {
  assertFields,
  queryDate,
  queryBoolean,
  queryPositiveInteger,
  strictSearchParams,
  translateResourceError,
} from "./support.js";

const serializeContext = (context: ResourceCalendarContext) => ({
  time_zone: context.timeZone,
  week_start_day: context.weekStartDay,
  today: context.today,
  current_week_start: context.currentWeekStart,
});
const serialize = (
  projection: Omit<ResourceCalendarProjection, "nextCursor">,
) => ({
  context: serializeContext(projection.context),
  view: projection.view,
  revision: projection.revision,
  week_starts: projection.weekStarts,
  people: projection.people.map((person) => ({
    person_id: person.personId,
    name: person.name,
    weeks: person.weeks.map((week) => ({
      week_start: week.weekStart,
      planned_seconds: week.plannedSeconds,
      available_seconds: week.availableSeconds,
      tracked_seconds: week.trackedSeconds,
      person_planned_seconds: week.personPlannedSeconds,
      person_other_scope_planned_seconds: week.personOtherScopePlannedSeconds,
      over_allocated: week.overAllocated,
      projects: week.projects.map((project) => ({
        project_id: project.projectId,
        planned_seconds: project.plannedSeconds,
      })),
      other_scope_planned_seconds: week.otherScopePlannedSeconds,
      other_scope_tracked_seconds: week.otherScopeTrackedSeconds,
    })),
  })),
  unassigned: projection.unassigned.map((row) => ({
    week_start: row.weekStart,
    placeholder_id: row.placeholderId,
    name: row.name,
    project_id: row.projectId,
    planned_seconds: row.plannedSeconds,
  })),
  unassigned_truncated: projection.unassignedTruncated,
  has_other_scope: projection.hasOtherScope,
});

const calendarQuery = (url: URL): ResourceCalendarQuery => {
  const params = strictSearchParams(
    url,
    new Set([
      "view",
      "from",
      "to",
      "project_id",
      "person_id",
      "cursor",
      "per_page",
    ]),
  );
  const errors: FieldError[] = [];
  const view = params.get("view"),
    from = queryDate(params, "from", errors),
    to = queryDate(params, "to", errors);
  const projectId = queryPositiveInteger(params, "project_id", errors),
    personId = queryPositiveInteger(params, "person_id", errors);
  if (view !== "team" && view !== "project")
    errors.push({
      field: "view",
      code: "invalid",
      message: "choose team or project",
    });
  for (const field of ["from", "to"] as const)
    if (!params.has(field))
      errors.push({ field, code: "required", message: `${field} is required` });
  if (view === "project" && !params.has("project_id"))
    errors.push({
      field: "project_id",
      code: "required",
      message: "project view requires project_id",
    });
  assertFields(errors);
  return {
    view: view as "team" | "project",
    from: from!,
    to: to!,
    ...(projectId === undefined ? {} : { projectId }),
    ...(personId === undefined ? {} : { personId }),
  };
};
const calendarError = (error: unknown): never => {
  if (error instanceof ResourceCalendarReadError) {
    if (error.code === "range_too_large")
      throw validationError([
        {
          field: "to",
          code: "range_too_large",
          message: "Narrow the calendar date range or person filter.",
        },
      ]);
    throw new ApiError({
      status: error.code === "actor_required" ? 403 : 404,
      code: error.code === "actor_required" ? "forbidden" : "not_found",
      message: "The calendar is not available in this scope.",
    });
  }
  return translateResourceError(error, "resource calendar");
};

export const installResourceCalendarRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: {
    repository: ResourceCalendarRepository;
    cursorSigningKey: Uint8Array;
    now: () => Date;
  },
): void => {
  api.get("/resource-calendar/projects", async (context) => {
    requireApiScope(context, "schedule:read");
    try {
      const url = new URL(context.req.url),
        errors: FieldError[] = [];
      const params = strictSearchParams(
        url,
        new Set(["is_active", "cursor", "per_page"]),
      );
      const isActive = queryBoolean(params, "is_active", errors);
      assertFields(errors);
      const principal = context.get("principal");
      const envelope = await projectionPage({
        requestUrl: url,
        cursorSigningKey: options.cursorSigningKey,
        maximumSize: 100,
        read: (afterId, size) =>
          options.repository.projects(
            {
              userId: principal.userId,
              profile: principal.profile,
              managerGrants: principal.managerGrants,
            },
            {
              limit: size,
              ...(afterId === undefined ? {} : { cursor: afterId }),
              ...(isActive === undefined ? {} : { isActive }),
            },
          ),
      });
      return context.json(
        {
          ...envelope,
          data: envelope.data.rows.map((row) => ({
            id: row.id,
            name: row.name,
            is_active: row.isActive,
          })),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return calendarError(error);
    }
  });
  api.get("/resource-calendar/allocations", async (context) => {
    requireApiScope(context, "schedule:read");
    try {
      const url = new URL(context.req.url),
        query = calendarQuery(url),
        principal = context.get("principal");
      const envelope = await projectionPage({
        requestUrl: url,
        cursorSigningKey: options.cursorSigningKey,
        maximumSize: 100,
        read: (afterId, size) =>
          options.repository.allocations(
            {
              userId: principal.userId,
              profile: principal.profile,
              managerGrants: principal.managerGrants,
            },
            {
              ...query,
              limit: size,
              ...(afterId === undefined ? {} : { cursor: afterId }),
            },
          ),
      });
      return context.json(
        {
          ...envelope,
          data: envelope.data.rows.map((row) => ({
            id: row.id,
            version: row.version,
            user_id: row.userId,
            project_id: row.projectId,
            project_name: row.projectName,
            start_date: row.startDate,
            end_date: row.endDate,
            planned_seconds_per_week: row.plannedSecondsPerWeek,
          })),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return calendarError(error);
    }
  });
  api.get("/resource-calendar/context", async (context) => {
    requireApiScope(context, "schedule:read");
    strictSearchParams(new URL(context.req.url), new Set());
    const principal = context.get("principal");
    try {
      const data = await options.repository.context(
        {
          userId: principal.userId,
          profile: principal.profile,
          managerGrants: principal.managerGrants,
        },
        options.now(),
      );
      return context.json(
        {
          data: serializeContext(data),
          links: { self: "/api/v1/resource-calendar/context" },
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      if (error instanceof ResourceCalendarReadError)
        throw new ApiError({
          status: 403,
          code: "forbidden",
          message: "The calendar is not available in this scope.",
        });
      throw error;
    }
  });
  api.get("/resource-calendar", async (context) => {
    requireApiScope(context, "schedule:read");
    try {
      const url = new URL(context.req.url);
      const query = calendarQuery(url);
      const principal = context.get("principal");
      const envelope = await projectionPage({
        requestUrl: url,
        cursorSigningKey: options.cursorSigningKey,
        maximumSize: maximumResourceCalendarPeople,
        read: (afterId, size) =>
          options.repository.read(
            {
              userId: principal.userId,
              profile: principal.profile,
              managerGrants: principal.managerGrants,
            },
            {
              ...query,
              limit: size,
              ...(afterId === undefined ? {} : { cursor: afterId }),
            },
            options.now(),
          ),
      });
      return context.json(
        { ...envelope, data: serialize(envelope.data) },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return calendarError(error);
    }
  });
};
