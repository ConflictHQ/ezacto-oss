# CSV browser planner and native ledger

Issue #1180 implements the reusable foundation for the sealed Clockify pilot.
It does **not** enable browser import: administrator upload/routes and generated
HTTP contracts remain #1181, the screen #1182, and durable apply orchestration
#1183. Worker/D1 browser activation remains #1184. Portable code bundling is not
proof of a deployed Worker importer.

## Workspace composition

`packages/migrate/src/csv-browser.ts` exports the portable parser, Clockify
browser reader, mapping, immutable planner and seal input. It has no Node
builtin dependency. `csv-browser-sqlite.ts` composes the real Container database,
canonical setup repository, canonical tracked time writer and native dataset
ledger through `createSqliteCsvBrowserService`. These are **workspace modules**,
not advertised npm subpaths. The existing standalone CLI and queued-loader
package remain unchanged; npm library packaging is a separate decision.

The CLI still uses `clockify-detailed-cli@1`, its existing mapping language and
its explicit database-owner compatibility adapter. The browser uses
`clockify-detailed-browser@2`, an explicit exporter zone and an actual current
administrator. No HTTP caller may select the CLI owner fallback. The eventual
HTTP adapter must authenticate a current administrator session and perform CSRF
and run-ownership checks before reading request content.

## Preview and identity

Registration is an explicit mutation, separate from preview. The pilot permits
one explicitly registered stable workspace/dataset per organization. Repeating
that registration returns its opaque source ID; another workspace cannot mint a
new source ID to evade a sealed dataset. A draft can be replaced before
confirmation. Confirmation seals file, mapping, adapter/identity version,
exporter zone, exclusions and destination interpretation. Changed inputs after
confirmation are refused rather than treated as an incremental export.

The planner receives a destination snapshot. Its SQLite adapter executes only
SELECTs inside one synchronous read transaction, with no awaited callbacks. It
does not create business data, lock windows, sequences, outbox events or import
runs. It reuses the canonical deadline calculation, including explicit unlocks,
without materializing locks. Direct planner tests fingerprint every table and
schema object; a later authenticated HTTP request may legitimately touch its
session or explicit staging metadata and must account for that separately.

Destination freshness uses one canonical native SQL expression for both the
preview digest and write-time equality guard. Scope includes referenced IDs,
resolution names, assignments, dates, rates and applicable policies. Native
normalization calls the same NFC/whitespace/case normalizer as the planner.
Unrelated destination edits do not invalidate the preview. Effective deadline
bits change when a deadline passes even if no lock has yet been materialized.
Only an opaque digest belongs in an HTTP response; `destinationFacts` is a
server-owned manifest of normalized hashes, IDs and dates.

Browser mappings can choose exact existing destination IDs. Opaque source keys
retain client/project boundaries, including tasks with identical names on
different projects. Missing, archived or wrong-parent choices are rejected;
there is no first-match fallback. This extension is not accepted by the CLI
mapping parser. Selected source seconds, actual destination seconds and
`destinationDeltaSeconds` are explicit: historical edits or deletions can affect
that difference, so it is not labeled solely as rounding. `organizationCurrency`
identifies the organization setting only; destination client/project currency
labels belong to the staging/catalog DTO in #1181/#1182. No price forecast is
provided. Historical imported entries use their actual stored
rounded seconds, without rechecking old notes or rewriting money. Deleted
entries retain dedup tombstones and are counted separately.

## Native writes and recovery

The current actor, sealed binding and live lease are checked in the same atomic
batch as a new write. Each setup unit uses canonical general-resource creation
with a unique run/entity lineage; its implicit default relations commit with
that unit. Relevant setup facts are hashed after those relations and checked on
continuation. Later explicit children are recognized only through their own
durable lineage. External edits are not ignored. Valid setup can remain after
cancellation; cancellation is not a rollback.

The sealed plan records actual file and selected row counts. The native run's
`total_rows` is the file count; completion requires exactly the selected number
of committed chunk receipts. An unfinished run cannot be marked complete, and
cancellation remains available before completion.

Each time entry uses the normal tracked writer. The time entry, existing CSV
source key, chunk receipt and progress commit together or all roll back. No
second time writer, imported rate override, invitation sender, invoice writer,
expense writer or payment operation is introduced. Source keys are computed
before exclusions, so excluding the first duplicate does not change the second
duplicate's identity.

Lease generations fence stale holders. A replacement administrator must be
currently authorized and obtain a new lease; original confirmation attribution
is retained separately from actual setup/chunk actors. Existing-key receipts
must never resurrect deleted time or reconstruct historical money from current
catalogs. Acknowledging an existing key checks its persisted physical line and
source seconds plus the exact chunk position; it does not require deleted target
catalogs or current note rules. Older CLI keys without browser source metadata
are not silently adopted or reconstructed by that receipt operation.

Durable job scheduling, bounded retry/status HTTP behavior, raw upload
retention and user-visible resume/cancel flows are completed by #1181/#1183.

## Local acceptance

The owned SQLite fixtures use a non-owner administrator, invented CSV data and
private temporary databases. Tests exercise nonmutating preview, canonical
locks/unlocks, exact seconds and rounding, selected IDs, immutable copies,
source-key tombstones and the actual native setup/time path. Native ledger tests
cover races, authority changes, lease expiry, rollback and chunk replay. The
portable bundle test and existing CSV CLI/provider suites protect shared
interpretation and hashes. Test output contains only sanitized counts/hashes;
no provider credentials or customer data are needed.
