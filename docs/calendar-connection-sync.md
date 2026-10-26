# Private calendar connections and proposal sync

Issue #1299 is the backend connection/apply slice of #428. Google and Microsoft
adapters, approved OAuth consent, and the week-calendar UI remain separate work.
No provider or fake source is installed by default. An unconfigured provider
reports `available: false`; a refresh is refused without contacting a provider.
There is no HTTP endpoint accepting a pasted grant.

A verified native-session OAuth callback uses the internal `completeOAuth`
operation. The runtime owns the adapter registry. `CalendarSource` remains
read-only, and the same service and database store are composed by Worker and
Container. Sessions can list only their own connection status and disconnect
only their own generation. API tokens cannot manage these personal grants.

OAuth tokens and cursors use AES-GCM under an HKDF purpose key derived from the
existing deployment cursor secret. Associated data binds the instance nonce,
user, provider, connection generation, credential revision, and payload purpose.
Neither API responses nor errors carry plaintext credentials or cursor values.
Keep an old deployment secret available for resolving its outstanding encrypted
cleanup obligations before retiring the key; key loss requires manual provider
cleanup rather than a false successful revocation.

Sync reads at most ten pages and ninety applicable events, with a thirty-second
provider deadline and a sixty-second fenced lease. Refresh accepts bounded `past_days` and `future_days` (0–90 each); explicitly changing that selection starts a full read, so a busy calendar can narrow its window. A failed or incomplete read
cannot advance the cursor. The successful proposal changes and encrypted cursor
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

**Local deletion does not mean provider revocation.** This slice has no revocation
adapter and never claims remote cleanup completed. Pending obligations block new
OAuth admission, and there is no arbitrary completion setter. The administrator
endpoint `GET /api/v1/calendar-cleanup-status` reports aggregate pending and manual
counts across old incarnations, without revealing tokens or old users. Provider
adapters must later complete revocation with evidence and an atomic receipt.

Logical backups retain encrypted evidence but mark live connection rows as
non-restorable. Physical CLI restore and demo reset rotate the instance nonce,
disable copied connections, and retain unresolved encrypted custody as
`manual_required`. Old-incarnation custody is not attached to reused user IDs;
it stays visible in the administrator aggregate. An operator restoring raw SQL
must perform the same quarantine before opening the instance. No backup contains
the deployment key needed to decrypt the envelopes.
