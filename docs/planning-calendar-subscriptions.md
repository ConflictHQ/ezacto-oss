# Advisory planning calendar subscriptions

Capacity → Calendar subscriptions publishes the same authorized weekly planning
projection used by the resource calendar. The default is **My planning**, without
names. A management user can explicitly choose the current project or their
managed team. The saved scope and date range stay fixed until a new subscription
is issued.

The calendar contains all-day, transparent advisory entries for planned hours,
available capacity, and permitted unassigned demand. It does not create timed
appointments or actual time. Every touched week receives the full weekly planned
amount; partial-day leave only changes the availability amount. Person and role
names are included only when selected. Rates, money, work notes, tracked time,
and leave reasons never enter this feed.

Create subscription shows a URL, a username, and a separate random password once.
Use a calendar client that supports HTTP Basic authentication for ICS
subscriptions. HTTPS is required outside loopback development. The URL contains no credential. Do not insert the username or
password into the URL. Authenticated downloads also work through the application.
Subscriptions expire after 30 days by default; API issuance can request at most
90 days. At most 20 current subscriptions per user can exist.

Rotate password immediately replaces the credential, extends expiry by 30 days,
and preserves event UIDs and revision history. Revoke subscription immediately
stops future access. A calendar client may retain information it already
downloaded. Owner inactivity, account closure, changed authority, and restoring a
database into a new incarnation also prevent old credentials from reading data.
If authority changed, create a new explicitly scoped subscription.

The server checks owner and scope on each request, refuses incomplete or
oversized projections, and commits reconciliation only against the exact source
revision that was read. Successful, denied and rate-limited feed responses are
private/no-store. Credentials are hashed at rest; no password appears in a path,
query string, cache validator or event UID. There are at most 60 accepted reads
per credential per minute. The projection supports at most 2,000 live/cancelled
events and 1 MB of reconciliation metadata; narrow the range or issue a new
subscription if that retained history is exhausted.

Source changes retain opaque UIDs and increase RFC 5545 SEQUENCE. Removed source
facts produce cancellation events with no retained private labels. Restore
changes the credential incarnation while keeping event identifiers stable.

## Verification

Core fixtures use ical.js to parse Unicode, folding, escaping, all-day exclusive
end dates, stable identities, revisions and cancellations. SQLite and D1 tests
cover current authority, ownership, expiry, credential rotation, source races,
rate/range bounds and account closure. HTTP tests verify native sessions and
separate Basic credentials, no URL credentials, no-store headers and empty denied
responses. UI fixtures verify explicit scope, one-time secrets, busy controls and
session cancellation.

Actual client subscription/reload evidence is recorded separately; no named
calendar-client compatibility is claimed by parser tests alone.

### Owned client acceptance — 2026-10-26

[Recorded evidence](evidence/1194-calendar-client.json) covers Thunderbird
158.0.1 on macOS 26.5.2 using a disposable profile and synthetic local data. An
actual authenticated subscription displayed all-day weekly plans and availability;
reload changed 3h to 4h under the same full UID and advanced SEQUENCE. Source
deletion produced a cancelled “Removed advisory information” tombstone. Revocation
made the next client request return empty HTTP 404. Thunderbird retained its
previously cached tombstone and availability after denial; revocation is not a
remote cache purge.

The receipt identifies the tested compiled service, API and serializer hashes.
This is local client compatibility evidence, not a production deployment test.
It does not establish Google Calendar or Outlook support.
