import {
  CalendarAuthorizationError,
  CalendarCursorExpiredError,
  type CalendarSource,
  type CalendarSourceEvent,
  type CalendarSourcePage,
} from "../../src/index.js";

export const sourceEvent = (overrides: Partial<CalendarSourceEvent> = {}): CalendarSourceEvent => ({
  calendarId: "primary",
  eventId: "evt-1",
  occurrence: "",
  summary: "Planning",
  startsAt: "2026-10-20T15:00:00.000Z",
  endsAt: "2026-10-20T16:00:00.000Z",
  allDay: false,
  cancelled: false,
  response: "accepted",
  showAs: "busy",
  version: "v1",
  ...overrides,
});

/** A scripted in-memory source any real adapter's fixtures can be replayed through. */
export class FakeCalendarSource implements CalendarSource {
  readonly provider = "google" as const;
  readonly requests: Array<{ cursor: string | null; page: string | null }> = [];
  expireCursors = false;
  refuseGrant = false;

  constructor(
    private readonly pages: readonly (readonly CalendarSourceEvent[])[],
    private readonly finalCursor = "cursor-2",
  ) {}

  async listEvents(request: { cursor: string | null; page: string | null }): Promise<CalendarSourcePage> {
    this.requests.push({ cursor: request.cursor, page: request.page });
    if (this.refuseGrant) throw new CalendarAuthorizationError();
    if (this.expireCursors && request.cursor !== null) throw new CalendarCursorExpiredError();
    const index = request.page === null ? 0 : Number(request.page);
    const last = index === this.pages.length - 1;
    return {
      events: this.pages[index] ?? [],
      nextPage: last ? null : String(index + 1),
      nextCursor: last ? this.finalCursor : null,
    };
  }
}
