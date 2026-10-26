# Ezacto backup and restore

This document separates the recovery path that exists today from the portable
backup format promised by D18. Do not discover that distinction during an
incident.

| Path                        | Current status                   | Protects                                           |
| --------------------------- | -------------------------------- | -------------------------------------------------- |
| Container physical snapshot | available and Docker-tested      | stopped `/data/db.sqlite` plus `/data/attachments` |
| D1 Time Travel              | Cloudflare-native, in-place undo | D1 database only; not R2 attachments               |
| Container logical bundle    | available (`ez backup`)          | database copy, one CSV per table, attachments      |
| Worker nightly bundle (0038+) | typed snapshot, restored offline by `ez restore` | exact schema/rows and verified attachment bytes; resulting SQLite remains quarantined |
| Off-platform S3 copy        | scheduled encrypted Worker logical bundles; container bundles via `--sync-to` | copies in an operator-owned S3-compatible bucket |

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

Before destructive recovery, preserve separate **current** closure and retention
evidence from the same instance; the older backup alone cannot authorize a
restore. See the [reconciliation prerequisite](#restore-into-a-new-volume) below.

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
- a **separate, current, stopped/checkpointed database snapshot from the same
  instance**, including its closure and retention-review history. Capture and
  protect this evidence before deleting or replacing the source. An old backup
  being restored is not current evidence. If current evidence is unavailable,
  keep the restore offline;
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

### Reconcile privacy history before starting

After exact copy verification, the helper deliberately quarantines the restored
database. It cannot serve traffic yet. Quarantine and subsequent reconciliation
change the database, so its post-release byte hash is not expected to match the
original snapshot. Preserve the original verified bundle unchanged.

Follow the complete [container restore quarantine procedure](docs/account-retention-follow-through.md#container-restore-quarantine).
Keep the restored volume offline and mount the **separate current evidence**
read-only. For the names above, replay local closure history with:

```sh
docker run --rm --network none --user 0:0 \
  --mount type=volume,source=ezacto-restored-data,target=/data \
  --mount type=bind,source=/absolute/protected/current.sqlite,target=/evidence/current.sqlite,readonly \
  --entrypoint node ezacto:YOUR_REVIEWED_COMMIT \
  entries/container/dist/privacy-restore.js replay \
  --database /data/db.sqlite --current-database /evidence/current.sqlite
```

Replay alone is not permission to start. Review later free-text edits,
attachment and email removals, external copies, provider obligations, and queued
mail/integration work against current evidence, and reapply required changes
while offline. Record the actual reconciliation in a protected restore ticket.
Only after that review, run the same command with `release` instead of `replay`
and add `--evidence 'Your protected ticket reference and verified reconciliation result'`
(20–2000 characters). Release rechecks current evidence and local closure rules;
changed evidence requires another replay and review. Never clear quarantine by
editing its database flag directly.

Start a separate validation container only after release, without reusing the
old container name or volume:

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

## Worker bundle recovery (0038 and later)

Download one complete backup ZIP or decrypt one complete off-site run. Preserve
all relative paths. The manifest lists human-readable CSVs plus checksummed
`schema.json`, typed row chunks and content-addressed attachments. SQL NULL, empty
text, embedded NULs, blobs, int64 values and real numbers are distinct in the typed
snapshot; CSV is for inspection and must not be substituted as restore input.

Run the exact command supplied in the bundle, choosing new paths:

```sh
ez restore /secure/downloaded-bundle --database /secure/recovered/db.sqlite \
  --attachments /secure/recovered/attachments
```

The reader verifies every typed object and attachment, reconstructs the captured
schema and migration ledger, checks integrity and foreign keys, removes live
session/link/API-token authority and preserves calendar grant cleanup custody.
It publishes a private **quarantined** SQLite database with no-overwrite semantics.
Do not start service yet: preserve current evidence and use the offline replay
and reviewed release procedure described above. This command targets SQLite;
it does not replace a live D1 database or grant permission to serve old data.
A reviewed Container image can then use the recovered database and attachments.

Worker bundle 0037 and older cannot be restored losslessly: those CSVs conflate
NULL with empty text and do not carry the schema or attachment bytes. The CLI
explicitly refuses them. Use a separately retained SQL/physical backup or D1 Time
Travel for those generations; do not infer missing values from the CSV.

The exporter admits its snapshot inside one atomic D1 transaction before returning
rows. A conservative 64 MiB live-memory estimate includes cell/row overhead,
encoding and CSV copies; it is **not** a 64 MiB database-size allowance. Over-limit
exports fail before materializing rows and never publish a completed manifest.
Each typed chunk and attachment is limited to 16 MiB, matching the encrypted-copy
format. Larger books/files require the operator SQL and independent attachment
copy path until a paged snapshot exporter is supported. Backup status reports the
failure; operators must verify a completed current backup rather than assume one.

## D1 Time Travel recovery

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
| Contents | `db.sqlite`, `tables/*.csv`, `attachments/`, `manifest.json`, `RESTORE.md` | `tables/*.csv`, `schema.json`, `rows/`, verified `attachments/`, `manifest.json`, `RESTORE.md` |
| Manifest | `format_version`, `database_sha256`, per-table `csv_sha256`, attachment hashes | `schema_version`, `bundle_version`, per-table `sha256`, `restore_skips` |
| Schema | inside `db.sqlite` | captured exact schema and migration ledger in typed snapshot |
| Attachment bytes | included | included and verified against file/brand metadata |
| Verify / restore | `ez export --verify`, `ez restore` | `ez restore` verifies typed 0038+ objects and restores quarantined SQLite |
| Run status | the command's exit code | `backup_runs` and `GET /api/v1/backup/status` |

Legacy Worker CSV bundles remain a readable record rather than a lossless restore
path. New 0038+ bundles restore to quarantined SQLite as described above; D1 Time
Travel and the operational SQL dump remain separate recovery options. A Harvest migration snapshot is
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
- The container command does not read Worker bundles. Worker logical copies use
  the encrypted scheduled path below; the two bundle formats remain distinct.

## Scheduled encrypted Worker copies (L2)

The minute cron copies completed L1 logical bundles from R2 into a separate,
operator-owned S3-compatible bucket. Configure these **GitHub deployment environment
secrets** (`dev` or `prod`); the deployment renderer retains them during `secret
bulk`. A secret set only on the Worker is removed by the next managed deployment.

| Secret | Value |
| --- | --- |
| `EZACTO_BACKUP_S3_BUCKET` | Existing private bucket |
| `EZACTO_BACKUP_S3_ACCESS_KEY_ID` / `EZACTO_BACKUP_S3_SECRET_ACCESS_KEY` | Dedicated backup credential; separate from mail credentials |
| `EZACTO_BACKUP_ENCRYPTION_KEY` | Random 32-byte key encoded as base64url; retain it outside the instance |
| `EZACTO_BACKUP_S3_ENDPOINT` | Optional HTTPS S3-compatible endpoint; default AWS regional endpoint |
| `EZACTO_BACKUP_S3_REGION` | Optional; defaults to `us-east-1` |
| `EZACTO_BACKUP_S3_PREFIX` | Optional relative prefix; defaults to `<APP_BASE_URL hostname>/backups` |
| `EZACTO_BACKUP_S3_SESSION_TOKEN` | Optional temporary-credential session token |

Generate the encryption key locally with
`node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`
and save it in your secret manager and the deployment environment. The key and S3
credentials are never stored in the database or the source backup. Partial
configuration produces a visible E14 error; no configuration leaves L2 disabled.
Production endpoints require HTTPS. Native tests may use HTTP on loopback only.

Grant scoped `s3:ListBucket`, `s3:GetObject` and `s3:PutObject`; deletion is not
required. Check any additional KMS permissions if the bucket uses SSE-KMS.
Versioning, Object Lock, public-access blocking and bucket encryption guidance
below still apply. The implementation supports ordinary AWS S3 and MinIO-style
path addressing, rather than S3 Express directory buckets.

Each object is encrypted with AES-256-GCM before upload. Its random nonce, source
checksum and object identity are frozen before the first attempt; retries reuse
the same ciphertext. Headers expose the format, relative filename, key fingerprint,
nonce and plaintext checksum, but not the row contents or encryption key. Uploaded
bytes are verified using the service checksum or a bounded read-back. Conditional
PUTs refuse to overwrite a conflicting object. Requests include the SHA-256
checksum and algorithm headers required by [S3 Object Lock uploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html). `manifest.json.ezenc` is committed
last, so its absence identifies an incomplete copy.

The scheduler handles at most ten objects per pass with a 20-second scheduling
budget. A 2-minute ownership lease permits recovery after a killed process; a
failed pass retries from its receipts after five minutes. Missing or changed L1
objects fail visibly. Tables over 16 MiB require an operator export: this path has
no multipart upload. Source bundles remain available in R2.

Settings → Company → Backups separates the last L1 export from the last completed
L2 copy, shows progress and E14 failures, and offers **Check off-site destination**.
That administrator-only, authenticated POST writes and verifies an encrypted probe
under `runs/checks/`; a successful check is not a backup. The API exposes the same
facts at `GET /api/v1/backup/status` and the preflight at
`POST /api/v1/backup/offsite/check`. Expected failures use machine code
`offsite_backup_unavailable` and an E14 message. GET never performs a sync or check.

Copy paths are `<prefix>/runs/<sync UUID>/...`. To inspect a recovered copy,
download **one run directory**, preserving its relative paths, then run:

```sh
# Load the original key from your secret manager into the environment.
export EZACTO_BACKUP_ENCRYPTION_KEY=...
ez backup-decrypt /secure/downloaded-run --output /secure/new-plaintext-directory
```

The command needs no account credential. It authenticates every object, verifies
all CSVs against the decrypted manifest, rejects symlinks/unexpected paths, and
writes a new private directory. Wrong keys or damaged input remove its partial
plaintext output; an existing output directory is refused. Retain old keys when
rotating: a new key/destination produces new copy identities, and cannot decrypt
previous copies.

**Recovery limit:** legacy Worker logical copies lack attachment bytes and a
lossless reader. New 0038+ copies include the typed snapshot and verified attachments,
but do not automatically replace D1. Keep the physical/SQL recovery paths and attachment copies described
above. Container operators can schedule `ez backup --sync-to` with their own cron;
that command still has the separate format and encryption limits stated above.

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

## Monthly retained-backup drill

The `restore-drill` Actions workflow restores the latest verified R2 SQL backup
in private scratch SQLite, checks integrity, foreign keys, invoice accounting
invariants and every recorded table count, then deletes the scratch copy.
`backup.restore_drilled` in the activity log records both passing and failing
results without row contents. The [operator guide](docs/operator-guide.md#monthly-operational-sql-restore-drill)
describes scheduling, manual dispatch, the 72-hour freshness bound and the
initial updated SQL backup needed to publish its latest-complete pointer.
This offline drill never starts an application or replaces a live database.
