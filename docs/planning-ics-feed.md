# Planning ICS feed contract (issue 1194)

The native implementation is `packages/db/src/calendar-feeds.ts`, using the
shared resource-calendar projection and the reconciliation model in
`packages/core/src/resource-calendar-feed.ts`. Operational instructions and
owned-client evidence are in [Planning calendar subscriptions](planning-calendar-subscriptions.md).
The older pure `planning-ics.ts` exports remain compatible; the native renderer
reuses their TEXT escaping and UTF-8 folding primitives.

## Projection and events

- Export only already-authorized weekly planning/availability. Self is the UI
  default; project/team issuance requires an explicitly selected permitted
  management scope. Never export tracked time, money, rates, private notes or
  leave reasons. Names are opt-in.
- Every event is advisory, private and transparent, with floating all-day dates.
  `DTEND` is exclusive. Weekly plans use the entire touched organization week;
  partial-day leave changes available hours rather than inventing appointments.
- UIDs are opaque HMAC identities under a random per-feed namespace, stable
  across refresh and credential rotation. Native state tracks nonnegative
  signed-32-bit `SEQUENCE` values, preserving monotonic change/cancel/reappearance.
- Removed facts remain as cancelled tombstones without private labels.
  Incomplete projections are refused. Limits are 2,000 live/cancelled events,
  1 MB reconciliation metadata, and at most 365 selected calendar dates.
- Reconciliation commits only with the same source revision, credential
  generation, owner authority and instance incarnation used for its read.

## Credentials and lifecycle

- A native session issues an owned feed and a separate random 256-bit password.
  Only a keyed hash is stored. Public subscription uses HTTP Basic: a nonsecret
  feed ID as username, password only in Authorization. No credential appears in
  a path, query, referrer, cache validator or UID. HTTPS is required except on
  loopback development hosts.
- Lifetime defaults to 30 days, maximum 90. Rotation replaces the password while
  retaining the feed's UID namespace/history. Revocation immediately stops reads.
  Owner inactivity, scope/authority loss, account closure and restored database
  incarnations also invalidate old reads.
- Authenticated download reads the same owned feed without a subscription
  password. At most 20 current feeds can be issued per user; current feeds are
  listed before revoked/expired history so their controls remain reachable.
- Every feed response is `private, no-store`, `no-referrer` and `noindex`.
  Invalid/revoked access returns no protected content; 60 accepted reads per
  credential per minute is the current rate ceiling.
- Revocation prevents new reads; it cannot erase a calendar client's prior cache.
  Thunderbird's tested cancellation display is an explicit removed-information
  tombstone. No Google Calendar/Outlook compatibility is implied.
