import { reminderDays, type ReminderDay } from "./team.js";

/**
 * Time reminders and timesheet-submission reminders (issue 935): when one is
 * due for somebody, and what it says. Pure, so the schedule's edge cases are
 * tested without a database or a clock.
 *
 * Every question here is asked in the *person's* local time. A reminder at
 * 17:00 that arrives at 17:00 in the sender's zone is a reminder at midnight
 * for somebody in Warsaw.
 */

/** How long after its time a reminder may still go out. A sweep later than this has missed it. */
export const REMINDER_WINDOW_MINUTES = 120;

/** Whether a zone is one this runtime's calendar can use. */
export const usableTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
};

/**
 * The zone a person's days are kept in: their own, then the organization's.
 * A person who never set one carries the column default, 'UTC', and defers to
 * the organization; so does one whose imported zone is a display name
 * ("Central America") the calendar refuses. The organization's zone is the
 * floor, and 'UTC' the floor under that.
 */
export const effectiveTimeZone = (personZone: string | null, organizationZone: string): string => {
  if (personZone !== null && personZone !== "UTC" && usableTimeZone(personZone)) return personZone;
  return usableTimeZone(organizationZone) ? organizationZone : "UTC";
};

export interface LocalMoment {
  /** `YYYY-MM-DD` in the zone. */
  readonly date: string;
  /** `HH:MM`, 24-hour, in the zone. */
  readonly time: string;
  readonly weekday: ReminderDay;
}

/** What an instant reads as on a wall in a zone. */
export const localMoment = (instant: string, zone: string): LocalMoment => {
  const at = new Date(instant);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" })
    .format(at)
    .toLowerCase() as ReminderDay;
  return { date, time: time === "24:00" ? "00:00" : time, weekday };
};

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export type ReminderTiming = "not_yet" | "due" | "late";

/**
 * Whether a reminder set for `at` has come due, as the wall clock reads it.
 * `late` is a sweep that arrives after the window: it is recorded as a skip
 * rather than sent, because a reminder to log today's time that lands at
 * midnight is worse than none.
 */
export const reminderTiming = (local: Pick<LocalMoment, "time">, at: string): ReminderTiming => {
  const elapsed = minutesOf(local.time) - minutesOf(at);
  if (elapsed < 0) return "not_yet";
  return elapsed > REMINDER_WINDOW_MINUTES ? "late" : "due";
};

/**
 * What a person is usually expected to track in a day they are reminded on:
 * their weekly capacity over the days they chose. Zero capacity means nobody
 * expects anything of them, so the bar is "anything at all".
 */
export const usualDaySeconds = (weeklyCapacitySeconds: number, reminderDayCount: number): number =>
  weeklyCapacitySeconds <= 0 || reminderDayCount <= 0
    ? 0
    : Math.floor(weeklyCapacitySeconds / reminderDayCount);

/** Whether somebody has tracked less than their usual day, and so is worth a reminder. */
export const trackedLessThanUsual = (trackedSeconds: number, usualSeconds: number): boolean =>
  usualSeconds <= 0 ? trackedSeconds <= 0 : trackedSeconds < usualSeconds;

const dayIndex: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const shift = (date: string, days: number): string => {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

export interface ReminderWeek {
  readonly start: string;
  readonly end: string;
}

/**
 * The week a submission reminder is about, when it goes out on `local`.
 *
 * Mid-to-late week it is the week now ending. In the first four days of a week
 * the work worth chasing is last week's: a "Monday 09:00" schedule reminds
 * about the week that finished over the weekend, not the one that has barely
 * begun. Weeks start on the organization's chosen day.
 */
export const submissionReminderWeek = (
  local: Pick<LocalMoment, "date" | "weekday">,
  weekStartDay: "saturday" | "sunday" | "monday",
): ReminderWeek => {
  const sinceStart = (dayIndex[local.weekday]! - dayIndex[weekStartDay]! + 7) % 7;
  const thisWeekStart = shift(local.date, -sinceStart);
  const start = sinceStart <= 3 ? shift(thisWeekStart, -7) : thisWeekStart;
  return { start, end: shift(start, 6) };
};

export const isReminderDay = (value: unknown): value is ReminderDay =>
  typeof value === "string" && (reminderDays as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// The messages
// ---------------------------------------------------------------------------

const dayName = (date: string): string =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00.000Z`),
  );

const rangeText = (week: ReminderWeek): string =>
  `${dayName(week.start)} to ${dayName(week.end)}`;

const hoursText = (seconds: number): string =>
  `${(seconds / 3600).toLocaleString("en-US", { maximumFractionDigits: 2 })} hours`;

export interface ReminderLinks {
  /** The timesheet, where the time is logged or submitted. */
  readonly timesheet: string;
  /** Settings › User, where the reminders are changed or switched off. */
  readonly preferences: string;
}

const footer = (links: ReminderLinks, what: string): string =>
  `You are receiving this because ${what}. Change or switch it off in your settings: ${links.preferences}`;

export const composeDailyTimeReminder = (input: {
  readonly companyName: string;
  readonly firstName: string;
  readonly date: string;
  readonly trackedSeconds: number;
  readonly usualSeconds: number;
  readonly links: ReminderLinks;
}): { readonly subject: string; readonly text: string } => ({
  subject: `Time reminder: log your hours for ${dayName(input.date)}`,
  text: [
    `Hi ${input.firstName},`,
    "",
    input.trackedSeconds <= 0
      ? `You have not logged any time for ${dayName(input.date)} yet.`
      : `You have logged ${hoursText(input.trackedSeconds)} for ${dayName(input.date)}, short of your usual ${hoursText(input.usualSeconds)}.`,
    "",
    `Log your time: ${input.links.timesheet}`,
    "",
    footer(input.links, `${input.companyName} sends a daily time reminder on the days you chose`),
  ].join("\n"),
});

export const composeSubmissionReminder = (input: {
  readonly companyName: string;
  readonly firstName: string;
  readonly week: ReminderWeek;
  readonly links: ReminderLinks;
}): { readonly subject: string; readonly text: string } => ({
  subject: `Timesheet reminder: submit your week of ${dayName(input.week.start)}`,
  text: [
    `Hi ${input.firstName},`,
    "",
    `Your time for ${rangeText(input.week)} has not been submitted for approval yet.`,
    "",
    `Review and submit it: ${input.links.timesheet}`,
    "",
    footer(input.links, `${input.companyName} reminds everyone to submit their week`),
  ].join("\n"),
});

export const composeAutoApprovalWarning = (input: {
  readonly companyName: string;
  readonly firstName: string;
  readonly week: ReminderWeek;
  /** When it will be approved, on the person's own wall clock. */
  readonly deadline: { readonly date: string; readonly time: string; readonly zone: string };
  readonly links: ReminderLinks;
}): { readonly subject: string; readonly text: string } => ({
  subject: `Timesheet notice: your week of ${dayName(input.week.start)} will be approved automatically`,
  text: [
    `Hi ${input.firstName},`,
    "",
    `Your submitted time for ${rangeText(input.week)} will be approved automatically on ${dayName(input.deadline.date)} at ${input.deadline.time} (${input.deadline.zone}) unless an approver decides on it first.`,
    "",
    `If something in it needs changing, withdraw the week from your timesheet before then: ${input.links.timesheet}`,
    "",
    footer(input.links, `${input.companyName} approves timesheets automatically after a review window`),
  ].join("\n"),
});

export const composeSubmissionDigest = (input: {
  readonly companyName: string;
  readonly firstName: string;
  readonly week: ReminderWeek;
  readonly people: readonly string[];
  readonly links: ReminderLinks;
}): { readonly subject: string; readonly text: string } => ({
  subject: `Timesheet digest: ${String(input.people.length)} ${input.people.length === 1 ? "person has" : "people have"} not submitted`,
  text: [
    `Hi ${input.firstName},`,
    "",
    `These people have time for ${rangeText(input.week)} that has not been submitted:`,
    "",
    ...input.people.map((name) => `- ${name}`),
    "",
    footer(input.links, `you approve timesheets and have the weekly digest on at ${input.companyName}`),
  ].join("\n"),
});
