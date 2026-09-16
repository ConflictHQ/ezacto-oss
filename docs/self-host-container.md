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

Add `EZACTO_BOOTSTRAP_TOKEN` as well if you intend to create the owner over the
API rather than through the sign-up form. Step 4 explains the choice, which is
worth making before the instance is reachable rather than after.

```dotenv
EZACTO_BOOTSTRAP_TOKEN=REPLACE_WITH_32_RANDOM_BYTES_AS_BASE64URL
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
`http://127.0.0.1:3000`.

### Tell Ezacto how many proxies are in front

Behind a proxy, every request arrives from the proxy's address, and Ezacto rate
limits sign-in by client address. Left unset, that means **one shared bucket for
the whole instance**: ten sign-in attempts per fifteen minutes between all your
people, so one person retyping a password can lock everybody out, and a single
attacker can do it deliberately.

Set the number of proxies between the internet and the container:

```dotenv
TRUSTED_PROXY_HOPS=1
```

With that, Ezacto counts that many entries in from the right of
`X-Forwarded-For` and rate limits per visitor. One is right for a single Caddy,
nginx or Traefik in front. Add one for each additional hop, a CDN in front of
your proxy being the usual second.

**Set it only if the container is genuinely unreachable except through those
proxies.** `X-Forwarded-For` is a request header like any other, so anything
that can reach the container directly can choose its own value and therefore its
own rate-limit bucket, which is no rate limit at all. That is why the default is
`0`, which ignores the header completely. Publishing on `127.0.0.1` as above is
what makes the setting safe. Give container shutdown at least 30 seconds; Ezacto
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

A new instance has no accounts, and the first account to claim first run becomes
the administrator. Until you have claimed it, anyone who can reach
`APP_BASE_URL` can. Pick one of the two paths below before the instance is
publicly reachable.

The claim is permanent once made: an unverified claim is not currently released,
so a stranger who signs up first leaves you with no route in except the bootstrap
token below, or editing the database by hand.

### Either: the sign-up form, immediately

Open `APP_BASE_URL`, use the sign-up form, and follow the SMTP verification link.
The first verified account creates the organization and becomes its
administrator. Do this as soon as the container is healthy, before you point
public DNS at it or open the firewall.

### Or: the bootstrap token, at your leisure

Set `EZACTO_BOOTSTRAP_TOKEN` in the environment file before the first start.
**While it is set, `/auth/signup` is not served at all**, so the race described
above cannot happen: there is no form for a stranger to reach, and the window
never opens rather than merely being short. Two authenticated endpoints create
the owner without the sign-up form or an inbox:

```sh
curl -sS -X POST "$APP_BASE_URL/__ezacto/bootstrap" \
  -H "authorization: Bearer $EZACTO_BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"organization_name":"Example Co","owner_first_name":"Ada",
       "owner_last_name":"Lovelace","owner_email":"ada@example.com"}'

curl -sS -X POST "$APP_BASE_URL/__ezacto/bootstrap/owner-password" \
  -H "authorization: Bearer $EZACTO_BOOTSTRAP_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"password":"a long passphrase you have not used elsewhere"}'
```

Both answer `503` when the variable is unset, so the surface does not exist on an
instance that never enabled it. **Remove `EZACTO_BOOTSTRAP_TOKEN` from the
environment file and restart once you can sign in.** It is first-owner
authority, and it should not outlive the setup that needed it.

Either way, sign in, create a client and project, and record a test entry before
inviting anyone else.

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
