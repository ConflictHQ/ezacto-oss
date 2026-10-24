# CSV import on Worker/D1: runtime contract

Contract only, for [#1184](https://github.com/ConflictHQ/ezacto-pvt/issues/1184)
(parent #1012, plan in [import-tools-plan.md](import-tools-plan.md)). It settles
the interface and invariants a D1 implementation must meet. It does not add a
route, migration, queue consumer or capability, and the Worker browser import
stays off. The types are in
[`csv-d1-contract.ts`](../packages/migrate/src/csv-d1-contract.ts); the suite any
real store must pass is
[`csv-d1-contract.test.ts`](../packages/migrate/test/csv-d1-contract.test.ts),
with an in-memory reference in `test/csv-d1-fake.ts`.

It sits under the planner and ports of #1180 (what a chunk contains) and the apply
orchestration of #1183 (when chunks run). Where those land different names, adapt
the names here; the invariants stand.

## What differs from SQLite

| SQLite/CLI today | D1 consequence |
| --- | --- |
| Dry-run applies, then rolls back | No interactive transactions. Preview is a read-only planner over `CsvD1PreviewReader`, which has no write method. |
| Time insert then `last_insert_rowid()` ledger insert in one transaction | One `D1Database.batch`, which is atomic. Per row: time insert, ledger insert. |
| One process owns the file | At-least-once, unordered queue delivery and concurrent invocations. |
| No statement budget | 100 bound parameters per statement and a per-invocation query cap; a chunk is sized to fit. |

## Invariants

1. **Atomic chunk.** One chunk is one batch: a guard statement, then per unkeyed row
   the time insert and its ledger insert. A failed statement writes nothing. A time
   entry never exists without its source key, or the reverse.
2. **Guard first.** The guard checks, in the batch, that the lease generation is
   current, the run is not cancelled, the actor is still an active administrator
   and the destination version equals the one the preview bound to. Reuse the
   `CHECK`-column pattern of `_ezacto_load_fence` so a failed guard aborts the batch.
3. **Idempotent by `(runId, chunkIndex)`.** Redelivery of a committed chunk returns
   `replayed` with the original counts and writes nothing. Chunks are independent, so
   out-of-order delivery is safe.
4. **Duplicate keys are counted.** A source key already recorded (this run, an
   earlier run or earlier in the same chunk) is skipped and reported as
   `alreadyImported`. It is neither an error nor a second entry. Edited rows keep
   the append limitation stated in the plan.
5. **Lease generations only increase.** A lapsed lease is replaced with generation
   + 1; a live one answers `held`. A writer holding an older generation gets
   `stale_lease` and writes nothing.
6. **Pause, do not fail.** `actor_unauthorized` and `destination_stale` pause the
   run for reauthorization or a fresh preview; neither broadens selection.
7. **Recoverable continuation.** The next message is derived from committed state
   (`nextChunk`: lowest uncommitted index), never from an acknowledged send. A lost
   acknowledgement or a crash after commit is repaired by the next delivery.
8. **Cancel is not rollback.** `cancel` stops future chunks and claims; committed
   rows and setup rows stay. Status reports committed counts.
9. **Messages and status are safe.** A queue message is `{ runId, chunkIndex }`
   only. Rows live in private R2 staging, purged on the plan's retention deadline;
   dedup keys and audit outlive the purge. Status carries safe codes, never emails,
   notes, cell content or filenames.
10. **Setup rows.** Unique/atomic creation of people, clients, projects, tasks and
    assignments with run lineage is part of #1180's ports; the same batch rules
    apply and the same suite is extended there.

## Not decided here, and not covered by this PR

- The real `CsvD1ApplyStore`, its D1 statements and any migration (a lease
  generation and committed-chunk record need columns beyond today's
  `csv_import_runs`).
- Queue consumer wiring, R2 staging, the capability flag and UI copy.
- Acceptance: the exact-count/seconds matrix on an **owned disposable** D1/R2/queue
  target with committed evidence. This needs a person to provision that target and
  run it; mocks and the existing Harvest proof do not count.
