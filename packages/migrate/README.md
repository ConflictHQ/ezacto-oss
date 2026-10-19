# @conflict-hq/ezacto-migrate

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

Also in the box: `import-csv` (a vendor-neutral time CSV), `sync`,
`carry-invoices`, `finish-retainers`, `finish-recurring-invoices` and
`preflight-migrations`. `ezacto-migrate` with no command lists them all.

## What is in the package

One file, `dist/cli.js`. The ezacto domain and database code it needs is bundled
into it; `better-sqlite3`, `drizzle-orm` and `@noble/hashes` are the only runtime
dependencies. `better-sqlite3` is a native module, so install with lifecycle
scripts enabled.

## License

AGPL-3.0-only.
