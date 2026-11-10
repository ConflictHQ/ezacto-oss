# Managed Deel connection and time-sync runtime

In-process contracts for a host that gives each tenant its own Deel connection
(#1238; hosted parent #237). Deel is an optional, per-person payout choice. The
contracts expose connection state, preview and the existing explicitly confirmed
time sync. They never initiate a payout or payment, and nothing here calls Deel
unless a tenant has connected and a person confirms a run. Paid-plan decisions
and entitlements stay hosted policy; there is no billing in this repository.

Separate gates remain: a public HTTP route for connect/disconnect, the hosted
adapter consuming an actually published pin with durable per-command admission,
and real provider/API permission and owned acceptance (hosted#237). The container
explicitly refuses a managed Deel capability before storage access; sync routes
remain Worker-only (`WORKER_ONLY_ROUTES`).

## Public composition

- `@ezacto/core`: `ManagedDeelConnectionStore`, command, state and authority
  types, `managedDeelLimits` (token 4096, fresh-session window 15 minutes).
- `@ezacto/db` and `@ezacto/db/d1`: `createManagedDeelConnectionStore(database)`
  and `createDeelCredentialSource(database)`. `createDeelSyncStore(database)`
  gains `intents`.
- `@ezacto/api`: `createManagedDeelConnectionCommands(options)`, with the same
  authentication choices as the managed QuickBooks commands (native session, or a
  trusted `guardedUserId`). It installs no route and makes no provider request.
- `@ezacto/integrations`: `createManagedDeelSyncRuntime(options)` returns the
  existing `DeelSyncRuntime`, so `installDeelSyncRoutes` serves preview and
  manual sync from it unchanged. `DeelSyncRuntime.status()` may now be async.
- Worker entry: `createWorker({ managedDeel })` takes a trusted process-local
  `WorkerManagedDeel` factory. `configured(scope)` is pure availability metadata;
  `compose({scope,database})` uses the original tenant binding's object identity
  and the native idempotency-aware database. Bind trusted tenant/incarnation
  metadata through a private WeakMap, never request parameters or WorkerEnv.
  Fetch, queue and scheduled paths propagate the same port. HTML reads only
  pure availability, without constructing services or reading custody.

## Entry capability boundary

With an explicit managed port, the Worker never supplies deployment DEEL_TOKEN
or DEEL_SYNC_START_DATE to any Deel consumer. An unavailable/null managed result
does not fall back to another company. Only time sync is composed: auxiliary
staging and payment-status runtimes remain unconfigured. Demo, disabled
accounting capability, suspended and erased tenants must not invoke the factory
or send provider requests. The ordinary self-host deployment path is unchanged
when no managed option is supplied.

The factory reuses `createManagedDeelSyncRuntime` and the canonical tenant
credential/settings/transfer stores. Its credential source must recheck current
host availability on every read and reject lifecycle checks after suspension or
erasure, including in an already-composed run. The host must make native intent
and log operations durable individually, outside any transaction that can replay
the entire API request or subscriber. Wiring the port alone does not provide
that host admission or prove recovery after an unknown provider result.

Container `createContainerRuntime(config,{managedDeel})` throws
`ManagedDeelUnsupportedRuntimeError` with `code=capability_unsupported` before
opening a database, invoking the factory or using environment credentials.

## Tenant binding

Native storage is one database per tenant. Every store and the credential source
are bound to the database they are given and take no tenant argument, so a caller
cannot select another tenant. The identity, token, start date, transfer log,
intents and run history all live in that database. Hosted adoption must hand each
request the store for the current tenant incarnation.

## Credential lifecycle

- `state` returns generation, connected flag, start date, who connected and when.
  It never returns the token. A live session is enough to read.
- `connect` connects or rotates (token and start date). `disconnect` erases the
  token. Both need the current active administrator and a native session signed
  in within 15 minutes, checked inside the same SQL statement that writes, plus
  the expected generation. Revoked or deactivated authority, a stale session, a
  foreign origin or a mismatched actor write nothing. A guarded session's
  freshness is the host's to prove.
- The generation advances on connect, rotate, disconnect, and disconnect with
  nothing connected. It is append-only (triggers refuse any other change).
- Every lifecycle change also returns the sync to `manual`. Automatic scheduling
  needs a fresh, separate opt-in afterwards.
- Failure bodies are static. An unexpected cause stays in the invocation and
  reaches only the optional `reportError`. Driver errors are never surfaced
  because they can carry the bound token.
- The token lives only in `deel_connection`, with the same native storage
  custody as other provider credentials. It is erased on disconnect; the
  immutable transfer log remains by design. Account closure and suspension are
  the host's: a suspended or erased tenant's credential source returns null.
- Native account-closure review explicitly inventories
  `deel_connection.connected_by_user_id`, including the original schema without
  a user foreign key. The operator must cover this retained custody in the
  reviewed policy or disconnect it before closing that administrator's account.
  The inventory exposes only a count. Tenant-wide drain still has to inspect
  transfer intents/logs, lifecycle generation and uncertain provider custody;
  local disconnect does not prove remote token revocation or erasure.

## Runtime

`createManagedDeelSyncRuntime` reads the credential on every call and caches
nothing. With no connection, every operation (status, preview, run, automatic,
reconcile) answers `unconfigured`, reads no storage and sends no request. A run
that began before a rotation, disconnect or suspension stops before its next
timesheet and reports it. Manual remains the default; preview never creates.
A run sends only the entry ids a preview showed; if the plan moved it reports
`stale` and sends nothing. The existing planner, fingerprint conflicts, busy
lock and reconciliation are unchanged.

## Unknown create results

Deel has no idempotency key on timesheet creation, so the transfer log (written
after Deel answers) cannot alone make a replay safe. Migration 0160 adds
`deel_transfer_intents`. The runtime writes an intent for a submission's entries
before the create. The log insert removes it. A definite refusal (HTTP 400, 401,
403, 404, 422, or a request that never left the process) releases it. Anything
else (timeout, 5xx, dropped connection, a crash, a failed log write) leaves it,
and those entries are held back, reported as `unresolved` in preview and run
detail, and never planned again across retries, restarts and transaction reruns.
Clearing a held entry is `intents.release(entryIds)`, only after someone has
confirmed at Deel that nothing was created. Operator tooling for that is not in
this change.

## Proof

Native SQLite and D1 tests (`packages/db/test/managed-deel.test.ts`) cover the
lifecycle, fences, generation, privacy and intents. `packages/integrations/test/
deel-managed-runtime.test.ts` runs the real client against an owned local HTTP
server, including a dropped response and a restart. No real Deel call is made.
