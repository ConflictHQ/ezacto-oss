/**
 * Calendar events, turned into time entries a person can accept (issue 428).
 *
 * The read-from direction, and deliberately only that one. The issue names the
 * reason: this account tracks in `duration` mode and holds 30,684 entries with
 * no start time, so pushing them to a calendar means inventing when they
 * happened -- which #426 already refused to do on screen. Reading is also the
 * only direction where being wrong is not destructive: a bad proposal is
 * declined, where a bad push writes into somebody's real calendar.
 *
 * Nothing here decides anything. A proposal is a suggestion with a reason
 * attached, and a person accepts or discards it. That is what makes the
 * matching allowed to be imperfect.
 *
 * The transport is injected and there is no vendor call in this module, the
 * same posture the other integrations here take. What a calendar is reached
 * through is the entry's business; what an event means is this module's.
 */

/** The shape stored in `time_entries.calendar_event_ref`. */
export interface CalendarEventRef {
  readonly provider: 'google'
  /** The provider's id for the event. Stable across edits to it. */
  readonly eventId: string
  /** Which calendar it came from, because a person has several. */
  readonly calendarId: string
}

export interface CalendarEvent {
  readonly id: string
  readonly calendarId: string
  readonly summary: string | null
  /** RFC 3339. An all-day event has no time and is not proposable. */
  readonly startsAt: string | null
  readonly endsAt: string | null
  /** Declined by this person, so it is not work they did. */
  readonly declined?: boolean
  /** A held slot rather than a meeting. */
  readonly transparent?: boolean
}

export interface ProposedTimeEntry {
  readonly spentDate: string
  readonly seconds: number
  readonly notes: string
  readonly calendarEventRef: CalendarEventRef
}

export type ProposalSkip =
  | 'already_recorded'
  | 'all_day'
  | 'declined'
  | 'free_time'
  | 'zero_length'
  | 'ends_before_it_starts'
  | 'spans_days'

export interface ProposalOutcome {
  readonly proposed: readonly ProposedTimeEntry[]
  /** Every event that produced nothing, and why. A silent drop is a bug report. */
  readonly skipped: readonly { readonly eventId: string; readonly reason: ProposalSkip }[]
}

const secondsBetween = (startsAt: string, endsAt: string): number =>
  Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 1000)

/** The calendar day an event belongs to, from the timestamp it starts at. */
const dayOf = (timestamp: string): string => timestamp.slice(0, 10)

/**
 * Turns events into proposals, skipping the ones that are not work.
 *
 * `recorded` is the set of event ids already carried by a time entry. The same
 * meeting offered twice is the failure this prevents: a person syncs on Friday,
 * accepts, syncs again on Monday, and is offered the week over again.
 */
export const proposeEntriesFromEvents = (input: {
  readonly events: readonly CalendarEvent[]
  readonly recorded: ReadonlySet<string>
}): ProposalOutcome => {
  const proposed: ProposedTimeEntry[] = []
  const skipped: { eventId: string; reason: ProposalSkip }[] = []

  for (const event of input.events) {
    const skip = (reason: ProposalSkip): void => {
      skipped.push({ eventId: event.id, reason })
    }
    if (input.recorded.has(event.id)) {
      skip('already_recorded')
      continue
    }
    if (event.declined === true) {
      // Somebody else's meeting that this person said no to.
      skip('declined')
      continue
    }
    if (event.transparent === true) {
      // Marked free: a held slot, not time spent.
      skip('free_time')
      continue
    }
    if (event.startsAt === null || event.endsAt === null) {
      // An all-day event carries no duration to propose, and guessing one is
      // the invention this direction exists to avoid.
      skip('all_day')
      continue
    }
    const seconds = secondsBetween(event.startsAt, event.endsAt)
    if (seconds < 0) {
      skip('ends_before_it_starts')
      continue
    }
    if (seconds === 0) {
      skip('zero_length')
      continue
    }
    if (dayOf(event.startsAt) !== dayOf(event.endsAt)) {
      // A time entry belongs to one day. Splitting a multi-day event across
      // days would be this module deciding how somebody's week looked.
      skip('spans_days')
      continue
    }
    proposed.push({
      spentDate: dayOf(event.startsAt),
      seconds,
      // The summary is what the person will recognise; an untitled event says
      // so rather than arriving as an empty note they have to decode.
      notes: event.summary?.trim() === '' || event.summary === null
        ? 'Untitled calendar event'
        : event.summary.trim(),
      calendarEventRef: {
        provider: 'google',
        eventId: event.id,
        calendarId: event.calendarId,
      },
    })
  }

  return { proposed, skipped }
}

/** Reads the event id back out of a stored reference, for the dedupe set. */
export const recordedEventId = (reference: unknown): string | null => {
  if (typeof reference !== 'object' || reference === null) return null
  const record = reference as Record<string, unknown>
  return typeof record['eventId'] === 'string' && record['eventId'] !== ''
    ? record['eventId']
    : null
}
