import {
  addDays,
  allocationCoversWeek,
  type AllocationWeekStartDay,
  capacityWeeks,
  isAllocationDate,
  isOverAllocated,
  weekStartOf,
} from "./allocation.js";
import { timeOffSecondsInWeek } from "./time-off.js";
import { TrackedResourceInputError } from "./tracked-state.js";

/**
 * Resource planning (issue 1192): the contract of the scoped project and team
 * calendar projection. This file holds the types, the organization-local date
 * context and a pure reference composition over plain rows. The database
 * composition, the API operation and the views must produce exactly what
 * `composeResourceCalendar` produces for the same rows; see
 * `docs/resource-calendar-contract.md`.
 *
 * Nothing here reads or writes time entries, rates, invoices or staffing. A
 * plan is not work, and the full weekly amount counts for every week a range
 * touches (no daily proration, no timed appointments).
 */

export const maximumResourceCalendarPeople = 100;
export const defaultResourceCalendarPeople = 50;

/** Where the calendar was asked for: one project, or the whole visible team. */
export type ResourceCalendarView = "project" | "team";

export interface ResourceCalendarContext {
  readonly timeZone: string;
  readonly weekStartDay: AllocationWeekStartDay;
  /** The organization-local calendar date, whatever the caller's device says. */
  readonly today: string;
  readonly currentWeekStart: string;
}

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** The organization's calendar date at `now`, respecting daylight saving time. */
export const organizationLocalDate = (now: Date, timeZone: string): string => {
  if (!isTimeZone(timeZone)) {
    throw new TrackedResourceInputError(
      "time_zone",
      "invalid_time_zone",
      "unknown time zone",
    );
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
};

export const resourceCalendarContext = (
  now: Date,
  timeZone: string,
  weekStartDay: AllocationWeekStartDay,
): ResourceCalendarContext => {
  const today = organizationLocalDate(now, timeZone);
  return {
    timeZone,
    weekStartDay,
    today,
    currentWeekStart: weekStartOf(today, weekStartDay),
  };
};

export interface ResourceCalendarQuery {
  readonly view: ResourceCalendarView;
  readonly from: string;
  readonly to: string;
  /** Required for the project view. */
  readonly projectId?: number;
  readonly personId?: number;
  readonly limit?: number;
  /** The last person id of the previous page. */
  readonly cursor?: number;
}

export interface CalendarPerson {
  readonly id: number;
  readonly name: string;
  readonly weeklyCapacitySeconds: number;
  readonly archived: boolean;
}

export interface CalendarProject {
  readonly id: number;
  readonly name: string;
}

export interface CalendarAllocation {
  readonly id: number;
  readonly personId: number;
  readonly projectId: number;
  readonly projectArchived: boolean;
  readonly startDate: string;
  readonly endDate: string;
  readonly plannedSecondsPerWeek: number;
  readonly revision: number;
}

/**
 * Named unassigned demand. Separate rows from allocations, never a person and
 * never part of a capacity denominator. The shape is provisional until the
 * placeholder issue (1191) settles it.
 */
export interface CalendarPlaceholder {
  readonly id: number;
  readonly projectId: number;
  readonly projectArchived: boolean;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly plannedSecondsPerWeek: number;
  readonly revision: number;
}

export interface CalendarTimeOff {
  readonly personId: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly secondsPerDay: number | null;
}

export interface CalendarTracked {
  readonly personId: number;
  readonly spentDate: string;
  readonly roundedSeconds: number;
}

export interface ResourceCalendarRows {
  readonly weekStartDay: AllocationWeekStartDay;
  /** People the caller may see, in any order. */
  readonly people: readonly CalendarPerson[];
  /** Projects the caller may see by identity. Others are labelled, not named. */
  readonly visibleProjects: readonly CalendarProject[];
  readonly allocations: readonly CalendarAllocation[];
  readonly placeholders: readonly CalendarPlaceholder[];
  readonly timeOff: readonly CalendarTimeOff[];
  readonly holidays: readonly { readonly date: string }[];
  readonly tracked: readonly CalendarTracked[];
}

export interface ResourceCalendarProjectHours {
  readonly projectId: number;
  readonly plannedSeconds: number;
}

export interface ResourceCalendarPersonWeek {
  readonly weekStart: string;
  readonly plannedSeconds: number;
  readonly availableSeconds: number;
  readonly trackedSeconds: number;
  readonly overAllocated: boolean;
  /** Visible projects only. */
  readonly projects: readonly ResourceCalendarProjectHours[];
  /** Planned seconds on projects the caller cannot see; included in plannedSeconds, never named. */
  readonly otherScopePlannedSeconds: number;
}

export interface ResourceCalendarPerson {
  readonly personId: number;
  readonly name: string;
  readonly weeks: readonly ResourceCalendarPersonWeek[];
}

export interface ResourceCalendarUnassignedWeek {
  readonly weekStart: string;
  readonly placeholderId: number;
  readonly name: string;
  readonly projectId: number;
  readonly plannedSeconds: number;
}

export interface ResourceCalendarProjection {
  readonly context: ResourceCalendarContext;
  readonly view: ResourceCalendarView;
  /** Changes whenever any contributing row or its revision changes. */
  readonly revision: string;
  readonly weekStarts: readonly string[];
  readonly people: readonly ResourceCalendarPerson[];
  /** Demand with no person, kept apart from every person total. */
  readonly unassigned: readonly ResourceCalendarUnassignedWeek[];
  /** Whether some planned hours belong to projects hidden from this caller. */
  readonly hasOtherScope: boolean;
  readonly nextCursor: number | null;
}

const fnv = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const assertQuery = (query: ResourceCalendarQuery): number => {
  for (const field of ["from", "to"] as const) {
    if (!isAllocationDate(query[field])) {
      throw new TrackedResourceInputError(
        field,
        "invalid_date",
        "must be a real canonical YYYY-MM-DD date",
      );
    }
  }
  if (query.view === "project" && query.projectId === undefined) {
    throw new TrackedResourceInputError(
      "project_id",
      "required",
      "the project view needs project_id",
    );
  }
  const limit = query.limit ?? defaultResourceCalendarPeople;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > maximumResourceCalendarPeople
  ) {
    throw new TrackedResourceInputError(
      "limit",
      "invalid_integer",
      `limit must be between 1 and ${maximumResourceCalendarPeople}`,
    );
  }
  return limit;
};

/**
 * The reference composition. Archived people are omitted; plans on archived
 * projects are omitted from planned and placeholder rows, while tracked time
 * for an included person keeps its stored actuals. Whole-week capacity and
 * availability follow `timeOffSecondsInWeek`, with organization holidays as
 * whole-day entries.
 */
export const composeResourceCalendar = (
  context: ResourceCalendarContext,
  query: ResourceCalendarQuery,
  rows: ResourceCalendarRows,
): ResourceCalendarProjection => {
  const limit = assertQuery(query);
  const weekStarts = capacityWeeks(query.from, query.to, rows.weekStartDay);
  const visible = new Set(rows.visibleProjects.map((project) => project.id));
  const projectScope = (id: number) =>
    query.view !== "project" || id === query.projectId;
  const holidayEntries = rows.holidays.map((holiday) => ({
    startDate: holiday.date,
    endDate: holiday.date,
    secondsPerDay: null,
  }));

  const eligible = rows.people
    .filter((person) => !person.archived)
    .filter(
      (person) => query.personId === undefined || person.id === query.personId,
    )
    .filter((person) => query.cursor === undefined || person.id > query.cursor)
    .sort((a, b) => a.id - b.id);
  const page = eligible.slice(0, limit);
  const nextCursor = eligible.length > limit ? page[page.length - 1]!.id : null;

  let hasOtherScope = false;
  const people = page.map((person): ResourceCalendarPerson => {
    const leave = [
      ...rows.timeOff.filter((entry) => entry.personId === person.id),
      ...holidayEntries,
    ];
    const weeks = weekStarts.map((weekStart): ResourceCalendarPersonWeek => {
      const covering = rows.allocations.filter(
        (allocation) =>
          allocation.personId === person.id &&
          !allocation.projectArchived &&
          projectScope(allocation.projectId) &&
          allocationCoversWeek(allocation, weekStart),
      );
      const byProject = new Map<number, number>();
      let other = 0;
      for (const allocation of covering) {
        if (visible.has(allocation.projectId)) {
          byProject.set(
            allocation.projectId,
            (byProject.get(allocation.projectId) ?? 0) +
              allocation.plannedSecondsPerWeek,
          );
        } else {
          other += allocation.plannedSecondsPerWeek;
        }
      }
      if (other > 0) hasOtherScope = true;
      const planned = covering.reduce(
        (sum, allocation) => sum + allocation.plannedSecondsPerWeek,
        0,
      );
      const available =
        person.weeklyCapacitySeconds -
        timeOffSecondsInWeek(leave, weekStart, person.weeklyCapacitySeconds);
      const weekEnd = addDays(weekStart, 6);
      const tracked = rows.tracked
        .filter(
          (entry) =>
            entry.personId === person.id &&
            entry.spentDate >= weekStart &&
            entry.spentDate <= weekEnd,
        )
        .reduce((sum, entry) => sum + entry.roundedSeconds, 0);
      return {
        weekStart,
        plannedSeconds: planned,
        availableSeconds: available,
        trackedSeconds: tracked,
        overAllocated: isOverAllocated(planned, available),
        projects: [...byProject].map(([projectId, plannedSeconds]) => ({
          projectId,
          plannedSeconds,
        })),
        otherScopePlannedSeconds: other,
      };
    });
    return { personId: person.id, name: person.name, weeks };
  });

  const unassigned: ResourceCalendarUnassignedWeek[] = [];
  for (const placeholder of rows.placeholders) {
    if (
      placeholder.projectArchived ||
      !visible.has(placeholder.projectId) ||
      !projectScope(placeholder.projectId)
    )
      continue;
    for (const weekStart of weekStarts) {
      if (allocationCoversWeek(placeholder, weekStart)) {
        unassigned.push({
          weekStart,
          placeholderId: placeholder.id,
          name: placeholder.name,
          projectId: placeholder.projectId,
          plannedSeconds: placeholder.plannedSecondsPerWeek,
        });
      }
    }
  }

  const revision = fnv(
    [
      ...rows.allocations.map((row) => `a${row.id}:${row.revision}`),
      ...rows.placeholders.map((row) => `p${row.id}:${row.revision}`),
    ]
      .sort()
      .join("|"),
  );
  return {
    context,
    view: query.view,
    revision,
    weekStarts,
    people,
    unassigned,
    hasOtherScope,
    nextCursor,
  };
};
