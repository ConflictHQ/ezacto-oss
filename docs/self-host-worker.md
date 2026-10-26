# Self-host on Cloudflare Workers

This path runs Ezacto on a custom domain with one Cloudflare D1 database, one R2
attachment bucket, delivery and migration Queues with separate dead-letter
Queues, and a scheduled-run Workflow. The repository's
GitHub Actions workflows deploy and verify the exact commit that reaches the
domain. For a deployment with no Cloudflare dependency, use the
[single-container guide](self-host-container.md).

Ezacto is pre-1.0. Pin a reviewed commit, keep the repository that
holds your deployment configuration private, and test recovery before entering
production books.

## Prerequisites

- Node.js 22, Git, and a GitHub repository containing this source tree.
- A Cloudflare account with Workers, D1, Queues, and an active R2 subscription.
  The Paid Workers plan gives D1 the 30-day Time Travel window assumed by the
  operations design; the Free plan currently retains seven days.
- A domain in an active Cloudflare zone. The application hostname must not have
  an existing CNAME when Wrangler creates it as a Worker Custom Domain.
- A Cloudflare API token restricted to the deployment account and application
  zone. It needs account-level Workers Scripts Write, Workers Observability
  Write, Account Settings Read, D1 Edit, and Workers R2 Storage Edit, plus
  zone-level Zone Read, Workers Routes Write, and DNS Write.
- GitHub CLI is useful for the commands below, but every workflow and secret can
  also be configured in the GitHub web interface.

Cloudflare documents [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/),
and [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

## 1. Customize one environment

Use `dev` for a continuously deployed instance or `prod` for a deployment that
only moves on an explicit workflow dispatch. This example uses `dev`.

Edit `entries/worker/wrangler.jsonc` under `env.dev` before the first deploy:

- choose a unique Worker `name`;
- replace the `routes[0].pattern` hostname;
- set `vars.APP_BASE_URL` to the exact HTTPS origin;
- choose unique D1 `database_name`, R2 `bucket_name`, delivery and migration
  Queue names, and both dead-letter Queue names;
- update `vars.MIGRATION_QUEUE_NAME` to the migration producer's Queue name;
- choose a unique `workflows[0].name`, keeping its binding and class unchanged;
- remove `vars.DEMO_MODE` or set it to `"false"`. The checked-in `dev` environment
  is the public demo: leaving `"true"` enables demo credentials and nightly data
  replacement. Replace its demo brand text with your own instance identity.

Keep the binding names `DB`, `ATTACHMENTS`, `EMAIL_QUEUE`, `MIGRATION_QUEUE`, and
`SCHEDULED_RUN_WORKFLOW`, and keep both the
top-level and environment-level `workers_dev` values `false`. Enabling
`workers.dev` creates another public hostname outside the custom-domain policy.

Create the D1 database from this checkout and copy the returned UUID into the
same environment's `database_id`:

```sh
npm ci
cd entries/worker
npx wrangler login
npx wrangler d1 create YOUR_DATABASE_NAME
cd ../..
```

Do not guess or reuse an ID from another environment. The tracked name and UUID
must identify the same database. The deploy workflow reads all other resource
names from this file and fails on missing or duplicate resources.

## 2. Configure GitHub credentials

Create the GitHub environment selected above (`dev` in this example). Store the
Cloudflare account credentials as repository secrets, and instance-specific
values as environment secrets:

| Name | Location | Required | Purpose |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | repository secret | yes | account holding every binding |
| `CLOUDFLARE_API_TOKEN` | repository secret | yes | scoped deploy/provision authority |
| `API_CURSOR_SIGNING_KEY` | `dev` secret | yes | 32 random bytes, unpadded base64url |
| `WEBHOOK_ENCRYPTION_KEY` | selected environment secret | outbound webhooks | separate 32 random bytes, unpadded base64url; retain for recovery; see [webhooks](integrations.md#outbound-webhooks) |
| `OIDC_REDIRECT_ORIGIN` | `dev` variable | yes for `prod` | the origin OIDC returns to: scheme and host only. `prod` refuses to start without it rather than falling back to a request-derived value |
| `EZACTO_BOOTSTRAP_TOKEN` | `dev` secret | initial setup | temporary first-owner authority |
| `EZACTO_OWNER_PASSWORD` | `dev` secret | password setup | first owner's password |

The GitHub CLI prompts without echoing secret values:

```sh
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set CLOUDFLARE_API_TOKEN
gh secret set API_CURSOR_SIGNING_KEY --env dev
gh secret set EZACTO_BOOTSTRAP_TOKEN --env dev
gh secret set EZACTO_OWNER_PASSWORD --env dev
```

Generate the two machine credentials locally. Send their output directly to a
password manager and GitHub; do not commit them:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "const c=require('node:crypto'); process.stdout.write('ezacto_'+c.randomBytes(12).toString('base64url')+'_'+c.randomBytes(32).toString('base64url'))"
```

The owner password must contain 12–1024 Unicode code points and at most 4096
UTF-8 bytes. Keep the original bootstrap token and password in your own
credential store because GitHub will not reveal a stored secret later.

Optional authentication and mail settings are complete-pair contracts. A
partial pair stops deployment before it mutates the Worker:

| Feature | GitHub environment configuration |
| --- | --- |
| Google OIDC | secrets `OIDC_GOOGLE_CLIENT_ID` and `OIDC_GOOGLE_CLIENT_SECRET` |
| Staff magic-link sign-in | secret `MAGIC_LINK_SIGNING_KEY`, 32 random bytes as unpadded base64url, in the same format as `API_CURSOR_SIGNING_KEY` and validated the same way before the deploy sends it. Without it the staff magic-link routes are not mounted at all. This is deliberate -- a route that hands out sessions under a weak or absent secret must not look the same as one that is switched off |
| In-app client portal | secret `PORTAL_MAGIC_LINK_SIGNING_KEY`, same format, **separate key on purpose**. Contact sign-in served from this worker, which is off unless you set it. It shared the staff key until the two were split, so turning staff magic-link on also mounted a contact-auth surface nobody asked for. Note that setting this mounts the routes but does not make them send: no runtime composes a portal mailer yet, so the request leg answers 503 until one is written |
| Cloudflare Access | variables `ACCESS_TEAM_DOMAIN` and `ACCESS_POLICY_AUD` |
| How often a signed-in request writes | optional `vars.LAST_SEEN_INTERVAL_SECONDS` in `wrangler.jsonc`, default `300`. A session's last-seen time and an API token's last-used time are written at most once per interval, so a page view inside it is a read; the idle timeout counts from the last recorded use, so it can close up to one interval early, never late. `0` writes on every request; the ceiling is `3600`, and a malformed value fails the request rather than being guessed at |
| The app's own backup feature | optional `vars.BACKUPS_ENABLED` in `wrangler.jsonc`, on by default. Leave it unset and nothing changes. Set it to `false` only where something else already backs the database up (a hosted tenant is backed up by its platform): the backup status, history, download and off-site routes then answer 403 `module_disabled`, the minute cron skips the off-site sync, and the Backups section and its links are not shown. Any value other than `true` or `false` fails requests rather than being guessed at. The schema is unchanged either way. `SSO_ENABLED` and `INVOICES_ENABLED` work the same way; see [Switch whole modules off](operator-guide.md#switch-whole-modules-off) |
| AWS SES | secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`; variables `SES_REGION`, `SES_FROM`, optional `SES_CONFIGURATION_SET` |

Password login for the bootstrapped owner does not require SES. Public signup,
email verification, and password reset do: configure a verified SES sender and
the documented IAM actions in [the infrastructure contract](infra.md#env--secrets).

The password sign-in screen includes **Forgot password?**. It sends a one-time
reset link through the configured mail transport and shows the same confirmation
whether an account exists or not. New links keep the token in the URL fragment;
the browser removes it before loading account data. Previously delivered query
links remain supported. After a successful reset, existing sessions are revoked
and the user signs in with the new password; enrolled two-factor authentication
still applies. Expired or already-used links require a new request. Recovery is
unavailable on the public demo and when password sign-in is disabled.

This uses the self-hosted password service and requires no Cognito account.

## 3. Provision and deploy

Commit the customized Wrangler configuration through your normal review path.
The first push to `main` automatically targets `dev`; `prod` must be dispatched
manually and only from `main`.

The deployment performs these gates in order:

1. the full repository verification suite;
2. exact Queue and R2 convergence (`dev` creates missing resources; `prod`
   requires them to have been provisioned explicitly);
3. one bulk secret convergence and Wrangler deployment;
4. exact Queue and R2 binding checks against Cloudflare's API;
5. polling `https://YOUR_HOST/healthz` until it reports the deployed commit SHA.

For `prod`, first run the `provision Queues` and `provision R2` workflows for
`prod`, then dispatch `deploy` with `environment=prod`. A green upload without a
green live-host poll is not a completed deployment.

Both provisioning workflows read the resource names out of the tracked
`wrangler.jsonc`, and the `prod` block of that file holds placeholders that only
the deploy renders. So the `PROD_*` values must be set on the environment
**before** provisioning, not just before deploying: provisioning refuses to run
against an unrendered config rather than creating a bucket called
`replace-me-r2-bucket`, which is a legal name and would leave the later deploy
binding to something nobody made.

Never dispatch an environment that still contains this repository's example
hostnames, resource names, or IDs. Your token's account and zone restriction is
an additional boundary, not a replacement for reviewing the tracked config.

## 4. Create the first owner

Do this as soon as the deployment is healthy. A new instance has no accounts, and
the first account to claim first run becomes the administrator, so until you have
claimed it anyone who can reach the Worker can. The claim is permanent once made:
an unverified claim is not currently released, so a stranger who signs up first
leaves the bootstrap token as the only way in.

**While `EZACTO_BOOTSTRAP_TOKEN` is set, `/auth/signup` is not served at all**,
so an instance deployed with one configured is never claimable by a stranger:
the window never opens rather than merely being short.

The bootstrap workflow below is that claim, which is why it comes before anything
public. After the deployment is healthy, run `bootstrap instance` once with the
exact organization and owner identity:

```sh
gh workflow run bootstrap-instance.yml --ref main \
  -f environment=dev \
  -f organization_name='Example Studio' \
  -f owner_first_name='Avery' \
  -f owner_last_name='Ng' \
  -f owner_email='owner@example.com'
```

Watch the run to completion. It installs the bootstrap token only temporarily,
creates one organization and verified administrator, proves both API and CLI
token authentication, and removes the Worker secret even on failure.

Then run `bootstrap browser owner`:

```sh
gh workflow run bootstrap-browser-owner.yml --ref main -f environment=dev
```

That workflow temporarily reinstalls the bootstrap authority, enrolls only the
exact owner, proves password sign-in and session revocation against the live
host, and removes the authority. A different retry or pre-existing partial
identity state fails instead of being overwritten.

Open the configured application origin and sign in with the owner email and
password. A direct health check should return JSON whose `release` is the
deployed commit:

```sh
curl -fsS https://YOUR_HOST/healthz
curl -fsS https://YOUR_HOST/readyz
```

`healthz` identifies the running release; `readyz` checks database readiness and
pending migrations. Require both to succeed with the intended release. A newly
created or reattached custom domain may need time for DNS and its certificate to
become available. Retry these read-only checks with a bounded wait; do not treat
a successful upload or a cached DNS failure as the application's final state.

## Updates and recovery

Pull a reviewed release into your deployment repository; CI deploys `dev`
automatically, while `prod` remains an explicit decision. Database migrations
run before request handling and deployment does not bypass a failed check.

D1 Time Travel is an in-place database undo, not a complete Ezacto backup. It
does not copy the R2 attachment bucket. The Worker also writes a nightly CSV
bundle to R2 (`backups/<date>/`): rows only, no schema, no attachment bytes, and
no command reads that format back yet. Read [RESTORE.md](../RESTORE.md) before an
incident, including how the Worker and container bundles differ and what is not
yet synced off-platform.

Before using Time Travel, preserve current evidence and disable the instance's
public routes, scheduled triggers, and Queue consumers as described in
[restore quarantine](account-retention-follow-through.md#container-restore-quarantine).
An existing warm Worker is not an offline database. Reconcile current privacy
history before bringing fresh Worker instances back online, then verify native
sign-in, known rows, and attachment bytes. The
[independent Worker walkthrough](evidence/99-worker-guide-walkthrough.md) records
the exact isolated checks performed and their limits.

## Operational notes

- **Backups share the attachments bucket.** The nightly CSV bundle
  (`backups/<date>/`) is written to the same R2 bucket as attachments. Anyone
  or anything with write access to that bucket can alter or delete both, and a
  bucket lifecycle rule or deletion removes backups and attachments together.
- **Plain HTTP cannot sign in.** Session cookies are set `Secure`, so a browser
  will not send them over `http://`. Serve the Worker over HTTPS only.
- **Expired sessions are inert, not deleted.** An expired or revoked session is
  refused when it is read, but no job removes its row, and a sign-in or Access
  request that opens a session adds one. This is accepted rather than fixed, so
  there is no migration. An operator who wants the table trimmed can delete rows
  whose `absolute_expires_at` is long past.
- **Magic links are confirmed, not consumed, by a GET.** Opening the emailed
  link shows a confirm page; the link is spent only when the page is submitted,
  so a mail scanner or link preview cannot use it up.
- **Admin email templates are privileged.** Whoever can edit email templates
  controls the text of messages sent from your domain, including sign-in and
  password-reset mail. Grant that to administrators you trust with that power.
- **Account linking trusts configured providers' verified email.** A sign-in
  provider that reports an email as verified is linked to the existing account
  with that email. Configure only providers whose email verification you trust.
