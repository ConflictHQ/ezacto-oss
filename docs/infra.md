# Infrastructure (OSS)

Scaffolding decisions for hosting, domains, env, CI. Product code lands per
`PLAN.md`; this file is the ops contract it lands into.

## Domains (owned at Porkbun, all five zones live on Cloudflare; see umbrella D1 record)

| Host | Role | When |
| --- | --- | --- |
| `app.example.com` | **OUR production instance** — the dogfood deployment, and the OSS gate | now |
| `ezacto.io` | **the dev deployment**, on the apex; becomes the public demo | now |
| `ezacto.dev` | developer site for the OSS project — docs + self-host guides, GitHub Pages (the `planopticon.dev` pattern: apex CNAME → `conflicthq.github.io`, proxied) | v1.0 |
| `portal.example.com` | the umbrella portal (private, behind Access) | live |
| `ezacto.com` | marketing site. Also carries Google Workspace MX and the Mailgun `go.` sending subdomain — **do not point an app at it** | v1.0 launch |
| `ezacto.ai`, `ezacto.net` | parked | — |

Two deployments, and only two. Per-branch preview Workers are how an account
grows forty of them; targets here are hosts we own and name. `app.ezacto.dev` —
the earlier plan for our instance — is dropped in favour of `app.example.com`.

## Hosting

- Default target: **Cloudflare Workers + D1** (one database per org), Queues for
  jobs, R2 for receipts + logical exports. Workers **Paid** plan required (D1
  30-day Time Travel, higher limits).
- Second target: **single container** (Node 22 + SQLite file) — same codebase.
- The Worker entry is `entries/worker`: thin Hono, an instance-identity page, and
  `/healthz` reporting the environment and the commit actually running.
- `workers_dev` is **false in every environment**. The default `*.workers.dev`
  subdomain serves the same Worker with nothing in front of it — a side door
  around whatever gates the custom domain.
- D1/R2/Queues bindings land in `wrangler.jsonc` with the stories that use them.
  A binding nothing reads is a lie about what the Worker needs.

## Backups (D3 / D18)

- Available now: hosted D1 Time Travel (30 days on the Paid plan, per-minute,
  on by default) and a stopped-container physical snapshot of `db.sqlite` plus
  attachments. Restore is a confirmed operator action, never automatic.
- Planned, not yet implemented: the shared D18 logical bundle, nightly Worker
  export to R2 (#37), and `ez backup` / `ez restore` (#28). The physical
  container snapshot is not that portable bundle. See [`RESTORE.md`](../RESTORE.md).

## Env & secrets

Registry lives in `.dev.vars.example` (copy to `.dev.vars` locally). Rules:
secrets never in git; production secrets only via `wrangler secret put` or CI
secrets; every new env var lands in `.dev.vars.example` in the same PR that
reads it.

CI holds two repository-wide Cloudflare credentials. They are consumed only by
`deploy.yml` and the manual `provision-d1.yml` / `provision-queues.yml` /
`provision-r2.yml` workflows:

| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | scoped deploy/provision token — account: Workers Scripts Write, Workers Observability Write, Account Settings Read, **D1 Edit**, **Workers R2 Storage Edit**; zone: Zone Read, Workers Routes Write, DNS Write, **limited to `example.com` and `ezacto.io`** |
| `CLOUDFLARE_ACCOUNT_ID` | the deploying account's id (not a secret in itself; held as one so it stays out of the tracked config) |

R2 bucket discovery and creation use Cloudflare's account REST API. In the API
token editor, grant **Account > Workers R2 Storage > Edit** and scope it to the
same account named by `CLOUDFLARE_ACCOUNT_ID`. A Worker R2 binding does not by
itself grant the deployment token permission to list or create buckets. The
workflow prints only this permission requirement on HTTP 403; it never prints
the token, account ID, or Cloudflare response body.

Each GitHub environment (`dev`, `prod`) also holds its own
`API_CURSOR_SIGNING_KEY`: canonical unpadded base64url for exactly 32 random
bytes. `deploy.yml` installs it through `wrangler secret put` before every deploy,
so tracked config never contains secret material. The two environments must not
share a key.

Browser sign-in uses the provider-generic OpenID Connect core with `google` as
the first configured provider. Google publishes discovery at
`https://accounts.google.com/.well-known/openid-configuration`; that document
currently identifies `https://www.googleapis.com/oauth2/v3/certs` as its JWKS.
The runtime follows and validates discovery rather than hardcoding endpoint
responses, requires PKCE S256, and pins ID tokens to RS256.

Create two Google OAuth Web clients, not one shared client, and register exactly
one callback on each:

| GitHub environment | Callback |
| --- | --- |
| `dev` | `https://ezacto.io/auth/oidc/google/callback` |
| `prod` | `https://app.example.com/auth/oidc/google/callback` |

Store each client's `OIDC_GOOGLE_CLIENT_ID` and
`OIDC_GOOGLE_CLIENT_SECRET` in its matching GitHub environment. `deploy.yml`
converges the cursor key and Google pair in one Wrangler `secret bulk` request.
If both Google values are absent, that request sends explicit `null` values to
delete any stale Worker copies; if only one is present, validation fails before
the remote mutation. Provider access
tokens, ID tokens, refresh tokens, authorization codes, and raw browser state
are never persisted. OIDC starts are limited to 20 per hashed Cloudflare client
address in a rolling 10-minute window. Each start transactionally removes
expired rows; consumed rows become eligible for cleanup no later than expiry.

Transactional email uses the SES v2 HTTPS API; SMTP is not part of the Worker
contract. Each GitHub environment supplies `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` as secrets, with `AWS_SESSION_TOKEN` when temporary
credentials are used. It supplies `SES_REGION`, `SES_FROM`, and optionally
`SES_CONFIGURATION_SET` as environment variables. `deploy.yml` validates
configuration completeness before mutating Worker secrets, and the provider
validates every value before runtime use. A partial or invalid contract fails
closed; absent SES secrets are converged to explicit `null` deletions.

The IAM principal needs only the region/account resources used by the instance
and these actions: `ses:GetAccount`, `ses:ListEmailIdentities`,
`ses:GetEmailIdentity`, `ses:GetSuppressedDestination`, and `ses:SendEmail`.
The configured sender identity must be verified with healthy DKIM in
`SES_REGION`. When a configuration set is named, create it in that same region
and attach event destinations for delivery, bounce, complaint, and rejection
events. Provider errors never include AWS response bodies in the delivery log.

SES v2 `SendEmail` has no idempotency token. Ezacto signs a stable
`ezacto-email-<delivery-id>` correlation value into an SES message tag and
custom header, while the durable queue lease fences concurrent attempts and the
receipt is persisted before acknowledgement. A provider success followed by a
database failure may still be redelivered, so this is an auditable at-least-once
boundary rather than a false exactly-once claim.

Live acceptance for issue #46 requires real sandbox configuration: provision
the Queue binding tracked by issue #43, verify the sender and sandbox recipient,
confirm account/sending/DKIM health, send through the deployed Queue consumer,
and verify the administrator email log contains the real SES `MessageId`, AWS
request ID, and latency. Then add a sandbox recipient to the account suppression
list and prove no `SendEmail` request occurs while the exact terminal reason is
logged. Synthetic fixtures do not satisfy that acceptance.

Each environment also holds one `EZACTO_BOOTSTRAP_TOKEN`, a canonical `ezacto_`
bearer generated independently for that instance. It is the first owner token,
not a general deployment secret: `bootstrap-instance.yml` temporarily installs
it on the Worker, persists only its selector and SHA-256 digest, proves the live
API and compiled CLI can authenticate, and removes the Worker copy in an
`always()` cleanup step. Store the original bearer in the operator's local CLI
or credential manager when it is generated: GitHub retains it for automation but
will not reveal it later. Workflow logs and artifacts never contain it.

Each environment also stores `EZACTO_OWNER_PASSWORD` for the explicit
`bootstrap browser owner` workflow. It is not a deployment variable and is never
installed as a Worker secret. The workflow reads it only into masked step
environment, sends it in runner-temp request bodies, accepts the real browser
session lifecycle, and removes those files. The value must contain 12–1024
Unicode code points and no more than 4096 UTF-8 bytes. Validation names a missing
or invalid secret and restates this policy, but never reports the supplied value,
its observed length, or derived data. Keep the same value in the owner's password
manager; GitHub cannot reveal it after it is stored.

The Cloudflare token cannot touch any other zone, and cannot create zones. Rotate
it by issuing a new token and replacing the repository secret; revoke the old one
after the first green deploy.

## D1 provisioning

Run the manual `provision D1` workflow once before adding bindings. It converges
the exact database each environment names: `vars.DEV_D1_DATABASE_NAME`
(`ezacto-dev`) and `vars.PROD_D1_DATABASE_NAME` (`ezacto-prod`), the same
variables `render-wrangler-prod.mjs` reads, so a rename lands in one place. An
existing exact-name match is reused, no match is created, and duplicates fail
closed. The workflow uploads a short-lived JSON artifact and job summary
containing the non-secret database ID for each environment, and installs that
environment's cursor-signing secret.

Commit the reported IDs under the matching `env.dev` and `env.prod`
`d1_databases` entries in `entries/worker/wrangler.jsonc`. The normal deployment
then applies the binding and its smoke gate proves the exact release is live.

## Queue provisioning

The automatic dev deploy converges its exact resources before it mutates Worker
secrets or bindings. Prod remains an explicit operator action: run the manual
`provision Queues` workflow for `prod` before its tracked Queue binding is first
deployed. The same workflow can explicitly converge dev when needed. Both paths
read the names from `entries/worker/wrangler.jsonc`, reuse an exact-name match,
create a missing resource, and fail closed on duplicates. They provision both
the delivery Queue and its dead-letter Queue:

Cloudflare's Queue list/create API accepts the existing Workers Scripts Write
permission, so this does not broaden the repository token beyond the deployment
scope already documented above.

| Environment | Delivery Queue                                    | Dead-letter Queue         |
| ----------- | ------------------------------------------------- | ------------------------- |
| `dev`       | `ezacto-dev-email`                                | `ezacto-dev-email-dlq`    |
| `prod`      | `vars.PROD_EMAIL_QUEUE` (`ezacto-prod-email`) | the same name with `-dlq` |

The same Worker is the `EMAIL_QUEUE` producer and push consumer. The consumer
accepts one message per batch with one concurrent invocation while SES sandbox
limits are in play. Cloudflare's bounded platform maximum of 100 Queue retries
is the transport-failure budget, not a provider-call count: lease contention,
D1 receipt persistence, and unexpected consumer failures can all consume Queue
deliveries without consuming a provider attempt. Its five-second default retry
delay matches the attempt-lease contention delay and prevents a hot retry loop.
The durable `email_log.attempt_count` independently limits provider I/O to five
claims and supplies the explicit per-message `60 / 300 / 900 / 3600` second
provider backoff, which overrides the Queue default. Provider exhaustion is
persisted and acknowledged. A message that still cannot complete after 100
transport retries reaches the dead-letter Queue instead of being discarded.

Every dev deploy idempotently converges both resources; a prod deploy only
checks them and fails before changing secrets when the operator has not run
provisioning. After `wrangler deploy`, both paths read Cloudflare's Queue API and
verify the exact Worker producer, consumer, dead-letter target, batching,
concurrency, and retry settings before the host smoke test can pass.
`APP_BASE_URL` is a tracked per-environment Worker variable so a configured
Queue and SES provider actually enable queued authentication mail.

Resource provisioning alone does not satisfy live mail acceptance. Each GitHub
environment still needs its SES credentials and static variables described
above; the sender and any sandbox recipient must be verified in AWS before a
real password-reset delivery can be accepted.

## Instance bootstrap

After the D1 binding is deployed, run the manual `bootstrap instance` workflow
for that environment with the organization and owner identity. The database must
already be migrated and its organization, user, email, and token tables must be
empty. The workflow creates exactly one organization, active administrator owner,
verified primary email, and all-scope owner API token in one D1 batch transaction.

The first statement claims a singleton audit record; the last statement asserts
the complete seeded state. An identical retry is a no-op, while different input,
pre-existing identity rows, or a partial write fails closed. Successful completion
requires both live `/api/v1/whoami` and the compiled `ez login`/`ez whoami` path.

That first bootstrap intentionally creates no password. After setting the
environment's `EZACTO_OWNER_PASSWORD`, run `bootstrap browser owner`. The
temporary bootstrap authority can enroll only user `1` when its active,
administrator-owner row, verified primary email, immutable bootstrap audit, and
unrevoked owner token all agree. An exact password retry is a no-op; a different
password or altered bootstrap state fails closed. Completion is the live
password sign-in, secure HttpOnly session cookie, session-authenticated
`/api/v1/whoami`, logout, and rejection of the revoked cookie. Google OIDC is an
independent alternative once its client credentials are configured.

## CI (`.github/workflows/ci.yml`)

`verify` = typecheck + lint + test + build across workspaces (`--if-present`, so
the pipeline is green pre-code and picks packages up as they land), plus the
gitleaks gate with its own self-test. Merge gates per `PROCESS.md`: lint, test,
build, review — a red gate blocks merge.

## CD (`.github/workflows/deploy.yml`)

| Trigger | Target |
| --- | --- |
| push to `main` | **dev** — `ezacto.io` |
| manual dispatch, `environment: prod`, only from `main` | **prod** — `app.example.com` |

Prod is never automatic. "It merged" and "we are ready to move a real book of work
onto it" are different questions, and only one is answered by a push event.

The run re-runs `verify` rather than trusting that `ci.yml` did, deploys with
`--var RELEASE:$GITHUB_SHA`, and then **polls the live host's `/healthz` until it
reports that SHA**. A wrangler exit code says the upload was accepted — not that
the domain resolves, the certificate is up, or the route is bound. The target
host is read out of `wrangler.jsonc`, never repeated in the workflow.

## The public demo (`ezacto.io`)

The dev deployment doubles as the demo anyone can click through. It publishes
its own sign-in credentials on its front page, so the guarantee that makes that
tolerable is that nothing done to it survives the night.

| | |
| --- | --- |
| Brand | **Folding Forks** — an invented firm; nothing here is CONFLICT's. The sign-in page and the brand tagline are where it says so |
| Sign-in | `admin@example.com` / `folding-forks-admin`, `user@example.com` / `folding-forks-user` |
| Data | 20 people, 8 clients, 16 projects, three years of hours, expenses and invoices — all invented, all `@example.com` (RFC 2606, so demo mail can never reach a real person) |
| Rebuild | `0 3 * * *` empties and reseeds; the every-minute cron bills the backlog ten client-months at a time |

Two switches, and both must agree: `DEMO_MODE=true` **and** `ENVIRONMENT` other
than `prod`. `DEMO_MODE` is an operator's switch and `ENVIRONMENT` is the
deployment's identity, so the flag copied into a production worker's vars — the
way this goes wrong — publishes nothing and wipes nothing. Everything
demo-shaped asks `demoDeployment()` in `entries/worker/src/app.ts`.

The history is anchored to the day it is built, not to a fixed calendar, so the
demo always shows a book of work running up to today.

### Rebuilding it by hand

Nothing serves the reset over HTTP: an endpoint that empties a database is worth
more to an attacker than everything else on the host put together. Trigger the
`0 3 * * *` schedule from the Cloudflare dashboard's cron trigger, or locally:

```
npx wrangler dev --env dev --test-scheduled
curl 'http://localhost:8787/__scheduled?cron=0+3+*+*+*'
```

The rebuild is idempotent and resumable: it reads what is left to bill off the
uninvoiced rows themselves, so a tick that dies costs its own slice and the next
one picks up where it stopped.
