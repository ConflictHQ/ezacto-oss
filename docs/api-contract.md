# Native API chassis

`@ezacto/api` owns the runtime-portable Hono chassis mounted at `/api/v1` by both
Worker and container entries. Resource stories add routes through its installer;
they do not replace the error, pagination, request-id, or serialization boundaries.

## Errors and request ids

Every response carries a server-generated `x-request-id`. Incoming values are not
trusted or reflected. Every error response is JSON with one stable shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request contains invalid fields.",
    "fields": [
      { "field": "name", "code": "required", "message": "name is required" }
    ]
  },
  "request_id": "11111111-2222-3333-4444-555555555555"
}
```

`error.code` and each field code are lowercase machine identifiers. `fields` is
always an array and every `422` has at least one entry. All `5xx` failures—including
deliberately raised ones—use the generic `internal_error` body; exception text is
never placed on the wire. Errors are never cached.

The chassis enforces `Cache-Control: no-store` on every `/api/v1` response,
including errors and mutations. It removes cache validators and refuses 304
responses, so clients cannot reuse a representation from an earlier privileged
identity. Public paths such as `/openapi/v1.json` retain their own caching policy.

JSON readers enforce a byte ceiling while consuming the stream (1 MiB by default),
even if `Content-Length` is absent or falsely small. Oversized bodies receive the
same envelope with `413 payload_too_large`.

## Retries and `Idempotency-Key`

Any write (POST, PUT, PATCH or DELETE) under the data paths may carry an
`Idempotency-Key`.

- **The key.** 1 to 255 visible ASCII characters. Make a fresh random UUID for
  each logical write, before its first attempt, and send it unchanged on every
  retry of that write.
- **The first attempt** runs, and its response is kept for 24 hours.
- **A retry** gets that response back with `idempotent-replayed: true`.
  Nothing runs again. The retry may come after a dropped connection, a lost
  response, or a restart of the client.

Every data answer carries `Idempotency-Key-Lifetime: 86400`. That is how a
client knows it may retry a write here; an instance that does not send it gets
no blind retry of a write.

A key binds the request it first carried: the method, the path and query, the
content type and the body. For a multipart upload it binds the parts, not the
boundary.

Fingerprinting stops streamed requests at the largest supported upload size
(25 MiB plus 64 KiB multipart overhead), including requests with absent or false
`Content-Length`. Each route still enforces its own smaller limit. Responses
above the 1 MiB replay limit stream to the original caller without buffering the
entire response; their claim is retained and subsequent retries receive `409`.

The stored answer goes back only to a retry that carries the same credentials
as the first attempt: the bearer token, the session cookie or the Access
assertion. A key alone, read out of a log say, is never enough to read what a
write answered. A client that signed in again in between is told the write was
done (`409`), and it reloads.

Before executing a keyed API command or replaying its answer, the entry runs the
same authentication and session-origin checks as the API. Revoked/expired
credentials and disabled accounts receive an authentication refusal. A changed
principal profile, grants, token scopes or money-visibility setting prevents
replay (`409`). A database authorization revision also invalidates receipts when
project/team assignments, resource ownership or organization access policy
change, even if credentials stay valid or access is later restored. The revision
advances atomically with those changes; ordinary time/expense writes and names
or budgets do not invalidate unrelated receipts. Access-policy mutations may
invalidate their own cached response. A release or demo-policy change also
requires reloading instead of replaying an older representation. The committed
claim survives every invalidation, so the write cannot run twice. Authorization
is checked again after waiting for another attempt.
If resolving a changed session rotates its cookie, `409 authentication_changed`
delivers that replacement and asks the client to reload; this refusal does not
mean the command ran. The key remains bound to its original credentials.

Non-API data surfaces (authentication, portal, bootstrap and webhooks) use
route-specific credentials. Their database writes still retain the key's claim,
but this boundary does not cache their responses: a duplicate receives `409`
instead of replaying a login cookie or bypassing a route's credential checks.


| Answer | Meaning | What the client does |
| --- | --- | --- |
| `400 invalid_idempotency_key` | The key is not 1 to 255 visible ASCII characters. | Fix the client; do not retry. |
| `422 idempotency_key_reused` | The key came with a different method, path, content type or body. | A client bug; do not retry. |
| `409 idempotent_result_unavailable` | The write was done, but its response is not available. It was over 1 MiB, the server failed after the write landed, or the retry carries other credentials. | Treat it as done and reload. |
| `503 idempotent_request_in_progress` | The first attempt is still running. The duplicate waits a few seconds for its answer before saying this. | Retry after `Retry-After`, with the same key. |

**Clients.**
- Retry network errors, 408, 429 and 5xx: up to 4 attempts, with exponential
  backoff and full jitter.
- Wait at least `Retry-After`.
- Fail at once on any other 4xx, and on a replayed answer.

**How it holds.** There is no transaction that spans a request on D1, so the key
is claimed inside every write's own batch or transaction (`@ezacto/db`
`idempotency.ts`):

- once one attempt has written, no other attempt with that key can commit
  anything;
- the response is recorded straight after the request;
- database writes already in flight settle before that response is recorded;
  later writes inherited from a finished request are refused. Independent
  queue consumers explicitly run outside the HTTP claim;
- an attempt that stops between a write and that record leaves the key claimed.
  After a one-minute lease its retries are answered `409`, so the work is
  reloaded rather than done twice.

Claim IDs remain stable when `API_CURSOR_SIGNING_KEY` rotates. Responses sealed
under the previous secret become unavailable (`409`), but the write cannot run
again during its original lifetime. Keys must be unguessable random values: the
database stores their hashes, never the keys themselves.

The money and upload routes that already take the header as their command id
keep their own ledgers. A retry is answered from the stored response before it
reaches them.

## Cursor pages

Lists accept `per_page` (`1..200`, default `50`) and an opaque `cursor`. A page is:

```json
{
  "data": [],
  "links": { "self": "/api/v1/things", "next": null },
  "page": { "per_page": 50, "next_cursor": null }
}
```

The first request captures the collection's maximum SQLite row id. Every later page
uses the cursor's same high-water id and an exclusive last-seen id, so native
concurrent inserts cannot move or extend the traversal.

`GET /api/v1/invoices` is the exception: it is ordered newest first (issue date,
then number, then id, all descending; the operation's description states the
rule), because invoice ids say nothing about age — the Harvest import numbered
newest first and a native invoice may carry a hash-derived id. Its cursor holds
the last invoice's place in that order, and the first request captures the
latest `created_at` instead of a high-water id, so invoices created during the
traversal stay out of it. Cursors are versioned,
HMAC-authenticated with a server-owned key of at least 32 bytes, and bound to the
endpoint, non-pagination filters, and page size. Re-encoding or replaying a cursor in
another collection scope is rejected. Clients follow `links.next`; they do not
construct or modify cursors.

Every returned record passes through the supplied serializer before entering
`data`. Permission and money-field redaction extend that seam rather than being
implemented ad hoc in routes.

Time-entry and expense responses omit `invoice_id` and `is_billed` unless both
the acting profile and (for bearer credentials) token allow `invoices:read`.
An omitted field is confidential, not an unbilled value. The `invoice_id` and
`is_billed` filters require the same authority and otherwise return 403 without
querying invoice state. Invoiced rows remain locked for every viewer, but readers
without invoice authority receive the generic `locked` / `This record is locked.`
reason on reads and rejected mutations. Other operational lock reasons remain
visible. Browser displays and exports must not infer "not invoiced" from omission.

Time entries belong to one person, and administrators alone may act on anyone's
(issue 917). `GET /api/v1/time-entries` and `GET /api/v1/time-entry-options`
answer for the acting user unless `user_id` names somebody else, which is 403
`row_forbidden` for every other profile, executive managers included. An
administrator may also read, update, stop and delete any entry by id, and create
stopped time for anyone by sending `user_id`; everyone else gets 404 for another
person's entry. An entry's owner never changes, and starting or restarting a
timer for somebody else is refused with `timer_owned`. Timesheet locks, approved
weeks and invoice claims refuse an administrator exactly as they refuse the
owner. Each change made on somebody else's behalf writes a
`time_entry.created_on_behalf`, `updated_on_behalf`, `stopped_on_behalf` or
`deleted_on_behalf` event to the outbox in the same transaction as the change.
The event names the administrator as `actor` and the owner as
`time_entry.user_id`, and carries before and after snapshots without rates. The
activity log records it like any other event.

Resource planning (issue 1007): `/api/v1/allocations` holds planned seconds per
week for a person on a project over a range of dates, and `GET /api/v1/capacity`
is the read-only person-by-week view of plan against capacity and tracked time.
Both use the existing `schedule:read` and `schedule:write` scopes. Administrators,
executive managers and project managers write, a project manager only for the
people and projects they manage (the team access rules); a person who is none of
those reads only their own plan, and the capacity view shows them only
themselves. A plan is not work: it never touches `time_entries`, rates or
invoices. Over-allocation is an `over_allocated` flag and never a refusal. Each
write leaves an `allocation.created`, `updated` or `deleted` outbox event in the
same transaction, which the activity log records.

Time off (issue 1007, slice 3): `/api/v1/time-off` holds days a person is away,
entered by an administrator, executive manager or project manager (the latter for
the people they manage); there is no request or approval step. Everyone else
reads only their own. `GET /api/v1/capacity` subtracts it: each week carries
`time_off_seconds` (Monday to Friday only; a whole day is a fifth of the weekly
capacity, or `seconds_per_day` when set; never more than the capacity) and
`available_capacity_seconds`, and `over_allocated` compares the plan with the
latter. Time off for one person may not overlap, so a day is never taken off
twice (409 `time_off_overlap`). It never touches `time_entries` or invoices, and
an over-plan is still a flag, never a refusal. Each write leaves a
`time_off.created`, `updated` or `deleted` outbox event.

Own payments (issue 100): `GET /api/v1/me/payments?month=` returns the signed-in
person's own hours, recorded amount owed, receipts and upcoming payments. It is
session only, off until the `own_money` setting is on, and refused (`not_a_payee`)
unless the person is flagged a contractor or has a recorded obligation. There is
no person parameter. See `docs/contractor-payments.md`.

Client rate cards (issue 34): `/api/v1/clients/:id/rate-card` reads or attaches the
named card of one client node (409 `rate_card_exists` for a second), and
`POST .../rate-card/versions` appends an effective-dated version of task lines or a
single default line (409 `rate_card_version_order` unless it starts after every
existing version; an empty `lines` array retires the card). There is no update or
delete. `GET /api/v1/clients/:id/effective-rate-card?task_id=&spent_date=` returns
the rate the resolver would use and which ancestor supplied it
(`supplied_by_client_id`, `depth`); inheritance follows `parent_client_id` only,
never the bill-to client. Billable rates are money, so only the profiles that may
see them (administrator, accounting, executive manager, and a project manager
granted `billable_rates_manager`) read or write; others get 403 `money_forbidden`.
A card prices only projects billed by people that use default rates, applies to
work resolved after it is written, and never changes an existing entry, snapshot
or invoice.

General-resource commercial fields are classified in `@ezacto/core`:
client payment terms/tax/discount defaults, project billing method/bill-by/currency,
and contact invoice-recipient routing. Finance, executive, administrator, and
project managers explicitly granted `billable_rates_manager` may see them.
Other viewers receive no keys, including on filtered client-project lists.
Setting any of these fields requires the same authority plus the resource write
scope; accounting's project-write restriction is unchanged. Operational edits can
omit the fields without resetting stored terms. Browser capabilities consume the
same policy; OpenAPI exposes the field classification as `x-commercial-fields`.

## OpenAPI and generated clients

`packages/api/src/contract.ts` is the executable v1 contract definition. It emits
the committed `openapi/ezacto-v1.openapi.json` artifact and the
`@conflict-hq/ezacto-client` TypeScript client from the same operation and schema registry:

```sh
npm run contract:generate
```

`npm run contract:check` regenerates both outputs in memory and fails on any
diff. It is part of `npm run verify`, so route or schema changes cannot merge
with stale artifacts. The API contract test independently compares every
documented method to the methods actually mounted by Hono.

CI uploads the versioned JSON document as an artifact named for the commit. A
running Worker also serves the current v1 document at `/openapi/v1.json` without
requiring database bindings. Consumers import `EzactoClient` from
`@conflict-hq/ezacto-client`; direct edits to `packages/client/src/generated.ts` are replaced
by the generator.

## Reports and rollups

The native report slice requires an explicit inclusive `from`/`to` date range:

- `GET /api/v1/reports/my-hours` totals the acting user's own tracked time by
  project. Whose hours it reports is the authenticated principal and nothing
  else: there is no `user_id` parameter, and the strict query parser refuses one
  rather than ignoring it, so the report cannot be widened by editing a request.
  It is gated on `time_entries:read` rather than `reports:read` -- these are the
  caller's own entries, so the three reporting profiles are not the ceiling. Rows
  carry tracked and rounded seconds side by side, because they differ on an
  account that rounds and only the tracked figure matches the week grid; they
  carry no money, so nothing here needs the money-field redaction the other
  reports apply. Archived projects stay in, unlike the uninvoiced report: work
  booked to a closed project is still work that was done.
- `GET /api/v1/reports/uninvoiced` prices stopped, billable, unlinked time from
  its stored `rounded_seconds` and rate snapshot, then adds billable unlinked
  expenses. The shared integer-cents generation preview owns this arithmetic;
  null rates remain unpriced and are counted rather than converted to zero.
  Archived projects are out of scope: their unbilled work leaves this report and
  the generation candidates together, and naming one in a generation request is
  refused rather than silently dropped from the resulting invoice.
- `GET /api/v1/reports/client-rollups/:clientId` returns direct and descendant
  totals for every node in the selected client subtree. Monetary values remain
  grouped by currency.
- `GET /api/v1/reports/project-budget/:projectId` reports the active budget grain
  (`project`, task assignment, or user assignment). Time budgets are visible on
  the project-read surface; money budget, billable, and cost-derived fields are
  independently omitted by the shared permission-profile policy. Account-wide
  reporting profiles can read every project. Other profiles need an active project
  assignment and either `report_visibility = everyone` or a project-manager profile
  with that assignment's `is_project_manager` grant. A denied project is indistinguishable
  from a missing one.

Report responses are `no-store`. Invalid, duplicate, missing, or inverted date
filters fail before the repository runs.

The contract suite dispatches the same fixture handlers through a real Node HTTP
server adapter and a Miniflare/workerd isolate. In-process Hono tests remain unit
tests and are not treated as proof of runtime parity.
