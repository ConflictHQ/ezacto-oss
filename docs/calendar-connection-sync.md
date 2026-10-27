# Private calendar connections and proposal sync

The connection/apply slice of #428 now composes the Google and Microsoft
read-only sources with per-user OAuth consent. See [calendar OAuth setup](calendar-oauth-setup.md)
for dedicated client registration and the remaining real-provider acceptance gate.
No provider or fake source is installed without configuration. An unconfigured provider
reports `available: false`; a refresh is refused without contacting a provider.
There is no HTTP endpoint accepting a pasted grant.

A verified native-session OAuth callback uses the internal `completeOAuth`
operation. The runtime owns the adapter registry. `CalendarSource` remains
read-only, and the same service and database store are composed by Worker and
Container. Sessions can list only their own connection status and disconnect
only their own generation. API tokens cannot manage these personal grants.

A native session authorizes admission of a manual refresh. Once admitted, the
persistent OAuth connection authorizes the proposal-only sync to finish, even
if that browser session logs out. A revoked session cannot start another
refresh. Disconnect, account closure, a disabled user, and connection or lease
fences still prevent an in-flight commit; no tracked time is written by sync.

OAuth tokens and cursors use AES-GCM under an HKDF purpose key derived from the
existing deployment cursor secret. Associated data binds the instance nonce,
user, provider, connection generation, credential revision, and payload purpose.
Neither API responses nor errors carry plaintext credentials or cursor values.
Keep an old deployment secret available for resolving its outstanding encrypted
cleanup obligations before retiring the key; key loss requires manual provider
cleanup rather than a false successful revocation.

Sync reads at most ten pages and ninety applicable events, with a thirty-second
provider deadline and a sixty-second fenced lease. Refresh accepts bounded `past_days` and `future_days` (0–90 each); explicitly changing that selection starts a full read, so a busy calendar can narrow its window. A failed or incomplete read
cannot advance the cursor. A saved cursor is reused only for identical query
bounds. Switching from a custom window to the default, or advancing the rolling
window, starts a full bounded read; provider cursors cannot silently omit events
from a different window. The successful proposal changes and encrypted cursor
commit in one SQLite transaction or native D1 batch. Disconnect, account closure,
replacement generation, expired lease, and reset/restore incarnation changes
refuse an old commit. Grant rotation within a live adapter refresh advances the
credential revision and re-seals the cursor. A replay preserves decisions and
cannot create duplicate proposals.

Timed, non-declined, busy events follow the existing eligibility policy. Accepted
entries remain unchanged when the provider edits or withdraws an event; the
proposal exposes `source_changed_at` and `source_cancelled_at`. Calendar identity
includes provider, calendar ID, event ID, and recurring occurrence.

Disconnect disables local access and cancels open proposals. Before erasing its
connection row or credential, the database retains an encrypted cleanup
obligation. Closing an account uses the same atomic custody transfer and deletes
its proposal rows; retained time follows the existing closure policy. An account
closure review includes credential revisions and pending-cleanup state, so a
concurrent grant change invalidates its acknowledgement.

**Local deletion does not mean provider revocation.** Google revocation is
verified through its token endpoint. Microsoft permission removal requires an
explicit owner attestation for their current-instance disconnect or reauthorization
record; this is recorded separately from provider verification. Closure and restore
records cannot use that confirmation path. Unresolved obligations block new OAuth
admission. The administrator endpoint `GET /api/v1/calendar-cleanup-status` reports aggregate pending and manual
counts across old incarnations, without revealing tokens or old users. There is currently no operator API or CLI to complete closure or old-instance
manual obligations. Those records remain unresolved and block affected restored
connections before token exchange; a dedicated operator evidence-and-receipt
workflow is still required. Current-instance Google cleanup is completed by the
provider adapter with evidence and an atomic receipt.

Logical backups retain encrypted evidence but mark live connection rows as
non-restorable. Physical CLI restore and demo reset rotate the instance nonce,
disable copied connections, and retain unresolved encrypted custody as
`manual_required`. Old-incarnation custody is not attached to reused user IDs;
it stays visible in the administrator aggregate. An operator restoring raw SQL
must perform the same quarantine before opening the instance. No backup contains
the deployment key needed to decrypt the envelopes.
