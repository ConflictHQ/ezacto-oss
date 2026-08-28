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

## Backups (D3)

- Hosted: D1 Time Travel (30 d, per-minute, on by default) + **nightly logical
  export to R2** per org (cron Worker). Restore = operator action with
  confirmation; never automated.
- Container: SQLite file copy + the same logical export format.

## Env & secrets

Registry lives in `.dev.vars.example` (copy to `.dev.vars` locally). Rules:
secrets never in git; production secrets only via `wrangler secret put` or CI
secrets; every new env var lands in `.dev.vars.example` in the same PR that
reads it.

CI holds two repository-wide Cloudflare credentials. They are consumed only by
`deploy.yml` and the manual `provision-d1.yml` workflow:

| Secret | What |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | scoped deploy/provision token — account: Workers Scripts Write, Workers Observability Write, Account Settings Read, **D1 Edit**; zone: Zone Read, Workers Routes Write, DNS Write, **limited to `example.com` and `ezacto.io`** |
| `CLOUDFLARE_ACCOUNT_ID` | CONFLICT LLC account id (not secret; a secret only to keep it out of the tracked config) |

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
installs the pair as Worker secrets. If both are absent, Google is not exposed;
if only one is present, deployment and runtime both fail closed. Provider access
tokens, ID tokens, refresh tokens, authorization codes, and raw browser state
are never persisted. OIDC starts are limited to 20 per hashed Cloudflare client
address in a rolling 10-minute window. Each start transactionally removes
expired rows; consumed rows become eligible for cleanup no later than expiry.

Each environment also holds one `EZACTO_BOOTSTRAP_TOKEN`, a canonical `ezacto_`
bearer generated independently for that instance. It is the first owner token,
not a general deployment secret: `bootstrap-instance.yml` temporarily installs
it on the Worker, persists only its selector and SHA-256 digest, proves the live
API and compiled CLI can authenticate, and removes the Worker copy in an
`always()` cleanup step. Store the original bearer in the operator's local CLI
or credential manager when it is generated: GitHub retains it for automation but
will not reveal it later. Workflow logs and artifacts never contain it.

The Cloudflare token cannot touch any other zone, and cannot create zones. Rotate
it by issuing a new token and replacing the repository secret; revoke the old one
after the first green deploy.

## D1 provisioning

Run the manual `provision D1` workflow once before adding bindings. It converges
the exact databases `ezacto-dev` and `ezacto-prod`: an existing exact-name match
is reused, no match is created, and duplicates fail closed. The workflow uploads
a short-lived JSON artifact and job summary containing the non-secret database
ID for each environment, and installs that environment's cursor-signing secret.

Commit the reported IDs under the matching `env.dev` and `env.prod`
`d1_databases` entries in `entries/worker/wrangler.jsonc`. The normal deployment
then applies the binding and its smoke gate proves the exact release is live.

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
