import { TrackedResourceInputError } from "./tracked-state.js";

/**
 * Resource planning (issue 1007, slices 1 and 2): planned hours per week for a
 * person on a project, over a range of dates.
 *
 * A plan is not work. It lives in its own table and is never a time entry, a
 * billable amount or an invoice line; the capacity view only sets it beside
 * what was tracked. These are the pure rules, so they are tested without a
 * database.
 *
 * Everything here is a plain local calendar date (`YYYY-MM-DD`). Planned hours
 * carry no time zone, so a week is the same seven days for everyone.
 */

export type AllocationWeekStartDay = "saturday" | "sunday" | "monday";

/** A week has 168 hours; planning more than that for one person is a typo. */
export const maximumAllocationSecondsPerWeek = 168 * 3_600;

/** The widest range the capacity view answers for in one request. */
export const maximumCapacityWeeks = 53;

export class AllocationNotFoundError extends Error {
  readonly code = "allocation_not_found" as const;

  constructor() {
    super("The requested allocation does not exist.");
    this.name = "AllocationNotFoundError";
  }
}

/** Two plans for the same person on the same project cover the same week. */
export class AllocationOverlapError extends Error {
  readonly code = "allocation_overlap" as const;

  constructor() {
    super("This person already has an allocation on this project that covers some of these dates.");
    this.name = "AllocationOverlapError";
  }
}

/** The allocation was changed by someone else since it was read. */
export class AllocationConflictError extends Error {
  readonly code = "allocation_changed" as const;

  constructor() {
    super("The allocation changed while this request was being made. Read it again and retry.");
    this.name = "AllocationConflictError";
  }
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isAllocationDate = (value: string): boolean => {
  const match = datePattern.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
};

export const addDays = (date: string, days: number): string => {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

const weekdayIndex = { sunday: 0, monday: 1, saturday: 6 } as const;

/** The first day of the week holding `date`, on the organization's chosen week start. */
export const weekStartOf = (date: string, weekStartDay: AllocationWeekStartDay): string => {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday - weekdayIndex[weekStartDay] + 7) % 7));
};

/**
 * The week starts from the week holding `from` through the week holding `to`.
 * Throws when the range is backwards or wider than a request may ask for.
 */
export const capacityWeeks = (
  from: string,
  to: string,
  weekStartDay: AllocationWeekStartDay,
): string[] => {
  if (from > to) {
    throw new TrackedResourceInputError("to", "invalid_range", "to must not precede from");
  }
  const last = weekStartOf(to, weekStartDay);
  const weeks: string[] = [];
  for (let week = weekStartOf(from, weekStartDay); week <= last; week = addDays(week, 7)) {
    if (weeks.length === maximumCapacityWeeks) {
      throw new TrackedResourceInputError(
        "to",
        "range_too_wide",
        `the range may cover at most ${maximumCapacityWeeks} weeks`,
      );
    }
    weeks.push(week);
  }
  return weeks;
};

/** Whether the allocation touches the seven days beginning `weekStart`. */
export const allocationCoversWeek = (
  allocation: { readonly startDate: string; readonly endDate: string },
  weekStart: string,
): boolean => allocation.startDate <= addDays(weekStart, 6) && allocation.endDate >= weekStart;

export interface AllocationFields {
  readonly startDate: string;
  readonly endDate: string;
  readonly plannedSecondsPerWeek: number;
}

/** The shape rules that need no database. Throws the first problem found. */
export const assertAllocationFields = (fields: Readonly<AllocationFields>): void => {
  for (const field of ["startDate", "endDate"] as const) {
    if (!isAllocationDate(fields[field])) {
      throw new TrackedResourceInputError(
        field === "startDate" ? "start_date" : "end_date",
        "invalid_date",
        "must be a real canonical YYYY-MM-DD date",
      );
    }
  }
  if (fields.endDate < fields.startDate) {
    throw new TrackedResourceInputError(
      "end_date",
      "invalid_range",
      "end_date must not precede start_date",
    );
  }
  if (
    !Number.isSafeInteger(fields.plannedSecondsPerWeek) ||
    fields.plannedSecondsPerWeek < 1 ||
    fields.plannedSecondsPerWeek > maximumAllocationSecondsPerWeek
  ) {
    throw new TrackedResourceInputError(
      "planned_seconds_per_week",
      "invalid_integer",
      `planned_seconds_per_week must be between 1 and ${maximumAllocationSecondsPerWeek}`,
    );
  }
};

/**
 * Over-allocated means more is planned than the person's weekly capacity. It is
 * a flag for a reader, never a refusal: a plan that overshoots is information.
 */
export const isOverAllocated = (plannedSeconds: number, capacitySeconds: number): boolean =>
  plannedSeconds > capacitySeconds;
