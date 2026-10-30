# Sealed CSV dataset contract

Contract-only slice of issue 1180 (parent 1012). It settles the interface and
invariants of the browser CSV import's dataset identity so the SQLite and
later D1 implementations can be written against one tested definition. It does
not add a browser import, a route, a migration or a runtime. Plan:
[import-tools-plan.md](import-tools-plan.md).

Code: `packages/migrate/src/csv-dataset-contract.ts` (types, `csvPlanId`,
`csvPlanDifference`, the `CsvDatasetLedger` port; no Node fs/crypto/sqlite
imports, so it can load in a Worker). Fake and contract tests:
`packages/migrate/test/csv-dataset-*.ts`.

## Existing identity, and its limit

The CLI keys time by `(source_id, canonical-row-hash + identical-row
occurrence)` and runs by `(source_id, file hash)` plus the mapping hash. Same
file and reordered unchanged rows do not duplicate time; identical rows stay
separate. Editing a source row changes its hash and appends new time, and
changing `source_id` bypasses dedup. No incremental reconciliation is promised
and no provider row ids are invented.

## Invariants

1. **Dataset identity.** `datasetId` is the stable source workspace/dataset
   chosen once; it is the dedup scope. This instance is single-organization, so
   no organization id appears. A different file never gets a freshly minted id.
2. **Plan identity.** `csvPlanId` is a SHA-256 over the canonical plan: dataset,
   file hash, mapping hash, adapter id, identity version, ISO date format,
   exporter zone, sorted de-duplicated exclusions and a destination-version
   digest. Any change yields a new id; exclusion order does not.
3. **Draft versus confirmed.** A draft seal replaces the previous draft and
   discards only its preview. After confirmation only an identical plan reopens
   the run; otherwise the result is `blocked` with the first difference
   (`different_file`, `different_mapping`, `different_adapter`,
   `different_selection`, `different_destination`). A destination change means
   replan, never a silent broadening.
4. **Exclusions are persisted with the plan.** A write for an excluded line is
   refused; a retry cannot change the exclusion list.
5. **Actor.** Confirming and writing require an `AdministratorActor` with a
   non-empty user id, recorded on the run. There is no CLI-owner variant.
6. **Atomic dedup.** `commitEntry` records the time and its dedup key as one
   unit. Double delivery or concurrent replay yields one `written` and the rest
   `duplicate`.
7. **Preview is non-mutating.** Preview produces a plan input and a report; it
   does not call `seal(..., true)` or `commitEntry`. A draft seal must not
   change confirmed state.

## Not decided here

The SQLite columns, the D1 equivalent, how `destinationVersion` is computed,
the lease/fence for queued chunks (story 1183) and the HTTP surface (1181) are
implementation work. A real ledger passes `csvDatasetLedgerContract`; the
exported function takes a factory returning `{ ledger, fingerprint, timeCount }`.
