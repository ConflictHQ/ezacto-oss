# Owned SQLite browser-planner acceptance

These invented fixtures use reserved `.invalid` addresses and local disposable
SQLite files. They contain no production export, provider credential or customer
data. The actual native planner actor is administrator 2, not organization owner 1; member
3 is the person whose stopped time is being planned.

`native-instance.sql` is applied only after the production migration registry.
The fixture has nonempty native catalog, assignments, SQLite sequences and
outbox data. Organization rounding is nearest six minutes. `preview.csv`
contains 3,601 source seconds; its destination rounding is 3,600 seconds.
Neither source monetary data nor a provider request is involved.

Acceptance takes a complete schema/table fingerprint (including internal
`sqlite_sequence` and outbox) before and after the real snapshot and planner.
A second file connection is genuinely SQLite-readonly and `query_only`; attempted
lock materialization is a failure, not something the test silently rolls back.
Canonical lock/unlock APIs run only in explicit fixture setup before this
nonmutation boundary. Explicitly unlocked deadline windows must remain open.

The duplicate-occurrence regression seeds historical time and its atomic source
key through the existing CLI importer before opening the readonly boundary. It
then previews as administrator 2. This is real ledger history, not proof of a
browser HTTP upload or browser apply operation. The tests make no live-provider,
Worker/D1 browser-apply, or HTTP-session acceptance claim.

The concrete browser service and writer cases use the real dataset registration,
sealed plan, native lease, canonical setup lineage and tracked time writer. They
prove an inactive person gains no invitation, and that the two invented paths
`A/B → C` and `A → B/C` become distinct projects attached to their correct clients.
One client setup commits before the snapshot, plan and writer are recreated;
the resumed operation reuses that lineage. Financial table fingerprints stay
unchanged and exact command replay creates no extra time, setup or progress.

The explicit-ID case resolves duplicate destination names without guessing a
match, rejects a project outside its selected client, and checks that referenced
rate changes invalidate the version while unrelated project edits do not.
Historical imported time retains its stored rounding after current rounding or
note policy changes; deleted time remains an explicit dedup tombstone.
