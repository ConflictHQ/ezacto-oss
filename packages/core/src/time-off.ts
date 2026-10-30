import { TrackedResourceInputError } from "./tracked-state.js";
import { addDays, isAllocationDate } from "./allocation.js";

/**
 * Time off (issue 1007, slice 3): days a person is away, entered by an
 * administrator, that reduce what the capacity view counts as available.
 *
 * Time off is not work and not leave management. There is no request or
 * approval step, it never touches `time_entries`, and a week planned beyond
 * the reduced capacity is still only flagged. Dates are plain local calendar
 * days, like allocations.
 */

export const timeOffKinds = ["vacation", "sick", "holiday", "other"] as const;
export type TimeOffKind = (typeof timeOffKinds)[number];

export const maximumTimeOffSecondsPerDay = 24 * 3_600;

/** Capacity is spread over Monday to Friday; weekends carry no capacity to remove. */
export const capacityDaysPerWeek = 5;

export class TimeOffNotFoundError extends Error {
  readonly code = "time_off_not_found" as const;

  constructor() {
    super("The requested time off does not exist.");
    this.name = "TimeOffNotFoundError";
  }
}

/** Overlapping entries for one person would take the same day off twice. */
export class TimeOffOverlapError extends Error {
  readonly code = "time_off_overlap" as const;

  constructor() {
    super("This person already has time off that covers some of these dates.");
    this.name = "TimeOffOverlapError";
  }
}

export class TimeOffConflictError extends Error {
  readonly code = "time_off_changed" as const;

  constructor(readonly currentVersion?: number, readonly current?: unknown) {
    super("The time off changed while this request was being made. Read it again and retry.");
    this.name = "TimeOffConflictError";
  }
}

export interface TimeOffFields {
  readonly startDate: string;
  readonly endDate: string;
  readonly kind: string;
  /** Seconds away on each working day; null is a whole day. */
  readonly secondsPerDay: number | null;
}

/** The shape rules that need no database. Throws the first problem found. */
export const assertTimeOffFields = (fields: Readonly<TimeOffFields>): void => {
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
  if (!(timeOffKinds as readonly string[]).includes(fields.kind)) {
    throw new TrackedResourceInputError(
      "kind",
      "unsupported",
      `kind must be one of ${timeOffKinds.join(", ")}`,
    );
  }
  if (
    fields.secondsPerDay !== null &&
    (!Number.isSafeInteger(fields.secondsPerDay) ||
      fields.secondsPerDay < 1 ||
      fields.secondsPerDay > maximumTimeOffSecondsPerDay)
  ) {
    throw new TrackedResourceInputError(
      "seconds_per_day",
      "invalid_integer",
      `seconds_per_day must be null or between 1 and ${maximumTimeOffSecondsPerDay}`,
    );
  }
};

/**
 * Seconds of capacity the person's time off removes from the seven days
 * beginning `weekStart`. Only Monday to Friday count. A whole day removes a
 * fifth of the weekly capacity. The total never exceeds the capacity, so
 * available capacity is never negative. Overlapping personal leave and organization holidays remove only the larger
 * daily amount; the same day is never subtracted twice.
 */
export const timeOffSecondsInWeek = (
  entries: readonly {
    readonly startDate: string;
    readonly endDate: string;
    readonly secondsPerDay: number | null;
  }[],
  weekStart: string,
  weeklyCapacitySeconds: number,
): number => {
  const wholeDay = Math.round(weeklyCapacitySeconds / capacityDaysPerWeek);
  let total = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addDays(weekStart, offset);
    const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    let away = 0;
    for (const entry of entries) {
      if (entry.startDate <= day && entry.endDate >= day) away = Math.max(away, entry.secondsPerDay ?? wholeDay);
    }
    total += away;
  }
  return Math.min(total, weeklyCapacitySeconds);
};
