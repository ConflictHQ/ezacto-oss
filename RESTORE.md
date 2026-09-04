# Ezacto backup and restore

This document separates the recovery path that exists today from the portable
backup format promised by D18. Do not discover that distinction during an
incident.

| Path                        | Current status                   | Protects                                           |
| --------------------------- | -------------------------------- | -------------------------------------------------- |
| Container physical snapshot | available and Docker-tested      | stopped `/data/db.sqlite` plus `/data/attachments` |
| D1 Time Travel              | Cloudflare-native, in-place undo | D1 database only; not R2 attachments               |
| Portable D18 logical bundle | **not implemented**              | future Worker/container escape bundle              |

## Container physical snapshots

The physical snapshot is for the [single-container layout](docs/self-host-container.md).
It is a directory containing:

```text
snapshot/
├── db.sqlite
├── attachments/
│   └── sha256/<prefix>/<sha256>
└── snapshot.json
```

`snapshot.json` records the writer image, source volume, byte size, and SHA-256
of the database and every attachment. It contains no SMTP credentials, signing
keys, reverse-proxy settings, or other environment configuration. Back those up
separately in a credential store the snapshot destination cannot overwrite.

This is deliberately called a _physical snapshot_, not a D18 bundle. It has no
`tables/*.csv`, no cross-runtime database conversion, and no activity event.

### Take a snapshot

Run these commands from the same reviewed Ezacto checkout used to build the
image. Choose a new absolute output path on storage outside the Docker volume:

```sh
docker stop --timeout 30 ezacto
node scripts/container-physical-snapshot.mjs backup \
  --container ezacto \
  --output /secure/backups/ezacto-2026-09-01T0100Z
docker start ezacto
```

The helper accepts only an exited source container with exactly one writable
named volume at `/data`, and only when that container is the volume's sole
Docker container reference. This prevents a second running or stopped container
from sharing the snapshot source. It refuses SQLite WAL/SHM sidecars, unexpected
root files, symlinks, special files, invalid content-addressed attachment paths,
or bytes whose hash differs from the attachment key. A failure removes only the
new output directory it created; it never changes the source volume.

Re-verify a copied snapshot at any time:

```sh
node scripts/container-physical-snapshot.mjs verify \
  --bundle /secure/backups/ezacto-2026-09-01T0100Z
```

Copy the verified directory to storage with independent credentials and
retention. Versioning or immutability protects old copies from a compromised
host deleting its own recovery points.

### Restore into a new volume

Prerequisites:

- the complete snapshot directory, not only `db.sqlite`;
- the same reviewed Ezacto checkout and the recorded image, or a newer image
  whose migrations you intend to apply;
- a protected environment file with the original public origin and working SMTP
  settings;
- a **new, empty** Docker named volume that no container references.

Verify first, create the target volume, and restore:

```sh
node scripts/container-physical-snapshot.mjs verify \
  --bundle /secure/backups/ezacto-2026-09-01T0100Z
docker volume create ezacto-restored-data
node scripts/container-physical-snapshot.mjs restore \
  --bundle /secure/backups/ezacto-2026-09-01T0100Z \
  --volume ezacto-restored-data \
  --image ezacto:YOUR_REVIEWED_COMMIT
```

The restore helper re-verifies every source hash, refuses any target volume
already referenced by a container, rechecks that it is empty, copies only
`db.sqlite` and `attachments`, applies the production image's UID/GID 1000
ownership with directory mode `0700` and file mode `0600`, then copies the target
back out and compares every byte to `snapshot.json`. If a restore fails after
writing begins, discard that new target volume and retry with another empty
volume; never merge a partial restore into existing data.

Start a separate validation container without reusing the old container name or
volume:

```sh
docker run --detach \
  --name ezacto-restored \
  --publish 127.0.0.1:3001:3000 \
  --volume ezacto-restored-data:/data \
  --env-file /secure/path/ezacto.env \
  ezacto:YOUR_REVIEWED_COMMIT
docker inspect --format '{{.State.Health.Status}}' ezacto-restored
curl -fsS http://127.0.0.1:3001/healthz
```

Startup performs `PRAGMA quick_check`, `foreign_key_check`, and pending
migrations before the listener opens. Sign in and verify a known time entry and
download at least one known attachment before moving the reverse proxy. Keep the
old stopped container and volume until validation and cutover are complete.

The CI test tagged `[e2e:backup-restore]` exercises these same helper commands. It
proves shared snapshot sources and already-attached restore targets fail closed,
then creates a real instance, uploads an attachment, stops and snapshots it,
deletes the source volume, restores a new volume, and proves both API row state
and exact attachment bytes through the restored application.

## Worker recovery today

Cloudflare D1 Time Travel can restore the database in place to a recent UTC
timestamp. It is destructive, cancels in-flight database work, and returns the
previous bookmark so the operation can be undone. Confirm the target database
name and timestamp with another operator, preserve the current bookmark, and use
Cloudflare's current [Time Travel procedure](https://developers.cloudflare.com/d1/reference/time-travel/).

Time Travel does **not** restore the `ATTACHMENTS` R2 bucket. If that bucket is
unchanged, restored database rows can continue to reference its immutable
content-addressed objects; if R2 objects are missing, Time Travel is not a
complete recovery. There is currently no supported command in this repository
that coordinates a D1 database export with an R2 attachment export or converts
that pair into a container snapshot.

## Portable D18 bundle: unavailable

D18 requires one verifiable, vendor-independent artifact containing a plain
SQLite database, one CSV per table, content-addressed attachments, a manifest
with per-file hashes and row counts, and its own restore instructions. Ezacto
does not yet produce that artifact. A Harvest migration snapshot is a different
input format and must not be presented as an Ezacto backup.

The exact missing implementation is tracked by:

- #28 — `ez backup`, `ez restore`, and `ez export --verify`, including the common
  D18 bundle writer and reader;
- #37 — nightly Worker D1 + R2 export in that identical format;
- #38 — scheduled off-platform S3-compatible sync;
- #39 — administrator download and Drive/Dropbox delivery;
- #40 — automated scratch restore and invariant drill.

Until #28 and #37 are complete, there is no honest portable Worker restore
command and no Worker-to-container escape procedure. The container physical
snapshot above is independently usable but does not close those dependencies.
