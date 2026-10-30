import { dateInTimeZone, timeInTimeZone } from "./local-day.js";
import { maximumTimeEntryNoteLength } from "./time-entry-note-requirements.js";
import { TrackedResourceInputError } from "./tracked-state.js";

/**
 * A calendar event on its way to becoming a time entry (issue 428).
 *
 * A proposal is a suggestion held beside the timesheet, never in it: it is not
 * a time entry, so it cannot reach a report, a lock or an invoice until a
 * person accepts it. These are the pure rules for that hand-over, so the two
 * organization modes are tested without a database.
 */

export const calendarProviders = ["google", "microsoft"] as const;
export type CalendarProvider = (typeof calendarProviders)[number];

export const calendarProposalStatuses = ["proposed", "accepted", "discarded", "cancelled"] as const;
export type CalendarProposalStatus = (typeof calendarProposalStatuses)[number];

/** What a meeting with no title is called, so the person has something to recognise. */
export const UNTITLED_CALENDAR_EVENT = "Untitled calendar event";

/** The title a proposal is stored under: trimmed, never empty, never longer than a note may be. */
export const calendarProposalTitle = (summary: string | null | undefined): string => {
  const trimmed = (summary ?? "").trim();
  return trimmed === "" ? UNTITLED_CALENDAR_EVENT : trimmed.slice(0, maximumTimeEntryNoteLength);
};

/** The reference an accepted proposal leaves on its time entry. */
export interface CalendarEventReference {
  readonly provider: CalendarProvider;
  readonly event_id: string;
  readonly calendar_id: string;
}

export class CalendarProposalNotFoundError extends Error {
  readonly code = "calendar_proposal_not_found" as const;

  constructor() {
    super("The requested calendar proposal does not exist.");
    this.name = "CalendarProposalNotFoundError";
  }
}

/** Accepting or discarding something that was already decided, or withdrawn by the calendar. */
export class CalendarProposalNotOpenError extends Error {
  readonly code = "proposal_not_open" as const;

  constructor(readonly status: CalendarProposalStatus) {
    super(`This calendar proposal is already ${status}.`);
    this.name = "CalendarProposalNotOpenError";
  }
}

export type CalendarProposalEntryFields =
  | { readonly kind: "duration"; readonly spentDate: string; readonly seconds: number }
  | {
      readonly kind: "start_end";
      readonly spentDate: string;
      readonly startedTime: string;
      readonly endedTime: string;
    };

/**
 * What a proposal becomes in an organization's mode.
 *
 * A `duration` organization records no start times, so the entry carries the
 * event's length and nothing else: filing a start there would invent a fact
 * the organization has chosen not to keep. A `start_end` organization keeps
 * the event's own times, on the wall clock of the person it belongs to. Either
 * way the day is that person's local day for the moment the event began.
 *
 * A start/end entry belongs to one day. An event that runs past local midnight
 * is refused rather than split, because splitting would decide how somebody's
 * week looked; the person can log it as they choose. An event ending exactly
 * at midnight is not past it.
 */
export const calendarProposalEntryFields = (input: {
  readonly mode: "duration" | "start_end";
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
}): CalendarProposalEntryFields => {
  const spentDate = dateInTimeZone(input.startsAt, input.timeZone);
  if (input.mode === "duration") {
    const seconds = Math.round((Date.parse(input.endsAt) - Date.parse(input.startsAt)) / 1000);
    return { kind: "duration", spentDate, seconds };
  }
  const startedTime = timeInTimeZone(input.startsAt, input.timeZone);
  const endedTime = timeInTimeZone(input.endsAt, input.timeZone);
  const endDate = dateInTimeZone(input.endsAt, input.timeZone);
  const endsAtMidnight = endedTime === "00:00" && endDate > spentDate;
  const nextDay = new Date(`${spentDate}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  if (endDate !== spentDate && !(endsAtMidnight && endDate === nextDay.toISOString().slice(0, 10))) {
    throw new TrackedResourceInputError(
      "proposal",
      "spans_days",
      "This event runs past midnight and a start/end entry belongs to one day.",
    );
  }
  // A start/end entry stores minute clocks. Preserve the actual event rather
  // than silently shifting subminute endpoints or changing its elapsed hours.
  const precision = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone, second: "2-digit", fractionalSecondDigits: 3,
  });
  for (const instant of [input.startsAt, input.endsAt]) {
    if (precision.formatToParts(new Date(instant)).some((part) =>
      (part.type === "second" || part.type === "fractionalSecond") && Number(part.value) !== 0)) {
      throw new TrackedResourceInputError(
        "proposal", "subminute_time",
        "This event includes seconds that a minute-based start/end entry cannot preserve.",
      );
    }
  }
  const minuteOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const difference = minuteOfDay(endedTime) - minuteOfDay(startedTime);
  // Match the ordinary entry path's implicit overnight arithmetic, including
  // equal clocks meaning zero rather than an invented full day.
  const wallSeconds = (difference < 0 ? difference + 1440 : difference) * 60;
  if (wallSeconds * 1000 !== Date.parse(input.endsAt) - Date.parse(input.startsAt)) {
    throw new TrackedResourceInputError(
      "proposal", "unrepresentable_time",
      "This event cannot be represented accurately by a minute-based start/end entry.",
    );
  }
  return { kind: "start_end", spentDate, startedTime, endedTime };
};
