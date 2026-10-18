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

/**
 * The instant a calendar day begins in a named timezone, as a UTC timestamp
 * with milliseconds -- the shape every `created_at` is stored in, so a day
 * becomes a plain string comparison against the log (issue 929).
 *
 * "From the 8th" on a log of UTC instants is not `2026-09-08T00:00:00Z`: for an
 * operator in UTC-6 the 8th began six hours later, and an email sent that
 * evening belongs to the 8th, not to the 9th. The offset is read at the guess
 * and again at the corrected instant, which settles a day whose start sits on
 * the far side of a daylight-saving change.
 */
export const startOfDayInTimeZone = (date: string, timeZone: string): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (match === null) throw new RangeError("a calendar day must be YYYY-MM-DD");
  const wallClockAsUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(wallClockAsUtc).toISOString().slice(0, 10) !== date) {
    throw new RangeError("a calendar day must be a real date");
  }
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(instant));
    const field = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value);
    const shown = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
      field("second"),
    );
    return shown - Math.floor(instant / 1000) * 1000;
  };
  const first = wallClockAsUtc - offsetAt(wallClockAsUtc);
  return new Date(wallClockAsUtc - offsetAt(first)).toISOString();
};
