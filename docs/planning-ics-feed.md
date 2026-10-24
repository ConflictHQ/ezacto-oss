# Planning ICS feed contract (issue 1194)

Status: contract only. The route, credential table and projection adapter are
not built; they wait on the shared calendar projection (issue 1192). Code:
[`planning-ics.ts`](../packages/core/src/planning-ics.ts). Tests any
implementation must keep green:
[`planning-ics.test.ts`](../packages/core/test/planning-ics.test.ts).

## What a feed is

A read-only, advisory export of the already-authorized planning projection:
allocations, personal time off and organization holidays. It is not two-way
sync, creates no actual time, and adds no provider OAuth scope or remote write.

## Event shape

- One all-day VEVENT per `PlanningFeedItem`: `DTSTART;VALUE=DATE`, and
  `DTEND;VALUE=DATE` is the day after the inclusive end date (exclusive).
  Dates stay floating; nothing is converted through a timezone, and no timed
  busy block is invented. `TRANSP:TRANSPARENT`, with a fixed advisory
  DESCRIPTION.
- `UID` is `<key>@<instance host>`. `key` is opaque, one per resource and week
  (or leave span), and never contains a name or email. Label edits do not change
  the UID.
- `SEQUENCE` is the item `revision`, monotonic per key.
- Removal: the projection supplies a tombstone (key, last span, revision above
  the last live one). It renders as `STATUS:CANCELLED` with only the kind as
  label. A live item with a revision at or above the tombstone wins (re-creation).
- Output is deterministic (sorted, DTSTAMP from `generatedAt`), CRLF, folded at
  75 octets without splitting a code point; TEXT is escaped and every control or
  line-separator character is neutralized so a label cannot inject a property.

## Fields exposed (the "what does this subscription show" screen)

Date span, kind label (Planned, Time off, Holiday), and the minimized SUMMARY the
projection supplies. Never money, rates, private notes or leave reasons. The
projection, not the serializer, chooses SUMMARY; the serializer only escapes it.

## Credentials

- `PlanningFeedCredential`: owner, scope (`self` by default, `project` or `team`
  only with an explicit permitted grant), `tokenHash`, `issuedAt`, `expiresAt`,
  `revokedAt`.
- Token: `ezpf_` plus 32 CSPRNG bytes as base64url. Only `sha256` hex is stored.
  Shown once at issue; rotation issues a new row and revokes the old one.
- Every request re-reads owner status and current permission for the scope
  (`evaluatePlanningFeedAccess`). Revoked, expired, owner inactive and scope
  lost all deny. All denials look identical to the client (404, empty body).
  The reason goes to the audit log only.
- Authenticated download uses the normal session and the same projection; it
  needs no credential row.
- Account closure deletes the owner's credential rows (add to the account
  closure inventory when built).
- Headers on every feed response (`planningFeedResponseHeaders`):
  `cache-control: private, no-store`, `referrer-policy: no-referrer`,
  `x-robots-tag: noindex`. Rate and range limits apply per credential.

## Open for the implementation (not decided here)

Where the token travels in the URL (see the decision on the issue), lifetime
default and maximum, and the owned disposable calendar-client reload
demonstration required before any availability claim.
