# Migrating off Harvest

From an operator checkout, build the standalone tool with `npm ci` and
`npm run build -w @conflict-hq/ezacto-migrate`. Run
`node packages/migrate/dist/cli.js` in place of the installed `ezacto-migrate`
command below when the published package is unavailable. Keep the checkout,
credentials and snapshot files on the operator's machine.

The happy path, for somebody who is not us.

[`cutover-runbook.md`](cutover-runbook.md) is the full walkthrough of one real
production run, kept for what it observed. This is the shape of the thing, the
order that matters, and the places it bites. It was written the day that account
was closed, from what actually happened rather than what was planned.

## What you get, and what you do not

`ezacto-migrate` sweeps a Harvest account into a snapshot directory, proves the
snapshot is internally consistent, and loads it into an ezacto database. Time
entries, expenses, clients, projects, users, invoices with their line items,
payments, messages and PDFs all come across.

Four things do not, because Harvest has no API for them:

- **Retainer balances.** The id appears on an invoice; the balance is unreachable.
- **Recurring invoice definitions.** Same shape.
- **Estimates**, if `estimate_feature` is off on the account.
- **Sub-cent unit prices.** Harvest stores rates finer than a cent; ezacto stores
  integer cents. Invoice *totals* are exact; the per-unit rate loses precision
  and is recorded as an anomaly rather than silently rounded.

The first two are filled in by hand from worksheets. Plan for that — **it needs
the Harvest UI open**, which means it has to happen before you close the account.

## Running it

`ezacto-migrate` is published as `@conflict-hq/ezacto-migrate`. It needs Node 22
or newer and nothing else installed; there is nothing to clone or build.

```sh
npx @conflict-hq/ezacto-migrate            # prints the command list
```

The package installs a single bin, so `npx` runs it without naming it. The rest
of this guide writes `ezacto-migrate <command>`; put `npx @conflict-hq/` in front
of it, or install it once and use the short form:

```sh
npm install --global @conflict-hq/ezacto-migrate
ezacto-migrate auth --snapshot-dir ./snapshot
```

It reads a Harvest personal access token from `HARVEST_PAT` (Harvest ID >
Developers), or from a `.dev.vars` file in the working directory, and optionally
`HARVEST_ACCOUNT_ID`. The token needs administrator scope: a member-scoped token
sweeps a fraction of the account and `auth` says so. The token is never written
into the snapshot, but the snapshot is your account's data, so keep the
directory private and out of version control.

`better-sqlite3` is a native module, so install with lifecycle scripts enabled
(the npm default). If `npx` fails on a machine with no C++ toolchain, that is the
first place to look.

To prove an install works before pointing it at a real account, run the smoke
test from a checkout: `npm run test:package -w @conflict-hq/ezacto-migrate`
packs the package, installs it into an empty prefix, and drives the installed
binary through `npx` and the global bin. Add `--live` with `HARVEST_PAT` and
`HARVEST_ACCOUNT_ID` set (`node packages/migrate/scripts/test-package.mjs --live`)
and it also sweeps, verifies, loads and reconciles a real account into
temporary files, printing only exit codes and counts.

## The order, and why it is the order

```
auth → extract → verify → load → worksheets → convert → import
```

**Freeze first.** Agree a time after which nobody writes to Harvest, and mean it.
Everything downstream treats the snapshot as truth.

**Sweep last.** `extract` and `sync` are point-in-time. Anything that happens in
Harvest afterwards is not in your snapshot. This is not theoretical: on our
cutover day an invoice was re-sent eight hours after the sweep, and a client
opened it — two rows that only exist in the archive because we swept again.

**Worksheets after the load, and no sync afterwards.** Worksheet completions are
bound to the snapshot digest. A later `sync` moves that digest and voids every
one of them, with no in-app repair path. There is no incremental load to recover
with: you get a virgin database and the hand-entered rows typed again.

That trap is cheap to fall into. Running `extract` against a snapshot that
already exists — without noticing it exists — advances the watermarks and moves
the digest. That is all it takes.

**`verify` is a gate, not a formality.** It is the only check of the snapshot's
own internal consistency. Do not continue until it exits 0.

**`reconcile` is the other gate.** It compares Harvest's own report checksums
against your snapshot and your loaded database. The number to look at is
`unexplained`. Zero means every difference is accounted for; anything else means
one is not. Gaps are differences matched against the known-limitations list in
[`migration-spec.md`](migration-spec.md) §7 — they are accepted, not ignored.

## Running in parallel

A parallel run keeps Harvest as the book while you try ezacto on a copy of its
data. It works, with two limits that decide how to do it.

**What parallel means here.** `extract` and `sync` keep the *snapshot* current:
run them as often as you like while people keep working in Harvest. Loading is
the expensive, one-way step. Treat every load before the real one as a rehearsal
into a throwaway database file, and delete it afterwards:

```sh
ezacto-migrate sync    --snapshot-dir ./snapshot
ezacto-migrate verify  --snapshot-dir ./snapshot
ezacto-migrate load    --snapshot-dir ./snapshot --database ./rehearsal.sqlite
ezacto-migrate reconcile --snapshot-dir ./snapshot --database ./rehearsal.sqlite
```

**Limit 1: load is insert-if-absent, not upsert (issue 407).** A row is written
only if no row with its `harvest_id` exists. After a load, a row edited in
Harvest keeps its old values in the database even though `sync` refreshed it in
the snapshot, and a row deleted in Harvest stays in the database. Neither shows
up as a row-count difference. `reconcile` reports it: a nonzero `load currency`
row means the database is behind the snapshot, and `upstream_deletion` gaps name
the deleted rows still held. There is no refresh in place. The remedy is a new
load into an **empty** database file.

So do not enter real work into a database you may have to rebuild. Time typed
into a rehearsal copy is lost when it is replaced. The one database that people
work in is the one loaded after the freeze.

**Limit 2: worksheets are bound to the snapshot digest.** Retainer and
recurring-invoice completions are tied to the exact snapshot a load was admitted
under. Any later `sync` or `extract` that changes the snapshot moves the digest,
and every completion is void with no in-app repair; `load` also refuses a
database admitted under a different snapshot. A rebuild therefore means a
virgin database, a full reload, and the worksheet rows entered again. Keep the
filled worksheet JSON files: only their header digests need regenerating.

The order that follows from both: parallel-run on rehearsal databases, freeze,
final `sync`, `verify`, one real `load`, worksheets, `reconcile`, ship. No sync
after the real load. [`cutover-runbook.md`](cutover-runbook.md) section 1 walks
through the sequencing and what a late sync costs.

If the instance has already moved on (people are working in it) and you only
need invoices it is missing, `carry-invoices` below is the supported path; it
does not touch anything else.

## For an instance that has already moved on

`load` wants a virgin target and refuses one admitted under a different snapshot.
That is right for a cutover and useless afterwards: once people are working in
ezacto, reloading would take their work with it.

`carry-invoices` moves the invoices a live database is missing across from a
freshly loaded one, using the same importer `load` uses:

```sh
ezacto-migrate carry-invoices --source ./fresh-load.db --database ./live.db --dry-run
ezacto-migrate carry-invoices --source ./fresh-load.db --database ./live.db --only 1314
```

It resolves every reference by `harvest_id` against the target rather than
trusting row ids to line up, and it carries *missing* invoices — not updates to
invoices the target already has.

Do not hand-write these rows. `invoices` carries forty-five triggers, and an
imported line is admitted only while a matching `invoice_import_operations` row
is open. Copying finished rows verbatim is refused, correctly.

## Before you close the account

- [ ] `verify` exits 0 on the final sweep
- [ ] `reconcile` reports `unexplained 0`
- [ ] Both worksheets completed **while the Harvest UI is still reachable**
- [ ] Invoice count, client count and total invoiced match between Harvest and
      your database
- [ ] The snapshot is archived somewhere durable, checksummed, and you have
      verified the checksum after upload
- [ ] Every invoice has its PDF: cross-check invoice ids against the PDF manifest
      in both directions, and re-hash the files

That last one is worth doing properly. Counts matching is not the same as every
invoice having its own PDF.

## A free reconciliation on the way out

Harvest's account-closure page shows lifetime hours, projects and total invoiced.
On the run this was written from, that total matched the migrated database to the
cent — a whole-account end-to-end check, free, from the vendor being left. If
yours disagrees with your migration, find out why before you click through.

The cancellation path itself is three retention screens deep, and `Cancel plan`
and `Close account permanently` are different decisions. Cancelling stops the
billing; closing starts a ten-day deletion clock.
