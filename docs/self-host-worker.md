# Self-host on Cloudflare Workers

This path runs Ezacto on a custom domain with one Cloudflare D1 database, one R2
attachment bucket, and a delivery Queue plus dead-letter Queue. The repository's
GitHub Actions workflows deploy and verify the exact commit that reaches the
domain. For a deployment with no Cloudflare dependency, use the
[single-container guide](self-host-container.md).

Ezacto is a private pre-release. Pin a reviewed commit, keep the repository that
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
- choose unique D1 `database_name`, R2 `bucket_name`, delivery Queue name, and
  dead-letter Queue name.

Keep the binding names `DB`, `ATTACHMENTS`, and `EMAIL_QUEUE`, and keep both the
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
| Client portal | secret `MAGIC_LINK_SIGNING_KEY`, 32 random bytes as unpadded base64url, in the same format as `API_CURSOR_SIGNING_KEY` and validated the same way before the deploy sends it. Without it the portal routes are not mounted at all, so every magic link a client is sent answers 404. This is deliberate -- a portal that hands out sessions under a weak or absent secret must not look the same as one that is switched off -- but it does mean the portal ships off unless you set this |
| Cloudflare Access | variables `ACCESS_TEAM_DOMAIN` and `ACCESS_POLICY_AUD` |
| AWS SES | secrets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`; variables `SES_REGION`, `SES_FROM`, optional `SES_CONFIGURATION_SET` |

Password login for the bootstrapped owner does not require SES. Public signup,
email verification, and password reset do: configure a verified SES sender and
the documented IAM actions in [the infrastructure contract](infra.md#env--secrets).

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

After the deployment is healthy, run `bootstrap instance` once with the exact
organization and owner identity:

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
```

## Updates and recovery

Pull a reviewed release into your deployment repository; CI deploys `dev`
automatically, while `prod` remains an explicit decision. Database migrations
run before request handling and deployment does not bypass a failed check.

D1 Time Travel is an in-place database undo, not a complete Ezacto backup. It
does not copy the R2 attachment bucket or produce the vendor-independent D18
bundle. Read [RESTORE.md](../RESTORE.md) before an incident. The portable Worker
backup and restore path remains unavailable until issues #28 and #37 land.
