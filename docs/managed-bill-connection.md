# Managed tenant BILL connection

This is the public, in-process contract for a host that gives each tenant its own
BILL company connection (issue 1252). It reuses the existing BILL login, mirror,
adoption and reconciliation runtime and adds only the missing connection,
lifecycle and composition layer. It does not enable managed BILL on its own:
runtime composition in a Worker (issue 1235), accounting capability and UI (issue
1217), BILL's approval of the platform developer key, controlled BILL acceptance
and hosted adoption are separate gates. Self-hosted BILL (deployment credentials,
[bill-setup.md](bill-setup.md)) is unchanged.

## Whose credential is whose

- The **developer key** belongs to the platform and is provider-approved. It
  reaches the runtime as `platformDevKey` and is never stored in tenant custody.
  Status reports `platformKeyConfigured` separately, so a missing platform key is
  never confused with a missing tenant credential. Having self-hosted BILL working
  does not imply BILL approved a multi-tenant platform key.
- The **tenant credential** is that tenant's company id plus a login or AP/AR sync
  token. It is stored only as a sealed envelope in that tenant's own database.
  There is no shared business login and no fallback to environment credentials.

## Public composition

| Export | Package | Role |
| --- | --- | --- |
| `createManagedBillVault` and the `ManagedBill*` types | `@ezacto/core` | tenant-bound AES-GCM custody and the store contract |
| `createManagedBillConnectionStore(database)` | `@ezacto/db`, `@ezacto/db/d1` | canonical store (migration 0159) |
| `createManagedBillConnectionCommands(options)` | `@ezacto/api` | private status, configure/rotate and disconnect commands |
| `createManagedBillRuntime(options)` | `@ezacto/integrations` | status, mirror, reconcile and payment-link consumers over the existing runtime |

`createBillMirrorSubscriber` accepts the managed runtime, and `installBillRoutes`
accepts a `BillService` whose `status()` is asynchronous, so the existing outbox
subscriber and the existing status route consume the managed composition unchanged.

## Custody

The vault takes two separate 32-byte purpose keys (custody and fingerprint, both
base64url) and an opaque `tenantBinding`. Every envelope authenticates the purpose,
the tenant binding, the key id and the connection **generation**, so an envelope
cannot be opened for another tenant, another key, or another incarnation. Opening
failures are static; parser and crypto detail never leave the vault. A host owns
key provisioning and rotation; this repository holds no key.

## Commands

The commands are invocation-local values, not a request body to a new public route.
Credentials are arguments of one call and are never read back: results carry only
`generation`, `status`, `companyId`, `environment` and `canSendFromBill`.

They require the existing session-only native authorization with exact-origin CSRF
(even `status`), or a trusted `guardedUserId(request)` callback that returns a fresh
host-authenticated identity. Active administrator authority and native session
revocation are rechecked inside the same SQL command that writes. Contacts and
member profiles are refused.

- `status(request)` returns the current generation and state.
- `configure(request, {commandId, expectedGeneration, credentials})` connects or
  rotates. The envelope is sealed for `expectedGeneration + 1`.
- `disconnect(request, {commandId, expectedGeneration})` erases the credential.

`commandId` is a random 64 hex digest naming the attempt. The receipt keeps only a
keyed digest of the full intent, so an exact retry (lost reply) returns
`outcome: 'replayed'`, a changed secret under the same id is a conflict, and a stale
generation is a conflict. Provider effects never occur inside these commands.

## Status and health

`connected` and `unavailable` are recorded only from a real exchange with BILL
(a provider answer that was not an error, or a refused login), never from a local
refusal or from constructing the runtime. A fresh connection is `configured` until
the first exchange. Status reads stored facts only: no decrypt, no login.

## No provider I/O when the capability is off

The runtime checks, before any credential is opened: the host's `isEnabled()`
(disabled, suspended or closing tenant), the platform developer key, and a stored
connection. Disabled, suspended, disconnected, erased or no-platform-key tenants
perform no provider I/O; `mirror` answers a refusal, so the outbox does not retry a
correct decision. Login and every provider call run inside the runtime, outside any
database transaction. The session cache lives inside one tenant composition and is
dropped when the stored generation changes.

## History is never repointed

Invoice and customer links (`bill_links`) are keyed by BILL ids. The company id is
retained as a binding after disconnect, and a reconnect to a different company is
refused while links exist, so adoption and payment history are never re-pointed at
another BILL company. Rotation inside the same company is allowed. Disconnect and
erasure never delete links, invoices or payments. Replays of mirror and adoption keep
using the existing link table, so invoices and email are not duplicated.

## Erasure inventory

`store.inventory()` counts credential-bearing rows (`sealedCredentials`,
`commandReceipts`). `store.erase(now)` removes the sealed credential and every
receipt and advances the generation, so a command from before erasure cannot revive
the connection. A host calls it for tenant closure or reset. Local erasure does not
revoke the credential at BILL; the tenant must revoke the sync token or password
there, and this contract does not claim otherwise.

## Acceptance boundary

Tests use native SQLite, a fake BILL, and two tenant databases. They prove
authorization, isolation, secret privacy, failures and recovery, replay, and
disconnect/erasure. They do not prove BILL's approval of a platform key, controlled
BILL acceptance, or that a hosted adapter consumes this publication.
