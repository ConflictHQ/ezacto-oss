# Import tools: first browser migration plan

Buildable plan for [#1012](https://github.com/ConflictHQ/ezacto-pvt/issues/1012).
This is post-beta work, not a beta gate or a claim that the browser can import
files today. The first browser target is **Clockify Detailed report CSV, time
only**, using the adapter and CSV importer already in this repository. No live
Clockify connection, credentials, universal provider wizard or money import is
part of this release.
Each deployed instance retains its single organization and database; run target
binding uses that existing instance identity.

## Existing boundaries to preserve

Inventory checked against source on 2026-10-23. Source links are relative to this
repository; current operator instructions remain in [CSV import](csv-import.md)
and [Harvest migration](migrating-from-harvest.md).

| Existing surface | Implementation and present behavior | Plan consequence |
| --- | --- | --- |
| Harvest operator commands | [`cli.ts`](../packages/migrate/src/cli.ts): `auth`, `extract`, `verify`, `sync`, `load`, `reconcile`, `preflight-migrations`, `finish-retainers`, `finish-recurring-invoices`, `carry-invoices` | Preserve #75/#98 extraction, reconciliation and packaging ownership. Do not turn CSV rows into fabricated Harvest records. |
| Checkpointed Worker snapshot load, #409 delivered | [`load-engine.ts`](../packages/migrate/src/load-engine.ts), [`queued-loader.ts`](../packages/migrate/src/queued-loader.ts), [`queued-commands.ts`](../packages/migrate/src/queued-commands.ts): `queue-upload`, `queue-start`, `queue-status`, `queue-retry`, `queue-cancel`; verified R2 snapshot, fenced D1 checkpoints, empty destination and quarantine | Reuse established immutable-input, lease, continuation and private-status conventions where appropriate. Do not build another snapshot loader, route populated-organization CSV through empty-database admission, or lift partial-load quarantine. |
| CSV CLI | [`csv-run.ts`](../packages/migrate/src/csv-run.ts): `import-csv --database ... --file ... [--format toggl\|clockify] [--mapping ...] [--source-id ...] --dry-run`; apply separately; SQLite only | This is the existing time writer and operator fallback. A command in Settings is guidance, not a browser import endpoint. |
| CSV contract/adapters | [`csv-contract.ts`](../packages/migrate/src/csv-contract.ts), [`csv-clockify.ts`](../packages/migrate/src/csv-clockify.ts), [`csv-toggl.ts`](../packages/migrate/src/csv-toggl.ts) | Clockify and Toggl adapters are already implemented. The first adapter story verifies and hardens the selected Clockify contract; it does not recreate an adapter. |
| Mappings and preview | [`csv-mapping.ts`](../packages/migrate/src/csv-mapping.ts), [`csv-import.ts`](../packages/migrate/src/csv-import.ts): normalized people/client/project/task mappings; entity/assignment tallies; new/already-imported/rejected rows; invalid versus unsupported row codes and warnings | Reuse these models and error taxonomy. Preserve physical source line numbers and make the full structured report accessible; CLI text truncates lists to 50. |
| Time writes and source ledger | [`csv-import.ts`](../packages/migrate/src/csv-import.ts) uses normal general-resource repositories and `DrizzleTrackedResourceRepository.createTimeEntry`; [`csv-imports.ts`](../packages/db/src/csv-imports.ts) records source identity atomically with each entry | Preserve normal rounding, rates, lock, approval, assignment and note rules. Extend existing ledger/run boundaries for browser execution; no second CSV writer or dedup table. |
| Runtime limitations | CSV parser/mapping hashing uses Node `crypto`; CLI reads local files; planner/apply uses `better-sqlite3` and rollback transactions; CLI currently acts as the database owner | Browser admission must not import Node-only modules into Worker code or impersonate the owner. Extract portable parsing/hashing and explicit caller/runtime ports first. The existing portable hash seam is [`portable-hash.ts`](../packages/migrate/src/portable-hash.ts). |

The first browser delivery is container/SQLite. Worker/D1 capability remains off
until a separate runtime adaptation proves equivalent preview, atomic row-ledger
writes and resumability. #409's delivered D1 snapshot capability does not make
CSV import D1-ready.

## Selected provider and data contract

Clockify documents Detailed exports with per-entry dates, times, duration,
identity and project dimensions; report exports can be filtered and customized.
Summary exports lack the required timestamps. Those are provider facts; the
narrow acceptance contract below is an eZacto decision, not a promise that every
Clockify export fits. See [Detailed report](https://clockify.me/help/reports/detailed-report),
[export reports](https://clockify.me/help/reports/exporting-reports) and
[customize export columns](https://clockify.me/help/reports/customize-exports).

Use an English-header, UTF-8, comma-separated Detailed CSV. Require the current
adapter's eleven columns: `Email`, `Client`, `Project`, `Task`, `Description`,
`Billable`, `Start Date`, `Start Time`, `End Date`, `End Time`, `Duration (h)`.
Preview lists missing, duplicate and unknown headers before any apply. Extra
columns are explicitly ignored and reported; repeated normalized headers are a
file error before adapter projection, not silently taken from the first column.

| Source data | Destination and decision |
| --- | --- |
| Email | Map to an existing destination person by email/explicit selection. An explicit new-person mapping creates an inactive member, without invitation or sign-in access. |
| Client, Project, Task | Map within the selected client/project boundary or explicitly approve creation. Ambiguous/archived matches require correction; never pick the first. Missing dimensions reject their rows until mapped to a named, explicitly chosen destination. |
| Description, Billable | Notes plus existing task-assignment semantics. Show where an existing assignment overrides the incoming billable flag; do not silently change that assignment for historical rows. |
| Start/End Date and Time, Duration (h) | Stopped time only. Same-date, whole-minute times with matching elapsed duration can use start/end mode; otherwise the existing adapter emits exact-second duration on the start date. Show that loss of source timing detail, including overnight/DST cases, before confirmation. An organization requiring start/end rejects duration-only rows. |
| Rates, amounts, currency columns | No imported rates, invoice lines, expenses, payments, balances, tax, refunds, payroll or permissions. List ignored monetary columns. Existing destination assignments determine captured rates; report unpriced time rather than implying invoice parity. |
| Tags, approvals, custom fields, attachments | Excluded. List detected unsupported columns/records. No ZIP, XLSX, PDF, receipt, URL fetch, attachment metadata creation or implied attachment transfer. Files/receipts remain in the source system. |

A browser import always states the destination organization, source dataset,
export date range, exact file hash and mapped entity counts. It is not a
continuous synchronization or edited-row reconciliation feature.

### Dates, timezone and currency are explicit

Clockify's [profile settings](https://clockify.me/help/administration/profile-settings)
let the exporter select date/time formats. Its [time-zone documentation](https://clockify.me/help/administration/time-zones)
says reports display time in the reporting user's zone, which may differ from
the person who tracked it. The current importer preserves written wall-clock
values; it does not recover the original user's zone. The wizard must state this
and require the export zone and the intended destination interpretation before
preview. Block unsupported zone conversion rather than guessing an offset,
including DST gaps, repeated hours and entries spanning midnight.

For the first browser contract require `YYYY-MM-DD` export dates; do not
infer MM/DD versus DD/MM from values such as `03/04/2026`. The existing adapter
accepts ISO or month-first dates and only recognizes day-first input when a
first component exceeds 12. That heuristic is insufficient for browser
confirmation and must be hardened by the adapter story. CLI compatibility is
separate; no silent change to a prior run's adapter interpretation is allowed.

Adapter identities are frozen per run
(`CLOCKIFY_ADAPTERS` in [`csv-clockify.ts`](../packages/migrate/src/csv-clockify.ts)).
`clockify-detailed-cli@1` is the existing CLI reader: ISO or month-first dates,
first of any repeated header. `clockify-detailed-browser@2`
(`createClockifyBrowserAdapter({ exporterZone })`) is the browser contract: ISO
dates only (any slash date refuses the file), a repeated header is a file error,
the source header is bounded to 40 columns before projection, a wall-clock time
in a daylight-saving gap is rejected for that row, and midnight spans, repeated
hours, seconds and duration/clock differences each carry a warning naming the
line. Neither reader converts zones. A change of reading is a new identity.

Browser `@2` also rejects formula-like cells in **every source column**, including
ignored columns and headers. Unnamed columns are refused with their physical
header line and column index rather than silently dropping their values. The earlier `clockify-detailed-browser@1` was a
pre-runtime contract, with no production consumer or persisted browser-run
executor; it is superseded, not silently replayed through `@2`. The CLI reader
stays `clockify-detailed-cli@1`: its ISO/month-first interpretation and first
repeated-header behavior remain unchanged, as does its treatment of ignored
formula-like cells. Exporter-zone options are copied when constructing a browser
reader; a later caller mutation cannot change that reader's interpretation.

Vendor CSV source admission enforces the existing 5 MiB, 50,000-row, 40-column
and 10,000-character decoded-field limits **before adapter projection**, including
columns the adapter would ignore. The tokenizer stops when a source bound is
exceeded; a rejected source never invokes vendor projection. File errors retain
the physical record start, and browser header diagnostics use the header's
physical line even after blank lines. These are source safety bounds, not new
CLI date or time interpretation. Committed invented fixtures and diagnostic
expectations live in `packages/migrate/test/fixtures/clockify-browser`.


Require unrounded export durations and `HH:MM:SS` duration output. Clockify's
[rounding guide](https://clockify.me/help/track-time-and-expenses/time-rounding)
explains that exported values can already be rounded. Preview shows source
seconds and destination rounded seconds separately; any difference requires an
explicit acknowledgement. Do not claim the file reproduces source invoices.

The browser pilot does not take currency from Clockify monetary columns. New
clients use an explicitly reviewed destination currency, initially the
organization default; existing client/project currency stays unchanged. Preview
groups any destination money estimates by currency and labels missing rates;
source money totals are excluded from reconciliation.

## Administrator upload, preview and confirmation

All upload, mapping, preview, apply, progress, retry, cancellation and diagnostic
download routes require a current administrator session and normal same-origin
CSRF protections. Reject API tokens and non-admin users before reading file
content or returning run metadata. Recheck active administrator authority and
organization/run binding when a queued chunk writes; never copy the CLI's
owner-impersonation fallback into an HTTP handler. Audit records name the actual
administrator, run, file hash, mapping version and outcome.

No provider credentials are collected for CSV. A future credentialed adapter is
a separate custody/scope/disconnect design and must reuse existing connection
custody rather than put secrets in CSVs, browser storage, analytics, issue bodies
or error reports. Logs/status carry run IDs, counts and safe error codes, not
emails, notes, cell contents, uploaded filenames or unredacted parse exceptions.

Admission keeps existing limits: 5 MiB CSV, 50,000 data rows, 40 input columns,
10,000 characters per field, 255-character names, one day/24 hours per entry,
and 1 MiB mapping JSON. Enforce byte limits while streaming, before allocation;
apply the column bound to the source header before adapter projection. Accept
only CSV text, reject invalid UTF-8/NUL/malformed quoting and formula-like cells,
and never evaluate cell formulas or render cell HTML. Diagnostic CSV downloads
escape formula-leading content. Browser pilot parsing also needs a bounded
execution budget and a cancellable private work item; larger imports use the
operator path, not relaxed limits.

Uploads are private staging objects scoped to one organization and run, with
server-generated names, content hash/length validation and no public URLs.
Retain staged input and full row diagnostics for at most 24 hours after completion
or expiry; failed/aborted runs expose the same retention deadline and an explicit
safe purge action. Persist hashes, counts and audit/identity records needed for
resumption/dedup after raw-file deletion. Purge must not delete imported time.

The flow is upload → choose source identity/date-zone interpretation → map →
preview → explicit apply → progress/reconciliation. Preview changes no durable
organization rows, sequence values, lock state, assignments, source ledger or
files outside staging. The current SQLite dry-run achieves this by rollback;
porting it to D1 requires a genuinely non-mutating planner, not a transaction
API that D1 does not supply.

Preview shows all counts: matched/new/rejected entities, assignments, new versus
already-imported time, invalid versus unsupported rows, source seconds,
destination rounded seconds, ignored columns and warning totals. Expand/paginate
all errors by physical line and safe code; a representative sample does not hide
additional failures. Bind confirmation to a signed/opaque preview identity over
the target, file hash, adapter/identity version, mappings, timezone/date choices,
row selection and relevant destination versions/policies. A changed mapping,
rate, assignment, lock or permission invalidates/replans affected work before
apply; a stale preview never silently broadens selection.

Default apply refuses any rejected row. Optional “apply accepted rows” requires
an explicit reviewed exclusion list/count and acknowledgement that the run is
partial. Persist those exclusions with the immutable plan. No per-row silent
skipping, silent account activation or automatic source cleanup follows upload.

## Identity, checkpoints and recovery

The current CLI uses `(source_id, canonical-row-hash + identical-row occurrence)`
for time identity, and `(source_id, file hash)` plus immutable mapping hash for
runs. It atomically records the entry key with the time insert. Same-file retry
and reordered unchanged rows do not duplicate time; identical source rows remain
separate. **Editing a source row changes its hash and currently appends new time.**
The current scheme therefore cannot promise safe arbitrary overlapping or
edited-export synchronization; changing `source_id` can also bypass dedup.

The first browser pilot is a **sealed dataset**: choose one stable source
workspace/dataset identity per organization, upload once, freeze bytes and
mapping on confirmation, and resume only that immutable dataset. Re-uploading
the same file reopens its existing run. Block a different/overlapping export for
that source after confirmation; do not claim to detect all semantic overlaps or
silently mint a fresh source ID. Replacing a draft before apply discards its
preview only. Replacing a partially applied dataset requires explicit operator
reconciliation, not an “overwrite” button. Any future incremental provider path
needs documented immutable provider row IDs or an independently reviewed change
reconciliation contract before this restriction is lifted.

Use the existing CSV source ledger and normal time writer. Persist run state,
immutable selection/mapping hash, actual actor, bounded chunk progress and lease
fence so a server restart, lost response, duplicate queue delivery, double-click
or cancelled browser does not duplicate time. Each time insert and its dedup key
must commit together on SQLite and, before Worker support, on D1. Entity creation
and assignment creation need equivalent unique/atomic handling and a record of
which run created them; abort may otherwise leave valid but unused setup rows.
A retry may not change an applied run's mapping or adapter/identity version.

A session expiring or an administrator losing access pauses further writes and
requires current administrator reauthorization. A replacement lease cannot
continue an old generation. Network retry is bounded; parse/mapping failures are
terminal until corrected, policy changes require a fresh preview, and unexpected
storage failures leave resumable partial status with counts and a safe error.
Only one apply lease per destination/source is active; other organization work
continues subject to normal row-level policies. Do not repurpose #409's full
snapshot quarantine for a populated destination.

Cancel stops future rows/chunks; committed rows stay. Neither existing CLI abort
nor the proposed browser control is an automatic rollback. UI must show the
committed count, residual created setup rows and safe recovery choices. Never
delete or overwrite time already invoiced/approved, reverse payments, remove
existing entities or restore an entire live organization automatically. For the
pilot, rollback acceptance is restore/recreate of the **owned disposable**
destination only; production cleanup requires a separately reviewed operator
plan with exact created-row lineage and current policy checks.

## Verification and release gate

Use sanitized, committed fixtures, not customer exports. The fixture matrix must
cover canonical Clockify headers, custom/extra/duplicate headers, quoted commas
and multi-line notes, BOM/UTF-8 failures, formula prefixes, limits, ambiguous
slash dates, 12/24-hour clocks, seconds, overnight/DST cases, missing dimensions,
archived/ambiguous matches, inactive/new people, destination rounding/rates,
locks/approvals, two identical rows, reordered files, changed mappings/files,
interrupted chunks, duplicate delivery and stale/revoked administrator sessions.
Assert a dry-run leaves the complete destination fingerprint unchanged.

A required acceptance harness owns a disposable container/SQLite destination
with fresh synthetic data and explicit identifier in its artifact. Record source
hash, adapter version, selected source/destination timezone and currency policy,
entity/row counts and exact source/destination seconds. Prove preview writes
nothing; first apply matches the expected row/assignment counts; same-input replay
adds zero; interruption/resume adds only the remainder; rejected/unsupported rows
are visible before apply; captured money and unrelated destination rows remain
unchanged; non-admin/token/cross-origin access is denied; raw input is purged on
the stated deadline without losing dedup/audit. Demonstrate cancellation's
partial state and recovery by recreating/restoring only this disposable target.
No production import or provider-account write is authorized by this plan.

A future Worker/D1 story must run the same matrix plus actual D1/R2/queue limits,
duplicate/out-of-order delivery and lease races in an owned disposable target.
An existing Harvest load proof is not evidence of CSV browser support. Enable
the browser capability only for the runtime whose whole chain passes; navigation
and help must describe the supported contract and exclusions accurately.

## Dependency-ordered implementation stories

The linked stories below are the execution plan. They remain implementation
work; merging this plan completes #1012's planning acceptance, not the wizard.
Clockify is the selected first browser provider and ISO-only detailed CSV is its
contract. A new provider requires a new adapter/fixture review against this same
boundary, not a universal-import marketing claim.

| Order | Story | Depends on | Delivery |
| --- | --- | --- | --- |
| 1 | [#1179: Clockify contract and sanitized fixture hardening](https://github.com/ConflictHQ/ezacto-pvt/issues/1179) | This plan accepted | Source-header limits/duplicates, explicit ISO/date-zone policy, exact-second fixtures and truthful existing CLI compatibility |
| 2 | [#1180: Reusable CSV planner/writer and sealed dataset identity](https://github.com/ConflictHQ/ezacto-pvt/issues/1180) | [#1179](https://github.com/ConflictHQ/ezacto-pvt/issues/1179) | Portable parser/hash ports, explicit administrator actor, existing-ledger extensions, immutable preview/run identity, non-mutating preview and atomic dedup |
| 3 | [#1181: Private administrator staging and preview API](https://github.com/ConflictHQ/ezacto-pvt/issues/1181) | [#1180](https://github.com/ConflictHQ/ezacto-pvt/issues/1180) | Container-only bounded upload, mapping/preview/status ownership, CSRF, diagnostics, retention and unsupported-runtime capability |
| 4 | [#1182: Administrator mapping and preview interface](https://github.com/ConflictHQ/ezacto-pvt/issues/1182) | [#1181](https://github.com/ConflictHQ/ezacto-pvt/issues/1181) | Responsive upload/map/preview flow, all errors/counts/exclusions, target/date-zone/currency review and explicit confirmation |
| 5 | [#1183: Durable apply, cancel/resume and disposable acceptance](https://github.com/ConflictHQ/ezacto-pvt/issues/1183) | [#1181](https://github.com/ConflictHQ/ezacto-pvt/issues/1181), [#1182](https://github.com/ConflictHQ/ezacto-pvt/issues/1182) | Fenced chunks through the existing writer, partial-state controls, replay/race proof, purge and owned end-to-end acceptance; container release gate |
| 6 | [#1184: Worker/D1 runtime adaptation, separately gated](https://github.com/ConflictHQ/ezacto-pvt/issues/1184) | [#1180](https://github.com/ConflictHQ/ezacto-pvt/issues/1180), [#1183](https://github.com/ConflictHQ/ezacto-pvt/issues/1183) | Equivalent planner, atomic D1 ledger writes and owned D1/R2/queue acceptance before enabling Worker UI |

## Apply contract for #1183

The executable contract for the durable apply (store port, authority recheck,
fenced lease, bounded retry, cancel, reconciliation) is
[`csv-apply-contract.ts`](../packages/migrate/src/csv-apply-contract.ts). Its
store invariants are pinned by a reusable suite, `describeApplyContract` in
`packages/migrate/test/csv-apply-suite.ts`, which any SQLite (and later D1)
store must pass; an in-memory fake runs it today. This is contract only: nothing
in production imports it, and it does not make the browser import available.

### Native planner foundation (#1180)

The reusable implementation boundary and native acceptance are documented in
[csv-browser-planner.md](csv-browser-planner.md). Registration/staging are
explicit mutations; direct preview performs only reads. Portable modules and
native SQLite primitives are distinct from the still-gated HTTP/UI/apply chain
and from the separately gated Worker/D1 adaptation.
