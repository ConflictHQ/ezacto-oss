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
- Migration0158 refuses to natively disconnect a managed connection, or point it
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
