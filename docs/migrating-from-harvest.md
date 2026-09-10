# Migrating off Harvest

The happy path, for somebody who is not us.

[`cutover-runbook.md`](cutover-runbook.md) is the procedure CONFLICT ran against
its own account, with its own hostnames and row counts. This is the shape of the
thing, the order that matters, and the places it bites. It was written the day
the account was closed, from what actually happened rather than what was planned.

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
Ours read `$REDACTED` — matching the migrated database to the cent. If yours
disagrees with your migration, find out why before you click through.

The cancellation path itself is three retention screens deep, and `Cancel plan`
and `Close account permanently` are different decisions. Cancelling stops the
billing; closing starts a ten-day deletion clock.
