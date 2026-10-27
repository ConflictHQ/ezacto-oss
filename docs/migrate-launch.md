# Standalone migration launch copy

Prepared for #98. These are publication drafts, not a claim that the npm release
or clean-machine acceptance has happened.

## Publication gates

Before publishing the copy below:

- Confirm the public npm release of `@conflict-hq/ezacto-migrate`, including its
  version and `ezacto-migrate` executable. Use the repository's publish workflow;
  do not publish a checkout with unpublished workspace dependencies.
- From a clean machine, run that published version against an authorized Harvest
  trial account. Record the version, runtime, extraction and verification result,
  and any friction. Keep credentials and snapshots out of the record.
- Verify the linked [migration guide](migrating-from-harvest.md), including the
  parallel rehearsal and final cutover sequence, against the release.

## Short announcement

Start moving off Harvest with one command:

```sh
npx @conflict-hq/ezacto-migrate
```

The standalone eZacto migration tool extracts a private snapshot of your Harvest
account, verifies it, loads an eZacto database, and reconciles the result. Start
with a rehearsal while Harvest remains your working system. Freeze writes only
for the final snapshot and cutover.

Migration is a reviewed sequence, not an unattended switch. Retainer balances
and recurring invoice definitions need manual worksheets; the guide explains
the remaining API limits and the checks to finish before closing Harvest.

Follow the [migration guide](migrating-from-harvest.md) for access requirements,
the commands, parallel operation, and cutover.

## README snippet

### Moving from Harvest

Use the standalone migration tool to extract, verify, load, and reconcile your
Harvest data:

```sh
npx @conflict-hq/ezacto-migrate
```

This command opens the command list. Follow the
[migration guide](migrating-from-harvest.md) for a rehearsal and the final
cutover. You will need Node 22 or newer and an authorized Harvest administrator
token. Keep the snapshot private; review the documented manual worksheets and
reconciliation results before closing the source account.

## Acceptance record

Keep the release evidence on #98: published package name/version, clean-machine
runtime, trial extraction result, verification and reconciliation totals, and
operator friction. Do not mark the issue complete from packed-install tests or
these draft assets alone.
