# Durable Container CSV apply

Refs #1183 and #1012. The Container composes private staging (#1181) with the
canonical planner and native writer (#1180). It uses the existing
`csv_import_runs`, `csv_import_chunks`, import keys and setup lineage. There is
no second loader, external queue, imported invoice or payment execution.

The backend reports `apply_supported` only when both real staging and apply
ports are installed. The Container browser flow now supports explicit review, confirmation, progress and cancellation; its readiness is advertised separately from apply capability.
Worker/D1 browser imports remain unsupported (#1184); the CLI's owner behavior,
source keys, mapping hashes and standalone package are unchanged.

## Commands and authority

`applyCsvImport` explicitly confirms the reviewed preview, immutable selection,
counts and acknowledgments. `resumeCsvImport` accepts a new command only for an
explicit continuation of that same seal. Both return authoritative progress,
not a promise that every row has already committed. The required
`Idempotency-Key` must equal the body `command_id`. Exact retries of either
accepted command can use Apply and never reset attempts or create more work.
`getCsvImportApply` recovers the accepted packet as `pending_command`, including
its original version, without browser storage of commands, CSV or mappings.

Every route checks the current administrator session and owned stage before
reading a body or command header. Tokens and cross-origin writes are refused.
Each setup, time/key/progress, duplicate acknowledgment and completion batch
repeats current native session, active administrator, closure, destination
incarnation, current input, command and lease guards. Persisted session ids are
internal database row references, never session cookies or bearer secrets.

Confirmation first claims the private stage, then atomically records the native
command with `apply_ready=0`. It becomes runnable only after the corresponding
private binding is acknowledged. A crash in that window leaves inspectable
custody; bounded recovery uses metadata and the same command. A delayed bind
cannot revive a cancelled private input. A stage owned by one administrator
never becomes another administrator's raw-data access merely through a lease
handover.

## Bounded work and recovery

The existing native run and chunk position are the queue. A Container timer
runs one driver at a time. Each tick uses a fenced 60-second lease, at most 25
rows and a four-second write budget, without holding a SQL transaction across
an await. Parsing and snapshot construction use the existing cancellable,
memory-limited staging worker. The driver consumes that same private plan and
snapshot; it does not synchronously parse the entire file a second time.

Canonical setup plus its unique lineage is one bounded atomic unit. Time plus
its source key, source evidence, audit and chunk progress is another. Already
committed setup can remain after cancellation. Recreated writers and duplicate
receipts do not reconstruct or resurrect a deleted imported time entry.

Unexpected storage failures retain progress and retry the same position at
most three times with persisted backoff. Durable cursor progress resets that
position's attempt count; replaying setup or an HTTP command does not. Expected
authority, input or policy refusals pause work. An explicit new Resume uses the
latest stage version and a current session; it does not create a new seal or
reinterpret source data. The bounded per-run command history accepts at most
256 distinct execution commands; exhaustion refuses further commands while
leaving inspection and cancellation available.

Policy drift never silently reseals a partial run. A fresh preview can resume
only if the exact original sealed destination binding matches again. Otherwise
inspect/reconcile/cancel; restore or recreate only the owned disposable pilot
destination if restarting is necessary. A new source id is not a dedup bypass.
After raw input expires, the old input cannot Resume: an administrator must
explicitly re-upload identical input into their own stage and recover under
the same registered source and immutable binding.

## Cancellation, retention and results

`cancelCsvImport` records a durable, version-fenced private cancellation intent,
then fences the exact current native stage/preview/command even if another
lease is live. A successful response means future writes are stopped. It does
not undo time, setup, invoices, payments or other organizational data. Unknown
responses are reconciled through the retained command and native progress.
Status and cancellation use metadata after raw expiry or purge.

Raw CSV and private previews expire independently of callbacks, including a
crashed confirmed run. Terminal retention is anchored to the native terminal
time, with staging expiry as the earlier bound. Raw purge preserves source
keys, chunks, setup lineage, command receipts and native audit. Physical backups
exclude ephemeral private CSV staging; restore rotates the destination nonce.

Results distinguish selected source seconds, committed source seconds and
current destination rounded seconds. `destination_delta_seconds` can also
reflect later edits or deletion; it is not exclusively a rounding delta. The
organization currency is a label, not a claim that every destination client
uses that currency. There is no source-money parity or invented zero/USD quote.
Unrelated financial rows remain untouched.

## Owned evidence

`entries/container/test/csv-apply.test.ts` uses actual streamed HTTP admission,
private disk objects, the bounded worker, native sessions and canonical SQLite
writers. Its cases cover preview business-table invariance, dropped-response
receipt recovery, restart and fresh-session continuation, pending and partial
cancellation, before-sweep expiry, purge/dedup retention and body-zero access
denials. The fixture contains a positive unrelated invoice witness and checks
its financial fingerprint throughout. No customer database, provider send,
production import or live payment is involved.

The test emits a sanitized local artifact at
`/tmp/ezacto-1183-owned-acceptance-artifact.json`: source hash, adapter, owned
scope, actual actor, exporter zone, organization currency, counts, exact seconds
and unchanged-money/dedup assertions. It contains no raw cells, private disk paths, session
references, credentials or customer identifiers. Exact-head CI and #1182's real
browser acceptance remain release gates.

Unexpected parser/storage exceptions are sanitized before reporting. Operator diagnostics use safe run codes and correlation IDs, never raw CSV cells or exception causes. Deletion custody remains retryable until private bytes are unlinked. Migration `0170_csv_apply_runtime` extends the existing native run metadata.
