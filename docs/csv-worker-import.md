# Optional native Worker CSV imports

The Container workflow uses private disk staging. A Worker can expose the same
administrator review and apply routes when all four bindings are present:
`DB`, private `ATTACHMENTS`, `CSV_IMPORT_QUEUE`, and `CSV_IMPORT_QUEUE_NAME`.
Without those bindings its capability remains unavailable. Existing production
configuration is unchanged; this feature does not provision production resources.

Provision a dedicated Queue and dead-letter Queue, then add the producer binding
and a consumer with `max_batch_size: 1`, `max_batch_timeout: 1`, a bounded retry
policy, and `max_concurrency: 1`. The consumer queue name must exactly match
`CSV_IMPORT_QUEUE_NAME`. Keep R2 private. Normal API startup applies migrations;
queue deliveries verify the migration ledger without issuing DDL. Do not send CSV
messages to the existing mail or migration queues. The existing scheduled entry
independently enqueues private-input expiry and continuation repair; failures in
those optional sends do not stop other scheduled work.

Messages carry only a random stage identifier. Authorization remains the native
administrator session, current target incarnation, immutable reviewed input,
current destination revision, and exact stage/native lease generations. Raw CSV
and private previews expire after 24 hours. Explicit purge removes every object
under that stage prefix while retaining imported time and audit receipts.

Each queue delivery seals a run, commits one canonical time row, or finalizes it.
The execution adapter reserves 38 D1 calls for its main path and leaves room for
cleanup, provider acknowledgement, and continuation publication within the
50-call invocation ceiling. D1 batches count as one query but retain per-statement
limits. Setup receipts survive continuations. Three budget yields without durable
progress pause with a visible diagnostic instead of looping indefinitely.
Snapshots cap each collection at 5,000 records and aggregate data at 6 MiB;
reviewed native seals exceeding 1.5 MiB are refused before confirmation.

A relevant external policy change pauses execution. The administrator must review
the same mapping again after restoring its reviewed policy, or cancel and start a
new selection; resuming never silently adopts changed policy. Committed rows stay
idempotent across redelivery, lost acknowledgements, and completion recovery.

The local acceptance suite runs the actual Worker handlers with workerd,
Miniflare D1, R2, and Queues. `csv-native.test.ts` observes all D1 calls around the
whole queue entry, injects a lost publication, then checks repair, duplicate
delivery, native API replay, exact time totals, and private-input purge. Separate
native tests cover current-session denial, replaced leases, policy pause/review,
partial cancellation, unknown D1 acknowledgements, completed-run recovery, and
oversized confirmation. Local emulator evidence is not evidence of a Cloudflare
deployment; deployed owned-target evidence must record its own source revision,
Worker deployment revision, resource identifiers, and cleanup receipt.

The completed acceptance receipt is [1184-owned-worker-proof.json](evidence/1184-owned-worker-proof.json). It records two real disposable Cloudflare D1 databases, the Worker deployment revisions, exact bundle digest, R2/Queue names, completion and partial cancellation totals, native authorization denials, and successful removal of every owned resource. The distinct cancellation database preserves the native contract that an instance's registered CSV workspace is bound to one immutable file. Local fault-injection checks remain separately identified; they are not described as remote results.
