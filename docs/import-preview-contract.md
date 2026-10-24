# CSV import preview: browser contract

Contract-only slice of [#1182](https://github.com/ConflictHQ/ezacto-pvt/issues/1182),
under [the import plan](import-tools-plan.md). It adds no route, UI or capability:
the browser cannot import files today. It fixes the shape the interface needs from
[#1181](https://github.com/ConflictHQ/ezacto-pvt/issues/1181), so both can be built
against the same thing.

- Types: [`contract.ts`](../apps/web/src/csv-import/contract.ts) (`ImportPreviewApi`,
  `ImportPreview`, `ErrorPage`, `ApplyCommand`, `ApplyOutcome`).
- Review rules: [`review.ts`](../apps/web/src/csv-import/review.ts), pure and tested.
- Fake and tests: `apps/web/test/support/fake-import-api.ts`,
  `apps/web/test/csv-import-review.test.ts`.

## Invariants any real implementation must keep

1. `upload`, `preview` and `errors` write nothing outside private staging.
2. Every route needs a current administrator session; tokens and other profiles are
   denied before content or run metadata is read.
3. `ErrorPage.total` is the full-file count on every page; paging never hides failures.
4. `preview_id` is immutable. A newer preview, a changed destination policy or a
   changed session makes the old one `stale`; apply from it writes nothing.
5. Apply is refused when `entries.rejected > 0` unless `partial` is acknowledged and
   `excluded_count` equals that count, and when source and rounded seconds differ
   unless `rounding` is acknowledged.
6. Cancel is a stop, not a rollback; the interface says so (`cancelNotice`).
7. `capability()` is read first. Worker/D1 reports `unsupported_runtime` with guidance.

## Asks of #1181 (not built here)

- Publish these shapes as OpenAPI schemas (snake_case) in `packages/api`, or tell
  #1182 which fields differ.
- Decide how `ImportChoices.mapping` keys are normalized (the planner's `nameKey`).
- Return `retention_expires_at` and a purge route as in the plan.
