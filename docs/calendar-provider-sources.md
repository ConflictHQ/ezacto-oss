# Calendar provider reads (#428)

The Google and Microsoft sources read the connected person's primary calendar.
They expose only the existing `CalendarSource.listEvents` port. The runtime's
OAuth factory supplies an access token through `getAccessToken(signal)`; the
source neither accepts credentials from a browser nor writes provider events.
Consent, refresh-token custody and provider cleanup are separate runtime work.

Google uses expanded event instances, deleted-event reporting and UTC on
`events.list`. The first read sends the chosen window; incremental reads send
the opaque sync token without the incompatible time bounds. Page tokens are
encoded as query values. A 410 lets the sync coordinator restart a full read.
Offsetless event times require an explicit IANA timezone and a unique matching
instant. Daylight-saving gaps and overlaps are refused rather than silently
choosing a different duration.

Microsoft uses the primary `calendarView/delta` endpoint. Every request asks for
immutable event IDs and UTC. Continuations are accepted only for that exact
HTTPS host and path, with no credentials or fragment. Returned continuation
URLs are checked before they can become a stored cursor.

An expanded occurrence's full provider ID is its stable identity. `occurrence`
is empty for these two sources because the ID already distinguishes instances.
This also matches later deletion tombstones that contain only an ID; replacing
the ID with a series ID would lose that correspondence.

Only a successful final page of a full read declares `completeCalendarIds`.
The coordinator then withdraws previously proposed events absent from that
calendar/window. An accepted event receives a source-change flag; its time entry
is untouched. Incremental, failed, oversized and partially paginated reads never
infer absence. Calendars outside the completed set are unaffected.

Reads use a 25-second signal, a 1 MiB response bound, and the coordinator's
existing page/event/action limits. Invalid data fails the pass before its cursor
or proposals commit. Authorization failures require reconnection; transport and
provider errors disclose neither credentials nor provider response bodies.

Verification uses synthetic provider-shaped pages through the actual source
transports, core planner tests, and native SQLite/D1 store tests. It does not
claim live OAuth/provider acceptance or completed Google/Microsoft registration.

Primary references:

- [Google events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Microsoft calendarView delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0)
- [Microsoft immutable event IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
- [Microsoft event representation](https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0)
