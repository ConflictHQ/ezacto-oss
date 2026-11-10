# Managed QuickBooks grant acceptance

This is the public, in-process contract for a host that exchanges an Intuit code
outside the tenant database transaction (#1233; hosted#437). It does not enable
managed accounting on its own: runtime composition (#1235), capability/UI (#1217),
provider/app approval (hosted#439), central webhooks (hosted#438) and external
revocation/erasure (#1236 / hosted#440) remain separate gates.

## Public composition

`@ezacto/core` exports the managed command, probe, authority, state and store
contracts, and `managedQuickBooksGrantLimits` matching existing canonical SQL
bounds: token4096, company name255 and realm64 characters. Hosts must validate
provider results against those bounds before treating a handoff as ready; do not
silently truncate credentials/company names. `@ezacto/db` and `@ezacto/db/d1` export
`createManagedQuickBooksGrantStore(database)`. `@ezacto/api` exports
`createManagedQuickBooksGrantCommands(options)`.

The host supplies that canonical store and either the existing native
`authentication.sessions` resolver or a trusted `guardedUserId(request)` callback.
The latter must obtain a fresh authenticated identity from the host's existing
session authority, bound to the current tenant/incarnation and lifecycle. It can
return a known authentication failure Response (400–599), which is preserved
unchanged without reading its body or reporting expected refusal as an exception.
The host should catch only its known refusal type for that return; unexpected
exceptions still reach the private error reporter. A non-failure Response is
rejected. It must
never read an acting user ID from an untrusted header, body or boolean. The core
resolves the current active administrator role itself; the host must not fabricate
an administrator principal or copy role SQL. Supply a resolver bound to the
current transaction attempt, not one cached across requests/replays.

The commands use normal session-only native API authorization and exact-origin
CSRF policy. Bearer credentials never fall back to a cookie; contacts and other
profiles cannot accept grants. Even `prepare` and `inspect` require exact origin.
They can rotate a session and acknowledge private custody. The native store
rechecks active administrator and native-session revocation/expiry inside the
same SQL command that accepts a grant. A guarded identity's external session and
directory proof remains the host's responsibility.

- `prepare(request)` returns actor, current safe-integer connection generation and
  whether a live connection exists.
- `inspect(request, {grantId, browserHash, credentialHash})` returns that current
  generation even when no receipt exists, plus `replayed`. A matching receipt is
  usable only while the same actor, browser/credential proof, unexpired handoff
  and accepted live connection generation still match. A disconnected or replaced
  connection cannot return a stale “connected” acknowledgement.
- `accept(request, command)` takes the opaque grant ID, expected actor and
  generation, browser/credential digests, expiry (epoch milliseconds), and the
  already-exchanged realm/company/scope/access/refresh token set. It returns only
  actor/generation/connection state and `outcome: accepted | replayed`.

The payload is an invocation-local value, never a request body to a newly mounted
public route. No platform client secret is accepted or persisted. The temporary
internal Hono instance applies existing native policy; importing or constructing
this factory installs no public Worker route and performs no provider request.

Successful results can include `setCookie`; failure Responses can also carry
native session headers. A host must commit/acknowledge the corresponding native
session work and pass its final directory/lifecycle fences before returning a
cookie or success. A rolled-back session rotation must not become a browser
credential. None of these commands bypasses the host's transaction or admission
protocol.

## Atomicity and generations

Migration0157 creates the canonical receipt and lifecycle counter. The counter is
an opaque safe integer, not a count an adapter should interpret. Connect,
reconnect, disconnect and deletion of a connection advance it. Explicit disconnect
also advances it when no live connection exists, so an in-flight grant cannot
outlive a second disconnect. Ordinary access/refresh token rotation and online
payment preference edits do not create a new connection incarnation.

The receipt records only the grant/binding digests, actor/authentication metadata,
expected/accepted generation, realm, expiry and time. The exact command fingerprint
covers the token set without storing recoverable tokens in the receipt. Tokens
exist only in the existing canonical connection row, with the existing native
storage/custody boundary (hosted encrypts its native database envelope).

Receipt insertion, the shared canonical connection write and final generation
read execute in one SQLite immediate transaction or D1 batch. A SQL guard checks
current actor/session, generation, absence of an already-live connection, handoff
expiry and the migration write barrier. Failure rolls the whole command back.
Concurrent exact retries recover the same receipt; changed intent, actor or
lifecycle cannot overwrite it. A lost reply can be recovered from the committed
receipt. Refreshing credentials does not reapply an old accepted token set.

The new receipt is transient authentication/security material in native account
closure inventory. Removing such a receipt cannot reset the lifecycle generation
or revive an old expected-generation command. This does not revoke an external
Intuit grant or prove complete provider erasure; those obligations remain explicit
and must not be hidden by local disconnection.

## Diagnostics and acceptance boundary

Expected invalid/forbidden/conflict/expired outcomes are static4xx responses and
are not reported as incidents. Unexpected causes remain private to the invocation:
console/body receive a static503 error, while optional standard
`reportError(error, requestId)` receives the original Error through a trusted
in-process callback. A host should remember it attempt-locally and capture only
the winning exhausted outcome after its transaction/lifecycle decision. Reporter
failure cannot change the command's response. Never serialize the original error,
command or token material yourself.

Native tests exercise real SQLite and D1, native session and guarded identity,
forced stale reads/concurrency, disconnect generations, refresh, rollback, response
loss and privacy. Provider exchange is intentionally absent. Hosted adoption must
consume an actual reviewed public publication/pin; a local shim, vendor patch or
compile-only declaration does not prove the host uses this contract.

## Lifecycle fence and revocation custody

Issue 1236 (hosted440) adds the lifecycle half. `createManagedQuickBooksLifecycleStore(database)`
from `@ezacto/db` and `@ezacto/db/d1` implements `ManagedQuickBooksLifecycleStore`;
`createManagedQuickBooksGrantCommands({ store, lifecycle, ... })` then exposes
`fence(request, command)` under the same session-only authority, exact-origin
policy and diagnostics as `accept`. Local disconnection is never reported as
revoked or erased: only a recorded provider outcome sets `complete: true`.

- `fence` takes an opaque 64-hex `revocationId`, the accepted `grantId`, the
  expected actor and connection generation, `environment` (`sandbox` or
  `production`) and `reason` (`disconnect`, `suspension` or `erasure`). In one
  atomic commit it records the revocation intent, retires the stored access and
  refresh tokens in the connection row and advances the generation, so a stale
  callback, refresh, sync or webhook finds no live connection and cannot recreate
  one. The intent retains only the refresh token, the single credential needed to
  revoke the grant. Exact retries replay; a changed binding, grant, generation or
  actor conflicts. A fresh administrator is rechecked in SQL.
- Migration 0159 refuses to natively disconnect a managed connection, or point it
  at another company, without such an intent (`managed_quickbooks_fence_required`),
  so the native disconnect path cannot strand custody. Managed hosts must call
  `fence`. A same-company native reconnect still advances the generation and
  invalidates older handoffs, but is not a custody-preserving path.
- The host performs the Intuit revocation outside any replayable tenant
  transaction: `beginRevocation` moves `pending` to `attempting` and hands the
  credential to exactly one caller. A second call (restart or lost reply)
  returns no credential; the host reconciles with the provider and calls
  `settleRevocation(id, 'revoked' | 'not_revoked')`. `not_revoked` returns to
  `pending`, visibly owed; `revoked` deletes the credential and keeps a receipt
  with no secret. `listUnresolved` is the host's completion gate.
- The table references the actor, so account closure inventories it
  automatically as billing and payments. A closure or drain must not claim
  provider erasure while any revocation is unresolved; no terminal coordinator is
  invented and no identity data is hidden to empty the inventory.
- Demo resets, which never hold real grants, wipe the table with the rest.
- Real revocation, deletion and provider/account changes are not exercised here;
  that evidence belongs to hosted440's owned sandbox acceptance.

## Trusted Worker runtime composition

`createWorker` accepts the process-local `managedQuickBooks` capability, whose
public type is `WorkerManagedQuickBooks`. This capability is passed through
fetch, email-queue service construction and scheduled service construction.
It is never a serialized Worker binding, HTTP input or browser configuration.

The capability has two methods:

- `configured(scope)` returns side-effect-free app/entitlement availability. It
  receives the original database binding's object identity for a trusted host
  lookup. It must perform no database or provider request. The service-free HTML
  shell uses this same metadata, so a managed connection can be discoverable
  without copying platform credentials into environment variables.
- `compose({ scope, database })` constructs one complete `QuickBooksRuntime` for
  the invocation or returns `null` when unavailable. The database is the native
  idempotency-aware D1 binding. The original scope exposes no SQL contract; use
  it only to find host-owned tenant/incarnation policy. The same runtime supplies
  native API services, the invoice/payment outbox subscriber and scheduled
  catch-up. Construction must perform no provider effects.

Demo and accounting-disabled deployments invoke neither method. An explicit
unavailable result never selects deployment-level QuickBooks credentials.
When no managed capability is supplied, self-host Worker configuration retains
its existing behavior; the container composition is unchanged.

The capability carries authority to compose a service, not authority to bypass
native session, Origin, role, financial deduplication or webhook validation.
A host must supply real tenant-bound grant/link stores and the managed OAuth
and lifecycle behavior appropriate to its connection broker.

### Hosted effect and acceptance boundary

These native hooks alone do not complete hosted adoption. The host must keep
provider effects outside replayable whole-request/outbox transactions and use
durable ownership, connection-generation fencing and explicit recovery for
rotating refresh tokens, mirrored writes and ambiguous replies. The existing
self-host refresh implementation does not establish those hosted guarantees.
Do not expose that implementation directly inside a replayable S3lite callback.
Retain late/ambiguous credential custody for lifecycle reconciliation and
revocation inventory; a disconnected or erased connection must not be revived
by a stale worker.

The host must also preserve fresh tenant admission, incarnation/source fences,
per-call SQL durability, directory acknowledgements and final response checks.
Public source publication and a real hosted consumer with two-tenant provider
and failure/recovery acceptance are required before #1235 can close. Actual
central realm webhook routing and provider approval retain their own hosted
acceptance gates.

Intuit documents a company-scoped `requestid` query parameter for write replay,
with a 50-character limit for individual operations. A durable effect record
must retain that ID together with the exact original payload; `DocNumber`
adoption alone is not a concurrent-create fence. The current client does not
supply request IDs, so this is a required part of the remaining managed effect
implementation, not an already-delivered guarantee. See
[Intuit request ID semantics](https://static.developer.intuit.com/output_html/qbo/docs/learn/learn-basic-field-definitions.html).

## Reconnect while revocation is outstanding

A fenced connection still owes provider revocation while its receipt is
`pending` or `attempting`. A fresh administrator session and a new connection
generation must not authorize a new OAuth flow over that unresolved obligation.
The managed prepare/inspect/accept boundary returns its ordinary static conflict;
read the existing safe revocation status to explain the pending work. No
credential is exposed in that status.

Migration0181 adds native SQL guards to both managed grant insertion and live
connection insertion/update. These apply to native OAuth writes too, so a
caller cannot bypass the pending-revocation fence by changing its entry path.
`not_revoked` keeps the obligation pending. Only an observed, recorded `revoked`
result permits fresh connection work; an already-completed revocation never
hands its credential to a later worker again.

The migration preserves existing custody, generations and financial records. If
an earlier version already stored a live connection alongside an unresolved
revocation, migration refuses atomically for explicit provider reconciliation.
It does not erase tokens, mark revocation complete or silently hide the overlap.
Never delete a revocation receipt or alter the migration ledger to bypass that
refusal. Reconcile the original provider outcome and connection ownership before
retrying the normal upgrade. Local fixture tests do not authorize an actual
provider revocation or tenant credential change.

## Durable refresh ownership

`createManagedQuickBooksRefresh` composes into `createQuickBooksRuntime` through
`managedRefresh`. Its native repository, `createManagedQuickBooksRefreshStore`,
requires independently committed operations. Do not supply the database adapter
from a replayable hosted request transaction. The native Worker acceptance fixture
uses the actual D1 binding; a hosted adapter still needs to establish the same
per-operation durability and admission contract after public publication.
Admission must cover the current tenant incarnation, grant generation and admitted
effect lifetime through transport and response custody; an entitlement flag alone
is not a drain or erasure fence. This change does not establish that hosted lease.

Migration0183 records a non-expiring owner before token transport. Another
runtime cannot refresh the same connection while that owner is attempting or
unresolved. A provider failure or lost reply retains an unknown outcome; neither
elapsed time nor a fresh process grants permission to repeat the exchange.
Before transport begins, the owner can cancel only its own proven unsent nonce
when admission changes or a claim acknowledgement is lost. Once transport starts,
no clock expiry releases that owner. Native status reports
`authorization: ready|pending|unavailable` without credentials
or provider calls. A known ownership refusal becomes a static API409, rather
than logging a database error containing bound token parameters.

A returned replacement is staged and adopted in one native atomic command. The
connection's realm, generation, connection timestamp and previous refresh token
must still match. A database trigger rejects an unowned token replacement on a
managed grant, including the legacy token setter. The exact result hash binds
completion replay. A committed completion clears receipt token custody; a late
result after disconnection retains its replacement refresh token for explicit
cleanup and leaves the original revocation credential intact. Both the native
grant command and SQL guards refuse reconnect over unresolved refresh custody.

Unknown and orphaned outcomes are obligations, not successful revocations. There
is no automatic expiry, retry, credential deletion or operator bypass here. A
provider-observed recovery/cleanup protocol and its authorized owner acceptance
remain required before hosted activation. Account closure inventories the
receipt's administrator foreign key as billing/payment custody; a hosted drain
must also account for unresolved refresh state before claiming erasure.

This protocol addresses refresh ownership only. It does not make provider writes
idempotent: invoice/customer/payment effects still require durable exact-payload
ownership and provider request IDs, outside replayable SQL. No provider approval,
actual hosted activation, real refresh/revocation or financial-history mutation
is established by local native and HTTP fixtures.
