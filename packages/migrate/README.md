# @conflict-hq/ezacto-migrate

## Queued Worker loads

The source build supports a verified snapshot in the target's existing R2
`ATTACHMENTS` bucket, processed by its `MIGRATION_QUEUE` into an **empty** D1
database. The container keeps the local SQLite `load` command. This is an
operator migration tool; these commands do not authorize a customer cutover.

Deploy the matching source and provision both queues first. The target's exact
checksum-verified migration ledger must match this CLI. Set
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the process environment;
the token needs D1 read/write, R2 object read/write and Queues write permission.
Use the target deployment's D1 UUID, attachment bucket and migration queue ID,
not its email queue. Tokens have no command-line argument and never enter the
catalog, database options, queue body or status output.

```sh
# Build this checkout; no new npm release is implied.
npm run build -w @conflict-hq/ezacto-migrate
node packages/migrate/dist/cli.js queue-upload --snapshot-dir ./snapshot \
  --target-d1 "$D1_ID" --bucket "$R2_BUCKET" --queue-id "$MIGRATION_QUEUE_ID"

# Review the printed run UUID, target and snapshot hash. Upload does not start loading.
node packages/migrate/dist/cli.js queue-start --run-id "$RUN_ID" \
  --target-d1 "$D1_ID" --confirm-target-d1 "$D1_ID" \
  --bucket "$R2_BUCKET" --queue-id "$MIGRATION_QUEUE_ID"
node packages/migrate/dist/cli.js queue-status --run-id "$RUN_ID" \
  --target-d1 "$D1_ID" --bucket "$R2_BUCKET" --queue-id "$MIGRATION_QUEUE_ID"
```

Upload prints the run identity before streaming. Repeat `queue-upload` with that
`--run-id` after an interrupted transfer: matching remote objects are hashed
and reused; different bytes are refused. Only declared raw rows, lineage,
manifest/checksums and content-addressed receipt/avatar/invoice-PDF assets are
uploaded. `auth.json`, `.dev.vars`, locks and unrelated files are excluded.
An optional `--input` JSON contains only `organizationCurrency`,
`organizationAddress` and explicit `userIdentity` aliases/work emails;
unknown fields, including credentials, are rejected. Existing organization
currency/address flags override those two input decisions.

Admission is bounded: metadata files 2 MiB each, catalog 1 MiB, options 256 KiB,
raw objects 256 MiB each, raw lines 1 MiB, binary assets 16 MiB each, at most
8192 files and a 4 MiB decoded child-index budget. Oversized inputs fail before
enqueueing. The Worker streams raw rows and pins every range request to its
uploaded ETag. Index checkpoints commit atomically in R2; row checkpoints and
lease fencing remain in D1.

The target is reserved after verified upload. Normal API, cron and email work
wait until loading completes. Use Cloudflare operator `queue-status` during
this quarantine; it works before the first native account exists. Afterwards,
`GET /api/v1/migration-loads/:id` exposes safe progress to administrator sessions
and refuses API tokens. Privacy-restore quarantine remains independent.

Duplicate deliveries cannot apply a row twice. A lost queue publication is
recoverable from its durable continuation intent; repeat `queue-start` to
republish a queued/running run if transport retries exhaust. A live lease must
expire before a replacement can take over. Poison input has five transport
retries and a separate dead-letter queue. Investigate a failed run's code and
the DLQ; `queue-retry` resumes the same immutable input after its cause is
resolved. It requires `--confirm-target-d1`, as does `queue-cancel`.
Cancellation stops loading; **a partial target stays quarantined and is not
rolled back**. Recover or replace that destination before serving books.

Verified completion deletes raw rows, manifest/checksums and rebuildable index
objects. Receipt/avatar/PDF objects remain as imported attachments or archives.
Status records `sourceCleanedAt`; a cleanup error remains visible and
`queue-retry` retries cleanup on a completed run. Incomplete/cancelled sources
remain private for diagnosis and recovery; purge them only after deciding how
to recover the destination. The CLI's control connection may exit immediately
after starting: the Worker owns subsequent chunks.

Move a Harvest account into [ezacto](https://ezacto.dev): sweep it into a
snapshot, prove the snapshot is consistent, load it into an ezacto SQLite
database, reconcile, and sync again until you cut over.

```sh
npx @conflict-hq/ezacto-migrate
```

Prints the command list. Node 22 or newer. The package installs a single
command, `ezacto-migrate`, so `npx` runs it without naming the bin. To keep it
on your path instead:

```sh
npm install --global @conflict-hq/ezacto-migrate
ezacto-migrate
```

## The short version

```sh
export HARVEST_PAT=<token from Harvest ID > Developers>
export HARVEST_ACCOUNT_ID=<your account id>

npx @conflict-hq/ezacto-migrate auth      --snapshot-dir ./snapshot
npx @conflict-hq/ezacto-migrate extract   --snapshot-dir ./snapshot
npx @conflict-hq/ezacto-migrate verify    --snapshot-dir ./snapshot
npx @conflict-hq/ezacto-migrate load      --snapshot-dir ./snapshot --database ./ezacto.sqlite
npx @conflict-hq/ezacto-migrate reconcile --snapshot-dir ./snapshot --database ./ezacto.sqlite
```

The token is read from the environment or a `.dev.vars` file and is never
written into the snapshot. Keep the snapshot directory private: it holds your
account's data.

Run the steps in that order and read the guide before the first real run. It
covers what does not come across, the order that matters, running ezacto
alongside Harvest, and cutting over:
[Migrating off Harvest](https://github.com/ConflictHQ/ezacto-oss/blob/main/docs/migrating-from-harvest.md).

Also in the box: `import-csv` (a vendor-neutral time CSV, a Toggl export, or a Clockify export), `sync`,
`carry-invoices`, `finish-retainers`, `finish-recurring-invoices` and
`preflight-migrations`. `ezacto-migrate` with no command lists them all.

## What is in the package

One file, `dist/cli.js`. The ezacto domain and database code it needs is bundled
into it; `better-sqlite3`, `drizzle-orm` and `@noble/hashes` are the only runtime
dependencies. `better-sqlite3` is a native module, so install with lifecycle
scripts enabled.

## License

AGPL-3.0-only.
