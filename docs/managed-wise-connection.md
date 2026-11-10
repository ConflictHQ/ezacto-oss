# Managed tenant-owned Wise reads

Implementation for #1237. This is Wise's business-token model, with an explicit
profile selection. It is not contractor OAuth. Each organization supplies its
own token; the host must never substitute its own Wise business credential.

## Public contracts

- `@ezacto/core`: `createManagedWiseVault`, `ManagedWise*` types and static errors.
- `@ezacto/db` and `@ezacto/db/d1`: `createManagedWiseConnectionStore` (0182).
- `@ezacto/api`: `createManagedWiseConnectionCommands`, consumed in process by a
  host's admitted configuration handler. The credentials are invocation arguments,
  never a generic activity/SDK payload. Existing `installWiseRoutes` consumes the
  runtime's read-only service and applies native session/role authorization.
- `@ezacto/integrations`: `createManagedWiseRuntime`, an async tenant-bound
  composition over the existing native `createWiseRuntime` in `read_only` mode.
  It has no payment provider or webhook consumer. No environment token is read.

## Custody and authority

The vault reuses the existing BILL envelope implementation, retaining BILL's exact
v1 format and AAD. Wise has a separate authenticated provider purpose. The host
supplies separate 32-byte custody and fingerprint keys plus an opaque tenant
incarnation binding, outside tenant storage. Envelope authentication includes
purpose, tenant, key id and connection generation. Never persist those keys in the
tenant database or return them to the browser. Configure seals for generation+1;
SQL stores only the envelope and keyed intent digest, never the raw token.

Commands require native session-only authorization and exact-origin CSRF, including
status. Configuration, rotation and disconnect require a current administrator
session signed in within 15 minutes. SQL repeats administrator, revocation,
freshness and expected-generation checks inside the same atomic command. A trusted
host-authenticated identity callback may substitute for a native session only if
it independently proves this same freshness for the current tenant incarnation.
Header/body identifiers are not such a proof.

A random 64-hex command id and keyed full-intent digest provide exact replay. A
changed secret under the same id, obsolete generation, revoked administrator,
foreign origin or stale sign-in cannot report a new success. Credentials never
appear in status or command results. The profile id is a canonical decimal string,
so provider identifiers beyond JavaScript's safe integer range retain their value.

## Reads and capability fences

The stored state distinguishes disconnected, configured, connected and unavailable.
Configuration alone is not provider verification. Read verification must find the
selected profile under that token before a healthy state is recorded; it never
falls back to another business profile. Provider refusal or invalid custody remains
unavailable. Existing native parsers preserve only masked recipient summaries,
not Wise's full accountSummary or bank accountNumber fields.

Every read reopens current custody; there is no credential/session cache. Each
provider request checks current generation and the host's fresh admission before
and after the exchange. Rotation, disconnect, suspension, erasure or changed
incarnation cannot let a late reply escape as current data. Hosts must implement
`isEnabled` and `assertAdmission` from trusted policy/directory facts. Neither a
provider exchange nor a runtime invocation may be enclosed in a replayable host
SQL transaction. SQL commands commit independently before/after provider I/O.

Only GET may cross the managed transport boundary. Native destination mutations
refuse through the existing read-only capability check, and account mutation ports
are not accepted by the managed constructor. This does not compose payment-run
execution, initiate a transfer, install settlement shortcuts or accept webhooks.
Existing separately enabled raw-signature/atomic webhook handling is unchanged.

## Closure and erasure

`inventory()` counts sealed credentials and command receipts. Both tables have
explicit user attribution references, so the native account-closure inventory
shows them for retention review; closing an attributed person's account does not
claim the organization's provider credential was revoked. Organization closure,
reset and hosted drain must call `erase(now)` and inspect the resulting inventory.
It removes recoverable custody and receipts and advances the generation, preserving
financial history and fencing earlier commands.

Local erasure/disconnect cannot revoke a Wise API token at Wise. The owner must
revoke it there; provider revocation and historical backup/key retention require
separate evidence. This contract makes no terminal hosted-erasure claim.

## Remaining acceptance

Two native tenant databases, actual session/API commands and an owned local HTTP
provider exercise SQLite/D1 isolation, permissions, masked reads, late replies,
rotation/disconnect, disabled/erased no-I/O and custody inventory. Crypto tests prove
Wise tenant/purpose/key/generation isolation and BILL v1 compatibility. Results must
be checked on the exact revision; source availability alone is not acceptance.

Actual public publication, Worker/container or explicit unsupported-capability
wiring, an actual hosted consumer with admitted per-command durability, hosted63
custody/drain inventory and owner-authorized provider read acceptance remain gates.
No live Wise request or production enablement is part of this implementation.
