# Self-host with one container

This path runs the same Ezacto application and SQLite schema without a
Cloudflare account. One Node.js 22 container stores the organization database in
`/data/db.sqlite`, content-addressed attachments under `/data/attachments`, and
delivers authentication mail through your SMTP server.

Ezacto is pre-1.0. Pin a reviewed commit and complete a restore
drill before entering production books.

## Prerequisites

- Docker Engine with Compose optional, plus enough durable local or network
  storage for one named volume.
- An HTTPS hostname and a TLS reverse proxy. The image serves HTTP; terminate TLS
  in Caddy, nginx, Traefik, or the ingress you already operate.
- An SMTP endpoint reachable from the container. Both `smtp://` with STARTTLS
  and `smtps://` are accepted. The process verifies DNS, TCP/TLS, and SMTP
  authentication before it starts listening.
- This source checkout and Node.js 22 for the tested snapshot helper.

## 1. Build a pinned image

Check out the reviewed commit you intend to operate, then build and tag that
exact source:

```sh
git checkout YOUR_REVIEWED_COMMIT
docker build --pull --tag ezacto:YOUR_REVIEWED_COMMIT .
```

Do not use a moving application tag for recovery. The snapshot records the
source container's image reference and image ID so an operator can identify the
writer version later.

## 2. Create the environment file

Create this file outside the repository with mode `0600`:

```dotenv
APP_BASE_URL=https://time.example.com
API_CURSOR_SIGNING_KEY=REPLACE_WITH_32_RANDOM_BYTES_AS_BASE64URL
SMTP_URL=smtps://username:password@smtp.example.com:465
SMTP_FROM=Ezacto <billing@example.com>
ENVIRONMENT=production
RELEASE=YOUR_REVIEWED_COMMIT
```

Generate the signing key without writing raw bytes to disk:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The SMTP values are checked once at startup, and a failure there is a warning
rather than a refusal: the instance starts, logs the endpoint it could not
reach, and retries from the queue. That is deliberate — an instance that runs
and cannot send beats one that will not run, and a mail server that goes down
must not stop a restart. It also means you can bring an instance up to look at
it before you have a mail server, which is what the example above does:
`smtp.example.com` is the reserved documentation domain and will never deliver.
Replace it before anybody relies on mail arriving.

`APP_BASE_URL` must be the exact public HTTPS origin; only literal `localhost`
may use HTTP. Percent-encode reserved characters in the SMTP username and
password. Optional Google login requires both `OIDC_GOOGLE_CLIENT_ID` and
`OIDC_GOOGLE_CLIENT_SECRET`. Keep the environment file in the same protected
configuration backup as your reverse proxy and SMTP account; physical Ezacto
snapshots deliberately exclude secrets.

`SMTP_FROM` is also the only mailbox the container can attest for organization
invoice mail. An administrator must create an `smtp` sender identity whose
email and provider identity exactly match that mailbox, then refresh it before
selecting it as the default. The resulting status is **operator configured**:
Ezacto has matched deployment configuration, not verified DKIM, SPF, or DNS
alignment. Those remain the SMTP operator's responsibility. Changing
`SMTP_FROM` makes an older attestation unusable at send time until the matching
identity is refreshed.

## 3. Start the instance

Create one named volume and publish the application only on loopback for the
reverse proxy:

```sh
docker volume create ezacto-data
docker run --detach \
  --name ezacto \
  --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --volume ezacto-data:/data \
  --env-file /secure/path/ezacto.env \
  ezacto:YOUR_REVIEWED_COMMIT
```

Configure the reverse proxy to forward `https://time.example.com` to
`http://127.0.0.1:3000`. Give container shutdown at least 30 seconds; Ezacto
stops accepting requests, drains queued SMTP work within its budget, checkpoints
SQLite WAL, and closes the database before exit.

Confirm the container is healthy and non-root:

```sh
docker inspect --format '{{.State.Health.Status}}' ezacto
docker exec ezacto node -e "if(process.getuid()===0)process.exit(1)"
curl -fsS https://time.example.com/healthz
```

The listener opens only after configuration, SMTP verification, SQLite
integrity checks, and migrations succeed. If it does not become healthy, inspect
`docker logs ezacto`; the process reports the invalid contract by name without
printing its value.

## 4. Create the owner

Open `APP_BASE_URL`, use the sign-up form, and follow the SMTP verification link.
The first verified account creates the organization and becomes its
administrator. Sign in, create a client and project, and record a test entry
before inviting anyone else.

## Updates

Take a verified snapshot first. Build the new reviewed commit under a new image
tag, stop and remove the old container, then create a container with the same
named volume and environment file. Startup applies pending migrations and runs
SQLite checks before serving traffic.

Do not assume an old image can read a database after a new migration. Application
rollback and data rollback are separate operations; restore the pre-upgrade
snapshot into a new volume if the database itself must go back.

## Backup and restore

Follow [RESTORE.md](../RESTORE.md). The tested physical path requires a cleanly
stopped container, captures both `db.sqlite` and every attachment, verifies
SHA-256 before and after restore, requires the source container to be the
volume's sole reference, and refuses a non-empty or already-attached target.
It is a complete recovery mechanism for this one-container layout, but it is not
the portable D18 logical export promised by issue #28: it has no per-table CSV
files and is not a Worker-to-container escape bundle.

## Claim the instance before anybody else does

`POST /auth/signup` is how an instance is claimed: the first request creates the
organization and its administrator, and **the claim is permanent**. Between the
moment the hostname resolves and the moment you sign up, whoever reaches it
first becomes the owner — and if they abandon it without verifying, the claim
still stands and the real operator has no route back that does not involve the
database.

Two ways to close that window, and you want one of them:

- **Set `EZACTO_BOOTSTRAP_TOKEN` before the first deploy.** While it is set,
  `/auth/signup` is not served at all, and you claim the instance through the
  bootstrap endpoint instead. This is the option to prefer: the window never
  opens.
- **Or sign up immediately**, before announcing the hostname to anyone.

There is no third option where you deploy, get to it tomorrow, and are fine.
