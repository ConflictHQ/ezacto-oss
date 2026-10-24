import type { CalendarProvider } from "./calendar-proposal.js";

/**
 * The provider-neutral calendar sync contract (issue 428, slice 2).
 *
 * Contract only: no network, no token, no storage. A real adapter (Google
 * Calendar, Microsoft Graph) implements `CalendarSource`; the sync rules here
 * decide what a page of events does to proposals. Read-only by construction:
 * the port has no write method, so push and two-way sync cannot be added by
 * accident.
 *
 * Invariants any adapter and any store must keep:
 * - Identity is (provider, calendarId, eventId, occurrence). Adapters must use
 *   an id that survives edits (Graph: the immutable id, not the default id) and
 *   give each instance of a recurring event its own `occurrence`.
 * - A proposal is never a time entry. Sync only ever creates, updates or
 *   cancels proposals; it never touches an accepted entry.
 * - A decided proposal (accepted or discarded) is never reopened or
 *   re-proposed by a later sync.
 */

export interface CalendarSourceEvent {
  readonly calendarId: string;
  readonly eventId: string;
  /** Tells recurring instances apart; the empty string for a one-off event. */
  readonly occurrence: string;
  readonly summary: string | null;
  /** UTC instants. Ignored for all-day events, which carry no interval. */
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  /** The provider withdrew the event (deleted or cancelled). */
  readonly cancelled: boolean;
  readonly response: "accepted" | "tentative" | "declined" | "none" | "organizer";
  readonly showAs: "busy" | "free" | "oof";
  /** The provider's edit stamp (etag or last-modified). */
  readonly version: string;
}

export interface CalendarSyncWindow {
  /** UTC instants, start inclusive, end exclusive. */
  readonly from: string;
  readonly to: string;
}

export interface CalendarSourcePage {
  readonly events: readonly CalendarSourceEvent[];
  /** Present when more pages remain in this listing. */
  readonly nextPage: string | null;
  /** Present on the final page: pass it back to resume incrementally. */
  readonly nextCursor: string | null;
}

export interface CalendarSource {
  readonly provider: CalendarProvider;
  listEvents(request: {
    readonly window: CalendarSyncWindow;
    /** The cursor from the last completed sync, or null for a full read of the window. */
    readonly cursor: string | null;
    readonly page: string | null;
  }): Promise<CalendarSourcePage>;
}

/** The provider no longer honours the cursor (Google 410 Gone). The caller re-reads the window in full. */
export class CalendarCursorExpiredError extends Error {
  readonly code = "calendar_cursor_expired" as const;
  constructor() {
    super("The calendar sync cursor is no longer valid.");
    this.name = "CalendarCursorExpiredError";
  }
}

/** The provider refused the stored grant (401/403, revoked, consent withdrawn). Retrying will not help. */
export class CalendarAuthorizationError extends Error {
  readonly code = "calendar_needs_reauth" as const;
  constructor() {
    super("The calendar connection needs the person to reconnect.");
    this.name = "CalendarAuthorizationError";
  }
}

export const calendarConnectionStatuses = ["connected", "needs_reauth"] as const;
export type CalendarConnectionStatus = (typeof calendarConnectionStatuses)[number];

export const defaultCalendarWindowDays = { past: 14, future: 0 } as const;
export const maximumCalendarWindowDays = 90;

const dayMilliseconds = 86_400_000;

/** The bounded window to read. Each side is clamped to 0..maximumCalendarWindowDays. */
export const calendarSyncWindow = (
  now: string,
  days: { readonly past?: number; readonly future?: number } = {},
): CalendarSyncWindow => {
  const clamp = (value: number | undefined, fallback: number) =>
    Math.min(Math.max(Math.trunc(value ?? fallback), 0), maximumCalendarWindowDays);
  const at = Date.parse(now);
  return {
    from: new Date(at - clamp(days.past, defaultCalendarWindowDays.past) * dayMilliseconds).toISOString(),
    to: new Date(at + clamp(days.future, defaultCalendarWindowDays.future) * dayMilliseconds).toISOString(),
  };
};

/**
 * Whether an event is worth proposing. Default: a timed meeting the person
 * attends (accepted, organizer or tentative-free of decline), busy, not
 * all-day, not declined, with a positive length. Widening is the caller's
 * choice and is not modelled here.
 */
export const isCalendarEventEligible = (event: CalendarSourceEvent): boolean =>
  !event.allDay &&
  event.response !== "declined" &&
  event.showAs === "busy" &&
  Date.parse(event.endsAt) > Date.parse(event.startsAt);

/** What the store already holds for one event identity. */
export interface CalendarProposalSnapshot {
  readonly status: "proposed" | "accepted" | "discarded" | "cancelled";
  readonly version: string | null;
}

export type CalendarSyncAction =
  | { readonly kind: "propose"; readonly event: CalendarSourceEvent }
  | { readonly kind: "update"; readonly event: CalendarSourceEvent }
  /** Edited after acceptance: leave the entry alone, mark the proposal so the person can see it changed. */
  | { readonly kind: "flag_changed"; readonly event: CalendarSourceEvent }
  | { readonly kind: "cancel"; readonly event: CalendarSourceEvent };

export const calendarEventKey = (event: Pick<CalendarSourceEvent, "calendarId" | "eventId" | "occurrence">): string =>
  JSON.stringify([event.calendarId, event.eventId, event.occurrence]);

/**
 * Turns events into proposal actions. Pure and idempotent: planning the same
 * events against the state that results from applying the plan yields an empty
 * plan.
 */
export const planCalendarSync = (
  events: readonly CalendarSourceEvent[],
  existing: ReadonlyMap<string, CalendarProposalSnapshot>,
): CalendarSyncAction[] => {
  const actions: CalendarSyncAction[] = [];
  for (const event of events) {
    const held = existing.get(calendarEventKey(event));
    if (event.cancelled) {
      // Withdrawn events cancel what is still open; an accepted entry is never deleted.
      if (held?.status === "proposed") actions.push({ kind: "cancel", event });
      continue;
    }
    if (held === undefined) {
      if (isCalendarEventEligible(event)) actions.push({ kind: "propose", event });
      continue;
    }
    if (held.version === event.version) continue;
    if (held.status === "proposed") {
      // An edit can make a proposal ineligible (declined, moved to all-day): withdraw it.
      actions.push(isCalendarEventEligible(event) ? { kind: "update", event } : { kind: "cancel", event });
    } else if (held.status === "accepted") {
      actions.push({ kind: "flag_changed", event });
    }
    // discarded and cancelled stay as they are: a decision is final.
  }
  return actions;
};

export type CalendarSyncOutcome =
  | { readonly status: "connected"; readonly cursor: string | null; readonly actions: CalendarSyncAction[] }
  | { readonly status: "needs_reauth"; readonly cursor: string | null; readonly actions: [] };

/**
 * One sync pass: page through the window and plan. Expired cursor means read
 * the whole window again; a refused grant stops with `needs_reauth` and keeps
 * the old cursor. No other error is swallowed, so the caller can retry later
 * from the same cursor.
 */
export const runCalendarSync = async (input: {
  readonly source: CalendarSource;
  readonly now: string;
  readonly days?: { readonly past?: number; readonly future?: number };
  readonly cursor: string | null;
  readonly existing: ReadonlyMap<string, CalendarProposalSnapshot>;
}): Promise<CalendarSyncOutcome> => {
  const window = calendarSyncWindow(input.now, input.days);
  const read = async (cursor: string | null) => {
    const events: CalendarSourceEvent[] = [];
    let page: string | null = null;
    let nextCursor: string | null;
    do {
      const result: CalendarSourcePage = await input.source.listEvents({ window, cursor, page });
      events.push(...result.events);
      page = result.nextPage;
      nextCursor = result.nextCursor;
    } while (page !== null);
    return { events, nextCursor };
  };
  try {
    let result;
    try {
      result = await read(input.cursor);
    } catch (error) {
      if (!(error instanceof CalendarCursorExpiredError)) throw error;
      result = await read(null);
    }
    return {
      status: "connected",
      cursor: result.nextCursor,
      actions: planCalendarSync(result.events, input.existing),
    };
  } catch (error) {
    if (error instanceof CalendarAuthorizationError) {
      return { status: "needs_reauth", cursor: input.cursor, actions: [] };
    }
    throw error;
  }
};
