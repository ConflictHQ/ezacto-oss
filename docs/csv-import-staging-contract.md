# CSV import staging and preview: API contract (contract only)

Refs #1181, parent #1012. Contract for the private administrator staging and
preview API described in [import-tools-plan.md](import-tools-plan.md). **Nothing
here is implemented or mounted.** The operations are not in the registered API
contract or OpenAPI, no route exists, and browser CSV import is not available on
any runtime. Implementation waits on #1180 (portable planner, administrator
actor port, sealed dataset identity).

Source of truth: `packages/api/src/csv-import-staging-contract.ts`; the
executable invariants are in `packages/api/test/csv-import-staging-contract.test.ts`.
Any real implementation must pass the same assertions against its own store and
handlers.

## Invariants

1. Check order, before any run content or metadata is read: runtime supported
   (container only; worker answers 404 `capability_unsupported`), session
   present, not a token, administrator, same-origin CSRF on mutations, then run
   ownership. A missing run, another administrator's run and another target
   are all `run_not_found`.
2. Byte limit is enforced while streaming, before the overflowing chunk is
   retained. Row, column, field, name and mapping limits equal
   `packages/migrate/src/csv-contract.ts`. Staged bytes are verified for sha256
   and length; objects get generated keys; the store port has no URL method.
3. Run states: `uploading, staged, previewed, confirmed, completed, failed,
   cancelled, expired, purged`. Only `previewed` reaches `confirmed`. No apply
   or confirm operation exists in this contract (#1183 owns it).
4. Raw input and diagnostics are deleted 24 hours after a run turns
   `completed`, `failed`, `cancelled` or `expired`; the status view carries that
   deadline and a purge action. Purge keeps hashes, counts and audit/dedup
   records and never deletes imported time.
5. The preview id is deterministic and opaque over target, file hash,
   adapter/identity version, source id, mapping hash, ISO date format,
   export/destination zone choices, currency, excluded lines and destination
   policy versions. Any change makes the old id stale (`preview_stale`, 409).
6. Errors are paged by physical line with `invalid` versus `unsupported` kind and
   a full `total`; messages and logs never contain cells, emails, notes or
   filenames.

## Dependencies and asks

- #1180 provides the planner, the administrator actor and the sealed identity
  that `previewCsvImport` calls; this contract only fixes its inputs.
- Registering the operations in `contract.ts`, regenerating OpenAPI and the
  client, and mounting routes are deliberately left to the implementation PR so
  no capability is advertised early.
