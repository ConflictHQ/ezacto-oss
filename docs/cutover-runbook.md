# Harvest cutover runbook

The ordered procedure for moving CONFLICT's Harvest account into the hosted
prod instance at `app.example.com`. Every command here has been run; the
row counts, error strings and timings are observed, not estimated.

It assumes one operator working alone. Where a control would normally be "have
another operator confirm the database name" — as [RESTORE.md](../RESTORE.md)
says for Time Travel — this document substitutes something a single person can
actually satisfy: write the value down, then diff it against what the platform
reports.

Read it through before the window opens. Two of its steps are one-way, and both
of them are cheap to get right and expensive to redo.

| Stage | Produces | Clean rollback? |
| --- | --- | --- |
| Freeze, extract, verify | a snapshot directory | yes — re-extract |
| Load | a local SQLite database | yes — delete the file, reload |
| Worksheets | 4 hand-entered rows in that file | **no** — completions are one-way |
| Convert, import | a new hosted D1 database | yes — delete the database |
| Attachments | 6 objects in prod R2 | yes — content-addressed, additive |
| Binding swap and deploy | prod serving the imported data | yes — revert the commit |
| First sign-in / first write | live use | **no** — see [Rollback](#rollback) |

## 0. Preconditions

### Credentials

The operating credential is the wrangler OAuth session, not an API token.

```sh
unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000
npx wrangler whoami
```

A scoped `CLOUDFLARE_API_TOKEN` in the environment shadows the OAuth session and
will authenticate as the wrong account, or fail on the D1 write scope. Unset it
for the whole window rather than per command. `whoami` must report the CONFLICT
LLC account with Workers and D1 write scopes; the account id above is the one
this runbook's resources live in.

### Account ceilings that matter

The account is on Workers Paid, which is what makes the import possible at all.
The three limits this procedure comes near:

| Ceiling | Value | Where it bites |
| --- | --- | --- |
| Database size | 10 GB | the loaded database is ~24 MB — no risk |
| Single SQL statement | 100 KB | one long `INSERT` in the dump would abort the import |
| Import file | 5 GB | the converted dump is tens of MB — no risk |

`scripts/d1ify.py` measures the longest line — after conversion, every `INSERT`
is exactly one line — and refuses to write a file that breaches the 100 KB
statement cap, so the ceiling is checked before the upload rather than
discovered halfway through it.

### Tooling and the build

- Node 22 or newer, and a `npm ci` in the repo root.
- `sqlite3` 3.51 or newer, and `python3`.
- The migrate CLI built from the commit you intend to deploy:
  `npm run build -w ezacto-migrate`, invoked below as
  `node packages/migrate/dist/cli.js`.

Build the load and the Worker from the same commit. The loaded database carries
the migration ledger of the code that built it; if the ledger is behind the
deployed Worker, `ensureRuntimeDatabaseReady` applies the difference on the
first request after cutover (`entries/worker/src/runtime.ts`), so the first
minute of the cutover is a schema migration rather than a read. That is
survivable but it is not something to discover.

### What this runbook does not cover

The database and its attachments. Sign-in and outbound mail are separate
go-live work and are not gated by anything here:

- no identity provider is configured in prod, and most active people
  have no password row — SSO provisioning must be scoped before the secrets are
  set (#268, #270);
- prod has no email transport, so password reset and invoice send both return
  503 (#276);
- work email addresses are not seeded by the loader (#273).

Do not set the Google OIDC secrets before the load lands. Provisioning links a
Google subject to an existing verified address; with no migrated users present,
each sign-in creates a fresh duplicate account instead.

## 1. The sequencing constraint

**Final sync first. Then load. Then worksheets. Then ship. No sync afterwards.**

This is the one ordering mistake that costs a redo of manual work.

Worksheet completions are bound to the snapshot digest and to a context digest
computed over every linked invoice (`packages/migrate/src/worksheets.ts`,
`assertBoundContext` and `completedIds`). A later `sync` rewrites the manifest,
which moves `snapshot_sha256`, which voids every completion:

```text
worksheet evidence does not match the admitted snapshot and load options
```

There is no incremental load to recover with. `_ezacto_load_progress` resumes
only within one snapshot digest, and a new snapshot cannot be loaded into a
database already admitted under an older one:

```text
load admission belongs to a different snapshot or load options
```

So a late sync means a virgin database, a full reload of ~32,500 rows, and all
four worksheet rows re-entered by hand. Note this cuts against a naive reading
of the milestone order in [migration-spec §8](migration-spec.md#8-milestones),
where M6 (`sync` steady state) precedes M7 (worksheets): sync keeps the
*snapshot* fresh during the parallel run, but the moment you load the snapshot
you intend to ship, the parallel run is over.

Keep the filled worksheet JSON files regardless. If a late sync is forced on
you, only the header digests need regenerating — the operator's data can be
pasted back into the new worksheet.

## 2. Freeze, extract, verify

Agree the freeze time with whoever is still entering time in Harvest, and stop
entering after it. Harvest stays readable; nothing writes back to it, ever.

```sh
node packages/migrate/dist/cli.js auth --snapshot-dir ./harvest-snapshot
node packages/migrate/dist/cli.js sync --snapshot-dir ./harvest-snapshot
node packages/migrate/dist/cli.js verify --snapshot-dir ./harvest-snapshot
```

`auth` must report `administrator: yes`. A member-scoped token sweeps a fraction
of the account and says nothing about it.

`sync` is the final pass: an incremental extract plus a full-ID delete witness.
On a first run use `extract` instead; both are resumable and re-runnable.

Do not continue past `verify` until it exits 0 with no issues. It is the only
check of the snapshot's own internal consistency, and every later step treats
the snapshot as truth.

Record the snapshot digest now — it is printed by `load` below, and it is the
value every worksheet completion is bound to.

## 3. Load

The load target is a local SQLite file. Loading directly into hosted D1 is
milestone M5 and is unshipped; `--database` takes a filesystem path and nothing
else. The database is built locally, then imported whole.

```sh
node packages/migrate/dist/cli.js load \
  --snapshot-dir ./harvest-snapshot \
  --database ./cutover.db \
  --organization-currency USD
```

Expect on the order of 32,500 rows and a handful of anomalies. Before
continuing, confirm the shape of the file:

```sh
sqlite3 ./cutover.db "
  SELECT 'time_entries', count(*) FROM time_entries
  UNION ALL SELECT 'invoices', count(*) FROM invoices
  UNION ALL SELECT 'invoice_line_items', count(*) FROM invoice_line_items
  UNION ALL SELECT 'invoice_messages', count(*) FROM invoice_messages
  UNION ALL SELECT 'clients', count(*) FROM clients
  UNION ALL SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'file_objects', count(*) FROM file_objects
  UNION ALL SELECT 'migrations', count(*) FROM _ezacto_migrations;"
```

The rehearsal figures were 30,665 time entries, 739 invoices, 11,909 line items,
4,487 invoice messages, 30 clients, 60 users and 6 file objects. Treat those as
the expected order of magnitude, not as constants: the account keeps moving
until the freeze.

Two things to settle here rather than discover later:

- The loader's own bookkeeping tables (`_ezacto_load_admission`,
  `_ezacto_load_progress`, `_ezacto_load_anomalies` and six siblings, plus two
  indexes) are created by the load and never dropped. They go into prod with
  everything else. Keeping them is defensible — `_ezacto_load_anomalies` is the
  on-database record of the load's anomalies — but decide it, and note the
  decision, so the next schema audit is not surprised by nine unexplained
  tables. They cannot simply be dropped before the dump if you may ever need to
  resume a load: reconcile and the worksheet path both read them.
- `_ezacto_load_anomalies` is the itemised list behind
  [What "flawless" means here](#what-flawless-means-here). Read it now:

```sh
sqlite3 ./cutover.db "SELECT kind, count(*) FROM _ezacto_load_anomalies
                      GROUP BY kind ORDER BY 2 DESC;"
```

## 4. Worksheets

Four rows in the whole account cannot come from any API: one retainer balance
and three recurring-invoice definitions. Harvest exposes neither over its API,
so they are transcribed from the Harvest UI by hand.

Gather all four values **before** touching the CLI. A worksheet apply is
all-or-nothing — one incomplete row applies zero rows — and an applied row
cannot be corrected:

```text
recurring_invoice_definition for Harvest id 440932 has conflicting prior
completion evidence
```

Recovering from a wrong value means hand-deleting `_ezacto_worksheet_completions`
rows and resetting `recurring_invoices.definition_status`. Slow down here.

### Retainer

```sh
node packages/migrate/dist/cli.js finish-retainers \
  --snapshot-dir ./harvest-snapshot --database ./cutover.db > retainer.json
# fill in retainer.json, then:
node packages/migrate/dist/cli.js finish-retainers \
  --snapshot-dir ./harvest-snapshot --database ./cutover.db --input retainer.json
```

The one retainer is Harvest 12345 (a client), loaded with balance 0 and
`on_exhaustion='block'`, which means every drawdown fails at the trigger until
the opening balance is entered:

```text
retainer balance cannot overdraw or exceed its unit bound
```

`balance_cents` comes from the Harvest Retainers screen. `occurred_on` has no
source in Harvest at all — the screen is four columns with no ledger and no
dates — so adopt a convention and put the reason in `notes`, which is the only
free-text field that survives. The defensible choices are the paid date of the
last deposit invoice that built the balance, or the cutover date. Either is
fine; an unexplained date is not. A negative balance cannot be entered at all.

The retainer's project link and nominal size are not worksheet fields and are
lost by the load. If a `$0.00`-sized, project-less retainer in the UI is not
acceptable, set them directly after the import — this is verified to pass the
retainer triggers, and it is safe in either order relative to the worksheet:

```sh
npx wrangler d1 execute <new-database> --remote --command \
  "UPDATE retainers SET project_id = 52, amount_cents = 2400000,
     updated_at = '<iso8601>' WHERE id = 1;"
```

That `UPDATE` lives outside the loader and outside the worksheet completions
table, so it is **not** replayed by a reload. If you ever redo the load, redo
this too.

### Recurring invoices

```sh
node packages/migrate/dist/cli.js finish-recurring-invoices \
  --snapshot-dir ./harvest-snapshot --database ./cutover.db > recurring.json
# fill in recurring.json, then:
node packages/migrate/dist/cli.js finish-recurring-invoices \
  --snapshot-dir ./harvest-snapshot --database ./cutover.db --input recurring.json
```

All three definitions load `incomplete`, which means they are invisible to
`GET /recurring-invoices`, cannot be fetched, patched or deleted, and the
generation engine refuses them. They are live billing, not history: 466138 and
440932 have been issuing monthly, and 90 issued invoices in the loaded database
point at the three stubs. Leaving them incomplete silently stops that.

One transcription rule the schema does not hint at. Harvest's Halcyon Biolabs
definition (100001) carries a credit line at quantity `-1.0` × `$6,250.00`.
Transcribed faithfully the apply aborts:

```text
rows[2].amount_config.line_items[1].quantity must be positive and bounded
```

Quantity must be positive at three separate layers, including a SQL trigger, so
the encoding to use is **quantity 1 with a negative `unit_price_cents`**
(`quantity: 1, unit_price_cents: -625000`). That is arithmetically identical —
the line total is an integer ratio rounded half away from zero either way — and
it applies cleanly. Harvest itself uses both encodings elsewhere in the same
account.

Separately, note that a fixed-line definition repeats every month with no
period awareness. Harvest's line reads "CREDIT 1 of 4"; a static definition
will keep crediting from month 5 onward. The schema cannot express "four
times", so either omit the credit and invoice the remaining months by hand, or
diarise an edit to the definition. Decide before you type it, not after.

### The gate reconcile cannot give you

Reconcile is blind to the worksheets — it runs identically against a database
with all four completions and one with none. So this query, not the reconcile
report, is what proves the manual gap is closed:

```sh
sqlite3 ./cutover.db "
  SELECT (SELECT count(*) FROM recurring_invoices
            WHERE definition_status <> 'complete') AS incomplete_definitions,
         (SELECT count(*) FROM retainer_ledger)   AS retainer_ledger_rows,
         (SELECT count(*) FROM _ezacto_worksheet_completions) AS completions;"
```

`incomplete_definitions` must be 0 and `retainer_ledger_rows` must be non-zero
(the opening entry is only written when the balance is above zero). Derive the
expected completion count from the stubs — one per `retainers` row with a
`harvest_id`, one per `recurring_invoices` row — rather than hardcoding 4.

## 5. Reconcile

```sh
node packages/migrate/dist/cli.js reconcile \
  --snapshot-dir ./harvest-snapshot --database ./cutover.db
```

Run it last, so the report you file describes the database you shipped. The
order relative to the worksheets is otherwise free, because reconcile does not
read them.

**It will exit 1, and that is the expected result today.** The rehearsal run
reported 25,333 matches, 0 rounding failures, 4 gaps and 74 UNEXPLAINED. Zero
UNEXPLAINED is not reachable with the current tool: the classifier cannot
express an accepted delta (#277), so the deltas caused by rows the loader
deliberately skipped have nowhere to go but UNEXPLAINED.

The gate for this cutover is therefore not the exit code. It is:

1. every UNEXPLAINED row falls into one of the five known classes below;
2. the count has not grown since the last rehearsal;
3. nothing in the report is a delta you cannot name.

Diff the new `reconciliation-report.json` against the rehearsal's. A row you
have not seen before is an abort condition. See
[What "flawless" means here](#what-flawless-means-here) for the breakdown.

## 6. Convert the dump for D1

Hosted D1 rejects a raw `sqlite3 .dump` twice, and neither failure can be found
by rehearsing locally.

**First: the transaction wrapper.** `.dump` writes `BEGIN TRANSACTION;` on line
2 and `COMMIT;` on the last line. The remote importer refuses both:

```text
To execute a transaction, please use the state.storage.transaction() or
state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or
SAVEPOINT statements.
```

wrangler does have a routine that strips exactly this — but it is reachable
only from the local path. `executeRemotely` uploads the file byte for byte.

**Second: `unistr()`.** For any TEXT value holding a control character,
sqlite3 3.51 emits a `unistr('...\u000d\u000a...')` call rather than a plain
quoted literal. The rehearsal dump held 9,292 such calls across seven tables
(time entries 4,846; invoice messages 2,360; invoice line items 1,403; invoices
625; invoice payments 38; clients 18; email template versions 2). D1 refuses the
function outright:

```text
not authorized to use function: unistr at offset 60: SQLITE_ERROR
```

**Why a local rehearsal catches neither.** Local sqlite3 accepts both
constructs happily — it is what wrote them — so a round-trip through
`sqlite3 verify.db < dump.sql` proves nothing about D1. And the obvious dry run,
`wrangler d1 execute --local --file`, is actively misleading: its client-side
statement splitter pushes a frame for every ` CASE ` and never pops on `END,`
or `END)`, both of which occur in our triggers. On the trigger tail it collapses
372 `CREATE TRIGGER` statements into one. An operator rehearsing that way gets a
bogus failure on a file that is already correct, and may "fix" it. Do not use
the local path. Rehearse with `sqlite3` and import remotely.

The converter handles both rejections:

```sh
sqlite3 ./cutover.db .dump > ./cutover.sql
python3 scripts/d1ify.py ./cutover.sql ./cutover.d1.sql
```

It rewrites every `unistr('…')` as `CAST(X'<utf8 hex>' AS TEXT)` — byte-exact,
one line, no quoting hazards — and strips the wrapper by position, only from
the dump header and the final line, so a TEXT value containing either keyword is
never touched. It refuses to write an output file that still contains
transaction control or a `unistr(` call, and it reports the longest statement
against D1's 100 KB cap.

Decoding `unistr()` back to literal characters is not a safe alternative: the
sqlite3 CLI strips CR when re-reading a script, so CRLF inside a value would be
silently lost.

Rehearse the converted file locally, with sqlite3, and compare it against the
source database:

```sh
sqlite3 ./verify.db < ./cutover.d1.sql
for db in ./cutover.db ./verify.db; do
  sqlite3 "$db" "
    SELECT (SELECT count(*) FROM sqlite_master WHERE type='trigger'),
           (SELECT count(*) FROM sqlite_master WHERE type='index'),
           (SELECT count(*) FROM sqlite_master WHERE type='view'),
           (SELECT count(*) FROM time_entries),
           (SELECT count(*) FROM invoices);"
done
```

The two lines must be identical. Also confirm at least one CRLF-bearing value
survived the rewrite — this is the check that proves the conversion was
byte-exact rather than merely syntactically valid:

```sh
sqlite3 ./verify.db \
  "SELECT length(address), instr(hex(address), '0D0A') FROM clients WHERE id = 1;"
```

In the rehearsal that returned `66|41`. Whatever it returns, it must match the
same query against `cutover.db`.

## 7. Import into a new D1 database

Import into a **new** database. Do not attempt to reuse `ezacto-prod`.

The existing prod database cannot receive the dump — the first statement fails
with `table _ezacto_migrations already exists` — and it cannot be wiped first
either. The schema has a foreign-key cycle across 17 core tables, so no
child-first `DROP` order exists; `PRAGMA defer_foreign_keys` and DELETE-then-DROP
were both refused, and one attempt returned:

```text
D1 DB was reset and rolled back to its last known good state because the
application left the database in a state where constraints were violated
```

The failure mode of pushing that approach is a reset database, not a clean
refusal. A new database avoids all of it, and gives a far better rollback than
Time Travel: the old database is simply never written to.

Nothing is lost by abandoning the old one. The loaded database already carries
prod's identity rows — organization, owner, API token, bootstrap, password —
and it advances the invoice number sequence to its real value, which any
"keep prod and insert the data" scheme would have quietly destroyed. What is
lost is the drift: anything written to live prod after the load was built
(a session, a rotated token) disappears at the swap. Today that is one
re-login.

Record the abort point for the *old* database before anything else, and write
it into a file rather than relying on scrollback:

```sh
npx wrangler d1 time-travel info ezacto-prod --env prod | tee ./bookmark-old.txt
```

Then create and load the new one:

```sh
npx wrangler d1 create ezacto-prod-<date> | tee ./new-database.txt
npx wrangler d1 execute ezacto-prod-<date> --remote --file=./cutover.d1.sql
```

Answer `y` to the "this may take some time" prompt. The rehearsal ran 68,326
queries and wrote 281,011 rows in 7–12 seconds. Keep `new-database.txt` — the
uuid it prints is what goes into `wrangler.jsonc`, and diffing it against
`npx wrangler d1 list` is the single-operator substitute for a second pair of
eyes on the database name.

For roughly four of those seconds, reads against that database return
`internal error [code: 7500]`. Nothing sees half-loaded data — readers get the
pre-import state or the finished state — and a failed import leaves the database
exactly as it was. Because the cutover binds an already-loaded database, prod
never experiences this window at all.

## 8. Attachments into R2

Six expense receipts have rows in the loaded database and no bytes behind them.
The prod bucket is empty and nothing in extract, load, reconcile or CI ever
writes to R2, so this cannot self-heal and reconcile cannot detect it — it
compares manifest counts against database rows and never touches the object
store (#274).

The consequence of skipping this step is not a broken link. It is an opaque
HTTP 500 on every one of the six receipt downloads, indistinguishable in the
logs from a real outage.

Keys must be byte-identical to `file_objects.file_key`; there is no fallback
lookup. Take them from the database rather than from the filesystem:

```sh
sqlite3 -noheader -separator '|' ./cutover.db \
  "SELECT file_key, content_type FROM file_objects ORDER BY file_key;" |
while IFS='|' read -r key type; do
  npx wrangler r2 object put "ezacto-prod-attachments/$key" \
    --file="./harvest-snapshot/$key" --content-type="$type" --remote
done
npx wrangler r2 bucket info ezacto-prod-attachments
```

`object_count` must reach 6. Then fetch one through the app after the deploy —
`GET /api/v1/expenses/:id/attachments/:aid/content` — not just from the bucket.

Do **not** backfill through the app's own upload endpoint. It mints a different
key shape (`sha256/<xx>/<hash>`) while the loader recorded `receipts/<hash>.<ext>`,
and the content hash is unique, so the upload half-succeeds: 409
`attachment_conflict`, plus an orphan object under the wrong key that cannot be
cleaned up through the API. The same collision hits any later upload of bytes
matching a migrated receipt; that is a product bug, tracked separately, not
something to work around here.

Keep the snapshot directory after cutover. The nightly export backs up
attachment *metadata* only, so for these six objects the bucket and the snapshot
are the only two copies in existence.

## 9. Verify the imported database

Verify remotely, before the binding swap, so a bad import is discovered while
rollback is still free.

```sh
npx wrangler d1 execute ezacto-prod-<date> --remote --command "
  SELECT (SELECT count(*) FROM sqlite_master WHERE type='trigger') AS triggers,
         (SELECT count(*) FROM sqlite_master WHERE type='index')   AS indexes,
         (SELECT count(*) FROM sqlite_master WHERE type='view')    AS views,
         (SELECT count(*) FROM sqlite_master WHERE type='table')   AS tables,
         (SELECT count(*) FROM _ezacto_migrations)                 AS migrations;"

npx wrangler d1 execute ezacto-prod-<date> --remote --command "
  SELECT (SELECT count(*) FROM time_entries)       AS time_entries,
         (SELECT count(*) FROM invoices)           AS invoices,
         (SELECT count(*) FROM invoice_line_items) AS line_items,
         (SELECT count(*) FROM invoice_messages)   AS messages,
         (SELECT count(*) FROM clients)            AS clients,
         (SELECT count(*) FROM users)              AS users;"

npx wrangler d1 execute ezacto-prod-<date> --remote --command \
  "SELECT length(address), instr(hex(address), '0D0A') FROM clients WHERE id = 1;"
```

Every figure must equal the same query against `cutover.db`, with one exception:
the remote table count is one higher, because hosted D1 carries its own `_cf_KV`
table. The rehearsal saw 372 triggers, 206 indexes, 3 views, 94 local tables
(95 remote), 30,665 time entries, 739 invoices, 4,487 messages and 30 clients.

Compare, do not assume. The point of the check is that the numbers match the
file you built, not that they match this document.

`migrations` must equal the number of migrations in the build you are about to
deploy. If it is behind, the Worker will apply the difference on its first
request; know that before it happens rather than reading a 503 as a failure.

## 10. Swap the binding and deploy

Two files pin the prod database, and they must change in the same commit:

- `entries/worker/wrangler.jsonc` — `env.prod.d1_databases[0].database_name`
  and `database_id`;
- `.github/workflows/provision-d1.yml` — the `prod` matrix entry's
  `database_name`.

Missing the second one is a delayed failure, not a silent one: the next run of
that workflow resolves the old name and prints binding evidence telling the
operator to commit a revert back to the empty database.

Open the PR, merge, then run the `deploy` workflow for `prod`.

Nothing in CI checks the D1 binding. The deploy workflow has converge-and-accept
steps for Queues and R2 and none at all for D1, and its smoke gate does not
touch the database. The row-count assertion in the next section is the check,
and it is yours to run.

## 11. Prove the data plane

`/healthz` cannot detect a broken data plane. It is served by a module-scope app
built with no services — `isDataRequest` excludes it — and it echoes the
environment and release from vars without ever opening D1. A deploy with a wrong
database binding, an unparseable cursor key or a failing migration passes that
gate green while every API request returns 503.

An unauthenticated API request is the proof, because reaching the
authentication check at all means `createRuntimeServices` succeeded — binding,
cursor key, migrations:

```sh
curl -s -o /tmp/whoami.json -w '%{http_code}\n' \
  https://app.example.com/api/v1/whoami
cat /tmp/whoami.json
```

| Result | Meaning |
| --- | --- |
| `401` + `authentication_required` | the data plane is up — this is the pass |
| `503` + `service_unavailable` | runtime construction failed; the binding, the cursor key or a migration |
| anything else | investigate before announcing |

Readiness is cached per isolate, so one green probe proves the isolate that
answered. Poll it a few times over a minute rather than once.

Then prove the rows survived, with an authenticated read of a known client and
a known time entry through the UI, and fetch one of the six receipts.

Be aware that a 503 here is deliberately opaque: the failure is swallowed to
avoid reflecting binding values or SQL, and nothing is logged either. If you get
one, the diagnosis comes from re-running the remote count queries in §9 against
the database named in `wrangler.jsonc`, not from the response body.

## 12. The first day after

- **The morning after, check the nightly export.** The `0 3 * * *` cron writes a
  logical bundle to R2 and has never run against a populated database. Its
  failure path is caught and recorded rather than thrown, so a broken backup
  reports success to Cloudflare and shows up only as a row in `backup_runs`.
  Query it. Also know before you rely on it: that bundle omits a large number of
  tables, including `user_passwords` and the attachment link tables, and
  `ez restore` does not accept its format. It is not yet a restore path (#37,
  #40).
- **Watch the email dead-letter queue** if SES is configured during cutover
  week. Nothing consumes `ezacto-prod-email-dlq` and messages are dropped after
  four days. Set all SES variables in a single deploy: a partial SES
  configuration throws during runtime construction and fails *every* request,
  not just mail.
- **Keep the old database at least a week** before deleting it, and keep the
  snapshot directory indefinitely — it is the only other copy of the receipt
  bytes and the only re-derivation path for the load.

## Rollback

Rollback is different at every stage, and it stops being clean at a specific
moment. Know which side of that moment you are on before you act.

| Stage | Rollback |
| --- | --- |
| Before the load | Nothing has happened. Re-extract. |
| After the load, before the worksheets | Delete `cutover.db` and reload. Free. |
| After the worksheets | The four rows are one-way. A reload means re-entering them; keep the filled JSON so only the digests change. |
| After the import, before the swap | `npx wrangler d1 delete ezacto-prod-<date>`. Prod is untouched and still serving the old database. |
| After the R2 puts | Nothing to undo. The keys are content-addressed and the writes are additive; only delete them if you also roll back the database. |
| After the swap, before anyone signs in | Revert the binding commit and re-run the deploy. The old database was never written to. **This is the last clean rollback point.** |
| After live use begins | Not clean. See below. |

One honest detail about the revert: it is not perfectly read-only. Once the
Worker points back at the old database, the first request runs the migration
ledger check against it, so the rollback itself writes. Harmless, but it means
"the old database is never written to" stops being true the moment you use it.

**After live use begins**, reverting the binding abandons every row written
since the swap — new time entries, sessions, invoice state changes. There is no
merge path back into the old database. From that point the recovery tool is
Time Travel against the *new* database, which is destructive, cancels in-flight
work, and needs a bookmark you captured beforehand. Capture it immediately after
the import:

```sh
npx wrangler d1 time-travel info ezacto-prod-<date> | tee ./bookmark-new.txt
```

For a first cutover into an empty prod, "abort" is genuinely just "delete the
new database and redo it" — the account holds one organization, one user and no
business data, so there is nothing to lose by starting again. The bookmark
matters on the *second* attempt, once real work has been entered. Ask yourself
which one you are on; the answer changes what abort means.

## What "flawless" means here

**Zero UNEXPLAINED.** That is an honest bar again, and it is not met yet.

The loader deliberately skips rows the domain model refuses to represent, each
recorded as an anomaly. Those skips are documented in
[migration-spec §7](migration-spec.md#7-known-documented-gaps-from-research--decided-handling),
and reconcile now classifies their downstream deltas as gaps citing that
section — but only where the delta equals what the skipped rows would have
contributed, to the second and to the cent. An approximate match is still
UNEXPLAINED, which is what makes the citation worth anything.

The rehearsal's 74 UNEXPLAINED deltas decompose as:

| Cause | Rows | Nature |
| --- | --- | --- |
| 5 negative time entries | 52 | **now cited gaps** — Harvest nets its own correction entries into every report total; `time_entries.seconds` is `CHECK >= 0` |
| 3 sub-cent unit prices | 3 | **now cited gaps** — the IRS half-cent mileage rate and a repeating decimal, rounded half-even |
| 1 unresolved estimate reference | 1 | **now a cited gap** — the estimates module is off; there is nothing to link to |
| 4 archived-project uninvoiced rows | 0 | **not a gap at all** — Harvest's uninvoiced report lists active projects only; reconcile recomputed over archived ones |
| **7 non-positive payments** | **16** | **the one real blocker** — $0 and credit-note receipts, which `invoice_payments.amount_cents` cannot hold |

Sixteen remain, and all sixteen are the same cause: the seven skipped payments,
their seven invoices' restated `state`, the credit note's due amount, and the
`invoice_payments` row count. §7 says plainly that skipping is **not** a safe
handling for this class. Widening that CHECK (#283) is what stands between this
rehearsal and zero.

Re-run the numbers against the load you intend to cut over rather than trusting
this table.

Two consequences are worth stating plainly to whoever signs this off:

- **Seven invoices read `open` in ezacto that read `paid` in Harvest.** Invoice
  state is derived from imported payments, so dropping the seven non-positive
  payments left those invoices with none. Six are $0 invoices settled by $0
  payments — a label difference with no money attached. The seventh is a credit
  note that carries a negative amount due of -$8,765. Reconcile now compares
  `state` and the loader records an `invoice_state_disagreement` anomaly per
  invoice, so all seven appear in the report rather than six of them being
  invisible to it — they read as UNEXPLAINED, which is what they are until the
  payments themselves can load (#283). The durable record is also in the
  database, and this query is the check to run and keep:

```sh
sqlite3 ./cutover.db "
  SELECT source_state, target_state, count(*)
  FROM invoice_import_reconciliations GROUP BY 1, 2;"
```

  Expect `paid|open` rows equal to the non-positive payment count. Anything
  else is unexplained. Note that migration-spec §7 currently asserts these
  invoices keep the state Harvest gave them; that sentence is wrong and is being
  corrected (#283).

- **The 739 archived invoice PDFs and 54 avatars are not imported.** They are
  archived in the snapshot as evidence, not loaded: there is no PDF renderer in
  the product, and `avatar_url` remains the Harvest-hosted URL. If "my old
  invoice PDFs are in the new system" is anyone's expectation, it is unmet, and
  nothing will report it.

So the definition of done for this cutover, written honestly:

1. `verify` clean, and the load's row counts match the snapshot;
2. every reconcile UNEXPLAINED row falls into the five classes above, and the
   count has not grown;
3. the worksheet gate query in §4 passes;
4. the remote counts in §9 equal the local file;
5. six objects in R2, one of them fetched through the app;
6. `/api/v1/whoami` returns 401, not 503;
7. the two known deltas above written down and acknowledged, not discovered
   later by someone reading the books.
