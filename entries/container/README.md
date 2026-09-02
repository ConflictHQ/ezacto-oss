# Ezacto container

The canonical operator walkthrough is
[`docs/self-host-container.md`](../../docs/self-host-container.md); tested backup
and recovery commands are in [`RESTORE.md`](../../RESTORE.md).

This entry runs the same Hono application and SQLite schema as the Worker entry in
one Node 22 process. It stores the complete organization database at
`/data/db.sqlite` and content-addressed attachments below `/data/attachments`.

Build the local image, create an environment file outside the repository, and run
it with a named volume:

```sh
docker build -t ezacto:local .
docker run --name ezacto --publish 3000:3000 --volume ezacto-data:/data \
  --env-file /secure/path/ezacto.env ezacto:local
```

Open the configured `APP_BASE_URL` and use the sign-up form. The first account
creates the organization and must receive and follow its SMTP verification link
before it can sign in.

The environment file must define:

```dotenv
APP_BASE_URL=https://time.example.com
API_CURSOR_SIGNING_KEY=<32 random bytes encoded as unpadded base64url>
SMTP_URL=smtps://username:password@smtp.example.com:465
SMTP_FROM=Ezacto <billing@example.com>
```

`APP_BASE_URL` must be an HTTPS origin in production; only `localhost` may use
plain HTTP. `SMTP_URL` is operator-supplied and may use `smtp://` (STARTTLS when
the server advertises it) or `smtps://` (TLS from connection start). The process
verifies DNS, TCP/TLS, and authentication before listening. Signup and password
reset therefore fail closed instead of claiming that an unsendable message was
queued.

Organization sender identities use a narrower deployment attestation. Only an
active `smtp` identity whose email and provider identity exactly equal the
normalized `SMTP_FROM` mailbox can be refreshed and selected; the API reports
that evidence as `operator_configured`. This does not claim that Ezacto checked
DKIM, SPF, or DNS alignment. Changing `SMTP_FROM` invalidates the old binding at
send time and requires a matching identity refresh.

Optional settings are `HOST` (default `0.0.0.0`), `PORT` (default `3000`),
`ENVIRONMENT`, `RELEASE`, and the Google OIDC variables used by the Worker entry.
The image runs as UID/GID 1000; bind mounts must be owned by that identity and the
data directory must not be a symlink. Keep an orchestrator stop grace of at least
30 seconds. Ezacto stops accepting requests, drains or terminates queued SMTP
work within one 25-second budget, checkpoints WAL, and closes SQLite before exit.

The image health check calls `/healthz`. A healthy response means startup
configuration, SMTP verification, SQLite integrity checks, and migrations all
completed before the HTTP listener opened.

The named volume is the durable unit. Stop the container cleanly before taking a
physical snapshot so WAL has been checkpointed. `RESTORE.md` uses the repository's
snapshot helper to retain `/data/db.sqlite` and `/data/attachments` together,
verify every attachment hash, require an exclusive source volume, restore UID/GID
1000, and refuse non-empty or already-attached target volumes. Startup reruns
integrity checks and pending migrations.

Treat the environment file as a secret. Do not put SMTP credentials or the cursor
signing key directly in shell history or source control.
