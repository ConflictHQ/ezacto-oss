/**
 * The calendar date an instant falls on, in a named timezone (issue 651).
 *
 * A running timer is filed against "today", and today is the operator's today,
 * not UTC's. West of UTC those differ every evening: at 23:14 on a Saturday in
 * UTC-6 the UTC date is already Sunday, so an evening session lands on the next
 * day -- and a Sunday-evening session lands in the next week's timesheet
 * entirely.
 *
 * `en-CA` because it formats as YYYY-MM-DD, which is the shape stored
 * everywhere here. An invalid zone throws rather than silently falling back to
 * UTC, because falling back is the bug this exists to fix.
 */
export const dateInTimeZone = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));

/** The wall-clock time an instant shows in a named timezone, as HH:mm. */
export const timeInTimeZone = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
