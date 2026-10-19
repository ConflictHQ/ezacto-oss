# Ezacto backup and restore

This document separates the recovery path that exists today from the portable
backup format promised by D18. Do not discover that distinction during an
incident.

| Path                        | Current status                   | Protects                                           |
| --------------------------- | -------------------------------- | -------------------------------------------------- |
| Container physical snapshot | available and Docker-tested      | stopped `/data/db.sqlite` plus `/data/attachments` |
| D1 Time Travel              | Cloudflare-native, in-place undo | D1 database only; not R2 attachments               |
| Container logical bundle    | available (`ez backup`)          | database copy, one CSV per table, attachments      |
| Worker nightly CSV bundle   | written to R2; no restore command | one CSV per table, no schema, no attachment bytes |
| Off-platform S3 copy        | container bundles only (`--sync-to`) | a copy of a container bundle in your own bucket |

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

## Portable bundles: what exists, and what does not

D18 asks for one verifiable, vendor-independent artifact. Two writers exist
today and they do **not** produce the same format. Do not discover that during an
incident.

| | Container bundle (`ez backup`) | Worker nightly bundle |
| --- | --- | --- |
| Written by | the `ez` CLI, on demand | the Worker cron, once per UTC day |
| Lands in | a local directory `ezacto-backup-<timestamp>/` | the R2 bucket under `backups/<date>/` |
| Contents | `db.sqlite`, `tables/*.csv`, `attachments/`, `manifest.json`, `RESTORE.md` | `tables/*.csv`, `manifest.json`, `RESTORE.md` |
| Manifest | `format_version`, `database_sha256`, per-table `csv_sha256`, attachment hashes | `schema_version`, `bundle_version`, per-table `sha256`, `restore_skips` |
| Schema | inside `db.sqlite` | not included; rebuild it from the ezacto source |
| Attachment bytes | included | not included (they stay in R2) |
| Verify / restore | `ez export --verify`, `ez restore` | no command reads this format yet |
| Run status | the command's exit code | `backup_runs` and `GET /api/v1/backup/status` |

The Worker bundle is therefore a readable record of the rows, not a restore
path. Until a single format reads both, the honest Worker recovery is D1 Time
Travel (above), plus the SQL dump described next. A Harvest migration snapshot is
a different input format and must not be presented as an Ezacto backup.

### The nightly SQL dump (operational foundation)

`.github/workflows/backup-sql.yml` is a separate, operator-specific path (#773).
It exports the whole D1 database as SQL, writes a sha256 manifest, uploads to R2,
and deposits to S3 and GCS from GitHub Actions (gpg-encrypted when
`BACKUP_PASSPHRASE` is set; see [docs/security.md](docs/security.md)). It runs in
the prod environment only and has no resume beyond a rerun. It stays as it is: the
S3 sync below does not replace it.

## Copying a container bundle off-platform

A backup that lives with the thing it backs up is one account suspension from
being no backup. `ez backup` can copy the bundle to a bucket you own:

```sh
export AWS_ACCESS_KEY_ID=...        # a put-only credential is enough
export AWS_SECRET_ACCESS_KEY=...
export EZACTO_S3_REGION=eu-west-1   # default us-east-1
# MinIO or another S3-compatible service:
export EZACTO_S3_ENDPOINT=https://minio.example.test:9000   # path-style by default

ez backup --database /data/db.sqlite --attachments /data/attachments \
  --output /secure/backups --sync-to s3://my-bucket/ezacto
```

Objects land under `s3://my-bucket/ezacto/<bundle-name>/`. What the sync does:

- verifies the bundle first (manifest present, every hash matches) and refuses to
  upload anything from a bundle that fails;
- sends every object with `x-amz-checksum-sha256`, so the service rejects bytes
  that do not match, and checks the checksum the service reports back;
- writes `manifest.json` **last**. A prefix without a manifest is an incomplete
  upload; a prefix with one is complete;
- resumes: if it is interrupted, sync the same bundle again with
  `ez backup --bundle <bundle-dir> --sync-to s3://my-bucket/ezacto`. Objects
  already present with the same size and checksum are skipped. Running
  `ez backup --sync-to` without `--bundle` takes a new backup first, so it
  starts a new prefix rather than resuming.

Credentials come from the environment only (never a flag), and never from the
database or a settings table: a credential stored in the database is copied into
the backup it protects and into the bucket it opens. A credential that may write
but not read cannot tell the client what is already there, so every object is
uploaded again; with versioning on that costs storage, not safety.

Limits, stated plainly:

- **Not encrypted yet.** The bundle carries password hashes and authenticator
  seeds. The sync warns on stderr and sends it as is. Encrypt before it leaves
  (the rule in [docs/security.md](docs/security.md)) is a later slice; until then
  rely on a private bucket with server-side encryption, or encrypt the bundle
  yourself first.
- Each object is one PUT held in memory, so a single file over 5 GiB is refused.
  There is no multipart upload.
- Only AWS S3 and MinIO-style servers are exercised. Other S3-compatible vendors
  differ on checksum headers; a failure names the service's error code.
- The Worker nightly bundle is not synced by this command. The scheduled Worker
  sync, off-site status in `backup/status`, and a destination preflight are not
  built yet (#38).

### Make the bucket hard to destroy

The point of an off-platform copy is that a compromised host, a mistaken script or
a suspended account cannot erase it. Configure the bucket, not just the client:

1. **Versioning on.** Overwrites and deletes then add versions instead of
   destroying data. On AWS: `aws s3api put-bucket-versioning --bucket my-bucket
   --versioning-configuration Status=Enabled`.
2. **Object Lock** (set at bucket creation on AWS, which also forces versioning on)
   with a default retention in **compliance** or **governance** mode. A locked
   version cannot be deleted or overwritten until retention expires, even by the
   account owner in compliance mode. MinIO supports the same, also at bucket
   creation (`mc mb --with-lock`). Choose the retention deliberately: compliance
   mode cannot be shortened, and Ezacto never deletes, so you pay for what you lock.
3. **A put-only credential.** Grant `s3:PutObject` on the prefix and nothing else:
   no delete, no list, no `s3:BypassGovernanceRetention`. Add `s3:GetObject` only if
   you want resume to skip objects already uploaded. This is the pattern the SQL
   dump workflow uses through GitHub OIDC.
4. **Block public access and enable server-side encryption** on the bucket.
5. **Keep the destination credential outside the book it protects.** Use a
   different account, or at least a different login, from the one that runs the
   instance.
6. Lifecycle rules should expire only noncurrent versions you have chosen to
   release, never the current backup.

Restore from a copy by downloading the bundle directory with any S3 tool, then
`ez export --verify <dir>` and `ez restore <dir> --database <target.sqlite>`.
